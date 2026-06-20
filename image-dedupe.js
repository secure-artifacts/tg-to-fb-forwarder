/**
 * 图片引用去重：优先按 URL 路径；data/blob 用内容采样哈希，避免“同长度误判为同图”。
 */
function fnv1aHash(str) {
  let hash = 2166136261;
  const s = String(str || "");
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function normalizeImageUrlRef(ref) {
  const s = String(ref || "").trim();
  if (!s) return "";
  if (s.startsWith("blob:") || s.startsWith("data:")) return s;
  try {
    const u = new URL(s, "https://web.telegram.org");
    return `${u.origin}${u.pathname}`;
  } catch {
    return s.split("?")[0].split("#")[0];
  }
}

function imageRefFingerprint(ref) {
  const s = String(ref || "").trim();
  if (!s) return "";
  if (s.startsWith("data:image/")) {
    const b64 = s.split(",")[1] || "";
    if (!b64) return "data:empty";
    if (b64.length <= 8192) return `data:${fnv1aHash(b64)}`;
    const sample = b64.slice(0, 4096) + b64.slice(-4096) + String(b64.length);
    return `data:${fnv1aHash(sample)}`;
  }
  if (s.startsWith("blob:")) {
    return `blob:${fnv1aHash(s)}`;
  }
  return normalizeImageUrlRef(s);
}

function scoreImageRef(ref) {
  const s = String(ref || "").trim();
  let score = 0;
  if (s.startsWith("https://")) score += 1000;
  else if (s.startsWith("http://")) score += 800;
  else if (s.startsWith("blob:")) score += 400;
  else if (s.startsWith("data:image/")) score += 200;
  score += Math.min(s.length, 500);
  return score;
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

/** 单张图消息只保留质量最高的一份引用 */
function pickSingleBestDataUrl(refs) {
  const list = dedupeImageRefs(refs, 5);
  if (list.length <= 1) return list;
  let best = list[0];
  let bestScore = scoreImageRef(best);
  for (let i = 1; i < list.length; i++) {
    const score = scoreImageRef(list[i]);
    if (score > bestScore) {
      bestScore = score;
      best = list[i];
    }
  }
  return [best];
}

if (typeof globalThis !== "undefined") {
  globalThis.TgFbImageDedupe = {
    fnv1aHash,
    normalizeImageUrlRef,
    imageRefFingerprint,
    dedupeImageRefs,
    pickSingleBestDataUrl,
  };
}
