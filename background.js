importScripts("config.js", "filter.js", "image-dedupe.js", "fb-api-send.js");

const DEFAULT_CONFIG = {
  enabled: false,
  watchUserName: "",
  watchUserNames: [],
  watchSenderPeerKeys: [],
  knownSenders: [],
  telegramGroupId: "",
  fbThreadUrl: "",
  fbThreadUrls: [],
  filterMode: "contains",
  filterRulesText: "",
  filterRules: [],
  sheetsRules: [],
  sheetsUrl: "",
  sheetsColumn: "A",
  sheetsRefreshMinutes: 30,
  prefix: "",
  telegramChatUrl: "",
  lastSheetsFetchAt: 0,
};

const QUEUE_KEY = "forwardQueue";
const FORWARDED_IDS_KEY = "tgfbForwardedIds";
const IMAGE_STASH_PREFIX = "tgfb_img_";
const FORWARD_STATUS_KEY = "forwardStatus";
const FORWARD_LOG_KEY = "forwardLog";
const claimedMessageIds = new Set();
const TG_MONITOR_TAB_KEY = "tgMonitorTabId";
const FB_DELIVERY_LOCKS_KEY = "fbDeliveryLocks";
const FB_DELIVERY_TTL_MS = 3 * 60 * 1000;
const fbSendInFlight = new Set();
const TG_MONITOR_ALARM = "tgMonitor";
const TG_WAKE_ALARM = "tgWake";
const TG_WAKE_INTERVAL_MS = 12000;
const TG_HOME_URL = "https://web.telegram.org/a/";
let processing = false;
const MAX_QUEUE_FAILURES = 6;
const MAX_FB_TARGETS = 10;
const MAX_TARGET_FAILURES = 3;
/** 一键群发：每个 FB 群之间间隔（用户要求约 2 秒） */
const INTER_GROUP_SEND_DELAY_MS = 2000;
/** 自动排队转发：群与群之间短间隔（单条发送走快速路径） */
const INTER_GROUP_AUTO_DELAY_MS = 400;

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(["config"], (data) => {
    if (!data.config) chrome.storage.local.set({ config: DEFAULT_CONFIG });
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const type = message?.type;

  if (type === "GET_CONFIG") {
    getConfig().then((config) => sendResponse({ ok: true, config }));
    return true;
  }

  if (type === "SAVE_CONFIG") {
    saveConfig(message.config || {}).then((result) =>
      sendResponse({
        ok: true,
        config: result.config,
        invalidFbUrls: result.invalidFbUrls || [],
        truncatedFbUrls: !!result.truncatedFbUrls,
      })
    );
    return true;
  }

  if (type === "REFRESH_SHEETS") {
    refreshSheetsRules()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (type === "TEST_FILTER") {
    getConfig().then((config) => {
      const hit = TgFbFilter.shouldFilterMessage(message.text || "", config.filterRules, {
        mode: config.filterMode,
      });
      sendResponse({ ok: true, filtered: hit });
    });
    return true;
  }

  if (type === "NEW_TG_MESSAGE") {
    handleNewTelegramMessage(message.payload)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (type === "FORWARD_DONE") {
    dequeueAndContinue();
    sendResponse({ ok: true });
    return false;
  }

  if (type === "FORWARD_FAILED") {
    markQueueItemFailed(message.jobId, message.error);
    dequeueAndContinue();
    sendResponse({ ok: true });
    return false;
  }

  if (type === "OPEN_TG_TAB") {
    openTelegramTab(message.url)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (type === "TG_REGISTER_TAB") {
    const tabId = _sender?.tab?.id;
    if (tabId) {
      chrome.storage.local.set({ [TG_MONITOR_TAB_KEY]: tabId });
      setTabUndiscardable(tabId).catch(() => {});
    }
    sendResponse({ ok: true, tabId });
    return false;
  }

  if (type === "GET_FORWARD_LOG") {
    getForwardLog()
      .then((log) => sendResponse({ ok: true, log }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "读取日志失败" }));
    return true;
  }

  return false;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "refreshSheets") refreshSheetsRules().catch(() => {});
  if (alarm.name === "processQueue") processQueue().catch(() => {});
  if (alarm.name === TG_MONITOR_ALARM) runBackgroundWatch().catch(() => {});
  if (alarm.name === TG_WAKE_ALARM) {
    getConfig()
      .then(async (cfg) => {
        if (!cfg?.enabled) return;
        await keepWatchTabsAlive(cfg);
        await processQueue();
        scheduleTgWakeAlarm(cfg);
      })
      .catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.get([TG_MONITOR_TAB_KEY], (data) => {
    if (data[TG_MONITOR_TAB_KEY] === tabId) {
      chrome.storage.local.remove(TG_MONITOR_TAB_KEY);
    }
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.config) return;
  const cfg = changes.config.newValue;
  scheduleSheetsAlarm(cfg);
  scheduleMonitorAlarm(cfg);
  scheduleQueueAlarm(cfg);
  scheduleTgWakeAlarm(cfg);
  if (cfg?.enabled && cfg?.fbThreadUrls?.length) prewarmFacebookTabs(cfg).catch(() => {});
});

async function getConfig() {
  const data = await chrome.storage.local.get(["config"]);
  const config = { ...DEFAULT_CONFIG, ...(data.config || {}) };
  return normalizeConfig(config);
}

function normalizeGroupId(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";
  if (s.includes("#")) s = s.split("#").pop();
  s = s.replace(/\s/g, "");
  if (!s.startsWith("-") && /^\d+$/.test(s)) {
    if (s.startsWith("100") && s.length > 10) s = "-" + s;
    else if (s.length >= 6) s = "-100" + s;
  }
  return s;
}

function buildTelegramChatUrl(groupId) {
  const id = normalizeGroupId(groupId);
  if (!id) return "";
  const hash = id.startsWith("#") ? id.slice(1) : id;
  return `https://web.telegram.org/a/#${hash}`;
}

function getWatchUserNames(config) {
  if (Array.isArray(config.watchUserNames) && config.watchUserNames.length) {
    return config.watchUserNames.map((n) => String(n).trim()).filter(Boolean);
  }
  if (config.watchUserName) return [String(config.watchUserName).trim()];
  return [];
}

function normalizeConfig(config) {
  if (config.telegramGroupId) {
    config.telegramGroupId = normalizeGroupId(config.telegramGroupId);
    config.telegramChatUrl = buildTelegramChatUrl(config.telegramGroupId);
  } else if (config.telegramChatUrl && !config.telegramGroupId) {
    const fromHash = config.telegramChatUrl.match(/#(.+)$/);
    if (fromHash) config.telegramGroupId = decodeURIComponent(fromHash[1]);
  }

  config.watchUserNames = getWatchUserNames(config);
  if (config.watchUserNames.length) config.watchUserName = config.watchUserNames[0];

  if (!Array.isArray(config.watchSenderPeerKeys)) config.watchSenderPeerKeys = [];
  config.watchSenderPeerKeys = [...new Set(config.watchSenderPeerKeys.map((s) => String(s).trim()).filter(Boolean))];

  if (!Array.isArray(config.knownSenders)) config.knownSenders = [];
  config.knownSenders = [...new Set(config.knownSenders.map((s) => String(s).trim()).filter(Boolean))];

  if (Array.isArray(config.fbThreadUrls) && config.fbThreadUrls.length) {
    config.fbThreadUrls = dedupeFbUrls(config.fbThreadUrls).slice(0, MAX_FB_TARGETS);
  } else if (config.fbThreadUrl) {
    config.fbThreadUrls = dedupeFbUrls([config.fbThreadUrl]).slice(0, MAX_FB_TARGETS);
  } else if (!Array.isArray(config.fbThreadUrls)) {
    config.fbThreadUrls = [];
  }
  if (config.fbThreadUrls?.length) config.fbThreadUrl = config.fbThreadUrls[0];
  return config;
}

const FB_THREAD_URL_HINT = "https://www.facebook.com/messages/t/数字";

function normalizeFbUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return { threadId: "", full: "", valid: false };

  if (/^\d{6,}$/.test(raw)) {
    return {
      threadId: raw,
      full: `https://www.facebook.com/messages/t/${raw}`,
      valid: true,
    };
  }

  const patterns = [
    /\/messages\/t\/(\d+)/i,
    /messenger\.com\/t\/(\d+)/i,
    /facebook\.com\/t\/(\d+)/i,
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (m?.[1]) {
      return {
        threadId: m[1],
        full: `https://www.facebook.com/messages/t/${m[1]}`,
        valid: true,
      };
    }
  }

  return { threadId: "", full: raw, valid: false };
}

function parseFbUrlsWithValidation(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const invalid = [];
  const candidates = [];
  for (const line of lines) {
    const n = normalizeFbUrl(line);
    if (n.valid && n.threadId) candidates.push(n.full);
    else invalid.push(line);
  }
  const all = dedupeFbUrls(candidates);
  const truncated = all.length > MAX_FB_TARGETS;
  return { urls: all.slice(0, MAX_FB_TARGETS), invalid, truncated };
}

function parseFbUrlsFromText(text) {
  return parseFbUrlsWithValidation(text).urls;
}

function dedupeFbUrls(urls) {
  const seen = new Set();
  const out = [];
  for (const raw of urls) {
    const n = normalizeFbUrl(raw);
    if (!n.valid || !n.threadId || seen.has(n.threadId)) continue;
    seen.add(n.threadId);
    out.push(n.full);
  }
  return out;
}

function getFbTargets(config) {
  const urls =
    config.fbThreadUrls?.length > 0
      ? config.fbThreadUrls
      : config.fbThreadUrl
        ? [config.fbThreadUrl]
        : [];
  return dedupeFbUrls(urls)
    .slice(0, MAX_FB_TARGETS)
    .map((full) => normalizeFbUrl(full));
}

async function saveConfig(partial) {
  const current = await getConfig();
  const next = { ...current, ...partial };
  let invalidFbUrls = [];
  let truncatedFbUrls = false;
  if (partial.fbThreadUrlsText !== undefined) {
    const parsed = parseFbUrlsWithValidation(partial.fbThreadUrlsText);
    next.fbThreadUrls = parsed.urls;
    invalidFbUrls = parsed.invalid;
    truncatedFbUrls = !!parsed.truncated;
    delete next.fbThreadUrlsText;
  } else if (partial.fbThreadUrls !== undefined) {
    const all = dedupeFbUrls(partial.fbThreadUrls);
    truncatedFbUrls = all.length > MAX_FB_TARGETS;
    next.fbThreadUrls = all.slice(0, MAX_FB_TARGETS);
  }
  if (next.fbThreadUrls?.length) next.fbThreadUrl = next.fbThreadUrls[0];
  if (partial.telegramChatUrl !== undefined) {
    next.telegramChatUrl = partial.telegramChatUrl;
  }
  if (partial.telegramGroupId !== undefined) {
    next.telegramGroupId = normalizeGroupId(partial.telegramGroupId);
    next.telegramChatUrl = buildTelegramChatUrl(next.telegramGroupId);
  }
  if (partial.knownSenders !== undefined) {
    next.knownSenders = [...new Set((partial.knownSenders || []).map((s) => String(s).trim()).filter(Boolean))];
  }
  if (partial.watchUserNames !== undefined) {
    next.watchUserNames = (partial.watchUserNames || []).map((s) => String(s).trim()).filter(Boolean);
    next.watchUserName = next.watchUserNames[0] || "";
  }
  if (partial.watchSenderPeerKeys !== undefined) {
    next.watchSenderPeerKeys = [...new Set((partial.watchSenderPeerKeys || []).map((s) => String(s).trim()).filter(Boolean))];
  }
  if (partial.filterRulesText !== undefined) {
    next.filterRules = mergeFilterRules(
      TgFbFilter.parseRulesFromText(next.filterRulesText),
      next.sheetsRules || []
    );
  } else if (partial.filterRules !== undefined) {
    next.filterRules = partial.filterRules;
  } else {
    next.filterRules = mergeFilterRules(
      TgFbFilter.parseRulesFromText(next.filterRulesText),
      next.sheetsRules || []
    );
  }
  const wasEnabled = !!current.enabled;
  const normalized = normalizeConfig(next);
  await chrome.storage.local.set({ config: normalized });
  scheduleSheetsAlarm(normalized);
  scheduleMonitorAlarm(normalized);
  scheduleQueueAlarm(normalized);
  scheduleTgWakeAlarm(normalized);
  if (!normalized.enabled) {
    await stopForwardQueue(wasEnabled);
  } else if (normalized.fbThreadUrls?.length) {
    prewarmFacebookTabs(normalized).catch(() => {});
  }
  return { config: normalized, invalidFbUrls, truncatedFbUrls };
}

async function stopForwardQueue(notify = false) {
  processing = false;
  fbSendInFlight.clear();
  const data = await chrome.storage.local.get([QUEUE_KEY]);
  const queue = (data[QUEUE_KEY] || []).map((j) =>
    j.done || isJobComplete(j) ? j : { ...j, done: true, stopped: true }
  );
  await chrome.storage.local.set({ [QUEUE_KEY]: queue });
  if (notify) {
    lastForwardStatusText = "";
    await setForwardStatus("转发已停止", "ok");
  }
}

let lastForwardStatusText = "";

async function setForwardStatus(text, level = "info") {
  const msg = String(text || "");
  if (msg === lastForwardStatusText) return;
  lastForwardStatusText = msg;
  await chrome.storage.local.set({
    [FORWARD_STATUS_KEY]: { text: msg, level, time: Date.now() },
  });
}

async function getForwardLog() {
  const data = await chrome.storage.local.get([FORWARD_LOG_KEY]);
  return data[FORWARD_LOG_KEY] || [];
}

async function appendForwardLog(entry) {
  const max = TgFbConfig?.MAX_FORWARD_LOG || 50;
  const data = await chrome.storage.local.get([FORWARD_LOG_KEY]);
  const log = data[FORWARD_LOG_KEY] || [];
  log.unshift({ ...entry, time: Date.now() });
  await chrome.storage.local.set({ [FORWARD_LOG_KEY]: log.slice(0, max) });
}

function isValidTelegramChatUrl(url) {
  if (!isTelegramChatUrl(url)) return false;
  const m = String(url).match(/#(.+)$/);
  if (!m) return false;
  const id = decodeURIComponent(m[1]).replace(/[^\d-@a-zA-Z_]/g, "");
  if (!id || /^-?0+$/.test(id)) return false;
  return true;
}

async function hasFacebookLoginCookie() {
  try {
    const domains = ["facebook.com"];
    for (const domain of domains) {
      const list = await chrome.cookies.getAll({ domain });
      if (list.some((c) => c.name === "c_user" && c.value && c.value !== "0")) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

async function sendJobViaBackgroundApi(job, target) {
  const loggedIn = await hasFacebookLoginCookie();
  if (!loggedIn) {
    throw new Error("Chrome 未检测到 FB 登录：请在任意标签页登录 facebook.com，无需保持页面打开");
  }
  const res = await TgFbApiSend.sendMessengerJob(String(target.threadId), job);
  return { ok: true, mode: res?.mode || "background-api" };
}

async function prewarmFacebookTabs(config) {
  if (!getFbTargets(config).length) return;
  try {
    const loggedIn = await hasFacebookLoginCookie();
    if (!loggedIn) {
      await setForwardStatus("未检测到 FB 登录：请在任意 Chrome 标签页登录 facebook.com", "err");
      return;
    }
    await setForwardStatus("Facebook 已登录，后台静默群发已就绪（无需打开群聊页）", "ok");
  } catch (err) {
    await setForwardStatus(err.message || "FB 登录检查失败", "err");
  }
}

async function getDeliveryLocks() {
  const data = await chrome.storage.local.get([FB_DELIVERY_LOCKS_KEY]);
  return data[FB_DELIVERY_LOCKS_KEY] || {};
}

async function isAlreadyDelivered(lockKey) {
  const locks = await getDeliveryLocks();
  const ts = locks[lockKey];
  return ts && Date.now() - ts < FB_DELIVERY_TTL_MS;
}

async function markDelivered(lockKey) {
  const locks = await getDeliveryLocks();
  locks[lockKey] = Date.now();
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [k, ts] of Object.entries(locks)) {
    if (ts < cutoff) delete locks[k];
  }
  await chrome.storage.local.set({ [FB_DELIVERY_LOCKS_KEY]: locks });
}

function buildDeliveryLockKey(job, threadId) {
  const text = String(job.text || "").trim();
  const img = (job.imageDataUrls?.length || 0) > 0 ? "1" : "0";
  return `${job.messageId}::${threadId}::${text}::img${img}`;
}

async function forwardManualJob(job) {
  const targets = job.fbTargets || [];
  if (!targets.length) throw new Error("未配置 FB 群");

  setForwardStatus(`手动转发到 ${targets.length} 个群（每群间隔 ${INTER_GROUP_SEND_DELAY_MS / 1000}s）…`, "info");

  let ok = 0;
  const errors = [];
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    if (i > 0) await sleep(INTER_GROUP_SEND_DELAY_MS);
    try {
      const res = await sendJobToFacebook({ ...job, manual: true }, target);
      if (res?.ok) ok++;
      else errors.push(res?.error || "发送失败");
    } catch (err) {
      errors.push(err?.message || "发送失败");
    }
  }

  if (!ok) throw new Error(errors[0] || "手动转发失败");

  const msg =
    ok === targets.length
      ? `手动转发完成（${ok} 个群）`
      : `手动转发完成 ${ok}/${targets.length} 个群`;
  await setForwardStatus(msg, ok === targets.length ? "ok" : "info");
  return { ok: true, sent: ok, total: targets.length };
}

async function sendJobToFacebook(job, target) {
  const lockKey = buildDeliveryLockKey(job, target.threadId);
  if (!job.manual && (await isAlreadyDelivered(lockKey))) {
    return { ok: true, alreadySent: true };
  }
  if (fbSendInFlight.has(lockKey)) {
    return { ok: true, alreadySent: true };
  }
  fbSendInFlight.add(lockKey);

  try {
    const apiRes = await sendJobViaBackgroundApi(job, target);
    if (!apiRes?.ok) throw new Error("Facebook API 发送失败");
    if (!job.manual) await markDelivered(lockKey);
    await appendForwardLog({
      messageId: job.messageId,
      threadId: target.threadId,
      ok: true,
      mode: apiRes.mode,
      text: truncate(job.text, 60),
      manual: !!job.manual,
    });
    return apiRes;
  } catch (err) {
    const errText = err?.message || "发送失败";
    const msg = String(errText);
    if (/登录|dtsg|cookie|checkpoint/i.test(msg)) {
      TgFbApiSend.invalidateSession?.();
    }
    await appendForwardLog({
      messageId: job.messageId,
      threadId: target.threadId,
      ok: false,
      error: errText,
      text: truncate(job.text, 60),
      manual: !!job.manual,
    });
    if (/checkpoint|登录|cookie|dtsg/i.test(errText)) {
      notify(`Facebook 会话异常：${truncate(errText, 80)}`, true);
    }
    throw err;
  } finally {
    fbSendInFlight.delete(lockKey);
  }
}

function mergeFilterRules(manual, sheets) {
  const seen = new Set();
  const out = [];
  for (const r of [...(manual || []), ...(sheets || [])]) {
    const t = String(r || "").trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function scheduleSheetsAlarm(config) {
  chrome.alarms.clear("refreshSheets");
  const mins = Math.max(5, Number(config?.sheetsRefreshMinutes) || 30);
  if (config?.sheetsUrl) {
    chrome.alarms.create("refreshSheets", { periodInMinutes: mins });
  }
}

async function refreshSheetsRules() {
  const config = await getConfig();
  const csvUrl = TgFbFilter.buildGoogleSheetCsvUrl(config.sheetsUrl);
  if (!csvUrl) throw new Error("Google 表格链接无效，需包含 /spreadsheets/d/ID");

  const res = await fetch(csvUrl, { credentials: "omit" });
  if (!res.ok) throw new Error(`拉取表格失败 HTTP ${res.status}，请确认已「发布到网络」或链接可查看`);

  const csv = await res.text();
  const sheetsRules = TgFbFilter.parseRulesFromCsv(csv, config.sheetsColumn || "A");
  const manual = TgFbFilter.parseRulesFromText(config.filterRulesText);
  const next = {
    ...config,
    sheetsRules,
    filterRules: mergeFilterRules(manual, sheetsRules),
    lastSheetsFetchAt: Date.now(),
  };
  await chrome.storage.local.set({ config: next });
  return { rulesCount: sheetsRules.length, filterRules: next.filterRules };
}

async function claimMessageForward(messageId) {
  const id = String(messageId || "");
  if (!id) return false;
  if (claimedMessageIds.has(id)) return false;

  const data = await chrome.storage.local.get([FORWARDED_IDS_KEY]);
  const map = data[FORWARDED_IDS_KEY] || {};
  if (map[id]) return false;

  claimedMessageIds.add(id);
  map[id] = Date.now();
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const [k, ts] of Object.entries(map)) {
    if (ts < cutoff) delete map[k];
  }
  await chrome.storage.local.set({ [FORWARDED_IDS_KEY]: map });
  return true;
}

async function fetchImagesFromMessageInTelegram(messageId) {
  const stored = await chrome.storage.local.get([TG_MONITOR_TAB_KEY]);
  const tabId = stored[TG_MONITOR_TAB_KEY];
  if (!tabId || !messageId) return [];

  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (mid) => {
        const root =
          document.querySelector(`[data-message-id="${mid}"]`)?.closest(".Message") ||
          document.querySelector(`.Message [data-message-id="${mid}"]`)?.closest(".Message");
        if (!root) return [];

        const isStickerMessage = () => {
          if (root.querySelector(".sticker-media, video.sticker-media, .CustomEmoji, .custom-emoji")) {
            return true;
          }
          if (root.querySelector("img.full-media, .Photo, .Album")) return false;
          for (const inner of root.querySelectorAll(".media-inner")) {
            if (inner.querySelector(".sticker-media, video.sticker-media")) return true;
            if (inner.querySelector("canvas") && !inner.querySelector("img.full-media")) return true;
          }
          return false;
        };
        if (isStickerMessage()) return [];

        const album = root.querySelector(".Album");
        const containers = album
          ? [...album.querySelectorAll(".media-inner")]
          : [...root.querySelectorAll(".media-inner, .Photo, .message-media, .message-content-media")].filter(
              (el, _i, all) => !all.some((other) => other !== el && other.contains(el))
            );

        const candidates = [];
        const pickBest = (container) => {
          let best = null;
          let bestArea = 0;
          let bestCanvas = null;
          for (const img of container.querySelectorAll("img")) {
            if (img.closest(".Avatar, .avatar, .Reactions")) continue;
            if (img.classList.contains("sticker-media")) continue;
            const src = (img.currentSrc || img.src || "").toLowerCase();
            if (src.includes("sticker") || (src.includes("emoji") && !img.classList.contains("full-media"))) {
              continue;
            }
            const r = img.getBoundingClientRect();
            const min = album ? 20 : 48;
            if (r.width < min || r.height < min) continue;
            const w = img.naturalWidth || r.width;
            const h = img.naturalHeight || r.height;
            const area = w * h;
            if (area >= bestArea) {
              bestArea = area;
              best = img;
            }
          }
          if (best) {
            candidates.push(best);
            return;
          }
          for (const canvas of container.querySelectorAll("canvas.thumbnail, canvas")) {
            if (canvas.width >= 8 && canvas.height >= 8) {
              bestCanvas = canvas;
              break;
            }
          }
          if (bestCanvas) candidates.push(bestCanvas);
        };
        if (containers.length) containers.forEach(pickBest);
        else {
          for (const img of root.querySelectorAll("img.full-media, .media-inner img")) {
            if (img.closest(".Avatar, .avatar, .Reactions")) continue;
            const r = img.getBoundingClientRect();
            if (r.width >= 48 && r.height >= 48) candidates.push(img);
          }
        }

        const seen = new Set();
        const out = [];

        async function nodeToData(node) {
          if (node instanceof HTMLCanvasElement) {
            if (!node.width || !node.height) return null;
            return node.toDataURL("image/jpeg", 0.92);
          }
          await new Promise((resolve) => {
            if (node.complete && node.naturalWidth > 0) resolve();
            else {
              node.onload = resolve;
              node.onerror = resolve;
              setTimeout(resolve, 2500);
            }
          });
          const w = node.naturalWidth || node.width;
          const h = node.naturalHeight || node.height;
          if (!w || !h) return null;
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          canvas.getContext("2d").drawImage(node, 0, 0);
          return canvas.toDataURL("image/jpeg", 0.92);
        }

        for (const node of candidates) {
          const r = node.getBoundingClientRect?.() || { width: 0, height: 0 };
          const src = node.currentSrc || node.src || "";
          const key = src || `w${r.width}h${r.height}:${out.length}`;
          if (seen.has(key)) continue;
          seen.add(key);
          try {
            let data = null;
            if (node instanceof HTMLCanvasElement) {
              data = await nodeToData(node);
            } else if (src) {
              const res = await fetch(src);
              const blob = await res.blob();
              data = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
              });
            } else {
              data = await nodeToData(node);
            }
            if (data) out.push(data);
          } catch {
            /* skip */
          }
          if (out.length >= 5) break;
        }
        return out;
      },
      args: [messageId],
    });
    const list = Array.isArray(result) ? result : [];
    return TgFbImageDedupe.dedupeImageRefs(list, 5);
  } catch {
    return [];
  }
}

async function fetchImagesInTelegramTab(urls) {
  const stored = await chrome.storage.local.get([TG_MONITOR_TAB_KEY]);
  const tabId = stored[TG_MONITOR_TAB_KEY];
  if (!tabId || !urls?.length) return [];

  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (urlList) => {
        const out = [];
        for (const url of urlList.slice(0, 5)) {
          try {
            const res = await fetch(url);
            const blob = await res.blob();
            const dataUrl = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            });
            if (dataUrl) out.push(dataUrl);
          } catch {
            /* skip */
          }
        }
        return out;
      },
      args: [TgFbImageDedupe.dedupeImageRefs(urls, 5)],
    });
    const list = Array.isArray(result) ? result : [];
    return TgFbImageDedupe.dedupeImageRefs(list, 5);
  } catch {
    return [];
  }
}

