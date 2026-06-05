(function () {
  if (window.__TGFB_FB_CONTENT__) return;
  window.__TGFB_FB_CONTENT__ = true;

  const SEND_DELAY_MS = 200;
  const SEND_DELAY_FAST_MS = 0;
  const COMPOSER_POLL_MS = 50;
  const COMPOSER_POLL_FAST_MS = 12;
  const COMPOSER_WAIT_MS = 5000;
  const COMPOSER_WAIT_FAST_MS = 500;
  const IMAGE_SEND_WAIT_MS = 650;
  const IMAGE_SEND_WAIT_FAST_MS = 380;

  let lastSentKey = "";
  let forwardQueue = Promise.resolve();
  const sendGuardKeys = new Set();

  function enqueueForwardJob(job) {
    const task = forwardQueue.catch(() => {}).then(() => forwardJob(job));
    forwardQueue = task
      .then(() => sleep(50))
      .catch(() => {});
    return task;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "TGFB_PING") {
      sendResponse({ ok: true });
      return true;
    }
    if (message?.type === "FORWARD_TO_FB") {
      enqueueForwardJob(message.job)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }
    return false;
  });

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

  function getThreadIdFromPage() {
    const m = location.pathname.match(/\/messages\/t\/(\d+)/i);
    return m?.[1] || "";
  }

  function buildSendKey(job, text) {
    return `${getThreadIdFromPage()}::${job.messageId}::${text}`;
  }

  function fbSentKey(messageId) {
    const tid = getThreadIdFromPage();
    return tid ? `tgfb_sent_${tid}_${messageId}` : `tgfb_sent_${messageId}`;
  }

  function imageRefFingerprint(ref) {
    const s = String(ref || "").trim();
    if (!s) return "";
    if (s.startsWith("data:image/")) {
      const b64 = s.split(",")[1] || "";
      return `data:${b64.length}`;
    }
    if (s.startsWith("blob:")) return `blob:${s.length}`;
    try {
      const u = new URL(s, "https://web.telegram.org");
      return `${u.origin}${u.pathname}`;
    } catch {
      return s.split("?")[0].split("#")[0];
    }
  }

  function dedupeImageRefs(refs, max = 5) {
    const out = [];
    const seen = new Set();
    for (const ref of refs || []) {
      const fp = imageRefFingerprint(ref);
      if (!fp || seen.has(fp)) continue;
      seen.add(fp);
      out.push(ref);
      if (out.length >= max) break;
    }
    return out;
  }

  function pickSingleBestDataUrl(refs) {
    const list = dedupeImageRefs(refs, 5);
    if (list.length <= 1) return list;
    let best = list[0];
    let bestLen = String(best || "").length;
    for (let i = 1; i < list.length; i++) {
      const len = String(list[i] || "").length;
      if (len > bestLen) {
        bestLen = len;
        best = list[i];
      }
    }
    return [best];
  }

  function buildJobGuardKey(job) {
    return `${getThreadIdFromPage()}::${job.id || job.messageId}`;
  }

  async function forwardJob(job) {
    if (!job) throw new Error("无效任务");
    if (!/facebook\.com/i.test(location.hostname)) {
      throw new Error("当前页面不是 Facebook，请检查群链接");
    }

    const guardKey = buildJobGuardKey(job);
    const manualDoneKey = `tgfb_manual_done_${guardKey}`;
    if (sendGuardKeys.has(guardKey) || (job.manual && sessionStorage.getItem(manualDoneKey))) {
      return;
    }
    sendGuardKeys.add(guardKey);

    try {
    let text = collapseRepeatedString(job.text || "");
    const albumSlots = Math.min(5, Math.max(1, Number(job.albumSlots) || 1));
    const merged = [...(job.imageDataUrls || []), ...(job.imageUrls || [])];
    const images =
      albumSlots > 1 ? dedupeImageRefs(merged, albumSlots) : pickSingleBestDataUrl(merged);
    const imageCount = images.length;
    if (imageCount && /^https?:\/\//i.test(text.trim())) text = "";
    const sendKey = buildSendKey(job, text);
    const sentStorageKey = fbSentKey(job.messageId);

    if (!text && imageCount === 0) throw new Error("无内容可发送");
    if (!job.manual && sessionStorage.getItem(sentStorageKey)) return;
    if (!job.manual && sendKey && lastSentKey === sendKey) return;

    const fast = !!job.manual;
    const composerWaitMs = job.coldStart
      ? 14000
      : fast
        ? COMPOSER_WAIT_FAST_MS
        : COMPOSER_WAIT_MS;
    await waitForComposer(composerWaitMs, fast);
    let composer = findComposer();
    if (!composer) {
      throw new Error("未找到输入框：请登录 Facebook，并确认已打开对应群聊页面");
    }

    if (imageCount) {
      const files = [];
      for (let i = 0; i < images.length; i++) {
        try {
          files.push(await imageRefToFile(images[i], `tg-${job.messageId}-${i}.jpg`));
        } catch (err) {
          console.warn("[tg-to-fb] image prepare failed", err);
        }
      }
      if (!files.length && !text) {
        throw new Error("图片上传失败：请确认 FB 群聊页已打开且已登录");
      }
      if (files.length) {
        composer = findComposer() || composer;
        await attachFilesOnce(files, composer, fast);
        if (!text) {
          lastSentKey = sendKey;
          markJobSent(job, sentStorageKey, manualDoneKey);
          return;
        }
      }
    }

    composer = findComposer() || composer;
    if (text) {
      if (fast && job.textOnly) await typeAndSendInstant(composer, text);
      else await typeAndSend(composer, text, fast);
    }
    lastSentKey = sendKey;
    markJobSent(job, sentStorageKey, manualDoneKey);
    } finally {
      setTimeout(() => sendGuardKeys.delete(guardKey), 8000);
    }
  }

  function markJobSent(job, sentStorageKey, manualDoneKey) {
    if (job.manual) {
      sessionStorage.setItem(manualDoneKey, String(Date.now()));
      return;
    }
    sessionStorage.setItem(sentStorageKey, String(Date.now()));
  }

  function isVisible(el) {
    if (!(el instanceof HTMLElement)) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 14) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
  }

  function scoreComposer(el) {
    const r = el.getBoundingClientRect();
    const aria = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("aria-placeholder") || ""} ${el.getAttribute("placeholder") || ""}`.toLowerCase();
    let score = 0;

    if (r.bottom > window.innerHeight * 0.45) score += 60;
    if (r.width > 180) score += 25;
    if (el.getAttribute("data-lexical-editor") === "true") score += 35;
    if (el.getAttribute("role") === "textbox") score += 25;
    if (/message|消息|messag|write|type|发送|reply|回复|aa/i.test(aria)) score += 45;
    if (el.closest('[role="main"], [data-pagelet*="Chat"], [data-pagelet*="Message"]')) score += 15;

    if (/search|搜索|comment|评论|创建帖子|create post|说点什么|what's on your mind/i.test(aria)) score -= 120;
    if (el.closest('[role="search"], [role="searchbox"], form[action*="search"]')) score -= 120;
    if (r.top < window.innerHeight * 0.15 && r.bottom < window.innerHeight * 0.4) score -= 40;

    return score;
  }

  function findComposer() {
    const selectors = [
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"][data-lexical-editor="true"]',
      'div[contenteditable="true"][aria-label]',
      'div[contenteditable="true"]',
    ];

    let best = null;
    let bestScore = -999;

    for (const sel of selectors) {
      for (const node of document.querySelectorAll(sel)) {
        if (!isVisible(node)) continue;
        const s = scoreComposer(node);
        if (s > bestScore) {
          bestScore = s;
          best = node;
        }
      }
      if (bestScore >= 80) break;
    }

    return best;
  }

  async function waitForComposer(maxMs, fast = false) {
    const start = Date.now();
    const poll = fast ? COMPOSER_POLL_FAST_MS : COMPOSER_POLL_MS;
    while (Date.now() - start < maxMs) {
      const c = findComposer();
      if (c) {
        c.scrollIntoView({ block: "nearest", behavior: "instant" });
        if (!fast) await sleep(40);
        return c;
      }
      await sleep(poll);
    }
  }

  function getLexicalTextNode(el) {
    const nodes = el.querySelectorAll('[data-lexical-text="true"]');
    if (nodes.length) return nodes[0];
    return el.querySelector("p[dir], p") || el;
  }

  function getComposerText(el) {
    const node = getLexicalTextNode(el);
    return (node.textContent || "").replace(/\u200b/g, "").trim();
  }

  async function focusComposer(el, fast = false) {
    el.scrollIntoView({ block: "nearest", behavior: "instant" });
    el.click();
    el.focus();
    await sleep(fast ? 12 : 60);
  }

  async function clearComposer(el) {
    await focusComposer(el);
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel?.removeAllRanges();
      sel?.addRange(range);
      document.execCommand("delete", false, null);
    } catch {
      /* ignore */
    }
    const node = getLexicalTextNode(el);
    node.textContent = "";
    fireInputEvents(el, "");
    await sleep(40);
  }

  function setComposerText(el, text) {
    const node = getLexicalTextNode(el);
    node.textContent = text;
    fireInputEvents(el, text);
  }

  function fireInputEvents(el, text) {
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
  }

  async function typeAndSendInstant(composer, text) {
    const target = findComposer() || composer;
    const normalized = collapseRepeatedString(String(text || "").trim());
    if (!normalized) throw new Error("无内容可发送");

    await focusComposer(target, true);
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(target);
      sel?.removeAllRanges();
      sel?.addRange(range);
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, normalized);
    } catch {
      setComposerText(target, normalized);
    }
    fireInputEvents(target, normalized);
    await sleep(8);

    const sent = await clickSendButton(target);
    if (!sent) await sendEnterKey(target);
    await sleep(35);
  }

  async function typeAndSend(composer, text, fast = false) {
    const target = findComposer() || composer;
    const normalized = collapseRepeatedString(String(text || "").trim());
    if (!normalized) throw new Error("无内容可发送");

    if (fast) {
      await typeAndSendInstant(target, normalized);
      return;
    }

    await clearComposer(target);
    setComposerText(target, normalized);
    await sleep(100);

    let current = getComposerText(target);
    if (current !== normalized) {
      await clearComposer(target);
      try {
        document.execCommand("insertText", false, normalized);
        fireInputEvents(target, normalized);
      } catch {
        setComposerText(target, normalized);
      }
      await sleep(80);
      current = getComposerText(target);
    }

    if (current !== normalized) {
      const compact = current.replace(/\s+/g, "");
      const expect = normalized.replace(/\s+/g, "");
      if (compact !== expect && !compact.startsWith(expect)) {
        throw new Error("输入内容与原文不一致，已中止发送以防重复");
      }
    }

    await sleep(SEND_DELAY_MS);
    const sent = await clickSendButton(target);
    if (!sent) await sendEnterKey(target);
    await sleep(280);
  }

  async function sendEnterKey(el) {
    el.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      })
    );
  }

  function findSendButtonNear(composer) {
    const roots = [];
    let p = composer;
    for (let i = 0; i < 8 && p; i++) {
      roots.push(p);
      p = p.parentElement;
    }
    roots.push(document.body);

    const labels = [/^send$/i, /^发送$/i, /press enter to send/i, /enter to send/i, /发送消息/i];

    for (const root of roots) {
      for (const btn of root.querySelectorAll('[role="button"], [aria-label]')) {
        const al = (btn.getAttribute("aria-label") || "").trim();
        if (!al || !isVisible(btn)) continue;
        if (labels.some((re) => re.test(al))) return btn;
        if (/send|发送/i.test(al) && !/unsend|取消发送|don't send/i.test(al)) return btn;
      }
    }
    return null;
  }

  async function clickSendButton(composer) {
    const btn = findSendButtonNear(composer);
    if (btn) {
      btn.click();
      return true;
    }
    const global = document.querySelector('[aria-label="Send"], [aria-label="发送"]');
    if (global instanceof HTMLElement && isVisible(global)) {
      global.click();
      return true;
    }
    return false;
  }

  function findAttachButton() {
    const labels = [
      /attach/i,
      /photo/i,
      /image/i,
      /file/i,
      /文件/i,
      /照片/i,
      /图片/i,
      /添加/i,
    ];
    return [...document.querySelectorAll("[aria-label], [role='button']")].find((el) => {
      const al = (el.getAttribute("aria-label") || "").trim();
      return labels.some((re) => re.test(al));
    });
  }

  function findFileInput() {
    const inputs = [...document.querySelectorAll('input[type="file"]')];
    return (
      inputs.find((inp) => {
        const acc = (inp.getAttribute("accept") || "").toLowerCase();
        return !acc || acc.includes("image");
      }) || inputs[0] ||
      null
    );
  }

  async function attachViaDrop(composer, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    for (const type of ["dragenter", "dragover", "drop"]) {
      composer.dispatchEvent(
        new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt })
      );
    }
  }

  function sendButtonReady(composer) {
    const btn = findSendButtonNear(composer);
    if (!(btn instanceof HTMLElement) || !isVisible(btn)) return false;
    if (btn.getAttribute("aria-disabled") === "true" || btn.hasAttribute("disabled")) return false;
    return true;
  }

  async function confirmSendOnce(composer, fast = false) {
    const c = findComposer() || composer;
    if (!c || !sendButtonReady(c)) return false;
    if (await clickSendButton(c)) return true;
    await sendEnterKey(c);
    await sleep(fast ? 80 : 200);
    return true;
  }

  async function attachFilesOnce(files, composer, fast = false) {
    if (!files?.length) return;
    const uploadFiles = files.length > 1 ? files : [files[0]];
    const target = composer || findComposer();
    if (!target) throw new Error("未找到输入框");
    const imgWait = fast ? IMAGE_SEND_WAIT_FAST_MS : IMAGE_SEND_WAIT_MS;

    await focusComposer(target);

    let input = findFileInput();
    if (!input) {
      const attachBtn = findAttachButton();
      if (attachBtn) {
        attachBtn.click();
        await sleep(fast ? 180 : 350);
        input = findFileInput();
      }
    }

    if (input) {
      const dt = new DataTransfer();
      for (const file of uploadFiles) dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(imgWait);
      if (sendButtonReady(target)) await confirmSendOnce(target, fast);
      return;
    }

    await attachViaDrop(target, uploadFiles[0]);
    await sleep(imgWait);
    await confirmSendOnce(target, fast);
  }

  async function imageRefToFile(ref, name) {
    if (typeof ref === "string" && ref.startsWith("data:image/")) {
      return dataUrlToFile(ref, name);
    }
    return urlToFile(ref, name);
  }

  function dataUrlToFile(dataUrl, name) {
    const [header, b64] = dataUrl.split(",");
    const mime = header.match(/:(.*?);/)?.[1] || "image/jpeg";
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new File([arr], name, { type: mime });
  }

  async function urlToFile(url, name) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`下载图片失败 ${res.status}`);
    const blob = await res.blob();
    return new File([blob], name, { type: blob.type || "image/jpeg" });
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
})();
