/**
 * Facebook 发送：在已打开的 FB 页面主环境发请求（Cookie 可用）。
 * 不导航到群聊页，只用 thread_id 发送。
 */
const FB_SESSION_TTL_MS = 8 * 60 * 1000;
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

async function getFacebookSession(force = false) {
  if (!force && fbSessionCache && Date.now() - fbSessionCache.at < FB_SESSION_TTL_MS) {
    return fbSessionCache;
  }

  const urls = ["https://www.facebook.com/messages/", "https://www.facebook.com/"];
  let html = "";
  for (const url of urls) {
    try {
      const res = await fetchFb(url);
      html = await res.text();
      if (html.length > 1000) break;
    } catch {
      /* try next */
    }
  }

  if (!html) throw new Error("无法连接 Facebook，请检查网络");

  if (/\/login|name="email"/i.test(html) && !/"USER_ID":"\d+"/.test(html)) {
    throw new Error("请先在 Chrome 登录 Facebook（不必打开群聊页）");
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
    throw new Error("无法获取 Facebook 登录状态，请打开 facebook.com/messages 登录后再试");
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
  const res = await fetchFb(`https://upload.facebook.com/ajax/react_composer/attachments/photo/upload${av}`, {
    method: "POST",
    body: form,
  });
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

async function tryMercurySendEndpoints(threadId, session, payload, fetchImpl = fetchFb) {
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

  const docIds = [
    session.graphqlDocId,
    "25633026871396835",
    "7342919075459530",
  ].filter(Boolean);
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

    const res = await fetchFb("https://www.facebook.com/api/graphql/", {
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
    if (graphqlSendSucceeded(json)) return { ok: true };
    lastErr = "GraphQL 未返回成功结果";
  }

  throw new Error(lastErr);
}

async function sendPayloadWithSession(threadId, session, payload) {
  const mercury = await tryMercurySendEndpoints(threadId, session, payload);
  if (mercury.ok) return { ok: true, mode: mercury.mode, url: mercury.url };

  await sendViaGraphQL(threadId, session, payload);
  return { ok: true, mode: "graphql" };
}

async function sendMessengerJob(threadId, job) {
  const text = String(job.text || "").trim();
  const images = (job.imageDataUrls || []).slice(0, 5);
  if (!text && !images.length) throw new Error("无内容可发送");

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

/**
 * 在 FB 标签页主环境执行（executeScript world: MAIN）
 * 必须自包含，不能引用扩展变量。
 */
function pageContextSendMessenger(threadId, text, imageDataUrls) {
  function extractDtsg(html) {
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

  function extractLsd(html) {
    const m =
      html.match(/"LSD",\[\],\{"token":"([^"]+)"/) || html.match(/name="lsd"\s+value="([^"]+)"/);
    return m?.[1] || "";
  }

  function extractUserId(html) {
    const m = html.match(/"USER_ID":"(\d+)"/) || html.match(/"actorID":"(\d+)"/);
    return m?.[1] || "";
  }

  function parseJson(text) {
    const raw = String(text || "").replace(/^\s*for\s*\(;;\);\s*/, "");
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function dataUrlToBlobLocal(dataUrl) {
    const [header, b64] = String(dataUrl).split(",");
    const mime = header.match(/:(.*?);/)?.[1] || "image/jpeg";
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  function readDtsgFromRuntime() {
    try {
      if (typeof require === "function") {
        const mod = require("DTSGInitData") || require("DTSG");
        if (mod?.token) return mod.token;
      }
    } catch {
      /* ignore */
    }
    return extractDtsg(document.documentElement.innerHTML);
  }

  function readUserId() {
    const html = document.documentElement.innerHTML;
    let id = extractUserId(html);
    if (!id) {
      try {
        const mod = typeof require === "function" && require("CurrentUserInitialData");
        if (mod?.USER_ID) id = String(mod.USER_ID);
      } catch {
        /* ignore */
      }
    }
    return id;
  }

  function parseMercuryResponse(res, body) {
    if (res.status === 404) return { ok: false, error: "HTTP 404", retry: true };
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, retry: res.status >= 500 };
    const json = parseJson(body);
    if (json?.error || json?.errorSummary) {
      return { ok: false, error: json.errorSummary || json.error, retry: false };
    }
    if (/login|checkpoint/i.test(body) && !/payload|success/i.test(body)) {
      return { ok: false, error: "需要重新登录 Facebook", retry: false };
    }
    return { ok: true };
  }

  function buildBatchForm(fb_dtsg, userId, lsd) {
    const form = new URLSearchParams();
    form.set("fb_dtsg", fb_dtsg);
    if (lsd) form.set("lsd", lsd);
    if (userId) form.set("__user", userId);
    form.set("__a", "1");
    const p = "message_batch[0]";
    if (text) form.set(`${p}[body]`, String(text));
    form.set(`${p}[action_type]`, "ma-type:user-generated-message");
    form.set(`${p}[client]`, "mercury");
    form.set(`${p}[source]`, "source:chat:web");
    form.set(`${p}[timestamp]`, String(Date.now()));
    form.set(`${p}[specific_to_list][0]`, `fbid:${threadId}`);
    if (userId) {
      form.set(`${p}[author]`, `fbid:${userId}`);
      form.set(`${p}[specific_to_list][1]`, `fbid:${userId}`);
    }
    form.set(`${p}[other_user_fbid]`, String(threadId));
    form.set(`${p}[thread_id]`, String(threadId));
    for (const id of imageIds) form.append(`${p}[image_ids][]`, id);
    return form;
  }

  function buildThreadForm(fb_dtsg, userId, lsd) {
    const form = new URLSearchParams();
    form.set("fb_dtsg", fb_dtsg);
    if (lsd) form.set("lsd", lsd);
    if (userId) form.set("__user", userId);
    form.set("__a", "1");
    if (text) form.set("body", String(text));
    form.set("thread_id", String(threadId));
    form.set("action_type", "ma-type:user-generated-message");
    form.set("client", "mercury");
    form.set("source", "source:chat:web");
    form.set("timestamp", String(Date.now()));
    form.set("specific_to_list[0]", `fbid:${threadId}`);
    if (userId) {
      form.set("specific_to_list[1]", `fbid:${userId}`);
      form.set("author", `fbid:${userId}`);
    }
    form.set("other_user_fbid", String(threadId));
    for (const id of imageIds) form.append("image_ids[]", id);
    return form;
  }

  async function tryGraphqlSend(fb_dtsg, userId, lsd) {
    const input = {
      thread_id: String(threadId),
      message: { text: String(text || "") },
      actor_id: userId || undefined,
      attribution_id_v2: "",
    };
    if (imageIds.length) {
      input.attachments = imageIds.map((id) => ({ media: { id }, actor_id: userId }));
    }
    const form = new URLSearchParams();
    form.set("fb_dtsg", fb_dtsg);
    if (lsd) form.set("lsd", lsd);
    if (userId) form.set("__user", userId);
    form.set("__a", "1");
    form.set("fb_api_caller_class", "RelayModern");
    form.set("fb_api_req_friendly_name", "MWChatSendMessageMutation");
    form.set("variables", JSON.stringify({ input }));
    form.set("doc_id", "25633026871396835");
    const res = await fetch("https://www.facebook.com/api/graphql/", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const body = await res.text();
    const json = parseJson(body);
    const err = json?.errors?.[0]?.message;
    if (err) return { ok: false, error: err };
    if (!res.ok) return { ok: false, error: `GraphQL HTTP ${res.status}` };
    return { ok: true, mode: "page-graphql" };
  }

  return (async () => {
    try {
    const start = Date.now();
    let fb_dtsg = "";
    while (Date.now() - start < 12000) {
      fb_dtsg = readDtsgFromRuntime();
      if (fb_dtsg) break;
      await new Promise((r) => setTimeout(r, 450));
    }
    const html = document.documentElement.innerHTML;
    const userId = readUserId();
    const lsd = extractLsd(html);
    if (!fb_dtsg) {
      return {
        ok: false,
        error: "FB 会话令牌未加载：请打开 facebook.com/messages 标签页按 F5 刷新一次",
      };
    }

    const imageIds = [];
    for (const dataUrl of imageDataUrls || []) {
      if (!dataUrl) continue;
      const form = new FormData();
      form.append("fb_dtsg", fb_dtsg);
      form.append("profile_id", userId || "0");
      form.append("source", "8");
      form.append("upload_id", String(Date.now()));
      form.append("farr", dataUrlToBlobLocal(dataUrl), "tg.jpg");
      const av = userId ? `?av=${userId}` : "";
      const up = await fetch(
        `https://upload.facebook.com/ajax/react_composer/attachments/photo/upload${av}`,
        { method: "POST", credentials: "include", body: form }
      );
      const upJson = parseJson(await up.text());
      const payload = upJson?.payload || upJson;
      const id = payload?.photoID || payload?.photo_id || payload?.fbid;
      if (id) imageIds.push(String(id));
    }

    const attempts = [
      {
        url: "https://www.facebook.com/ajax/mercury/send_messages.php",
        form: buildBatchForm(fb_dtsg, userId, lsd),
      },
      {
        url: "https://www.facebook.com/messaging/send/?dpr=1",
        form: buildThreadForm(fb_dtsg, userId, lsd),
      },
    ];

    let lastErr = "发送失败";
    for (const attempt of attempts) {
      const res = await fetch(attempt.url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: attempt.form.toString(),
      });
      const body = await res.text();
      const parsed = parseMercuryResponse(res, body);
      if (parsed.ok) return { ok: true, mode: "page-mercury", url: attempt.url };
      lastErr = parsed.error || lastErr;
      if (!parsed.retry) break;
    }

    const gql = await tryGraphqlSend(fb_dtsg, userId, lsd);
    if (gql.ok) return gql;

    return { ok: false, error: gql.error || lastErr || "Messenger 接口不可用" };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  })();
}

if (typeof globalThis !== "undefined") {
  globalThis.TgFbApiSend = {
    getFacebookSession,
    sendMessengerJob,
    pageContextSendMessenger,
    invalidateSession() {
      fbSessionCache = null;
    },
  };
}