async function resolvePayloadImages(payload) {
  let list = payload.imageDataUrls || [];
  if (payload.imageStashKey) {
    const data = await chrome.storage.local.get(payload.imageStashKey);
    const stashed = data[payload.imageStashKey];
    if (Array.isArray(stashed) && stashed.length) list = stashed;
  }
  return TgFbImageDedupe.dedupeImageRefs(list, 5);
}

async function clearImageStash(stashKey) {
  if (!stashKey) return;
  await chrome.storage.local.remove(stashKey);
}

async function releaseForwardClaim(messageId) {
  const id = String(messageId || "");
  if (!id) return;
  claimedMessageIds.delete(id);
  const data = await chrome.storage.local.get([FORWARDED_IDS_KEY]);
  const map = data[FORWARDED_IDS_KEY] || {};
  delete map[id];
  await chrome.storage.local.set({ [FORWARDED_IDS_KEY]: map });
}

async function handleNewTelegramMessage(payload) {
  const config = await getConfig();
  const manual = !!payload.manual;
  if (!manual && !config.enabled) return { skipped: true, reason: "disabled" };

  if (manual) await releaseForwardClaim(payload.messageId);
  if (!(await claimMessageForward(payload.messageId))) {
    if (!manual) return { skipped: true, reason: "duplicate" };
    await releaseForwardClaim(payload.messageId);
    if (!(await claimMessageForward(payload.messageId))) {
      return { skipped: true, reason: "duplicate" };
    }
  }

  const albumSlots = Math.min(5, Math.max(1, Number(payload.albumSlots) || 1));
  const text = buildForwardText(payload);
  const textOnlyManual =
    manual &&
    !payload.hasImages &&
    !payload.mediaShell &&
    !payload.imageStashKey &&
    !(payload.imageUrls?.length);
  const imageDataUrls = textOnlyManual
    ? []
    : await resolveJobImages(payload, albumSlots, manual);
  const hasImages = imageDataUrls.length > 0;
  if (!text && !hasImages) {
    await releaseForwardClaim(payload.messageId);
    return { skipped: true, reason: "empty" };
  }
  if (
    !manual &&
    text.trim() &&
    TgFbFilter.shouldFilterMessage(text, config.filterRules, { mode: config.filterMode })
  ) {
    await releaseForwardClaim(payload.messageId);
    return { skipped: true, reason: "filtered" };
  }

  const fbTargets = getFbTargets(config);
  if (!fbTargets.length) {
    await releaseForwardClaim(payload.messageId);
    return { skipped: true, reason: "no_fb_targets", hint: FB_THREAD_URL_HINT };
  }

  const job = {
    id: `${payload.messageId}-${Date.now()}`,
    messageId: payload.messageId,
    text,
    imageUrls: payload.imageUrls || [],
    imageDataUrls,
    imageStashKey: null,
    albumSlots,
    links: payload.links || [],
    sender: payload.sender,
    fbTargets,
    completedTargetIds: [],
    failedTargetIds: [],
    targetFailures: {},
    createdAt: Date.now(),
    attempts: 0,
    failures: 0,
    retryAt: 0,
    manual,
    textOnly: textOnlyManual || (!hasImages && !!text),
    state: "pending",
  };

  if (manual) {
    await setForwardStatus(`手动转发：${truncate(text || "(图片)", 40)}`, "info");
    try {
      const result = await forwardManualJob(job);
      return {
        queued: true,
        sent: true,
        jobId: job.id,
        targetCount: fbTargets.length,
        sentCount: result.sent,
      };
    } catch (err) {
      await releaseForwardClaim(payload.messageId);
      return { skipped: true, reason: "send_failed", error: err.message };
    }
  }

  const added = await enqueue(job);
  if (!added) {
    await releaseForwardClaim(payload.messageId);
    return { skipped: true, reason: "duplicate" };
  }
  await setForwardStatus(`排队转发：${truncate(text || "(图片)", 40)}`, "info");
  getConfig()
    .then((cfg) => prewarmFacebookTabs(cfg))
    .catch(() => {});
  processQueue().catch(() => {});
  return { queued: true, jobId: job.id, targetCount: fbTargets.length };
}

