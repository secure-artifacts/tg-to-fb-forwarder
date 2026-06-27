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
const TG_WAKE_INTERVAL_MS =
  (typeof TgFbConfig !== "undefined" && TgFbConfig.TG_WAKE_INTERVAL_MS) || 60000;
const TG_HOME_URL = "https://web.telegram.org/a/";
let processing = false;
const MAX_QUEUE_FAILURES = 6;
const MAX_FB_TARGETS = 10;
const MAX_TARGET_FAILURES = 3;
const INTER_GROUP_SEND_DELAY_MS = 2000;
const INTER_GROUP_AUTO_DELAY_MS = 400;

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(["config"], (data) => {
    if (!data.config) chrome.storage.local.set({ config: DEFAULT_CONFIG });
  });
  purgeOrphanImageStashes().catch(() => {});
});

function isTrustedTelegramSender(sender) {
  try {
    const url = String(sender?.tab?.url || sender?.url || "");
    return /https:\/\/web\.telegram\.org/i.test(url);
  } catch {
    return false;
  }
}

function isTrustedExtensionSender(sender) {
  return !!sender?.id && sender.id === chrome.runtime.id && !sender?.tab;
}

function assertTelegramSender(sender) {
  if (!isTrustedTelegramSender(sender)) {
    throw new Error("未授权：仅接受来自 web.telegram.org 的请求");
  }
}

function assertExtensionOrTelegramSender(sender) {
  if (isTrustedExtensionSender(sender) || isTrustedTelegramSender(sender)) return;
  throw new Error("未授权的消息来源");
}

function classifyForwardError(errText) {
  const msg = String(errText || "").toLowerCase();
  if (/checkpoint|安全验证|captcha|验证/.test(msg)) return "checkpoint";
  if (/登录|login|cookie|未检测到 fb|会话|dtsg/.test(msg)) return "login";
  if (/超时|timeout|网络|connect|fetch|无法连接/.test(msg)) return "network";
  if (/限流|rate|too many|spam|blocked|频率/.test(msg)) return "rate_limit";
  if (/http\s*\d|graphql|mercury|api|发送失败|上传/.test(msg)) return "api";
  return "unknown";
}

function sanitizeForwardPayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("无效的消息载荷");
  }
  const messageId = String(payload.messageId || "").trim();
  if (!messageId || messageId.length > 128) {
    throw new Error("无效的消息 ID");
  }
  const maxText = TgFbConfig?.MAX_FORWARD_TEXT_LENGTH || 12000;
  const text = String(payload.text || "").slice(0, maxText);
  return { ...payload, messageId, text };
}

function serializeQueueForStorage(queue) {
  return (queue || []).slice(-200).map((job) => {
    const copy = { ...job };
    delete copy._imagesResolved;
    copy.imageDataUrls = [];
    return copy;
  });
}

async function persistQueue(queue) {
  await chrome.storage.local.set({ [QUEUE_KEY]: serializeQueueForStorage(queue) });
}

async function purgeOrphanImageStashes() {
  try {
    const data = await chrome.storage.local.get(null);
    const keys = Object.keys(data || {}).filter((k) => k.startsWith(IMAGE_STASH_PREFIX));
    if (keys.length) await chrome.storage.local.remove(keys);
  } catch {
    /* ignore */
  }
}

