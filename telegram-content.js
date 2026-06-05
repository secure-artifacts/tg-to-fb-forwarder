(function () {
  const BAR_ID = "tgfb-settings-bar";
  const BAR_COLLAPSED_KEY = "tgfbBarCollapsed";
  const BAR_POSITION_KEY = "tgfbBarPosition";
  const IMAGE_STASH_PREFIX = "tgfb_img_";
  const CHECK_CLASS = "tgfb-msg-check";
  const SENDER_LIST_ID = "tgfb-sender-list";
  let barResizeObserver = null;
  const seenIds = new Set();
  const forwardingIds = new Set();
  const mediaRetryScheduled = new Set();
  let config = null;
  let observer = null;
  let observedRoot = null;
  let scanTimer = null;
  let currentChatKey = "";
  let lastSummaryText = "";
  let lastForwardUiText = "";
  let chatReadyForForward = false;
  let senderSyncPausedUntil = 0;
  let checkboxDelegationBound = false;

  scheduleBarInjection();

  init().catch((err) => {
    console.error("[tg-to-fb] init failed", err);
    scheduleBarInjection();
  });

  async function init() {
    if (!chrome?.runtime?.id) {
      scheduleBarInjection();
      return;
    }
    await loadConfig();
    bindCheckboxDelegation();
    bindChatNavigation();
    await waitForTelegramShell(20000);
    scheduleBarInjection();
    onChatChanged(true).catch((err) => console.error("[tg-to-fb] onChatChanged", err));
    let statusTick = 0;
    setInterval(() => {
      if (!isTelegramStuckLoading()) {
        ensureObserver();
        runInjectPass();
      }
      if (++statusTick % 5 === 0) updateBarStatus();
    }, 2000);

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.config) {
        const prev = changes.config.oldValue || {};
        const next = changes.config.newValue || {};
        config = { ...config, ...next };
        if (!prev.enabled && next.enabled) {
          markAllVisibleMessagesSeen().then(() => {
            chatReadyForForward = true;
          });
        } else if (prev.enabled && !next.enabled) {
          chatReadyForForward = false;
        }
        syncSettingsBar();
        syncAllCheckboxes();
        updateBarStatus();
      }
      if (area === "local" && changes.forwardStatus) {
        showForwardStatus(changes.forwardStatus.newValue);
      }
    });
    loadForwardStatus();

    chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
      if (msg?.type === "TG_RELOAD_CONFIG") {
        loadConfig().then(() => {
          syncSettingsBar();
          syncAllCheckboxes();
          renderSenderPicker();
          updateBarStatus();
          sendResponse({ ok: true });
        });
        return true;
      }
      return false;
    });
  }

  function loadConfig() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "GET_CONFIG" }, (res) => {
        config = res?.config || {};
        resolve(config);
      });
    });
  }

  function saveConfig(partial) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "SAVE_CONFIG", config: partial }, (res) => {
        if (res?.config) config = res.config;
        resolve(res || { config });
      });
    });
  }

  function normalizeSenderName(name) {
    return String(name || "")
      .replace(/\u200b/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function getWatchList() {
    const raw = Array.isArray(config?.watchUserNames) && config.watchUserNames.length
      ? config.watchUserNames
      : config?.watchUserName
        ? [config.watchUserName]
        : [];
    const seen = new Set();
    const out = [];
    for (const n of raw) {
      const s = normalizeSenderName(n);
      if (!s || s === "未知" || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
    return out;
  }

  function getSenderFromControl(cb) {
    if (!(cb instanceof HTMLInputElement)) return "";
    const wrap = cb.closest(`.${CHECK_CLASS}`);
    return normalizeSenderName(cb.dataset.sender || wrap?.dataset?.sender || "");
  }

  function getWatchPeerKeys() {
    const raw = config?.watchSenderPeerKeys || [];
    return [...new Set(raw.map((s) => String(s).trim()).filter(Boolean))];
  }

  function collectPeerKeysForSender(targetName) {
    const keys = new Set();
    const ctx = { lastSender: "", lastPeerKey: "" };
    const target = normalizeSenderName(targetName);
    if (!target) return [];

    for (const raw of findMessageNodes()) {
      const msg = normalizeMessageEl(raw);
      if (isOwnMessage(msg)) {
        ctx.lastSender = "";
        ctx.lastPeerKey = "";
        continue;
      }
      const sender = normalizeSenderName(resolveMessageSender(msg, ctx) || "");
      if (sender) ctx.lastSender = sender;
      const peerKey = extractSenderPeerKey(getMessageListItem(msg));
      if (peerKey) ctx.lastPeerKey = peerKey;

      if (senderMatches(sender, [target])) {
        if (peerKey) keys.add(peerKey);
        if (ctx.lastPeerKey) keys.add(ctx.lastPeerKey);
      }
    }
    return [...keys];
  }

  function rebuildWatchPeerKeysForList(watchList) {
    const keys = new Set();
    for (const name of watchList || []) {
      for (const pk of collectPeerKeysForSender(name)) keys.add(pk);
    }
    return [...keys];
  }

  function isMessageWatched(sender, peerKey, watchList, watchPeers) {
    const peerSet = watchPeers instanceof Set ? watchPeers : new Set(watchPeers || []);
    if (sender && senderMatches(sender, watchList)) return true;
    if (peerKey && peerSet.has(peerKey)) return true;
    return false;
  }

  function syncMessageCheckboxesFromWalk(watchList, watchPeers) {
    const peerSet = new Set(watchPeers || []);
    const ctx = { lastSender: "", lastPeerKey: "" };

    for (const raw of findMessageNodes()) {
      const msg = normalizeMessageEl(raw);
      if (isOwnMessage(msg)) {
        ctx.lastSender = "";
        ctx.lastPeerKey = "";
        continue;
      }

      const sender = normalizeSenderName(resolveMessageSender(msg, ctx) || "");
      if (sender) ctx.lastSender = sender;
      const peerKey = extractSenderPeerKey(getMessageListItem(msg));
      if (peerKey) ctx.lastPeerKey = peerKey;

      const byName = sender && senderMatches(sender, watchList);
      const byPeer = peerKey && peerSet.has(peerKey);
      const byGroupPeer =
        !byName &&
        !byPeer &&
        isGroupedContinuation(msg) &&
        ctx.lastPeerKey &&
        peerSet.has(ctx.lastPeerKey) &&
        ctx.lastSender &&
        senderMatches(ctx.lastSender, watchList);
      const checked = byName || byPeer || byGroupPeer;

      const wrap = msg.querySelector(`.${CHECK_CLASS}`);
      if (!wrap) continue;

      const labelName = sender || ctx.lastSender || wrap.dataset.sender || "未知";
      if (labelName !== "未知") {
        wrap.dataset.sender = labelName;
        const cb = wrap.querySelector(".tgfb-cb");
        if (cb) {
          cb.dataset.sender = labelName;
          cb.checked = checked;
          wrap.querySelector("label")?.setAttribute("title", `勾选后自动转发「${labelName}」`);
        }
      }
    }
  }

  function bindCheckboxDelegation() {
    if (checkboxDelegationBound) return;
    checkboxDelegationBound = true;
    document.addEventListener(
      "change",
      (e) => {
        const cb = e.target;
        if (!(cb instanceof HTMLInputElement)) return;
        if (!cb.matches(".tgfb-cb, .tgfb-picker-cb")) return;
        e.stopPropagation();
        e.stopImmediatePropagation();
        const sender = getSenderFromControl(cb);
        if (!sender || sender === "未知") {
          cb.checked = false;
          return;
        }
        void toggleSender(sender, cb.checked);
      },
      true
    );
  }

  function getFbUrlsText() {
    const urls = config?.fbThreadUrls?.length
      ? config.fbThreadUrls
      : config?.fbThreadUrl
        ? [config.fbThreadUrl]
        : [];
    return urls.join("\n");
  }

  function normalizeMessageEl(el) {
    if (el.classList.contains("Message")) return el;
    return el.querySelector(".Message") || el.closest(".Message") || el;
  }

  function getMessageListItem(el) {
    const msg = normalizeMessageEl(el);
    return msg.closest(".message-list-item") || msg;
  }

  function isFirstInGroup(msg) {
    return (
      msg.classList.contains("first-in-group") ||
      msg.classList.contains("first-in-document") ||
      !!msg.querySelector(".message-subheader .sender-title, .message-subheader .message-title")
    );
  }

  function isGroupedContinuation(msg) {
    return (
      msg.classList.contains("middle-in-group") ||
      msg.classList.contains("last-in-group") ||
      (msg.classList.contains("grouped") && !isFirstInGroup(msg))
    );
  }

  /** TG Web A 使用 .Message；兼容 message-list-item */
  function findMessageNodes() {
    const root =
      document.querySelector(".MessageList") ||
      document.querySelector(".messages-container") ||
      document.querySelector("#MiddleColumn") ||
      document.body;

    const byId = new Map();

    root.querySelectorAll(".Message").forEach((el) => {
      if (el.closest(`#${BAR_ID}`)) return;
      const id = getMessageId(el);
      if (!id) return;
      if (!byId.has(id)) byId.set(id, el);
    });

    if (byId.size) return [...byId.values()];

    root.querySelectorAll("[data-message-id]").forEach((el) => {
      if (el.closest(`#${BAR_ID}`)) return;
      const item = normalizeMessageEl(el);
      const id = getMessageId(item);
      if (!id || id === "0") return;
      if (!byId.has(id)) byId.set(id, item);
    });

    return [...byId.values()];
  }

  function extractSenderPeerKey(listItem) {
    const av = findAvatarInListItem(listItem);
    if (!av) return "";
    const peer =
      av.getAttribute("data-peer-id") ||
      av.getAttribute("data-peer") ||
      av.querySelector("[data-peer-id]")?.getAttribute("data-peer-id") ||
      "";
    if (peer) return `peer:${peer}`;
    const img = av.querySelector("img");
    if (img?.src && !img.src.startsWith("data:")) {
      try {
        const u = new URL(img.src, location.origin);
        return `img:${u.pathname}`;
      } catch {
        return `img:${img.src.split("?")[0]}`;
      }
    }
    const label = (img?.alt || av.getAttribute("aria-label") || av.title || "").trim();
    if (label && label.length < 80) return `name:${label.toLowerCase()}`;
    return "";
  }

  function findSenderFromPreviousMessages(msg) {
    let item = getMessageListItem(msg);
    for (let i = 0; i < 24; i++) {
      item = item?.previousElementSibling;
      if (!item) break;
      const prevMsg = normalizeMessageEl(item.querySelector?.(".Message") || item);
      if (isOwnMessage(prevMsg)) break;
      const s = extractSender(prevMsg, item);
      if (s) return s;
    }
    return "";
  }

  function resolveMessageSender(el, ctx) {
    const msg = normalizeMessageEl(el);
    const listItem = getMessageListItem(msg);
    const peerKey = extractSenderPeerKey(listItem);
    const direct = extractSender(msg, listItem);

    if (direct) {
      if (peerKey && peerKey !== ctx.lastPeerKey) {
        ctx.lastPeerKey = peerKey;
      }
      return direct;
    }

    if (peerKey && ctx.lastPeerKey && peerKey !== ctx.lastPeerKey) {
      ctx.lastPeerKey = peerKey;
      ctx.lastSender = "";
    }

    if (isFirstInGroup(msg)) {
      const fromPrev = findSenderFromPreviousMessages(msg);
      if (fromPrev) return fromPrev;
      return "";
    }

    if (isGroupedContinuation(msg) && ctx.lastSender) {
      if (!peerKey || !ctx.lastPeerKey || peerKey === ctx.lastPeerKey) {
        return ctx.lastSender;
      }
    }

    if (ctx.lastSender && (!peerKey || peerKey === ctx.lastPeerKey)) {
      return ctx.lastSender;
    }

    return findSenderFromPreviousMessages(msg);
  }

  /** 按 DOM 顺序遍历，补全群聊里“不重复显示昵称”的发送者 */
  function walkMessagesWithSender() {
    const nodes = findMessageNodes();
    const ctx = { lastSender: "", lastPeerKey: "" };
    const result = [];

    for (const raw of nodes) {
      const el = normalizeMessageEl(raw);
      if (isOwnMessage(el)) {
        ctx.lastSender = "";
        ctx.lastPeerKey = "";
        continue;
      }
      const sender = resolveMessageSender(el, ctx);
      if (sender) ctx.lastSender = sender;
      if (!sender) continue;
      result.push({ el, sender });
    }
    return result;
  }

  function collectSenders() {
    try {
      const names = new Set();
      for (const { sender } of walkMessagesWithSender()) {
        if (sender && sender !== "未知") names.add(sender);
      }
      return [...names].sort((a, b) => a.localeCompare(b, "zh"));
    } catch (err) {
      console.error("[tg-to-fb] collectSenders failed", err);
      return [];
    }
  }

  function getChatKey() {
    return location.hash || location.href;
  }

  function getChatIdFromHash() {
    const h = (location.hash || "").replace(/^#/, "");
    return h ? decodeURIComponent(h) : "";
  }

  function isInGroupChat() {
    const id = getChatIdFromHash();
    return id.startsWith("-") || id.startsWith("@");
  }

  function bindChatNavigation() {
    window.addEventListener("hashchange", () => onChatChanged(false));
    window.addEventListener("popstate", () => onChatChanged(false));
  }

  async function onChatChanged(isInit) {
    const key = getChatKey();
    if (!isInit && key === currentChatKey) return;
    currentChatKey = key;
    chatReadyForForward = false;
    seenIds.clear();

    if (isInGroupChat()) {
      saveConfig({ telegramChatUrl: location.href });
    }

    ensureObserver();
    await waitForChatReady(20000);
    await markAllVisibleMessagesSeen();
    chatReadyForForward = true;
    runInjectPass();
    setTimeout(runInjectPass, 1500);
    setTimeout(runInjectPass, 4000);
  }

  async function waitForChatReady(maxMs) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      if (findMessageNodes().length > 0) return true;
      if (!isInGroupChat()) return false;
      ensureObserver();
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  function ensureObserver() {
    const root =
      document.querySelector(".MessageList") ||
      document.querySelector(".messages-container") ||
      document.querySelector("#MiddleColumn");
    if (!root) return;
    if (root === observedRoot && observer) return;
    if (observer) observer.disconnect();
    observedRoot = root;
    observer = new MutationObserver(() => scheduleWork());
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "srcset"] });
  }

  function waitForTelegramShell(maxMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        const shell =
          document.querySelector("#LeftColumn, .LeftColumn, #Main, .App, #root") ||
          document.querySelector(".MessageList, .Message");
        if (shell || Date.now() - start >= maxMs) resolve();
        else setTimeout(tick, 400);
      };
      tick();
    });
  }

  function scheduleWork() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      runInjectPass();
      if (chatReadyForForward) scanNewMessages();
    }, 50);
  }

  function runInjectPass() {
    try {
      injectMessageCheckboxes();
      renderSenderPicker();
      updateBarStatus();
    } catch (err) {
      console.error("[tg-to-fb] runInjectPass failed", err);
      scheduleBarInjection();
    }
  }

  function scanExistingMessages() {
    for (const { el } of walkMessagesWithSender()) {
      const id = getMessageId(el);
      if (id) seenIds.add(id);
    }
  }

  async function markAllVisibleMessagesSeen() {
    for (const ms of [0, 300, 800, 2000, 4500]) {
      if (ms) await new Promise((r) => setTimeout(r, ms));
      scanExistingMessages();
    }
  }

  function markSenderMessagesSeen(senderName) {
    const watchPeers = new Set(collectPeerKeysForSender(senderName));
    for (const { el, sender } of walkMessagesWithSender()) {
      const msg = normalizeMessageEl(el);
      const peerKey = extractSenderPeerKey(getMessageListItem(msg));
      if (!isMessageWatched(sender, peerKey, [senderName], watchPeers)) continue;
      const id = getMessageId(el);
      if (id) seenIds.add(id);
    }
  }

  function getMessageId(el) {
    return (
      el.getAttribute("data-message-id") ||
      el.querySelector("[data-message-id]")?.getAttribute("data-message-id") ||
      ""
    );
  }

  function isOwnMessage(el) {
    const msg = normalizeMessageEl(el);
    if (msg.classList.contains("own")) return true;
    if (msg.classList.contains("message-out") || msg.classList.contains("is-out")) return true;
    if (msg.getAttribute("data-is-out") === "true") return true;
    return false;
  }

  function isLikelySenderName(text) {
    const t = (text || "").trim();
    if (!t || t.length >= 80) return false;
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(t)) return false;
    if (/^(已发送|已送达|已读|发送中|edited|已编辑)$/i.test(t)) return false;
    if (/^via @/i.test(t)) return false;
    return true;
  }

  function extractSender(el, listItem) {
    const msg = normalizeMessageEl(el);
    const scope = listItem || getMessageListItem(msg);

    const selectors = [
      ".message-subheader .sender-title",
      ".message-subheader .message-title",
      ".message-subheader .peer-title",
      ".sender-title",
      ".message-title",
      ".peer-title",
      ".message-author",
      ".user-title",
    ];
    for (const sel of selectors) {
      const node = msg.querySelector(sel) || scope.querySelector(sel);
      const t = node?.textContent?.trim();
      if (isLikelySenderName(t)) return normalizeSenderName(t);
    }

    const avatar = findAvatarInListItem(scope);
    if (avatar) {
      const img = avatar.querySelector("img");
      if (isLikelySenderName(img?.alt)) return normalizeSenderName(img.alt);
      const aria = avatar.getAttribute("aria-label") || avatar.title;
      if (isLikelySenderName(aria)) return normalizeSenderName(aria);
    }

    const sub = msg.querySelector(".message-subheader");
    if (sub) {
      for (const node of sub.querySelectorAll("span, a, div")) {
        const t = node.textContent?.trim();
        if (isLikelySenderName(t)) return normalizeSenderName(t);
      }
    }

    return "";
  }

  function buildMessageActionsWrap(sender) {
    const name = normalizeSenderName(sender) || "未知";
    const wrap = document.createElement("div");
    wrap.className = CHECK_CLASS;
    wrap.dataset.sender = name;

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "tgfb-cb";
    cb.dataset.sender = name;
    cb.checked = senderMatches(name, getWatchList());

    const label = document.createElement("label");
    label.title = `勾选后自动转发「${name}」`;
    label.append(cb, document.createTextNode(" 自动"));

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tgfb-forward-now";
    btn.textContent = "转发";
    btn.title = "立即转发本条到 Facebook";

    wrap.append(label, btn);
    return wrap;
  }

  /** 群聊头像可能在 message-list-item 内、与 .Message 并列 */
  function findAvatarInListItem(scope) {
    if (!(scope instanceof Element)) return null;
    try {
      const root = scope;
      const msg = root.classList.contains("Message") ? root : root.querySelector(".Message");

      for (const child of root.children) {
        if (child.matches?.(".Avatar, .avatar") && isElementVisible(child)) return child;
      }
      if (msg) {
        for (const child of msg.children) {
          if (child.matches?.(".Avatar, .avatar") && isElementVisible(child)) return child;
        }
      }

      const candidates = [...root.querySelectorAll(".Avatar, .avatar")].filter(
        (node) => !node.closest(`.${CHECK_CLASS}`) && isElementVisible(node)
      );
      if (!candidates.length) return null;

      const anchor = msg || root;
      const msgRect = anchor.getBoundingClientRect();
      candidates.sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        const aLeft = Math.abs(ar.left - msgRect.left);
        const bLeft = Math.abs(br.left - msgRect.left);
        return aLeft - bLeft || ar.top - br.top;
      });
      return candidates[0];
    } catch (err) {
      console.warn("[tg-to-fb] findAvatarInListItem", err);
      return null;
    }
  }

  function findAvatarInMessage(msg) {
    return findAvatarInListItem(getMessageListItem(msg));
  }

  function isElementVisible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 8 && r.height > 8;
  }

  function messageNeedsCheckbox(msg) {
    if (msg.querySelector(`.${CHECK_CLASS}`)) return false;
    if (isOwnMessage(msg) || isServiceMessage(msg)) return false;
    return !!(
      getMessageContentAnchor(msg) ||
      msg.querySelector(".message-content-wrapper, .message-content")
    );
  }

  function syncExistingCheckboxSender(msg, sender) {
    const wrap = msg.querySelector(`.${CHECK_CLASS}`);
    const name = normalizeSenderName(sender);
    if (!wrap || !name || name === "未知") return;
    if (wrap.dataset.sender === name) return;
    wrap.dataset.sender = name;
    const cb = wrap.querySelector(".tgfb-cb");
    if (cb) {
      cb.dataset.sender = name;
      if (Date.now() >= senderSyncPausedUntil) {
        cb.checked = senderMatches(name, getWatchList());
      }
      wrap.querySelector("label")?.setAttribute("title", `勾选后自动转发「${name}」`);
    }
  }

  function getMessageContentAnchor(msg) {
    return (
      msg.querySelector(":scope > .message-content-wrapper") ||
      msg.querySelector(".message-content-wrapper") ||
      msg.querySelector(":scope > .message-content") ||
      msg.querySelector(".message-content") ||
      msg.querySelector(".content-inner")
    );
  }

  /** 操作条放在消息气泡正文下方 */
  function placeCheckboxOnMessage(msg, wrap) {
    const anchor = getMessageContentAnchor(msg);
    wrap.classList.add("tgfb-below-message");
    if (anchor) {
      anchor.insertAdjacentElement("afterend", wrap);
      return true;
    }
    msg.appendChild(wrap);
    return true;
  }

  function scheduleInjectRetries() {
    for (const ms of [200, 600, 1200, 2500, 4000]) {
      setTimeout(injectMessageCheckboxes, ms);
    }
  }

  function countMessagesMissingCheckbox() {
    let n = 0;
    for (const { el } of walkMessagesWithSender()) {
      if (messageNeedsCheckbox(normalizeMessageEl(el))) n++;
    }
    return n;
  }

  function normalizeForwardOptions(arg) {
    if (typeof arg === "boolean") return { isRetry: arg, manual: false, btn: null };
    return {
      isRetry: !!arg?.isRetry,
      manual: !!arg?.manual,
      btn: arg?.btn || null,
    };
  }

  function resetForwardNowButton(btn) {
    if (!btn) return;
    btn.disabled = false;
    btn.textContent = "转发";
  }

  function forwardMessageNow(msg, sender, btn) {
    const messageId = getMessageId(msg);
    if (!messageId) {
      updateBarStatus("无法识别消息，请刷新页面", "err");
      return;
    }
    if (!getFbUrlsText().trim()) {
      updateBarStatus("请先填写并保存 FB 群链接", "err");
      return;
    }
    if (btn) {
      btn.disabled = true;
      btn.textContent = "…";
    }
    processMessageForward(msg, sender, messageId, { manual: true, btn });
  }

  /** 自动勾选 + 立即转发按钮，放在头像下方 */
  function injectMessageCheckboxes(opts = {}) {
    let injected = 0;
    const nodes = findMessageNodes();
    const ctx = { lastSender: "", lastPeerKey: "" };

    for (const raw of nodes) {
      const msg = normalizeMessageEl(raw);
      if (isOwnMessage(msg)) {
        ctx.lastSender = "";
        ctx.lastPeerKey = "";
        continue;
      }

      const sender = resolveMessageSender(msg, ctx) || "";
      if (sender) ctx.lastSender = sender;

      if (msg.querySelector(`.${CHECK_CLASS}`)) {
        if (sender) syncExistingCheckboxSender(msg, sender);
        continue;
      }
      if (!messageNeedsCheckbox(msg)) continue;

      const wrap = buildMessageActionsWrap(sender || "未知");
      const btn = wrap.querySelector(".tgfb-forward-now");
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        const liveSender = wrap.dataset.sender || normalizeSenderName(sender) || "未知";
        forwardMessageNow(msg, liveSender, btn);
      });
      if (placeCheckboxOnMessage(msg, wrap)) injected++;
    }
    if (!opts.skipSync) syncAllCheckboxes();

    if (countMessagesMissingCheckbox() > 0) scheduleInjectRetries();

    const status = document.getElementById("tgfb-bar-status");
    const total = findMessageNodes().length;
    if (status && injected === 0 && total === 0) {
      status.textContent = "未检测到消息：请确认在 web.telegram.org/a 群聊内";
    } else if (status && injected === 0 && total > 0) {
      status.textContent = `已识别 ${total} 条消息，${collectSenders().length} 人 · 请在顶部列表勾选`;
    }
  }

  function renderSenderPicker() {
    const host = document.getElementById(SENDER_LIST_ID);
    if (!host) return;

    const senders = collectSenders();
    const list = getWatchList();

    if (!senders.length) {
      host.innerHTML =
        '<p class="tgfb-hint">暂无发言者。请打开群聊并向上滚动加载消息，然后点「刷新发言者」。</p>';
      return;
    }

    host.innerHTML = "";
    const hint = document.createElement("p");
    hint.className = "tgfb-hint";
    hint.textContent = "消息下方有「转发」可立即发送；「自动」勾选后可持续转发该人：";
    host.appendChild(hint);

    for (const name of senders) {
      const norm = normalizeSenderName(name);
      const label = document.createElement("label");
      label.className = "tgfb-sender-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "tgfb-picker-cb";
      cb.dataset.sender = norm;
      cb.checked = senderMatches(norm, list);
      label.append(cb, document.createTextNode(` ${norm}`));
      host.appendChild(label);
    }
  }

  function syncAllCheckboxes(force = false) {
    if (!force && Date.now() < senderSyncPausedUntil) return;
    const list = getWatchList();
    const peers = getWatchPeerKeys();
    syncMessageCheckboxesFromWalk(list, peers);
    document.querySelectorAll(".tgfb-picker-cb").forEach((cb) => {
      const sender = getSenderFromControl(cb);
      if (sender) cb.checked = senderMatches(sender, list);
    });
  }

  async function toggleSender(sender, enabled) {
    const name = normalizeSenderName(sender);
    if (!name || name === "未知") return;
    senderSyncPausedUntil = Date.now() + 1200;
    const list = new Set(getWatchList());
    if (enabled) list.add(name);
    else {
      list.delete(name);
      for (const n of [...list]) {
        if (senderMatches(n, [name])) list.delete(n);
      }
    }
    const watchUserNames = [...list];
    const watchSenderPeerKeys = rebuildWatchPeerKeysForList(watchUserNames);
    config = { ...config, watchUserNames, watchSenderPeerKeys };
    injectMessageCheckboxes({ skipSync: true });
    syncAllCheckboxes(true);
    if (enabled) markSenderMessagesSeen(name);
    updateBarStatus(enabled ? `已监听：${name}` : `已取消：${name}`);
    await saveConfig({ watchUserNames, watchSenderPeerKeys });
  }

  function messageHasMediaShell(msg) {
    return !!msg.querySelector(
      ".media-inner, .Album, .Photo, .Video, .RoundVideo, img.full-media, canvas.thumbnail, .message-media, .message-content-media, .Attachment, .document-container, .File, .WebPage--with-photo"
    );
  }

  function scheduleMediaForwardRetry(msg, sender, messageId) {
    if (mediaRetryScheduled.has(messageId) || seenIds.has(messageId)) return;
    mediaRetryScheduled.add(messageId);
    setTimeout(() => {
      if (seenIds.has(messageId)) return;
      processMessageForward(msg, sender, messageId, true);
    }, 2000);
  }

  function processMessageForward(msg, sender, messageId, options) {
    const { isRetry, manual, btn } = normalizeForwardOptions(options);
    if (forwardingIds.has(messageId)) return;
    if (!manual && seenIds.has(messageId)) return;
    forwardingIds.add(messageId);

    if (manual) {
      const pending = forwardingIds.size;
      const hint = pending > 1 ? `手动转发中（${pending} 条排队）…` : "手动转发中…";
      updateBarStatus(hint);
      showForwardStatus({ text: hint, level: "info" });
    } else if (messageHasMediaShell(msg)) {
      const hint = isRetry ? "图片重试中…" : "检测到图片，处理中…";
      updateBarStatus(hint);
      showForwardStatus({ text: hint, level: "info" });
    }

    extractPayloadAsync(msg, sender, messageId, { manual })
      .then((payload) => {
        payload.manual = manual;
        const hasContent = !!(
          payload.text?.trim() ||
          payload.imageDataUrls?.length ||
          payload.imageUrls?.length ||
          payload.imageStashKey
        );
        if (!hasContent) {
          forwardingIds.delete(messageId);
          resetForwardNowButton(btn);
          if (!isRetry && !manual && messageHasMediaShell(msg)) {
            updateBarStatus("图片加载中，稍后自动重试…");
            scheduleMediaForwardRetry(msg, sender, messageId);
          } else if (messageHasMediaShell(msg)) {
            updateBarStatus("未识别到图片：请在 TG 中点开图片预览后再试", "err");
          } else if (manual) {
            updateBarStatus("本条无文字/图片可转发", "err");
          }
          return;
        }

        chrome.runtime.sendMessage({ type: "NEW_TG_MESSAGE", payload }, (res) => {
          resetForwardNowButton(btn);
          if (chrome.runtime.lastError) {
            forwardingIds.delete(messageId);
            return;
          }
          if (res?.skipped) {
            const reason =
              res.reason === "disabled"
                ? "未启用转发"
                : res.reason === "filtered"
                  ? "被过滤"
                  : res.reason === "no_fb_targets"
                    ? "未配置有效 FB 群链接（须 messages/t/ 格式）"
                    : res.reason === "empty"
                      ? "无文字/图片"
                      : res.reason === "duplicate"
                        ? "重复消息"
                        : res.reason || "跳过";
            const skipMsg = manual ? `手动转发失败：${reason}` : `未转发：${reason}`;
            updateBarStatus(skipMsg, res.reason === "filtered" || res.reason === "empty" ? "err" : undefined);
            if (payload.hasImages || messageHasMediaShell(msg) || manual) {
              showForwardStatus({ text: skipMsg, level: "err" });
            }
            forwardingIds.delete(messageId);
            if (!manual && res.reason === "duplicate") seenIds.add(messageId);
            if (!manual && res.reason === "empty" && messageHasMediaShell(msg) && !isRetry) {
              scheduleMediaForwardRetry(msg, sender, messageId);
            }
            return;
          }
          forwardingIds.delete(messageId);
          if (!manual) seenIds.add(messageId);
          if (res?.sent) {
            const tag = payload.hasImages ? "图片" : "消息";
            const done = `手动转发${tag}完成（${res.sentCount || res.targetCount || 1} 个群）`;
            updateBarStatus(done, "ok");
            showForwardStatus({ text: done, level: "ok" });
          } else if (res?.queued) {
            const tag = payload.hasImages ? "图片" : "消息";
            const queued = manual ? `已手动转发${tag}` : `已排队转发${tag}：${sender}`;
            updateBarStatus(queued);
            showForwardStatus({ text: queued, level: "info" });
          } else if (res?.skipped && manual && res.reason === "send_failed") {
            const failMsg = `手动转发失败：${res.error || "未知错误"}`;
            updateBarStatus(failMsg, "err");
            showForwardStatus({ text: failMsg, level: "err" });
          } else if (res?.error) {
            updateBarStatus(`错误：${res.error}`, "err");
          }
        });
      })
      .catch((err) => {
        forwardingIds.delete(messageId);
        resetForwardNowButton(btn);
        updateBarStatus(`提取失败：${err.message}`, "err");
      });
  }

  function scanNewMessages() {
    const watchList = getWatchList();
    const watchPeers = getWatchPeerKeys();
    if (!config?.enabled || (!watchList.length && !watchPeers.length)) return;
    if (!getFbUrlsText().trim()) return;

    for (const { el, sender } of walkMessagesWithSender()) {
      const messageId = getMessageId(el);
      if (!messageId || seenIds.has(messageId) || forwardingIds.has(messageId)) continue;

      const msg = normalizeMessageEl(el);
      const peerKey = extractSenderPeerKey(getMessageListItem(msg));
      if (!isMessageWatched(sender, peerKey, watchList, watchPeers)) continue;
      if (isServiceMessage(msg)) {
        seenIds.add(messageId);
        continue;
      }

      processMessageForward(msg, sender, messageId, false);
    }
  }

  function senderMatches(sender, watchList) {
    const a = normalizeSenderName(sender).toLowerCase();
    if (!a || a === "未知" || !watchList?.length) return false;
    return watchList.some((name) => {
      const b = normalizeSenderName(name).toLowerCase();
      return b && a === b;
    });
  }

  function isServiceMessage(msg) {
    return (
      msg.classList.contains("ActionMessage") ||
      msg.classList.contains("action-message") ||
      !!msg.querySelector(":scope > .ActionMessage, .service-notification")
    );
  }

  function getMessageContentRoot(msg) {
    return (
      msg.querySelector(":scope > .message-content-wrapper > .message-content") ||
      msg.querySelector(":scope > .message-content") ||
      msg.querySelector(".message-content-wrapper .message-content") ||
      msg.querySelector(".message-content") ||
      msg.querySelector(".content-inner")
    );
  }

  const META_REMOVE_SELECTOR =
    ".MessageMeta, .message-meta, .message-time, .MessageOutgoingStatus, .message-status";

  function isInsideMetaNode(el) {
    return !!el.closest(META_REMOVE_SELECTOR);
  }

  function isTimestampOnlyLine(line) {
    const t = (line || "").trim();
    if (!t) return true;
    if (/^(已发送|已送达|已读|发送中|Edited|已编辑)$/i.test(t)) return true;
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(t)) return true;
    if (/^\d{1,2}:\d{3,4}$/.test(t)) return true;
    if (/^(\d{1,2}:\d{2,4}\s*)+$/.test(t)) return true;
    return false;
  }

  function collapseRepeatedString(text) {
    const compact = String(text || "")
      .replace(/\u200b/g, "")
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

  function sanitizeMessageText(raw) {
    if (!raw) return "";
    let text = raw.replace(/\u200b/g, "").trim();
    text = text.replace(/\s+\d{1,2}:\d{2,4}(?=\s|$)/g, " ").trim();

    const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
    const content = lines.filter((line) => !isTimestampOnlyLine(line));
    const deduped = [];
    for (const line of content) {
      if (deduped[deduped.length - 1] !== line) deduped.push(line);
    }
    return collapseRepeatedString(deduped.join("\n").trim());
  }

  function readTextWithoutMeta(textEl) {
    const tm = textEl.querySelector(":scope > .translatable-message, .translatable-message");
    if (tm) {
      return (tm.textContent || "").replace(/\u200b/g, "").trim();
    }
    const clone = textEl.cloneNode(true);
    clone.querySelectorAll(META_REMOVE_SELECTOR).forEach((el) => el.remove());
    return (clone.textContent || "").replace(/\u200b/g, "").trim();
  }

  function extractTextFromRoot(root) {
    const caption =
      root.querySelector(".text-content .translatable-message") ||
      root.querySelector(".translatable-message") ||
      root.querySelector(".message-text");

    if (caption) {
      return sanitizeMessageText(readTextWithoutMeta(caption.closest(".text-content") || caption));
    }

    const textEl = root.querySelector(".text-content .text") || root.querySelector(".text-content");

    if (textEl) {
      if (textEl.matches(".text-content") && textEl.querySelector(".media-inner, .Album, .Photo, .Media")) {
        const cap = textEl.querySelector(".translatable-message, .message-text");
        if (cap) return sanitizeMessageText(readTextWithoutMeta(cap));
      } else {
        const cleaned = sanitizeMessageText(readTextWithoutMeta(textEl));
        if (cleaned) return cleaned;
      }
    }

    const clone = root.cloneNode(true);
    clone
      .querySelectorAll(
        `${META_REMOVE_SELECTOR}, .message-subheader, .media-inner, .Album, .Photo, .Media, .Reactions, .${CHECK_CLASS}`
      )
      .forEach((el) => el.remove());
    return sanitizeMessageText(clone.textContent || "");
  }

  function isUrlOrPhotoPlaceholder(text) {
    const t = String(text || "").trim();
    if (!t) return true;
    if (/^https?:\/\//i.test(t)) return true;
    return /^(photo|image|图片|照片|点击查看|view\s*photo)$/i.test(t);
  }

  function extractMessageText(msg) {
    const hasMedia = messageHasMediaShell(msg);
    const roots = [];
    const primary = getMessageContentRoot(msg);
    if (primary) roots.push(primary);
    const wrapper = msg.querySelector(".message-content-wrapper");
    if (wrapper && !roots.includes(wrapper)) roots.push(wrapper);

    for (const root of roots) {
      const text = extractTextFromRoot(root);
      if (!text) continue;
      if (hasMedia && isUrlOrPhotoPlaceholder(text)) continue;
      return text;
    }
    return "";
  }

  function extractMessageLinks(msg) {
    const root = getMessageContentRoot(msg);
    if (!root) return [];
    const hasMedia = messageHasMediaShell(msg);
    const links = [];
    root.querySelectorAll("a[href]").forEach((a) => {
      if (isInsideMetaNode(a)) return;
      const href = a.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("javascript:")) return;
      if (hasMedia && /\/file\/|\/photo\/|blob:|telesco\.pe/i.test(href)) return;
      links.push(href);
    });
    return [...new Set(links)];
  }

  function isMediaImage(img, msg) {
    if (!msg || !msg.contains(img)) return false;
    if (img.closest(`.Avatar, .avatar, .Reactions, .MessageMeta, .message-subheader, .${CHECK_CLASS}`)) {
      return false;
    }
    if (img.classList.contains("full-media")) return true;
    if (img.closest(".media-inner, .Album, .Photo, .Media, .message-media, .content-image")) return true;

    const src = (img.currentSrc || img.src || "").toLowerCase();
    if (src && (src.includes("emoji") || src.includes("sticker") || src.includes("blank"))) return false;

    const r = img.getBoundingClientRect();
    if (r.width >= 56 && r.height >= 56) return true;
    return false;
  }

  function addImageItem(items, seen, img, msg) {
    if (!isMediaImage(img, msg)) return;
    const url = getBestImageSrc(img);
    const key = url || `node-${items.length}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ url, img });
  }

  function getBestImageSrc(img) {
    const srcset = img.getAttribute("srcset");
    if (srcset) {
      const parts = srcset
        .split(",")
        .map((s) => s.trim().split(/\s+/))
        .filter((p) => p[0]);
      if (parts.length) return parts[parts.length - 1][0];
    }
    return img.currentSrc || img.src || "";
  }

  function pickLargestImageInContainer(container, msg, items, seen) {
    let best = null;
    let bestArea = 0;
    for (const img of container.querySelectorAll("img")) {
      if (!isMediaImage(img, msg)) continue;
      const w = img.naturalWidth || img.offsetWidth || 0;
      const h = img.naturalHeight || img.offsetHeight || 0;
      const area = w * h;
      if (area >= bestArea) {
        bestArea = area;
        best = img;
      }
    }
    if (best) addImageItem(items, seen, best, msg);
  }

  function getLeafMediaContainers(msg) {
    const all = [
      ...msg.querySelectorAll(".media-inner, .message-media, .Photo, .message-content-media"),
    ];
    return all.filter((el) => !all.some((other) => other !== el && other.contains(el)));
  }

  function countAlbumSlots(msg) {
    const slots = getLeafMediaContainers(msg);
    return slots.length > 1 ? Math.min(5, slots.length) : 1;
  }

  function collapseImageItems(items) {
    const out = [];
    const imgNodes = new Set();
    for (const item of items) {
      if (item.img) {
        if (imgNodes.has(item.img)) continue;
        imgNodes.add(item.img);
      }
      out.push(item);
    }
    return out;
  }

  function collectMessageImages(msg) {
    const items = [];
    const seen = new Set();
    const containers = getLeafMediaContainers(msg);

    if (containers.length) {
      containers.forEach((c) => pickLargestImageInContainer(c, msg, items, seen));
    }
    if (!items.length) {
      msg.querySelectorAll("img.full-media, .media-inner img, .Photo img").forEach((img) =>
        addImageItem(items, seen, img, msg)
      );
    }

    const collapsed = collapseImageItems(items);
    const maxSlots = countAlbumSlots(msg);
    return collapsed.slice(0, maxSlots);
  }

  function waitForImageReady(img) {
    return new Promise((resolve, reject) => {
      if (!img) {
        resolve();
        return;
      }
      if (img.complete && img.naturalWidth > 0) {
        resolve();
        return;
      }
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("image load failed"));
      setTimeout(() => resolve(), 1200);
    });
  }

  async function imgElementToDataUrl(img) {
    await waitForImageReady(img);
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) throw new Error("invalid image size");
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(img, 0, 0);
    return canvas.toDataURL("image/jpeg", 0.92);
  }

  async function fetchImageAsDataUrl(url, imgEl) {
    if (!url && imgEl) return await imgElementToDataUrl(imgEl);
    if (!url) throw new Error("no image url");

    if (url.startsWith("blob:") || url.startsWith("data:")) {
      if (imgEl) {
        try {
          return await imgElementToDataUrl(imgEl);
        } catch {
          /* fallback fetch */
        }
      }
      const res = await fetch(url);
      const blob = await res.blob();
      return await blobToDataUrl(blob);
    }
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      if (!blob.type.startsWith("image/")) throw new Error("not image");
      if (blob.size > 8 * 1024 * 1024) throw new Error("image too large");
      return await blobToDataUrl(blob);
    } catch {
      if (imgEl) return await imgElementToDataUrl(imgEl);
      throw new Error("fetch image failed");
    }
  }

  async function stashImageData(messageId, imageDataUrls) {
    if (!imageDataUrls.length) return null;
    const key = IMAGE_STASH_PREFIX + messageId;
    await chrome.storage.local.set({ [key]: imageDataUrls });
    return key;
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async function extractPayloadAsync(msg, sender, messageId, opts = {}) {
    const manual = !!opts.manual;
    const text = extractMessageText(msg);
    const links = extractMessageLinks(msg);
    const imageItems = collectMessageImages(msg);
    const hasMediaShell = messageHasMediaShell(msg);
    const albumSlots = countAlbumSlots(msg);

    if (manual && !imageItems.length && !hasMediaShell) {
      return {
        messageId,
        sender,
        text,
        links,
        imageUrls: [],
        imageDataUrls: [],
        imageStashKey: null,
        hasImages: false,
        mediaShell: false,
        albumSlots,
      };
    }

    const rawUrls = TgFbImageDedupe.dedupeImageRefs(
      [...new Set(imageItems.map((i) => i.url).filter(Boolean))],
      albumSlots
    );
    const imageDataUrls = [];

    if (imageItems.length) {
      const perImgMs = manual ? 1400 : 2800;
      const totalMs = manual ? 1800 : 3500;
      const fetched = await Promise.race([
        Promise.all(
          imageItems
            .slice(0, albumSlots)
            .map((item) =>
              Promise.race([
                fetchImageAsDataUrl(item.url, item.img).catch(() => null),
                new Promise((r) => setTimeout(() => r(null), perImgMs)),
              ])
            )
        ),
        new Promise((resolve) => setTimeout(() => resolve([]), totalMs)),
      ]);
      if (Array.isArray(fetched)) {
        for (const data of fetched) {
          if (data) imageDataUrls.push(data);
        }
      }
    }

    const dedupedData =
      albumSlots > 1
        ? TgFbImageDedupe.dedupeImageRefs(imageDataUrls, albumSlots)
        : TgFbImageDedupe.pickSingleBestDataUrl(imageDataUrls);
    const imageStashKey = dedupedData.length ? await stashImageData(messageId, dedupedData) : null;

    return {
      messageId,
      sender,
      text,
      links,
      imageUrls: imageStashKey ? [] : rawUrls,
      imageDataUrls: imageStashKey ? [] : dedupedData,
      imageStashKey,
      hasImages: dedupedData.length > 0 || rawUrls.length > 0,
      mediaShell: hasMediaShell,
      albumSlots,
    };
  }

  function injectSettingsBar() {
    if (document.getElementById(BAR_ID)) return;
    const mount = document.body || document.documentElement;
    if (!mount) return;

    const bar = document.createElement("div");
    bar.id = BAR_ID;
    bar.innerHTML = `
      <style>
        #${BAR_ID} {
          position: fixed; top: 8px; right: 8px; left: auto;
          width: min(520px, calc(100vw - 24px));
          z-index: 2147483646;
          background: linear-gradient(180deg, #1e3a52 0%, #172b3c 100%);
          color: #e8f4fc; font: 12px/1.4 system-ui, sans-serif;
          padding: 6px 10px 8px; box-shadow: 0 4px 16px rgba(0,0,0,.4);
          border: 1px solid #2481cc;
          border-radius: 10px;
          pointer-events: auto;
          max-height: min(42vh, 320px);
          overflow-y: auto;
        }
        #${BAR_ID}.tgfb-mini {
          padding: 5px 10px 6px;
          max-height: none;
          overflow: visible;
          width: min(420px, calc(100vw - 24px));
        }
        #${BAR_ID}.tgfb-mini .tgfb-expand-only { display: none !important; }
        #${BAR_ID}.tgfb-user-positioned { right: auto !important; }
        #${BAR_ID}.tgfb-dragging {
          opacity: 0.96; box-shadow: 0 8px 24px rgba(0,0,0,.5);
          user-select: none;
        }
        #${BAR_ID}:not(.tgfb-dragging) { cursor: default; }
        #${BAR_ID} .tgfb-drag-handle {
          flex: 0 0 auto; cursor: grab; user-select: none;
          padding: 2px 6px; margin-right: 2px; border-radius: 4px;
          background: rgba(255,255,255,.12); font-size: 11px; letter-spacing: 1px;
          line-height: 1.2; color: rgba(232,244,252,.95);
        }
        #${BAR_ID} .tgfb-drag-handle:hover { background: rgba(255,255,255,.2); }
        #${BAR_ID}.tgfb-dragging .tgfb-drag-handle { cursor: grabbing; }
        #${BAR_ID} .tgfb-mini-status {
          flex: 1 1 auto; min-width: 0; font-size: 11px; opacity: .9;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        /* 只给消息列表留白，不移动整列（避免底部输入框被挤出屏幕） */
        body.tgfb-bar-active:not(.tgfb-bar-mini-layout) #MiddleColumn .MessageList,
        body.tgfb-bar-active:not(.tgfb-bar-mini-layout) #MiddleColumn .messages-container {
          padding-top: var(--tgfb-bar-height, 0px) !important;
        }
        #${BAR_ID} .row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 6px; }
        #${BAR_ID} label { display: flex; align-items: center; gap: 6px; font-weight: 600; cursor: pointer; }
        #${BAR_ID} textarea {
          flex: 1 1 280px; min-width: 200px; min-height: 44px; max-height: 80px;
          padding: 6px 8px; border-radius: 6px; border: 1px solid #3d5f7a; font: inherit; resize: vertical;
        }
        #${BAR_ID} button {
          padding: 6px 12px; border: none; border-radius: 6px; background: #2481cc; color: #fff;
          cursor: pointer; font-weight: 600;
        }
        #${BAR_ID} button.secondary { background: #3a5068; }
        #${BAR_ID} .status { font-size: 11px; opacity: .92; flex: 1 1 100%; }
        #${BAR_ID} details { flex: 1 1 100%; font-size: 11px; }
        #${BAR_ID} details textarea { width: 100%; margin-top: 4px; min-height: 48px; }
        #${SENDER_LIST_ID} {
          flex: 1 1 100%; max-height: 120px; overflow-y: auto;
          padding: 6px 8px; background: rgba(0,0,0,.2); border-radius: 6px;
          display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center;
        }
        .tgfb-sender-item { font-weight: normal; font-size: 11px; cursor: pointer; }
        .tgfb-hint { margin: 0; font-size: 11px; opacity: .85; width: 100%; }
        .${CHECK_CLASS} {
          display: flex !important; flex-direction: column !important; align-items: center !important;
          visibility: visible !important; opacity: 1 !important;
          box-sizing: border-box !important; pointer-events: auto !important;
        }
        .${CHECK_CLASS}.tgfb-below-message {
          position: relative !important;
          left: auto !important;
          top: auto !important;
          bottom: auto !important;
          z-index: 5 !important;
          display: inline-flex !important;
          flex-direction: column !important;
          align-items: stretch !important;
          gap: 3px !important;
          width: auto !important;
          min-width: 3.2rem !important;
          max-width: 5.5rem !important;
          margin: 5px 0 6px 0 !important;
          padding: 4px 5px !important;
          background: #fff !important;
          border: 2px solid #2481cc !important;
          border-radius: 8px !important;
          box-shadow: 0 1px 4px rgba(0,0,0,.18) !important;
          clear: both !important;
        }
        .Message .${CHECK_CLASS}.tgfb-below-message {
          margin-left: 0 !important;
        }
        .${CHECK_CLASS} label {
          cursor: pointer !important; color: #1565c0 !important; font-weight: 700 !important;
          display: flex !important; align-items: center !important; justify-content: center !important;
          font-size: 10px !important; margin: 0 !important;
        }
        .${CHECK_CLASS} input {
          width: 14px !important; height: 14px !important; margin: 0 2px 0 0 !important;
          cursor: pointer !important;
        }
        .${CHECK_CLASS} .tgfb-forward-now {
          display: block !important;
          width: 100% !important;
          margin: 0 !important;
          padding: 2px 0 !important;
          font-size: 9px !important;
          font-weight: 700 !important;
          line-height: 1.2 !important;
          color: #fff !important;
          background: #2481cc !important;
          border: none !important;
          border-radius: 4px !important;
          cursor: pointer !important;
        }
        .${CHECK_CLASS} .tgfb-forward-now:hover { background: #1a6dad !important; }
        .${CHECK_CLASS} .tgfb-forward-now:disabled {
          opacity: 0.65 !important;
          cursor: wait !important;
        }
        #tgfb-forward-status { flex: 1 1 100%; font-size: 11px; padding: 4px 6px; border-radius: 4px; }
        #tgfb-forward-status.ok { background: rgba(52,168,83,.25); }
        #tgfb-forward-status.err { background: rgba(234,67,53,.35); }
      </style>
      <div class="row tgfb-toolbar" id="tgfb-toolbar">
        <span class="tgfb-drag-handle" id="tgfb-drag-handle" title="按住拖动 · 双击恢复默认位置">⠿ 拖动</span>
        <label><input type="checkbox" id="tgfb-enabled" /> 启用转发</label>
        <button type="button" id="tgfb-save">保存</button>
        <button type="button" class="secondary" id="tgfb-refresh-senders">刷新发言者</button>
        <button type="button" class="secondary tgfb-expand-only" id="tgfb-open-home">TG 卡住</button>
        <span id="tgfb-mini-status" class="tgfb-mini-status"></span>
        <button type="button" class="secondary" id="tgfb-bar-toggle">展开</button>
      </div>
      <div id="tgfb-forward-status" class="status tgfb-expand-only">转发状态：等待操作</div>
      <div class="row tgfb-expand-only" id="tgfb-bar-body">
        <textarea id="tgfb-fb-urls" placeholder="每行一个，必须用此格式：&#10;https://www.facebook.com/messages/t/1234567890"></textarea>
        <p class="tgfb-hint tgfb-expand-only">每行一个群链接（最多 10 个），须含 <code>/messages/t/</code>；转发前请自行打开全部群聊页并保持登录</p>
      </div>
      <div class="row tgfb-expand-only" id="tgfb-sender-row">
        <div id="${SENDER_LIST_ID}"></div>
      </div>
      <details class="row tgfb-expand-only">
        <summary>废话过滤（可选）</summary>
        <textarea id="tgfb-filter" placeholder="每行一条，包含即不转发"></textarea>
      </details>
      <div class="status tgfb-expand-only" id="tgfb-bar-status">请先手动打开 FB 群聊页；消息下方可点「转发」或勾选「自动」持续转发</div>
      <div class="status tgfb-expand-only" id="tgfb-chat-id"></div>
    `;

    try {
      mount.appendChild(bar);
    } catch (err) {
      console.error("[tg-to-fb] append bar failed", err);
      return;
    }

    try {
      bar.querySelector("#tgfb-save").addEventListener("click", onSaveBar);
      bar.querySelector("#tgfb-open-home").addEventListener("click", () => {
        location.href = "https://web.telegram.org/a/";
      });
      bar.querySelector("#tgfb-refresh-senders").addEventListener("click", () => {
        runInjectPass();
        updateBarStatus(`已刷新，识别到 ${collectSenders().length} 位发言者`);
      });
      bar.querySelector("#tgfb-enabled").addEventListener("change", async (e) => {
        config.enabled = e.target.checked;
        if (config.enabled) {
          chatReadyForForward = false;
          await markAllVisibleMessagesSeen();
          chatReadyForForward = true;
        } else {
          chatReadyForForward = false;
        }
        saveConfig({ enabled: config.enabled }).then(updateBarStatus);
      });
      bar.querySelector("#tgfb-bar-toggle").addEventListener("click", () => {
        const mini = bar.classList.contains("tgfb-mini");
        setBarExpanded(mini);
      });

      bindBarDrag(bar);
      bindBarResizeObserver(bar);
      initBarCollapseState(bar);
      loadBarPosition(bar);
      syncSettingsBar();
      renderSenderPicker();
      updateBarStatus();
    } catch (err) {
      console.error("[tg-to-fb] bar setup failed", err);
    }
    document.body.classList.add("tgfb-bar-active");
    applyBarOffset();
  }

  function setBarExpanded(expanded) {
    const bar = document.getElementById(BAR_ID);
    if (!bar) return;
    const mini = !expanded;
    bar.classList.toggle("tgfb-mini", mini);
    bar.classList.toggle("tgfb-expanded", expanded);
    const btn = bar.querySelector("#tgfb-bar-toggle");
    if (btn) btn.textContent = mini ? "展开" : "收起";
    chrome.storage.local.set({ [BAR_COLLAPSED_KEY]: mini });
    requestAnimationFrame(() => {
      applyBarOffset();
      setTimeout(applyBarOffset, 80);
    });
  }

  function initBarCollapseState(bar) {
    chrome.storage.local.get([BAR_COLLAPSED_KEY], (data) => {
      const collapsed = data[BAR_COLLAPSED_KEY] === true;
      setBarExpanded(!collapsed);
    });
  }

  function bindBarResizeObserver(bar) {
    if (barResizeObserver) barResizeObserver.disconnect();
    if (typeof ResizeObserver === "undefined") {
      setInterval(applyBarOffset, 1500);
      return;
    }
    barResizeObserver = new ResizeObserver(() => applyBarOffset());
    barResizeObserver.observe(bar);
  }

  function clampBarToViewport(bar) {
    const rect = bar.getBoundingClientRect();
    const w = bar.offsetWidth;
    const h = bar.offsetHeight;
    let left = rect.left;
    let top = rect.top;
    left = Math.max(4, Math.min(left, window.innerWidth - w - 4));
    top = Math.max(4, Math.min(top, window.innerHeight - h - 4));
    bar.style.left = `${left}px`;
    bar.style.top = `${top}px`;
    return { left, top };
  }

  function applyBarPosition(bar, left, top) {
    bar.style.right = "auto";
    bar.style.left = `${left}px`;
    bar.style.top = `${top}px`;
    bar.classList.add("tgfb-user-positioned");
    clampBarToViewport(bar);
  }

  function loadBarPosition(bar) {
    chrome.storage.local.get([BAR_POSITION_KEY], (data) => {
      const pos = data[BAR_POSITION_KEY];
      if (!pos || !Number.isFinite(pos.left) || !Number.isFinite(pos.top)) return;
      if (pos.left < -2000 || pos.top < -2000 || pos.left > 8000 || pos.top > 8000) {
        resetBarPosition(bar);
        return;
      }
      applyBarPosition(bar, pos.left, pos.top);
      applyBarOffset();
    });
  }

  function saveBarPosition(bar) {
    const left = parseFloat(bar.style.left);
    const top = parseFloat(bar.style.top);
    if (Number.isFinite(left) && Number.isFinite(top)) {
      chrome.storage.local.set({ [BAR_POSITION_KEY]: { left, top } });
    }
  }

  function resetBarPosition(bar) {
    bar.classList.remove("tgfb-user-positioned");
    bar.style.left = "";
    bar.style.right = "8px";
    bar.style.top = "8px";
    chrome.storage.local.remove(BAR_POSITION_KEY);
    applyBarOffset();
  }

  function isDragInteractiveTarget(target) {
    return !!target.closest(
      "input, button, textarea, select, label, a, summary, details, #tgfb-bar-toggle"
    );
  }

  function bindBarDrag(bar) {
    const handle = bar.querySelector("#tgfb-drag-handle");
    if (!handle) return;

    let dragging = false;
    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    function onPointerDown(e) {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      if (isDragInteractiveTarget(e.target)) return;
      dragging = true;
      pointerId = e.pointerId;
      bar.setPointerCapture?.(pointerId);
      const rect = bar.getBoundingClientRect();
      bar.classList.add("tgfb-dragging");
      bar.style.right = "auto";
      startLeft = rect.left;
      startTop = rect.top;
      bar.style.left = `${startLeft}px`;
      bar.style.top = `${startTop}px`;
      bar.classList.add("tgfb-user-positioned");
      startX = e.clientX;
      startY = e.clientY;
      e.preventDefault();
    }

    function onPointerMove(e) {
      if (!dragging || (pointerId !== null && e.pointerId !== pointerId)) return;
      const left = startLeft + (e.clientX - startX);
      const top = startTop + (e.clientY - startY);
      bar.style.left = `${left}px`;
      bar.style.top = `${top}px`;
      clampBarToViewport(bar);
    }

    function onPointerUp(e) {
      if (!dragging || (pointerId !== null && e.pointerId !== pointerId)) return;
      dragging = false;
      pointerId = null;
      bar.classList.remove("tgfb-dragging");
      try {
        bar.releasePointerCapture?.(e.pointerId);
      } catch {
        /* ignore */
      }
      saveBarPosition(bar);
      applyBarOffset();
    }

    bar.addEventListener("pointerdown", onPointerDown);
    bar.addEventListener("pointermove", onPointerMove);
    bar.addEventListener("pointerup", onPointerUp);
    bar.addEventListener("pointercancel", onPointerUp);

    handle.addEventListener("dblclick", (e) => {
      e.preventDefault();
      resetBarPosition(bar);
    });

    window.addEventListener("resize", () => {
      if (bar.classList.contains("tgfb-user-positioned")) {
        clampBarToViewport(bar);
        saveBarPosition(bar);
      }
    });
  }

  function applyBarOffset() {
    const bar = document.getElementById(BAR_ID);
    if (!bar || isTelegramStuckLoading()) {
      document.body.classList.remove("tgfb-bar-active", "tgfb-bar-mini-layout");
      document.documentElement.style.setProperty("--tgfb-bar-height", "0px");
      return;
    }
    if (bar.classList.contains("tgfb-user-positioned")) {
      document.body.classList.remove("tgfb-bar-active", "tgfb-bar-mini-layout");
      document.documentElement.style.setProperty("--tgfb-bar-height", "0px");
      return;
    }
    const mini = bar.classList.contains("tgfb-mini");
    document.body.classList.toggle("tgfb-bar-mini-layout", mini);
    document.body.classList.add("tgfb-bar-active");
    const h = mini ? 0 : Math.ceil(bar.getBoundingClientRect().height);
    document.documentElement.style.setProperty("--tgfb-bar-height", `${h}px`);
  }

  function syncSettingsBar() {
    const enabled = document.getElementById("tgfb-enabled");
    const urls = document.getElementById("tgfb-fb-urls");
    const filter = document.getElementById("tgfb-filter");
    if (enabled) enabled.checked = !!config?.enabled;
    if (urls) urls.value = getFbUrlsText();
    if (filter) filter.value = config?.filterRulesText || "";
  }

  async function onSaveBar() {
    const urlsText = document.getElementById("tgfb-fb-urls")?.value || "";
    const filterText = document.getElementById("tgfb-filter")?.value || "";
    const enabled = document.getElementById("tgfb-enabled")?.checked;
    if (enabled) {
      chatReadyForForward = false;
      await markAllVisibleMessagesSeen();
      chatReadyForForward = true;
    } else {
      chatReadyForForward = false;
    }
    const res = await saveConfig({
      fbThreadUrlsText: urlsText,
      filterRulesText: filterText,
      enabled,
      telegramChatUrl: location.href,
    });
    syncBarFromConfig();
    const invalid = res?.invalidFbUrls || [];
    const truncated = !!res?.truncatedFbUrls;
    const fbCount = (config?.fbThreadUrls || []).length;
    if (invalid.length) {
      updateBarStatus(
        `部分链接无效（${invalid.length} 条），已保存 ${fbCount} 个有效群：messages/t/数字`,
        "err"
      );
      return;
    }
    if (truncated) {
      updateBarStatus(`已保存前 10 个群（最多支持 10 个），请删除多余链接`, "err");
      return;
    }
    if (urlsText.trim() && !fbCount) {
      updateBarStatus("未识别有效群链接，请用 https://www.facebook.com/messages/t/数字", "err");
      return;
    }
    updateBarStatus(fbCount ? `已保存 ${fbCount} 个 FB 群（messages/t/ 格式）` : "设置已保存");
  }

  function scheduleBarInjection() {
    const tryInject = () => {
      bindCheckboxDelegation();
      if (!document.body && !document.documentElement) return;
      if (document.getElementById(BAR_ID)) return;
      try {
        injectSettingsBar();
      } catch (err) {
        console.error("[tg-to-fb] injectSettingsBar failed", err);
      }
    };
    tryInject();
    setTimeout(tryInject, 300);
    setTimeout(tryInject, 1200);
    setInterval(tryInject, 3000);
  }

  function isTelegramStuckLoading() {
    const hasMessages = document.querySelector(".MessageList, .Message");
    const hasChatList = document.querySelector("#LeftColumn, .LeftColumn");
    return !hasMessages && !hasChatList;
  }

  function loadForwardStatus() {
    chrome.storage.local.get(["forwardStatus"], (data) => {
      if (data.forwardStatus) showForwardStatus(data.forwardStatus);
    });
  }

  function showForwardStatus(st) {
    const el = document.getElementById("tgfb-forward-status");
    if (!el || !st) return;
    const text = `转发：${st.text || ""}`;
    if (text === lastForwardUiText) return;
    lastForwardUiText = text;
    el.textContent = text;
    el.className = `status ${st.level === "err" ? "err" : st.level === "ok" ? "ok" : ""}`;
    const miniEl = document.getElementById("tgfb-mini-status");
    const bar = document.getElementById(BAR_ID);
    if (miniEl && bar?.classList.contains("tgfb-mini")) {
      const miniText = st.text || "";
      if (miniEl.textContent !== miniText) miniEl.textContent = miniText;
      miniEl.style.color = st.level === "err" ? "#ffb4a9" : "";
    }
    applyBarOffset();
  }

  function updateBarStatus(msg, level) {
    const el = document.getElementById("tgfb-bar-status");
    const chatEl = document.getElementById("tgfb-chat-id");
    if (chatEl) {
      const cid = getChatIdFromHash();
      chatEl.textContent = cid
        ? `当前链接群 ID：${cid}（须为 web.telegram.org/a 且地址栏含 # 群号）`
        : "未进入群聊：请从左侧点进群组，或让扩展打开带 # 群号的链接";
    }
    if (!el) return;
    if (msg) {
      el.textContent = msg;
      if (level === "err") el.style.color = "#ffb4a9";
      return;
    }
    const n = getWatchList().length;
    const fb = (config?.fbThreadUrls || []).length;
    const senders = collectSenders().length;
    const msgs = findMessageNodes().length;
    const on = config?.enabled ? "已启用" : "未启用";
    const stuck = isTelegramStuckLoading() ? " · ⚠️ TG未加载完" : "";
    const summary = `${on} · ${msgs} 条 · ${senders} 人 · 勾选 ${n} · ${fb} 个 FB${stuck}`;
    if (summary !== lastSummaryText) {
      lastSummaryText = summary;
      el.textContent = summary;
    }
    const miniEl = document.getElementById("tgfb-mini-status");
    const bar = document.getElementById(BAR_ID);
    if (miniEl && bar && !bar.classList.contains("tgfb-mini") && miniEl.textContent !== summary) {
      miniEl.textContent = summary;
    }
    requestAnimationFrame(applyBarOffset);
  }
})();
