/**
 * Facebook Messenger 纯后台 API 发送（Service Worker + Cookie）。
 * 不依赖任何 FB 标签页、不模拟点击/输入。
 */
const FB_SESSION_TTL_MS = (typeof TgFbConfig !== "undefined" && TgFbConfig.FB_SESSION_TTL_MS) || 8 * 60 * 1000;
const FB_FETCH_TIMEOUT_MS = 15000;
let fbSessionCache = null;

function parseFbJsonResponse(text) {
  const raw = String(text || "").replace(/^\s*for\s*\(;;\);\s*/, "");
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractFromHtml(html, patterns) {
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return m[1];
  }
  return "";
}

const FB_FETCH_HEADERS = {
  Accept: "*/*",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
};

async function fetchFb(url, init = {}) {
  return fetch(url, {
    credentials: "include",
    redirect: "follow",
    ...init,
    headers: { ...FB_FETCH_HEADERS, ...(init.headers || {}) },
  });
}

async function fetchFbWithTimeout(url, init = {}, timeoutMs = FB_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchFb(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error("连接 Facebook 超时，请检查网络后重试");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFacebookHtml() {
  const urls = ["https://www.facebook.com/messages/", "https://www.facebook.com/"];
  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await fetchFbWithTimeout(url);
      const html = await res.text();
      if (html.length > 1000) return html;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
  throw new Error("无法连接 Facebook，请检查网络");
}

async function getFacebookSession(force = false) {
  if (!force && fbSessionCache && Date.now() - fbSessionCache.at < FB_SESSION_TTL_MS) {
    return fbSessionCache;
  }

  let html = "";
  try {
    html = await fetchFacebookHtml();
  } catch (err) {
    if (!force) {
      await sleep(400);
      try {
        html = await fetchFacebookHtml();
      } catch (retryErr) {
        throw retryErr;
      }
    } else {
      throw err;
    }
  }

  if (/\/login|name="email"/i.test(html) && !/"USER_ID":"\d+"/.test(html)) {
    throw new Error("请在任意 Chrome 标签页登录 Facebook，无需保持页面打开");
  }

  const fb_dtsg = extractFromHtml(html, [
    /"DTSGInitialData",\[\],\{"token":"([^"]+)"/,
    /"DTSGInitData",\[\],\{"token":"([^"]+)"/,
    /"dtsg":\{"token":"([^"]+)"/,
    /name="fb_dtsg"\s+value="([^"]+)"/,
    /"token":"([^"]+)","async_get_token"/,
  ]);
  const lsd = extractFromHtml(html, [
    /"LSD",\[\],\{"token":"([^"]+)"/,
    /name="lsd"\s+value="([^"]+)"/,
  ]);
  const userId = extractFromHtml(html, [
    /"USER_ID":"(\d+)"/,
    /"actorID":"(\d+)"/,
    /"ACCOUNT_ID":"(\d+)"/,
  ]);

  if (!fb_dtsg) {
    throw new Error("无法获取 Facebook 会话：请在任意标签页登录 facebook.com 后重试");
  }

  const graphqlDocId =
    extractFromHtml(html, [
      /"MWChatSendMessageMutation"[^}]{0,400}"doc_id":"(\d+)"/,
      /"doc_id":"(\d+)"[^}]{0,400}"MWChatSendMessageMutation"/,
      /MWChatSendMessageMutation[^}]{0,200}doc_id['":\s]+(\d+)/,
    ]) || "25633026871396835";

  fbSessionCache = { fb_dtsg, lsd, userId, graphqlDocId, at: Date.now() };
  return fbSessionCache;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function dataUrlToBlob(dataUrl) {
  const [header, b64] = String(dataUrl).split(",");
  const mime = header.match(/:(.*?);/)?.[1] || "image/jpeg";
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

async function uploadImageDataUrl(dataUrl, session) {
  const blob = dataUrlToBlob(dataUrl);
  const form = new FormData();
  form.append("fb_dtsg", session.fb_dtsg);
  form.append("profile_id", session.userId || "0");
  form.append("source", "8");
  form.append("upload_id", String(Date.now()));
  form.append("farr", blob, "tg-forward.jpg");

  const av = session.userId ? `?av=${session.userId}` : "";
  const res = await fetchFbWithTimeout(
    `https://upload.facebook.com/ajax/react_composer/attachments/photo/upload${av}`,
    { method: "POST", body: form },
    30000
  );
  const json = parseFbJsonResponse(await res.text());
  const payload = json?.payload || json;
  const id =
    payload?.photoID ||
    payload?.photo_id ||
    payload?.image_id ||
    payload?.fbid ||
    payload?.metadata?.[0]?.fbid;
  if (!id) throw new Error("图片上传失败");
  return String(id);
}

function buildMercuryBatchForm(session, threadId, { text, imageIds }) {
  const form = new URLSearchParams();
  form.set("fb_dtsg", session.fb_dtsg);
  if (session.lsd) form.set("lsd", session.lsd);
  if (session.userId) form.set("__user", session.userId);
  form.set("__a", "1");

  const p = "message_batch[0]";
  if (text) form.set(`${p}[body]`, text);
  form.set(`${p}[action_type]`, "ma-type:user-generated-message");
  form.set(`${p}[client]`, "mercury");
  form.set(`${p}[source]`, "source:chat:web");
  form.set(`${p}[timestamp]`, String(Date.now()));
  form.set(`${p}[specific_to_list][0]`, `fbid:${threadId}`);
  if (session.userId) {
    form.set(`${p}[author]`, `fbid:${session.userId}`);
    form.set(`${p}[specific_to_list][1]`, `fbid:${session.userId}`);
  }
  form.set(`${p}[other_user_fbid]`, String(threadId));
  form.set(`${p}[thread_id]`, String(threadId));

  for (const id of imageIds || []) {
    form.append(`${p}[image_ids][]`, String(id));
  }
  return form;
}

function buildMercuryThreadForm(session, threadId, { text, imageIds }) {
  const form = new URLSearchParams();
  form.set("fb_dtsg", session.fb_dtsg);
  if (session.lsd) form.set("lsd", session.lsd);
  if (session.userId) form.set("__user", session.userId);
  form.set("__a", "1");
  if (text) form.set("body", text);
  form.set("thread_id", String(threadId));
  form.set("action_type", "ma-type:user-generated-message");
  form.set("client", "mercury");
  form.set("source", "source:chat:web");
  form.set("timestamp", String(Date.now()));
  form.set("specific_to_list[0]", `fbid:${threadId}`);
  if (session.userId) {
    form.set("specific_to_list[1]", `fbid:${session.userId}`);
    form.set("author", `fbid:${session.userId}`);
  }
  form.set("other_user_fbid", String(threadId));

  for (const id of imageIds || []) {
    form.append("image_ids[]", String(id));
  }
  return form;
}

const MERCURY_SEND_ATTEMPTS = [
  {
    url: "https://www.facebook.com/ajax/mercury/send_messages.php",
    build: buildMercuryBatchForm,
  },
  {
    url: "https://www.facebook.com/messaging/send/?dpr=1",
    build: buildMercuryThreadForm,
  },
];

function parseMercurySendResponse(res, body) {
  if (res.status === 404) return { ok: false, error: "HTTP 404", retry: true };
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, retry: res.status >= 500 };
  const json = parseFbJsonResponse(body);
  if (json?.error || json?.errorSummary) {
    return { ok: false, error: json.errorSummary || json.error, retry: false };
  }
  if (/login|checkpoint/i.test(body) && !/payload|success/i.test(body)) {
    return { ok: false, error: "Facebook 要求重新登录或安全验证", retry: false };
  }
  return { ok: true };
}