async function ensureJobImagesResolved(job, manual = false) {
  if (job._imagesResolved && job.imageDataUrls?.length) return job.imageDataUrls;
  const needsImages =
    job.hasImages || job.mediaShell || (job.imageUrls && job.imageUrls.length > 0);
  if (!needsImages) {
    job.imageDataUrls = [];
    job._imagesResolved = true;
    return [];
  }
  job.imageDataUrls = await resolveJobImages(
    {
      messageId: job.messageId,
      imageUrls: job.imageUrls || [],
      hasImages: job.hasImages,
      mediaShell: job.mediaShell,
      isSticker: job.isSticker,
      imageStashKey: null,
      imageDataUrls: [],
    },
    job.albumSlots || 1,
    manual
  );
  job._imagesResolved = true;
  return job.imageDataUrls;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message?.type;

  if (type === "GET_CONFIG") {
    try {
      assertExtensionOrTelegramSender(sender);
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
      return false;
    }
    getConfig().then((config) => sendResponse({ ok: true, config }));
    return true;
  }

  if (type === "SAVE_CONFIG") {
    try {
      assertTelegramSender(sender);
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
      return false;
    }
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
    try {
      assertTelegramSender(sender);
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
      return false;
    }
    refreshSheetsRules()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (type === "TEST_FILTER") {
    try {
      assertTelegramSender(sender);
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
      return false;
    }
    getConfig().then((config) => {
      const hit = TgFbFilter.shouldFilterMessage(message.text || "", config.filterRules, {
        mode: config.filterMode,
      });
      sendResponse({ ok: true, filtered: hit });
    });
    return true;
  }

  if (type === "NEW_TG_MESSAGE") {
    try {
      assertTelegramSender(sender);
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
      return false;
    }
    handleNewTelegramMessage(sanitizeForwardPayload(message.payload))
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (type === "OPEN_TG_TAB") {
    if (!isTrustedExtensionSender(sender)) {
      sendResponse({ ok: false, error: "未授权" });
      return false;
    }
    openTelegramTab(message.url)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (type === "TG_REGISTER_TAB") {
    try {
      assertTelegramSender(sender);
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
      return false;
    }
    const tabId = sender?.tab?.id;
    if (tabId) {
      chrome.storage.local.set({ [TG_MONITOR_TAB_KEY]: tabId });
      setTabUndiscardable(tabId).catch(() => {});
    }
    sendResponse({ ok: true, tabId });
    return false;
  }

  if (type === "GET_FORWARD_LOG") {
    if (!isTrustedExtensionSender(sender)) {
      sendResponse({ ok: false, error: "未授权" });
      return false;
    }
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
  await chrome.storage.local.set({ config: next });
  return { config: next, invalidFbUrls, truncatedFbUrls };
}

async function setForwardStatus(text, level = "info") {
  await chrome.storage.local.set({ [FORWARD_STATUS_KEY]: { text, level, at: Date.now() } });
}

async function getForwardLog() {
  const data = await chrome.storage.local.get([FORWARD_LOG_KEY]);
  return data[FORWARD_LOG_KEY] || [];
}

async function addForwardLog(entry) {
  const max = TgFbConfig?.MAX_FORWARD_LOG || 50;
  const data = await chrome.storage.local.get([FORWARD_LOG_KEY]);
  const log = data[FORWARD_LOG_KEY] || [];
  log.unshift({ ...entry, at: Date.now() });
  await chrome.storage.local.set({ [FORWARD_LOG_KEY]: log.slice(0, max) });
}

async function releaseForwardClaim(messageId) {
  claimedMessageIds.delete(String(messageId));
}

async function handleNewTelegramMessage(payload) {
  const config = await getConfig();
  if (!config.enabled) return { skipped: true, reason: "未启用转发" };

  const { messageId, text, manual } = payload;
  const data = await chrome.storage.local.get([FORWARDED_IDS_KEY, QUEUE_KEY]);
  const forwarded = new Set(data[FORWARDED_IDS_KEY] || []);
  const queue = data[QUEUE_KEY] || [];

  if (forwarded.has(messageId)) return { skipped: true, reason: "已转发过" };
  if (queue.some((j) => j.messageId === messageId)) return { skipped: true, reason: "队列中已存在" };

  const targets = getFbTargets(config);
  if (!targets.length) return { skipped: true, reason: "未设置 FB 群" };

  const job = {
    id: `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    messageId,
    text,
    manual,
    fbTargets: targets,
    completedTargetIds: [],
    failedTargetIds: [],
    failures: 0,
    retryAt: 0,
    state: "pending",
    at: Date.now(),
    hasImages: !!payload.hasImages,
    imageUrls: payload.imageUrls || [],
    mediaShell: !!payload.mediaShell,
    isSticker: !!payload.isSticker,
    albumSlots: payload.albumSlots || 1,
  };

  queue.push(job);
  await persistQueue(queue);
  processQueue().catch(() => {});
  return { ok: true, jobId: job.id };
}

function isJobPending(j) {
  if (j.done || j.state === "completed") return false;
  if ((j.failures || 0) >= MAX_QUEUE_FAILURES) return false;
  return Date.now() >= (j.retryAt || 0);
}

function isJobComplete(j) {
  const total = (j.fbTargets || []).length;
  const done = (j.completedTargetIds || []).length;
  const failed = (j.failedTargetIds || []).length;
  return done + failed >= total;
}

async function processQueue() {
  if (processing) return;
  const config = await getConfig();
  if (!config.enabled) return;

  processing = true;
  try {
    const data = await chrome.storage.local.get([QUEUE_KEY]);
    const queue = data[QUEUE_KEY] || [];
    const job = queue.find((j) => isJobPending(j));
    if (!job) return;

    if (!job.fbTargets?.length) {
      job.fbTargets = getFbTargets(config);
      if (!job.fbTargets.length) {
        job.done = true;
        await persistQueue(queue);
        return;
      }
      job.completedTargetIds = job.completedTargetIds || [];
      await persistQueue(queue);
    }

    await ensureJobImagesResolved(job, false);
    if (!String(job.text || "").trim() && !job.imageDataUrls?.length) {
      job.done = true;
      job.state = "empty";
      await releaseForwardClaim(job.messageId);
      await persistQueue(queue);
      return;
    }

    const pendingTargets = job.fbTargets.filter(t => 
      !(job.completedTargetIds || []).includes(t.threadId) && 
      !(job.failedTargetIds || []).includes(t.threadId)
    );

    if (pendingTargets.length === 0) {
      job.done = true;
      await persistQueue(queue);
      return;
    }

    const sendPromises = pendingTargets.map(async (target, index) => {
      await sleep(index * INTER_GROUP_AUTO_DELAY_MS);
      try {
        await setForwardStatus(`正在向 FB 群 ${target.threadId} 发送…`, "info");
        const response = await sendJobToFacebook(job, target);
        if (response?.ok) {
          if (!job.completedTargetIds.includes(target.threadId)) {
            job.completedTargetIds.push(target.threadId);
          }
          job.failures = 0;
          job.retryAt = 0;
        } else {
          throw new Error(response?.error || "发送失败");
        }
      } catch (err) {
        const tid = String(target.threadId);
        job.targetFailures = job.targetFailures || {};
        job.targetFailures[tid] = (job.targetFailures[tid] || 0) + 1;
        if (job.targetFailures[tid] >= MAX_TARGET_FAILURES) {
          if (!job.failedTargetIds.includes(tid)) job.failedTargetIds.push(tid);
        } else {
          job.retryAt = Date.now() + 1000;
        }
      }
      await persistQueue(queue);
    });

    await Promise.all(sendPromises);

    if (isJobComplete(job)) {
      job.done = true;
      job.state = "completed";
      const doneCount = (job.completedTargetIds || []).length;
      const total = job.fbTargets.length;
      const failCount = (job.failedTargetIds || []).length;
      
      notify(failCount ? `已转发 ${doneCount}/${total} 个群` : `已转发到 ${total} 个群`);
      await setForwardStatus(
        failCount ? `完成：成功 ${doneCount}，跳过 ${failCount}` : `已全部转发到 ${total} 个群`,
        failCount ? "info" : "ok"
      );
      
      const data2 = await chrome.storage.local.get([FORWARDED_IDS_KEY]);
      const forwarded = data2[FORWARDED_IDS_KEY] || [];
      forwarded.push(job.messageId);
      await chrome.storage.local.set({ [FORWARDED_IDS_KEY]: forwarded.slice(-1000) });
      await persistQueue(queue);
    }
  } catch (err) {
    console.error("[tg-to-fb] processQueue error:", err);
  } finally {
    processing = false;
    const cfg = await getConfig();
    if (!cfg.enabled) return;
    const data = await chrome.storage.local.get([QUEUE_KEY]);
    const pending = (data[QUEUE_KEY] || []).some((j) => isJobPending(j));
    if (pending) {
      const next = (data[QUEUE_KEY] || []).find((j) => isJobPending(j));
      const delay = next?.retryAt ? Math.max(100, next.retryAt - Date.now()) : 200;
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
    return hash.length > 2 && (hash.startsWith("#-") || hash.startsWith("#@"));
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
  if (config.enabled) chrome.alarms.create(TG_MONITOR_ALARM, { periodInMinutes: 1 });
}

function scheduleQueueAlarm(config) {
  chrome.alarms.clear("processQueue");
  if (config.enabled) chrome.alarms.create("processQueue", { periodInMinutes: 0.5 });
}

function scheduleTgWakeAlarm(config) {
  chrome.alarms.clear(TG_WAKE_ALARM);
  if (config.enabled) chrome.alarms.create(TG_WAKE_ALARM, { periodInMinutes: TG_WAKE_INTERVAL_MS / 60000 });
}

function scheduleSheetsAlarm(config) {
  chrome.alarms.clear("refreshSheets");
  if (config.enabled && config.sheetsUrl && config.sheetsRefreshMinutes > 0) {
    chrome.alarms.create("refreshSheets", { periodInMinutes: config.sheetsRefreshMinutes });
  }
}

async function runBackgroundWatch() {
  const config = await getConfig();
  if (!config.enabled) return;
  const tabId = await getTgMonitorTabId();
  if (!tabId) {
    await openTelegramTab(config.telegramChatUrl || TG_HOME_URL);
  } else {
    chrome.tabs.sendMessage(tabId, { type: "TG_WAKE_SCAN" }, () => void chrome.runtime.lastError);
  }
  await processQueue();
}

async function getTgMonitorTabId() {
  const data = await chrome.storage.local.get([TG_MONITOR_TAB_KEY]);
  const id = data[TG_MONITOR_TAB_KEY];
  if (!id) return null;
  try {
    const tab = await chrome.tabs.get(id);
    return tab ? id : null;
  } catch {
    return null;
  }
}

async function openTelegramTab(url) {
  const target = normalizeTelegramOpenUrl(url);
  const tab = await chrome.tabs.create({ url: target, active: false });
  if (tab.id) {
    await chrome.storage.local.set({ [TG_MONITOR_TAB_KEY]: tab.id });
    await setTabUndiscardable(tab.id);
  }
  return { tabId: tab.id };
}

async function setTabUndiscardable(tabId) {
  try {
    if (chrome.tabs.update) await chrome.tabs.update(tabId, { autoDiscardable: false });
  } catch { /* ignore */ }
}

async function keepWatchTabsAlive(config) {
  const tabId = await getTgMonitorTabId();
  if (tabId) chrome.tabs.sendMessage(tabId, { type: "TG_WAKE_SCAN" }, () => void chrome.runtime.lastError);
}

async function prewarmFacebookTabs(config) {}

async function sendJobToFacebook(job, target) {
  try {
    const result = await globalThis.TgFbApiSend.sendMessengerJob(target.threadId, job);
    await addForwardLog({ messageId: job.messageId, text: job.text, targetId: target.threadId, status: "ok" });
    return result;
  } catch (err) {
    const error = err.message || "未知错误";
    await addForwardLog({ messageId: job.messageId, text: job.text, targetId: target.threadId, status: "err", error });
    return { ok: false, error };
  }
}

function notify(message) {
  chrome.notifications.create({ type: "basic", iconUrl: "icons/icon48.png", title: "TG→FB 转发", message: message || "", priority: 1 });
}

async function refreshSheetsRules() {
  const config = await getConfig();
  const csvUrl = TgFbFilter.buildGoogleSheetCsvUrl(config.sheetsUrl);
  if (!csvUrl) throw new Error("Google 表格链接无效");
  const res = await fetch(csvUrl, { credentials: "omit" });
  if (!res.ok) throw new Error(`拉取表格失败 HTTP ${res.status}`);
  const csv = await res.text();
  const sheetsRules = TgFbFilter.parseRulesFromCsv(csv, config.sheetsColumn || "A");
  const manual = TgFbFilter.parseRulesFromText(config.filterRulesText);
  const next = { ...config, sheetsRules, filterRules: mergeFilterRules(manual, sheetsRules), lastSheetsFetchAt: Date.now() };
  await chrome.storage.local.set({ config: next });
  return { rulesCount: sheetsRules.length, filterRules: next.filterRules };
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

async function resolveJobImages(payload, albumSlots, manual = false) {
  if (payload.isSticker) return [];
  const urlFallback = TgFbImageDedupe.dedupeImageRefs(payload.imageUrls || [], 5);
  const slotCount = Math.min(5, Math.max(1, Number(albumSlots) || 1));
  const cfg = TgFbConfig || {};
  const fetchTimeout = manual
    ? Math.min(15000, (cfg.MANUAL_IMAGE_FETCH_TIMEOUT_BASE_MS || 2000) + slotCount * (cfg.MANUAL_IMAGE_FETCH_TIMEOUT_PER_SLOT_MS || 2000))
    : Math.min(22000, (cfg.IMAGE_FETCH_TIMEOUT_BASE_MS || 4000) + slotCount * (cfg.IMAGE_FETCH_TIMEOUT_PER_SLOT_MS || 3500));
  let imageDataUrls = [];
  if (urlFallback.length) {
    imageDataUrls = await Promise.race([fetchImagesInTelegramTab(urlFallback), sleep(fetchTimeout).then(() => [])]);
  }
  if (!imageDataUrls.length && (payload.mediaShell || payload.hasImages)) {
    imageDataUrls = await Promise.race([fetchImagesFromMessageInTelegram(payload.messageId), sleep(fetchTimeout).then(() => [])]);
  }
  return albumSlots > 1 ? TgFbImageDedupe.dedupeImageRefs(imageDataUrls, albumSlots) : TgFbImageDedupe.pickSingleBestDataUrl(imageDataUrls);
}

async function fetchImagesInTelegramTab(urls) {
  const tabId = await getTgMonitorTabId();
  if (!tabId) return [];
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "TG_FETCH_IMAGES", urls }, (res) => {
      if (chrome.runtime.lastError) resolve([]);
      else resolve(res?.dataUrls || []);
    });
  });
}

async function fetchImagesFromMessageInTelegram(messageId) {
  const tabId = await getTgMonitorTabId();
  if (!tabId) return [];
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (msgId) => {
        const root = document.querySelector(`[data-message-id="${msgId}"]`) || document.querySelector(`.Message[data-id="${msgId}"]`);
        if (!root) return [];
        const candidates = [];
        root.querySelectorAll("img, canvas").forEach(node => {
          if (node.offsetParent !== null) candidates.push(node);
        });
        const out = [];
        for (const node of candidates) {
          try {
            if (node instanceof HTMLCanvasElement) out.push(node.toDataURL("image/jpeg", 0.92));
            else if (node.complete && node.naturalWidth > 0) {
              const canvas = document.createElement("canvas");
              canvas.width = node.naturalWidth;
              canvas.height = node.naturalHeight;
              canvas.getContext("2d").drawImage(node, 0, 0);
              out.push(canvas.toDataURL("image/jpeg", 0.92));
            }
          } catch { /* skip */ }
        }
        return out;
      },
      args: [messageId],
    });
    return result[0]?.result || [];
  } catch { return []; }
}
