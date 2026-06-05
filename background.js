importScripts("filter.js", "image-dedupe.js", "fb-api-send.js");

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
const claimedMessageIds = new Set();
const TG_MONITOR_TAB_KEY = "tgMonitorTabId";
const FB_WORKER_TAB_KEY = "fbWorkerTabId";
const FB_WORKER_URL = "https://www.facebook.com/messages/";
const FB_WORKER_ALT_URL = "https://www.facebook.com/";
const FB_TAB_QUERY_URLS = ["*://*.facebook.com/*", "*://facebook.com/*"];
const FB_DELIVERY_LOCKS_KEY = "fbDeliveryLocks";
const FB_DELIVERY_TTL_MS = 3 * 60 * 1000;
const fbSendInFlight = new Set();
const fbTabSendQueues = new Map();
const TG_MONITOR_ALARM = "tgMonitor";
const TG_HOME_URL = "https://web.telegram.org/a/";
let processing = false;
const fbTabCache = new Map();
const fbContentInjected = new Set();
const MAX_QUEUE_FAILURES = 6;
const MAX_FB_TARGETS = 10;
const MAX_TARGET_FAILURES = 3;
const INTER_GROUP_SEND_DELAY_MS = 450;

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(["config"], (data) => {
    if (!data.config) chrome.storage.local.set({ config: DEFAULT_CONFIG });
  });
  chrome.storage.local.remove(FB_WORKER_TAB_KEY);
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

  return false;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "refreshSheets") refreshSheetsRules().catch(() => {});
  if (alarm.name === "processQueue") processQueue().catch(() => {});
  if (alarm.name === TG_MONITOR_ALARM) runBackgroundWatch().catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  fbContentInjected.delete(tabId);
  for (const [threadId, cachedId] of fbTabCache.entries()) {
    if (cachedId === tabId) fbTabCache.delete(threadId);
  }
  chrome.storage.local.get([TG_MONITOR_TAB_KEY, FB_WORKER_TAB_KEY], (data) => {
    const removeKeys = [];
    if (data[TG_MONITOR_TAB_KEY] === tabId) removeKeys.push(TG_MONITOR_TAB_KEY);
    if (data[FB_WORKER_TAB_KEY] === tabId) removeKeys.push(FB_WORKER_TAB_KEY);
    if (removeKeys.length) chrome.storage.local.remove(removeKeys);
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.config) return;
  const cfg = changes.config.newValue;
  scheduleSheetsAlarm(cfg);
  scheduleMonitorAlarm(cfg);
  scheduleQueueAlarm(cfg);
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

function isValidTelegramChatUrl(url) {
  if (!isTelegramChatUrl(url)) return false;
  const m = String(url).match(/#(.+)$/);
  if (!m) return false;
  const id = decodeURIComponent(m[1]).replace(/[^\d-@a-zA-Z_]/g, "");
  if (!id || /^-?0+$/.test(id)) return false;
  return true;
}

async function injectFacebookContent(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "TGFB_PING" });
    if (res?.ok) {
      fbContentInjected.add(tabId);
      return;
    }
  } catch {
    /* script not ready */
  }
  if (fbContentInjected.has(tabId)) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["facebook-content.js"],
    });
  } catch {
    /* manifest content_scripts may already be present */
  }
  fbContentInjected.add(tabId);
}

function isFacebookTabUrl(url) {
  return isInjectableFacebookUrl(url) && !String(url).includes("/login");
}

function isMessengerSendTabUrl(url) {
  return (
    isInjectableFacebookUrl(url) &&
    !String(url).includes("/login") &&
    /facebook\.com\/messages/i.test(url)
  );
}

function isInjectableFacebookUrl(url) {
  if (!url || /^(about:|chrome:|edge:|devtools:)/i.test(url)) return false;
  if (/messenger\.com/i.test(url)) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "facebook.com" || host === "www.facebook.com" || host.endsWith(".facebook.com");
  } catch {
    return false;
  }
}

