/**
 * 从 Telegram Web 的 React 内部 props 读取消息元数据（发送者、消息 ID、图片 URL）。
 * DOM 结构变化时作为比纯 DOM 遍历更稳定的优先路径。
 */
(function () {
  const metaCache = new WeakMap();
  const MAX_PROP_DEPTH = 8;
  const MAX_FIBER_DEPTH = 36;

  function getReactFiber(el) {
    if (!el || !(el instanceof Element)) return null;
    for (const key of Object.keys(el)) {
      if (key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")) {
        return el[key];
      }
    }
    return null;
  }

  function looksLikeTelegramMessage(obj) {
    if (!obj || typeof obj !== "object") return false;
    const hasId = obj.id != null || obj.mid != null || obj.messageId != null;
    if (!hasId) return false;
    return !!(obj.sender || obj.isOutgoing != null || obj.content || obj.chatId);
  }

  function deepFindMessage(root, seen, depth) {
    if (!root || depth > MAX_PROP_DEPTH) return null;
    if (typeof root !== "object") return null;
    if (seen.has(root)) return null;
    seen.add(root);

    if (looksLikeTelegramMessage(root)) return root;

    if (Array.isArray(root)) {
      for (const item of root) {
        const found = deepFindMessage(item, seen, depth + 1);
        if (found) return found;
      }
      return null;
    }

    for (const value of Object.values(root)) {
      if (!value || typeof value !== "object") continue;
      const found = deepFindMessage(value, seen, depth + 1);
      if (found) return found;
    }
    return null;
  }

  function senderNameFromMessage(msg) {
    const sender = msg?.sender;
    if (!sender || typeof sender !== "object") return "";

    const parts = [sender.firstName, sender.lastName].filter(Boolean);
    if (parts.length) return parts.join(" ").trim();
    if (sender.title) return String(sender.title).trim();
    if (sender.name) return String(sender.name).trim();
    if (sender.usernames?.[0]?.username) return String(sender.usernames[0].username).trim();
    if (sender.username) return String(sender.username).trim();
    return "";
  }

  function pickBestPhotoUrl(photo) {
    if (!photo) return "";
    if (typeof photo === "string") return photo;
    if (photo.blobUrl) return String(photo.blobUrl);
    if (photo.url) return String(photo.url);
    if (photo.src) return String(photo.src);

    const sizes = photo.sizes || photo.thumbnails;
    if (Array.isArray(sizes) && sizes.length) {
      const preferred = sizes.find((s) => s?.type === "w" || s?.type === "y") || sizes[sizes.length - 1];
      return String(preferred?.url || preferred?.src || preferred?.location || "");
    }
    return "";
  }

  function imageUrlsFromContent(content) {
    const urls = [];
    if (!content || typeof content !== "object") return urls;

    const pushUrl = (url) => {
      const u = String(url || "").trim();
      if (u && !urls.includes(u)) urls.push(u);
    };

    if (content.photo) pushUrl(pickBestPhotoUrl(content.photo));

    const albumPhotos = content.album?.photos || content.album?.items;
    if (Array.isArray(albumPhotos)) {
      for (const photo of albumPhotos.slice(0, 5)) {
        pushUrl(pickBestPhotoUrl(photo));
      }
    }

    if (content.document?.mimeType?.startsWith("image/")) {
      pushUrl(content.document.url || content.document.previewBlobUrl);
    }

    return urls;
  }

  function normalizeMessageId(msg) {
    if (!msg) return "";
    const id = msg.id ?? msg.mid ?? msg.messageId;
    return id != null ? String(id) : "";
  }

  function buildMetaFromMessage(msg) {
    if (!msg) return null;
    return {
      messageId: normalizeMessageId(msg),
      senderName: senderNameFromMessage(msg),
      isOutgoing: msg.isOutgoing === true,
      peerId: msg.peerId != null ? String(msg.peerId) : "",
      imageUrls: imageUrlsFromContent(msg.content),
    };
  }

  function scanElementForMessageMeta(el) {
    const fiber = getReactFiber(el);
    if (!fiber) return null;

    let node = fiber;
    let depth = 0;
    while (node && depth < MAX_FIBER_DEPTH) {
      const propsList = [node.memoizedProps, node.pendingProps].filter(Boolean);
      for (const props of propsList) {
        const direct =
          props.message ||
          props.chatMessage ||
          props.messageData ||
          (looksLikeTelegramMessage(props) ? props : null);
        if (direct) {
          const meta = buildMetaFromMessage(direct);
          if (meta?.messageId || meta?.senderName || meta?.imageUrls?.length) return meta;
        }
        const found = deepFindMessage(props, new WeakSet(), 0);
        if (found) {
          const meta = buildMetaFromMessage(found);
          if (meta?.messageId || meta?.senderName || meta?.imageUrls?.length) return meta;
        }
      }
      node = node.return;
      depth += 1;
    }
    return null;
  }

  function getMessageMeta(el) {
    if (!el) return null;
    if (metaCache.has(el)) return metaCache.get(el);
    const meta = scanElementForMessageMeta(el);
    metaCache.set(el, meta);
    return meta;
  }

  function getSenderName(el) {
    const meta = getMessageMeta(el);
    return meta?.senderName || "";
  }

  function getImageUrls(el) {
    const meta = getMessageMeta(el);
    return meta?.imageUrls?.length ? [...meta.imageUrls] : [];
  }

  if (typeof globalThis !== "undefined") {
    globalThis.TgReactBridge = {
      getMessageMeta,
      getSenderName,
      getImageUrls,
      invalidate(el) {
        if (el) metaCache.delete(el);
      },
    };
  }
})();