function collapseRepeatedText(text) {
  const compact = String(text || "")
    .replace(/\s+/g, "")
    .trim();
  if (compact.length < 4) return String(text || "").trim();
  for (let len = 1; len <= Math.floor(compact.length / 2); len++) {
    if (compact.length % len !== 0) continue;
    const unit = compact.slice(0, len);
    if (unit.repeat(compact.length / len) === compact) return unit;
  }
  return String(text || "").trim();
}

function isMediaOrUrlOnlyText(text) {
  const t = String(text || "").trim();
  if (!t) return true;
  if (/^https?:\/\//i.test(t)) return true;
  if (/^(photo|image|图片|照片|点击查看|view\s*photo)$/i.test(t)) return true;
  return false;
}

function buildForwardText(payload) {
  const isMediaMsg = !!(payload.hasImages || payload.mediaShell);
  let text = collapseRepeatedText((payload.text || "").trim());
  if (isMediaMsg && isMediaOrUrlOnlyText(text)) text = "";

  const parts = [];
  if (text) parts.push(text);
  if (!isMediaMsg && payload.links?.length) {
    const extra = payload.links.filter((l) => !text.includes(l) && !isMediaOrUrlOnlyText(l));
    if (extra.length) parts.push(extra.join("\n"));
  }
  return parts.join("\n").trim();
}

async function resolveJobImages(payload, albumSlots, manual = false) {
  if (payload.isSticker) return [];
  const urlFallback = TgFbImageDedupe.dedupeImageRefs(payload.imageUrls || [], 5);
  const slotCount = Math.min(5, Math.max(1, Number(albumSlots) || 1));
  const cfg = TgFbConfig || {};
  const fetchTimeout = manual
    ? Math.min(
        15000,
        (cfg.MANUAL_IMAGE_FETCH_TIMEOUT_BASE_MS || 2000) +
          slotCount * (cfg.MANUAL_IMAGE_FETCH_TIMEOUT_PER_SLOT_MS || 2000)
      )
    : Math.min(
        22000,
        (cfg.IMAGE_FETCH_TIMEOUT_BASE_MS || 4000) +
          slotCount * (cfg.IMAGE_FETCH_TIMEOUT_PER_SLOT_MS || 3500)
      );

  let imageDataUrls = [];
  if (urlFallback.length) {
    imageDataUrls = await Promise.race([
      fetchImagesInTelegramTab(urlFallback),
      sleep(fetchTimeout).then(() => []),
    ]);
  }
  if (!imageDataUrls.length && (payload.mediaShell || payload.hasImages)) {
    imageDataUrls = await Promise.race([
      fetchImagesFromMessageInTelegram(payload.messageId),
      sleep(fetchTimeout).then(() => []),
    ]);
  }

  return albumSlots > 1
    ? TgFbImageDedupe.dedupeImageRefs(imageDataUrls, albumSlots)
    : TgFbImageDedupe.pickSingleBestDataUrl(imageDataUrls);
}

async function enqueue(job, opts = {}) {
  const data = await chrome.storage.local.get([QUEUE_KEY]);
  let queue = data[QUEUE_KEY] || [];
  if (opts.force) {
    queue = queue.filter((q) => q.messageId !== job.messageId);
  } else if (queue.some((q) => q.messageId === job.messageId && !q.done)) {
    return false;
  }
  queue.push(job);
  await chrome.storage.local.set({ [QUEUE_KEY]: queue.slice(-200) });
  return true;
}

function getNextTarget(job) {
  const done = new Set(job.completedTargetIds || []);
  const failed = new Set(job.failedTargetIds || []);
  return (job.fbTargets || []).find(
    (t) => t.threadId && !done.has(t.threadId) && !failed.has(t.threadId)
  );
}

function isJobComplete(job) {
  const total = (job.fbTargets || []).length;
  if (!total) return false;
  const done = (job.completedTargetIds || []).length;
  const failed = (job.failedTargetIds || []).length;
  return done + failed >= total;
}

function countJobProgress(job) {
  const total = (job.fbTargets || []).length;
  const done = (job.completedTargetIds || []).length;
  const failed = (job.failedTargetIds || []).length;
  return { total, done, failed };
}

function isJobPending(j) {
  if (j.done || isJobComplete(j)) return false;
  if ((j.failures || 0) >= MAX_QUEUE_FAILURES) return false;
  return Date.now() >= (j.retryAt || 0);
}

async function processQueue() {
  if (processing) return;
  const config = await getConfig();
  if (!config.enabled) return;

  processing = true;
  let job = null;
  let target = null;
  try {
    const data = await chrome.storage.local.get([QUEUE_KEY]);
    const queue = data[QUEUE_KEY] || [];
    job = queue.find((j) => isJobPending(j));
    if (!job) return;

    if (!job.fbTargets?.length) {
      const config = await getConfig();
      job.fbTargets = getFbTargets(config);
      if (!job.fbTargets.length) return;
      job.completedTargetIds = job.completedTargetIds || [];
      await chrome.storage.local.set({ [QUEUE_KEY]: queue });
    }

    target = getNextTarget(job);
    if (!target) {
      job.done = true;
      await chrome.storage.local.set({ [QUEUE_KEY]: queue });
      return;
    }

    await setForwardStatus(`正在向 FB 群 ${target.threadId} 发送（API）…`, "info");
    job.state = "sending";
    await chrome.storage.local.set({ [QUEUE_KEY]: queue });
    const response = await sendJobToFacebook(job, target);

    if (response?.ok) {
      job.completedTargetIds = job.completedTargetIds || [];
      if (!job.completedTargetIds.includes(target.threadId)) {
        job.completedTargetIds.push(target.threadId);
      }
      job.failures = 0;
      job.retryAt = 0;
      const total = job.fbTargets.length;
      const doneCount = job.completedTargetIds.length;
      await chrome.storage.local.set({ [QUEUE_KEY]: queue });

      if (isJobComplete(job)) {
        job.done = true;
        job.state = "completed";
        const failCount = (job.failedTargetIds || []).length;
        notify(
          failCount
            ? `已转发 ${doneCount}/${total} 个群（${failCount} 个跳过）：${truncate(job.text, 36)}`
            : `已转发到 ${total} 个群：${truncate(job.text, 36)}`
        );
        await setForwardStatus(
          failCount
            ? `完成：成功 ${doneCount} 个，跳过 ${failCount} 个（共 ${total} 个群）`
            : `已全部转发到 ${total} 个 FB 群`,
          failCount ? "info" : "ok"
        );
        await chrome.storage.local.set({ [QUEUE_KEY]: queue });
      } else {
        await setForwardStatus(
          `已发到 ${doneCount}/${total} 个群，继续发送到下一群…`,
          "info"
        );
        processing = false;
        await sleep(INTER_GROUP_AUTO_DELAY_MS);
        await processQueue();
        return;
      }
    } else {
      throw new Error(response?.error || "Facebook 页面发送失败");
    }
  } catch (err) {
    const msg = err.message || "转发失败";
    console.warn("[tg-to-fb]", err);
    let skipToNextTarget = false;
    if (job && target) {
      const data = await chrome.storage.local.get([QUEUE_KEY]);
      const queue = data[QUEUE_KEY] || [];
      const j = queue.find((x) => x.id === job.id);
      if (j) {
        const tid = String(target.threadId);
        j.targetFailures = j.targetFailures || {};
        j.targetFailures[tid] = (j.targetFailures[tid] || 0) + 1;
        j.lastError = msg;
        const tf = j.targetFailures[tid];
        const progress = countJobProgress(j);

        if (tf >= MAX_TARGET_FAILURES) {
          j.failedTargetIds = j.failedTargetIds || [];
          if (!j.failedTargetIds.includes(tid)) j.failedTargetIds.push(tid);
          j.retryAt = 0;
          if (isJobComplete(j)) {
            j.done = true;
            j.state = "completed";
            await setForwardStatus(
              `完成：成功 ${progress.done} 个，跳过 ${progress.failed} 个（共 ${progress.total} 个群）`,
              progress.failed ? "info" : "ok"
            );
          } else {
            await setForwardStatus(
              `群 ${tid} 已跳过，继续下一群（${progress.done + progress.failed}/${progress.total}）…`,
              "info"
            );
            skipToNextTarget = true;
          }
        } else {
          j.retryAt = Date.now() + Math.min(15000, 2000 * tf);
          const waitSec = Math.max(1, Math.ceil((j.retryAt - Date.now()) / 1000));
          await setForwardStatus(
            `群 ${tid} 失败：${truncate(msg, 40)} · ${waitSec}秒后重试（${tf}/${MAX_TARGET_FAILURES}）`,
            "info"
          );
        }
        await chrome.storage.local.set({ [QUEUE_KEY]: queue });
      }
    } else {
      await setForwardStatus(msg, "err");
    }
    if (skipToNextTarget) {
      processing = false;
      await sleep(INTER_GROUP_AUTO_DELAY_MS);
      await processQueue();
      return;
    }
  } finally {
    processing = false;
    const cfg = await getConfig();
    if (!cfg.enabled) return;

    const data = await chrome.storage.local.get([QUEUE_KEY]);
    const pending = (data[QUEUE_KEY] || []).some((j) => isJobPending(j));
    if (pending) {
      const next = (data[QUEUE_KEY] || []).find((j) => isJobPending(j));
      const delay = next?.retryAt ? Math.max(200, next.retryAt - Date.now()) : 300;
      setTimeout(() => processQueue().catch(() => {}), delay);
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isTelegramChatUrl(url) {
  try {
    const u = new URL(url);
    if (!/web\.telegram\.org$/i.test(u.hostname)) return false;
    if (!/^\/(a|k)\/?/i.test(u.pathname)) return false;
    const hash = u.hash || "";
    if (hash.length > 2 && (hash.startsWith("#-") || hash.startsWith("#@"))) return true;
    return false;
  } catch {
    return false;
  }
}

function normalizeTelegramOpenUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return TG_HOME_URL;
  if (raw.startsWith("#")) return `https://web.telegram.org/a/${raw}`;
  if (isTelegramChatUrl(raw)) return raw;
  if (/^-?\d+$/.test(raw)) return `https://web.telegram.org/a/#${raw}`;
  return raw;
}

function scheduleMonitorAlarm(config) {
  chrome.alarms.clear(TG_MONITOR_ALARM);
  if (!config?.enabled) return;
  chrome.alarms.create(TG_MONITOR_ALARM, { periodInMinutes: 1 });
}

function scheduleQueueAlarm(config) {
  chrome.alarms.clear("processQueue");
  if (!config?.enabled) return;
  chrome.alarms.create("processQueue", { periodInMinutes: 0.5 });
}

function scheduleTgWakeAlarm(config) {
  chrome.alarms.clear(TG_WAKE_ALARM);
  if (!config?.enabled) return;
  chrome.alarms.create(TG_WAKE_ALARM, { when: Date.now() + TG_WAKE_INTERVAL_MS });
}

async function resolveTelegramMonitorTab(config) {
  const stored = await chrome.storage.local.get([TG_MONITOR_TAB_KEY]);
  const cachedId = stored[TG_MONITOR_TAB_KEY];
  if (cachedId) {
    try {
      const tab = await chrome.tabs.get(cachedId);
      if (tab?.id && /web\.telegram\.org/i.test(tab.url || "")) return tab.id;
    } catch {
      await chrome.storage.local.remove(TG_MONITOR_TAB_KEY);
    }
  }

  const tabs = await chrome.tabs.query({ url: ["*://web.telegram.org/*"] });
  if (!tabs.length) return null;

  const wantUrl = config?.telegramChatUrl || "";
  let hash = "";
  try {
    if (wantUrl) hash = new URL(wantUrl).hash || "";
  } catch {
    /* ignore */
  }

  const match =
    (hash && tabs.find((t) => t.url && t.url.includes(hash))) ||
    tabs.find((t) => /\/a\//i.test(t.url || "")) ||
    tabs[0];

  if (match?.id) {
    await chrome.storage.local.set({ [TG_MONITOR_TAB_KEY]: match.id });
    return match.id;
  }
  return null;
}

async function wakeTelegramMonitor(config) {
  const cfg = config || (await getConfig());
  const tabId = await resolveTelegramMonitorTab(cfg);
  if (!tabId) return false;
  await setTabUndiscardable(tabId);
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "TG_WAKE_SCAN" });
    if (res?.ok) return true;
  } catch {
    /* content script may be frozen; fall through */
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        window.dispatchEvent(new CustomEvent("tgfb-wake-scan"));
      },
    });
    return true;
  } catch {
    return false;
  }
}