async function getTabUrlSafe(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab?.url || "";
  } catch {
    return "";
  }
}

async function safeExecuteScript(details) {
  try {
    return await chrome.scripting.executeScript(details);
  } catch (err) {
    const msg = String(err?.message || err);
    if (/cannot access contents|extension manifest must request permission/i.test(msg)) {
      throw new Error("无法访问 Facebook 页面：请用 Chrome 打开 facebook.com 登录（勿用 messenger.com）");
    }
    throw err;
  }
}

async function ensureInjectableFacebookTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab?.id) throw new Error("FB 标签无效");
  if (isInjectableFacebookUrl(tab.url)) return tab.id;

  await chrome.tabs.update(tab.id, { url: FB_WORKER_URL, active: false });
  await waitForTabComplete(tab.id, 22000);
  const url = await getTabUrlSafe(tab.id);
  if (!isInjectableFacebookUrl(url)) {
    throw new Error("Facebook 页面无法加载，请手动打开 facebook.com 并保持登录");
  }
  return tab.id;
}

async function prepareTabForMessengerSend(tabId) {
  return ensureInjectableFacebookTab(tabId);
}

async function findExistingFbThreadTab(threadId) {
  if (!threadId) return null;
  const tabs = await chrome.tabs.query({ url: FB_TAB_QUERY_URLS });
  return (
    tabs.find(
      (t) =>
        t.id &&
        t.url &&
        (t.url.includes(`/messages/t/${threadId}`) || t.url.includes(`/t/${threadId}`))
    ) || null
  );
}

async function findAnyFacebookTab() {
  const tabs = await chrome.tabs.query({ url: FB_TAB_QUERY_URLS });
  const sorted = tabs
    .filter((t) => isFacebookTabUrl(t.url))
    .sort((a, b) => {
      const score = (t) =>
        (isMessengerSendTabUrl(t.url) ? 4 : 0) +
        (t.url?.includes("facebook.com/messages") ? 2 : 0) +
        (t.active ? 1 : 0);
      return score(b) - score(a);
    });
  return sorted[0] || null;
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

async function probePageDtsg(tabId) {
  const url = await getTabUrlSafe(tabId);
  if (!isInjectableFacebookUrl(url)) return { dtsg: false, href: url };

  try {
    const [{ result }] = await safeExecuteScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      function pick(html) {
        const patterns = [
          /"DTSGInitialData",\[\],\{"token":"([^"]+)"/,
          /"DTSGInitData",\[\],\{"token":"([^"]+)"/,
          /"dtsg":\{"token":"([^"]+)"/,
          /name="fb_dtsg"\s+value="([^"]+)"/,
        ];
        for (const re of patterns) {
          const m = html.match(re);
          if (m?.[1]) return m[1];
        }
        return "";
      }
      let dtsg = pick(document.documentElement.innerHTML);
      if (!dtsg) {
        try {
          if (typeof require === "function") {
            const mod = require("DTSGInitData") || require("DTSG");
            if (mod?.token) dtsg = mod.token;
          }
        } catch {
          /* ignore */
        }
      }
      return { dtsg: !!dtsg, href: location.href };
    },
    });
    return result || { dtsg: false };
  } catch {
    return { dtsg: false, href: url };
  }
}

async function waitForPageDtsg(tabId, maxMs = 14000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const probe = await probePageDtsg(tabId);
    if (probe.dtsg) return true;
    await sleep(500);
  }
  return false;
}

async function openWorkerTab(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  await setTabUndiscardable(tab.id);
  await waitForTabComplete(tab.id, 22000);
  await sleep(1000);
  await chrome.storage.local.set({ [FB_WORKER_TAB_KEY]: tab.id });
  return tab.id;
}

