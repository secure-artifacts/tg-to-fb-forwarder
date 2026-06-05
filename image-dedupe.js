/**
 * 图片引用去重：同一消息里缩略图/大图/blob/data 只保留一份。
 */
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

/** 单张图消息只保留体积最大的一份 data URL */
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

if (typeof globalThis !== "undefined") {
  globalThis.TgFbImageDedupe = { imageRefFingerprint, dedupeImageRefs, pickSingleBestDataUrl };
}
