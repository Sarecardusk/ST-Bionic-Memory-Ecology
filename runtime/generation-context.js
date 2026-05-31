const DEFAULT_GENERATION_CONTEXT_TTL_MS = 60000;

export function normalizeGenerationType(type = "normal") {
  const normalized = String(type || "normal").trim();
  return normalized || "normal";
}

export function classifyGenerationKind(type = "normal", params = {}) {
  const generationType = normalizeGenerationType(type);
  if (params?.automatic_trigger || params?.quiet_prompt) {
    return "skip";
  }
  if (generationType === "quiet" || generationType === "impersonate") {
    return "skip";
  }
  if (
    generationType === "swipe" ||
    generationType === "regenerate" ||
    generationType === "continue"
  ) {
    return "no-new-user";
  }
  return "fresh";
}

function clonePlain(value, fallback = null) {
  if (!value || typeof value !== "object") return fallback;
  try {
    return structuredClone(value);
  } catch (_error) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_jsonError) {
      return fallback;
    }
  }
}

export function createGenerationContextTracker(deps = {}) {
  let current = null;
  let pendingSwipe = null;
  let sequence = 0;

  const now = () =>
    typeof deps.now === "function" ? Number(deps.now()) || Date.now() : Date.now();
  const ttlMs = () =>
    Number.isFinite(Number(deps.ttlMs))
      ? Math.max(1, Number(deps.ttlMs))
      : DEFAULT_GENERATION_CONTEXT_TTL_MS;
  const getChatId = () => String(deps.getCurrentChatId?.() || "").trim();

  function noteSwipe(messageId = null, meta = null) {
    const parsed = Number(messageId);
    pendingSwipe = {
      assistantFloor: Number.isFinite(parsed) ? Math.floor(parsed) : null,
      meta: clonePlain(meta, null),
      chatId: getChatId(),
      at: now(),
    };
    return pendingSwipe;
  }

  function begin(type = "normal", params = {}, { dryRun = false, phase = "" } = {}) {
    if (dryRun) return null;
    const at = now();
    const generationType = normalizeGenerationType(type);
    const kind = classifyGenerationKind(generationType, params);
    const context = {
      id: `${at}:${++sequence}`,
      type: generationType,
      kind,
      chatId: getChatId(),
      params: clonePlain(params, {}),
      dryRun: false,
      startedAt: at,
      updatedAt: at,
      phase: String(phase || ""),
      swipedAssistantFloor:
        generationType === "swipe" && Number.isFinite(pendingSwipe?.assistantFloor)
          ? pendingSwipe.assistantFloor
          : null,
      swipeMeta: generationType === "swipe" ? clonePlain(pendingSwipe?.meta, null) : null,
      expectedMutation: "",
      expectedMutationAt: 0,
    };
    pendingSwipe = null;
    current = context;
    return { ...context };
  }

  function update(type = "normal", params = {}, { dryRun = false, phase = "" } = {}) {
    if (dryRun) return null;
    const at = now();
    const generationType = normalizeGenerationType(type);
    const kind = classifyGenerationKind(generationType, params);
    if (!current || current.type !== generationType || current.chatId !== getChatId()) {
      return begin(generationType, params, { dryRun, phase });
    }
    current = {
      ...current,
      type: generationType,
      kind,
      params: clonePlain(params, current.params || {}),
      updatedAt: at,
      afterCommandsAt:
        String(phase || "") === "GENERATION_AFTER_COMMANDS"
          ? at
          : current.afterCommandsAt || 0,
      phase: String(phase || current.phase || ""),
    };
    return { ...current };
  }

  function get({ allowStale = false } = {}) {
    if (!current) return null;
    const age = now() - Number(current.updatedAt || current.startedAt || 0);
    if (!allowStale && age > ttlMs()) {
      current = null;
      return null;
    }
    const activeChatId = getChatId();
    if (current.chatId && activeChatId && current.chatId !== activeChatId) {
      current = null;
      return null;
    }
    return { ...current };
  }

  function markExpectedMutation(kind = "", payload = {}) {
    if (!current) return null;
    current = {
      ...current,
      expectedMutation: String(kind || ""),
      expectedMutationAt: now(),
      expectedMutationPayload: clonePlain(payload, {}),
      updatedAt: now(),
    };
    return { ...current };
  }

  function clear(reason = "") {
    const previous = current;
    current = null;
    pendingSwipe = null;
    return previous ? { ...previous, clearReason: String(reason || "") } : null;
  }

  return {
    begin,
    update,
    get,
    clear,
    noteSwipe,
    markExpectedMutation,
  };
}