async function ensureFacebookWorkerTab() {
  const loggedIn = await hasFacebookLoginCookie();
  if (!loggedIn) {
    throw new Error("Chrome 未检测到 FB 登录 Cookie：请用同一浏览器打开 facebook.com 登录一次");
  }

  const stored = await chrome.storage.local.get([FB_WORKER_TAB_KEY]);
  const cachedId = stored[FB_WORKER_TAB_KEY];
  if (cachedId) {
    try {
      const tab = await chrome.tabs.get(cachedId);
      if (tab?.id) {
        if (!isInjectableFacebookUrl(tab.url)) {
          await chrome.storage.local.remove(FB_WORKER_TAB_KEY);
          try {
            await chrome.tabs.update(tab.id, { url: FB_WORKER_URL, active: false });
            await waitForTabComplete(tab.id, 22000);
            if (await waitForPageDtsg(tab.id, 12000)) {
              await chrome.storage.local.set({ [FB_WORKER_TAB_KEY]: tab.id });
              return tab.id;
            }
          } catch {
            /* fall through */
          }
        } else if (isFacebookTabUrl(tab.url)) {
          await setTabUndiscardable(tab.id);
          if (await waitForPageDtsg(tab.id, 6000)) return tab.id;
          await chrome.tabs.reload(tab.id);
          await waitForTabComplete(tab.id, 20000);
          if (await waitForPageDtsg(tab.id, 12000)) return tab.id;
        }
      }
    } catch {
      await chrome.storage.local.remove(FB_WORKER_TAB_KEY);
    }
  }

  const existing = await findAnyFacebookTab();
  if (existing?.id) {
    await setTabUndiscardable(existing.id);
    await chrome.storage.local.set({ [FB_WORKER_TAB_KEY]: existing.id });
    if (await waitForPageDtsg(existing.id, 8000)) return existing.id;
    await chrome.tabs.reload(existing.id);
    await waitForTabComplete(existing.id, 20000);
    if (await waitForPageDtsg(existing.id, 12000)) return existing.id;
  }

  let tabId = await openWorkerTab(FB_WORKER_URL);
  if (await waitForPageDtsg(tabId, 12000)) return tabId;

  tabId = await openWorkerTab(FB_WORKER_ALT_URL);
  if (await waitForPageDtsg(tabId, 12000)) return tabId;

  throw new Error("已登录 FB，但会话未就绪：请手动打开 facebook.com/messages 按 F5 刷新后再试");
}

async function sendViaPageContext(tabId, threadId, job) {
  tabId = await prepareTabForMessengerSend(tabId);
  if (!(await waitForPageDtsg(tabId, 8000))) {
    await chrome.tabs.reload(tabId);
    await waitForTabComplete(tabId, 18000);
    if (!(await waitForPageDtsg(tabId, 10000))) {
      throw new Error("FB 页面会话未就绪，请打开 facebook.com/messages 刷新后重试");
    }
  }

  const results = await safeExecuteScript({
    target: { tabId },
    world: "MAIN",
    func: TgFbApiSend.pageContextSendMessenger,
    args: [threadId, job.text || "", (job.imageDataUrls || []).slice(0, 3)],
  });
  const result = results?.[0]?.result;
  if (result === undefined || result === null) {
    throw new Error("页面脚本无响应，将改用后台 API");
  }
  if (!result?.ok) throw new Error(result?.error || "页面内发送失败");
  return result;
}

