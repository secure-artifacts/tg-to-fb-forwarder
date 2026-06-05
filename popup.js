const statusEl = document.getElementById("status");

if (!chrome?.runtime?.id) {
  document.addEventListener("DOMContentLoaded", () => {
    setStatus("扩展未正确加载，请到 chrome://extensions 点「重新加载」", "err");
  });
}

function setStatus(text, type) {
  statusEl.hidden = false;
  statusEl.textContent = text;
  statusEl.className = `status ${type || "ok"}`;
}

function send(type, payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (res?.ok === false) reject(new Error(res.error || "失败"));
      else resolve(res);
    });
  });
}

function warnInvalidTgUrl(url) {
  if (!url) return "";
  const m = url.match(/#(.+)$/);
  if (!m) return "";
  const id = decodeURIComponent(m[1]).replace(/[^\d-@a-zA-Z_]/g, "");
  if (!id || /^-?0+$/.test(id)) {
    return "群链接无效（ID 全为 0 或为空），将打开 TG 首页，请登录后从左侧点进群组";
  }
  return "";
}

document.getElementById("openTgTabBtn").addEventListener("click", async () => {
  try {
    const url = document.getElementById("tgGroupUrl")?.value?.trim() || "";
    const warn = warnInvalidTgUrl(url);
    const res = await send("OPEN_TG_TAB", { url });
    if (warn) setStatus(warn, "err");
    else setStatus(res.created ? "已打开 Telegram 并进入该群链接" : "已切换到 Telegram 群聊页", "ok");
  } catch (e) {
    setStatus(e.message, "err");
  }
});

send("GET_CONFIG")
  .then((res) => {
    const u = res.config?.telegramChatUrl || "";
    const input = document.getElementById("tgGroupUrl");
    if (input && u) input.value = u;
  })
  .catch((e) => setStatus(e.message || "无法连接扩展后台", "err"));
