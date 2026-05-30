// ST-BME reroll transaction boundary helpers.
//
// Pure helpers only. They keep the one-shot reroll recall reuse marker small,
// expiring, chat-bound, and tied to an unchanged parent user floor.

function normalizeText(value = "") {
  return String(value ?? "").replace(/\r\n/g, "\n").trim();
}

function normalizeChatId(value = "") {
  return String(value ?? "").trim();
}

function normalizeIndex(value = null) {
  return Number.isFinite(Number(value)) ? Math.floor(Number(value)) : null;
}

export function createRerollRecallReuseMarker({
  chatId = "",
  fromFloor = null,
  targetUserMessageIndex = null,
  userText = "",
  persistedRecord = null,
  hashRecallInput = null,
  now = Date.now(),
  meta = null,
} = {}) {
  const normalizedUserText = normalizeText(userText);
  if (!normalizedUserText) return { marker: null, reason: "missing-user-text" };

  const persistedInjection = normalizeText(persistedRecord?.injectionText || "");
  if (!persistedRecord || !persistedInjection) {
    return { marker: null, reason: "missing-persisted-recall" };
  }

  const boundText = normalizeText(
    persistedRecord?.boundUserFloorText || persistedRecord?.recallInput || "",
  );
  if (boundText && boundText !== normalizedUserText) {
    return { marker: null, reason: "bound-user-floor-mismatch" };
  }

  const hash =
    typeof hashRecallInput === "function"
      ? hashRecallInput(normalizedUserText)
      : normalizedUserText;

  return {
    marker: {
      chatId: normalizeChatId(chatId),
      fromFloor: normalizeIndex(fromFloor),
      targetUserMessageIndex: normalizeIndex(targetUserMessageIndex),
      userText: normalizedUserText,
      userHash: String(hash || ""),
      createdAt: Number(now || 0),
      meta,
    },
    reason: "prepared",
  };
}

export function consumeRerollRecallReuseMarker({
  marker = null,
  activeChatId = "",
  latestUserMessageIndex = null,
  currentUserText = "",
  hashRecallInput = null,
  now = Date.now(),
  ttlMs = 0,
} = {}) {
  if (!marker || typeof marker !== "object") {
    return { consumed: false, marker: null, reason: "missing-marker", override: null };
  }

  const markerChatId = normalizeChatId(marker.chatId);
  const normalizedActiveChatId = normalizeChatId(activeChatId);
  if (markerChatId && normalizedActiveChatId && markerChatId !== normalizedActiveChatId) {
    return { consumed: false, marker: null, reason: "chat-mismatch", override: null };
  }

  if (ttlMs > 0 && Number(now || 0) - Number(marker.createdAt || 0) > ttlMs) {
    return { consumed: false, marker: null, reason: "expired", override: null };
  }

  const targetUserMessageIndex = normalizeIndex(latestUserMessageIndex);
  const markerTargetIndex = normalizeIndex(marker.targetUserMessageIndex);
  if (targetUserMessageIndex !== markerTargetIndex) {
    return { consumed: false, marker: null, reason: "target-user-floor-changed", override: null };
  }

  const normalizedUserText = normalizeText(currentUserText);
  const currentHash =
    typeof hashRecallInput === "function"
      ? hashRecallInput(normalizedUserText)
      : normalizedUserText;
  if (!normalizedUserText || String(currentHash || "") !== String(marker.userHash || "")) {
    return { consumed: false, marker: null, reason: "user-text-changed", override: null };
  }

  return {
    consumed: true,
    marker: null,
    reason: "consumed",
    override: {
      overrideUserMessage: normalizedUserText,
      generationType: "normal",
      targetUserMessageIndex: markerTargetIndex,
      overrideSource: "chat-last-user",
      overrideSourceLabel: "历史最后用户楼层",
      overrideReason: "reroll-user-floor-reuse",
      sourceCandidates: [
        {
          text: normalizedUserText,
          source: "chat-last-user",
          sourceLabel: "历史最后用户楼层",
          reason: "reroll-user-floor-reuse",
          includeSyntheticUserMessage: false,
        },
      ],
      includeSyntheticUserMessage: false,
      rerollRecallReuse: true,
    },
  };
}