async function prewarmFacebookTabs(config) {
  const targets = getFbTargets(config);
  if (!targets.length) return;
  try {
    const loggedIn = await hasFacebookLoginCookie();
    if (!loggedIn) {
      await setForwardStatus("未检测到 FB 登录：请用 Chrome 打开 facebook.com 登录", "err");
      return;
    }
    let ready = 0;
    await Promise.all(
      targets.map(async (target) => {
        const tab = await findExistingFbThreadTab(target.threadId);
        if (tab?.id && tab.url?.includes(`/messages/t/${target.threadId}`)) {
          ready++;
          await injectFacebookContent(tab.id);
        }
      })
    );
    if (ready === targets.length) {
      await setForwardStatus(`已检测到 ${ready} 个 FB 群聊页，可以转发`, "ok");
    } else if (ready > 0) {
      await setForwardStatus(
        `已检测到 ${ready}/${targets.length} 个群页，请手动打开其余 FB 群聊页`,
        "info"
      );
    } else {
      await setForwardStatus("请手动打开 FB 群聊页（messages/t/数字）后再转发", "info");
    }
  } catch (err) {
    await setForwardStatus(err.message || "FB 群页检查失败", "err");
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

function fbThreadOpenHint(threadId) {
  return `https://www.facebook.com/messages/t/${threadId}`;
}

async function ensureFbThreadTab(threadId, manual = false) {
  const tid = String(threadId || "").trim();
  if (!tid) throw new Error("无效的 FB 群 ID");

  const existing = await findExistingFbThreadTab(tid);
  if (!existing?.id) {
    throw new Error(`请手动打开 FB 群聊页：${fbThreadOpenHint(tid)}`);
  }
  if (!existing.url?.includes(`/messages/t/${tid}`)) {
    throw new Error(`当前 FB 标签不是该群，请打开：${fbThreadOpenHint(tid)}`);
  }

  await setTabUndiscardable(existing.id);
  let coldStart = false;
  if (existing.status !== "complete") {
    await waitForTabComplete(existing.id, manual ? 6000 : 28000);
    if (!manual) await sleep(600);
    coldStart = !manual;
  }
  try {
    await injectFacebookContent(existing.id);
  } catch {
    if (!manual) throw new Error("无法注入 FB 页面脚本，请刷新群聊页后重试");
  }
  return { tabId: existing.id, coldStart };
}

async function forwardManualJob(job) {
  const targets = job.fbTargets || [];
  if (!targets.length) throw new Error("未配置 FB 群");

  const hasImages = (job.imageDataUrls?.length || 0) > 0;
  setForwardStatus(`手动转发到 ${targets.length} 个群…`, "info");

  const prepared = await Promise.all(
    targets.map(async (target) => {
      const { tabId } = await ensureFbThreadTab(target.threadId, true);
      if (hasImages) await clearFbSentFlag(tabId, job.messageId);
      return { target, tabId };
    })
  );

  const results = await Promise.allSettled(
    prepared.map(({ target, tabId }) =>
      sendJobToFacebook(
        {
          ...job,
          preparedTabId: tabId,
          skipPreSentCheck: !hasImages,
        },
        target
      )
    )
  );

  let ok = 0;
  const errors = [];
  for (const r of results) {
    if (r.status === "fulfilled" && r.value?.ok) ok++;
    else errors.push(r.status === "rejected" ? r.reason?.message : r.value?.error || "发送失败");
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
    let tabId = job.preparedTabId;
    let coldStart = false;
    if (!tabId) {
      const prep = await ensureFbThreadTab(target.threadId, job.manual);
      tabId = prep.tabId;
      coldStart = prep.coldStart;
      if (job.manual && !job.skipPreSentCheck) await clearFbSentFlag(tabId, job.messageId);
    }
    const res = await sendToFacebookTab(tabId, {
      ...job,
      coldStart: job.manual ? false : coldStart,
    });
    if (res?.ok) {
      if (!job.manual) await markDelivered(lockKey);
      return { ...res, mode: "composer-tab" };
    }
    throw new Error(res?.error || "群聊页发送失败");
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

async function clearFbSentFlag(tabId, messageId) {
  if (!tabId || !messageId) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (mid) => {
        const m = location.pathname.match(/\/messages\/t\/(\d+)/i);
        const tid = m?.[1] || "";
        sessionStorage.removeItem(tid ? `tgfb_sent_${tid}_${mid}` : `tgfb_sent_${mid}`);
      },
      args: [String(messageId)],
    });
  } catch {
    /* ignore */
  }
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
    imageUrls: [],
    imageDataUrls,
    imageStashKey: payload.imageStashKey || null,
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
  let imageDataUrls = await resolvePayloadImages(payload);
  const urlFallback = TgFbImageDedupe.dedupeImageRefs(payload.imageUrls || [], 5);
  const slotCount = Math.min(5, Math.max(1, Number(albumSlots) || 1));
  const fetchTimeout = manual ? Math.min(15000, 2000 + slotCount * 2000) : Math.min(22000, 4000 + slotCount * 3500);

  if (!imageDataUrls.length && urlFallback.length) {
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

    await setForwardStatus(`正在向 FB 群 ${target.threadId} 发送（群聊页）…`, "info");
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
        await clearImageStash(job.imageStashKey);
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
        await sleep(INTER_GROUP_SEND_DELAY_MS);
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
            await clearImageStash(j.imageStashKey);
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
      await sleep(INTER_GROUP_SEND_DELAY_MS);
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

async function isFbManualJobAlreadySent(tabId, jobId) {
  if (!tabId || !jobId) return false;
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (jid) => {
        const m = location.pathname.match(/\/messages\/t\/(\d+)/i);
        const tid = m?.[1] || "";
        const guard = tid ? `${tid}::${jid}` : String(jid);
        return !!sessionStorage.getItem(`tgfb_manual_done_${guard}`);
      },
      args: [String(jobId)],
    });
    return !!result;
  } catch {
    return false;
  }
}