async function tryMercurySendEndpoints(threadId, session, payload, fetchImpl = fetchFbWithTimeout) {
  let lastErr = "发送失败";
  for (const attempt of MERCURY_SEND_ATTEMPTS) {
    const form = attempt.build(session, threadId, payload);
    const res = await fetchImpl(attempt.url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const body = await res.text();
    const parsed = parseMercurySendResponse(res, body);
    if (parsed.ok) return { ok: true, mode: "mercury", url: attempt.url };
    lastErr = parsed.error || lastErr;
    if (!parsed.retry) break;
  }
  return { ok: false, error: lastErr };
}

function parseGraphqlJson(body) {
  const json = parseFbJsonResponse(body);
  if (json) return json;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function graphqlSendSucceeded(json) {
  if (!json) return false;
  if (json.errors?.length) return false;
  const data = json.data;
  if (!data) return true;
  const node = data.send_chat_message || data.xma_send_message || Object.values(data)[0];
  if (!node) return true;
  if (node.errors?.length) return false;
  return true;
}

async function sendViaGraphQL(threadId, session, { text, imageIds }) {
  const input = {
    thread_id: String(threadId),
    message: { text: text || "" },
    actor_id: session.userId || undefined,
    attribution_id_v2: "",
  };
  if (imageIds?.length) {
    input.attachments = imageIds.map((id) => ({
      media: { id },
      actor_id: session.userId,
    }));
  }

  const docIds = [session.graphqlDocId, "25633026871396835", "7342919075459530"].filter(Boolean);
  const seen = new Set();
  let lastErr = "GraphQL 发送失败";

  for (const docId of docIds) {
    if (seen.has(docId)) continue;
    seen.add(docId);

    const form = new URLSearchParams();
    form.set("fb_dtsg", session.fb_dtsg);
    if (session.lsd) form.set("lsd", session.lsd);
    if (session.userId) form.set("__user", session.userId);
    form.set("__a", "1");
    form.set("fb_api_caller_class", "RelayModern");
    form.set("fb_api_req_friendly_name", "MWChatSendMessageMutation");
    form.set("variables", JSON.stringify({ input }));
    form.set("doc_id", docId);

    const res = await fetchFbWithTimeout("https://www.facebook.com/api/graphql/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const body = await res.text();
    const json = parseGraphqlJson(body);
    const err = json?.errors?.[0]?.message;
    if (err) {
      lastErr = err;
      continue;
    }
    if (!res.ok) {
      lastErr = `GraphQL HTTP ${res.status}`;
      continue;
    }
    if (graphqlSendSucceeded(json)) return { ok: true, mode: "graphql" };
    lastErr = "GraphQL 未返回成功结果";
  }

  throw new Error(lastErr);
}

async function sendPayloadWithSession(threadId, session, payload) {
  const mercury = await tryMercurySendEndpoints(threadId, session, payload);
  if (mercury.ok) return { ok: true, mode: mercury.mode, url: mercury.url };

  return sendViaGraphQL(threadId, session, payload);
}

async function sendMessengerJob(threadId, job) {
  const text = String(job.text || "");
  const images = (job.imageDataUrls || []).slice(0, 5);
  if (!text.trim() && !images.length) throw new Error("无内容可发送");

  let session = await getFacebookSession();
  const imageIds = [];
  for (const dataUrl of images) {
    try {
      imageIds.push(await uploadImageDataUrl(dataUrl, session));
    } catch {
      session = await getFacebookSession(true);
      imageIds.push(await uploadImageDataUrl(dataUrl, session));
    }
  }

  return sendPayloadWithSession(threadId, session, { text, imageIds });
}

if (typeof globalThis !== "undefined") {
  globalThis.TgFbApiSend = {
    getFacebookSession,
    sendMessengerJob,
    invalidateSession() {
      fbSessionCache = null;
    },
  };
}