async function keepWatchTabsAlive(config) {
  const cfg = config || (await getConfig());
  if (!cfg?.enabled) return;
  await wakeTelegramMonitor(cfg);
}

async function runBackgroundWatch() {
  const config = await getConfig();
  if (!config.enabled) return;
  scheduleTgWakeAlarm(config);
  await keepWatchTabsAlive(config);
  await prewarmFacebookTabs(config).catch(() => {});
  await processQueue();
}

async function openTelegramTab(overrideUrl) {
  const config = await getConfig();
  let candidate = normalizeTelegramOpenUrl(overrideUrl || "");
  if (!candidate || !isValidTelegramChatUrl(candidate)) {
    candidate =
      config.telegramChatUrl && isValidTelegramChatUrl(config.telegramChatUrl)
        ? config.telegramChatUrl
        : TG_HOME_URL;
  }
  const url = candidate;
  if (isValidTelegramChatUrl(url)) {
    await saveConfig({ telegramChatUrl: url }).then((r) => r.config);
  }

  const stored = await chrome.storage.local.get([TG_MONITOR_TAB_KEY]);
  if (stored[TG_MONITOR_TAB_KEY]) {
    try {
      const tab = await chrome.tabs.get(stored[TG_MONITOR_TAB_KEY]);
      await chrome.tabs.update(tab.id, { url, active: true });
      await setTabUndiscardable(tab.id);
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "TG_RELOAD_CONFIG" });
      } catch {
        /* content script loads on navigation */
      }
      return { tabId: tab.id, created: false };
    } catch {
      await chrome.storage.local.remove(TG_MONITOR_TAB_KEY);
    }
  }

  const tab = await chrome.tabs.create({ url, active: true });
  await chrome.storage.local.set({ [TG_MONITOR_TAB_KEY]: tab.id });
  await setTabUndiscardable(tab.id);
  return { tabId: tab.id, created: true };
}