async function isFbMessageAlreadySent(tabId, messageId) {
  if (!tabId || !messageId) return false;
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (mid) => {
        const m = location.pathname.match(/\/messages\/t\/(\d+)/i);
        const tid = m?.[1] || "";
        const key = tid ? `tgfb_sent_${tid}_${mid}` : `tgfb_sent_${mid}`;
        return !!sessionStorage.getItem(key);
      },
      args: [String(messageId)],
    });
    return !!result;
  } catch {
    return false;
  }
}

function runInFbTabQueue(tabId, fn) {
  const key = String(tabId);
  const prev = fbTabSendQueues.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(() => fn());
  fbTabSendQueues.set(
    key,
    run.catch(() => {})
  );
  return run;
}

async function sendToFacebookTabImpl(tabId, job) {
  if (!job.skipPreSentCheck && (await isFbMessageAlreadySent(tabId, job.messageId))) {
    return { ok: true, alreadySent: true };
  }

  let lastErr = null;
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "FORWARD_TO_FB", job });
    if (res?.ok) return res;
    lastErr = new Error(res?.error || "Facebook 页面发送失败");
  } catch (e) {
    lastErr = e;
    try {
      await injectFacebookContent(tabId);
      await sleep(job.manual ? 80 : 400);
      if (await isFbMessageAlreadySent(tabId, job.messageId)) {
        return { ok: true, alreadySent: true };
      }
      if (job.manual && (await isFbManualJobAlreadySent(tabId, job.id))) {
        return { ok: true, alreadySent: true };
      }
      const res = await chrome.tabs.sendMessage(tabId, { type: "FORWARD_TO_FB", job });
      if (res?.ok) return res;
      lastErr = new Error(res?.error || "Facebook 页面发送失败");
    } catch (e2) {
      lastErr = e2;
    }
  }

  if (!job.skipPreSentCheck && (await isFbMessageAlreadySent(tabId, job.messageId))) {
    return { ok: true, alreadySent: true };
  }
  throw lastErr || new Error("无法连接 Facebook 标签页");
}

async function sendToFacebookTab(tabId, job) {
  return runInFbTabQueue(tabId, () => sendToFacebookTabImpl(tabId, job));
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

async function runBackgroundWatch() {
  const config = await getConfig();
  if (!config.enabled) return;
  if (config.fbThreadUrls?.length) {
    prewarmFacebookTabs(config).catch(() => {});
  }
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
  if (cfg.enabled) runBackgroundWatch().catch(() => {});
  if (cfg.sheetsUrl) refreshSheetsRules().catch(() => {});
});