async function setTabUndiscardable(tabId) {
  try {
    await chrome.tabs.update(tabId, { autoDiscardable: false });
  } catch {
    // older chrome may not support
  }
}

function waitForTabComplete(tabId, maxMs = 15000) {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, maxMs);
    function listener(id, info) {
      if (id !== tabId || info.status !== "complete") return;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timeout);
      setTimeout(resolve, 120);
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, (tab) => {
      if (tab?.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeout);
        setTimeout(resolve, 120);
      }
    });
  });
}

async function dequeueAndContinue() {
  processing = false;
  await processQueue();
}

async function markQueueItemFailed(jobId, error) {
  const data = await chrome.storage.local.get([QUEUE_KEY]);
  const queue = data[QUEUE_KEY] || [];
  const job = queue.find((j) => j.id === jobId);
  if (job) job.lastError = error;
  await chrome.storage.local.set({ [QUEUE_KEY]: queue });
  const errText = error || "未知错误";
  await setForwardStatus(`转发失败：${truncate(errText, 80)}`, "err");
  notify(`转发失败：${truncate(errText, 60)}`, true);
}

function notify(message, isError) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: isError ? "TG→FB 转发失败" : "TG→FB 已转发",
    message,
  });
}

function truncate(s, n) {
  const t = String(s || "");
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}

getConfig().then((cfg) => {
  scheduleSheetsAlarm(cfg);
  scheduleMonitorAlarm(cfg);
  scheduleQueueAlarm(cfg);
  scheduleTgWakeAlarm(cfg);
  if (cfg.enabled) runBackgroundWatch().catch(() => {});
  if (cfg.sheetsUrl) refreshSheetsRules().catch(() => {});
});
