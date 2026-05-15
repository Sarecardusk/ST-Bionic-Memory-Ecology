import { stableHashString } from "../runtime/runtime-state.js";

export const VECTOR_MANIFEST_VERSION = 1;

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeLower(value) {
  return normalizeString(value).toLowerCase();
}

export function normalizeVectorApiUrl(value) {
  const raw = normalizeString(value);
  if (!raw) return "";
  try {
    const url = new URL(raw, raw.startsWith("/") ? "http://st-bme.local" : undefined);
    url.hash = "";
    url.search = "";
    let pathname = url.pathname.replace(/\/+$/, "");
    pathname = pathname.replace(/\/embeddings$/i, "").replace(/\/v1$/i, "/v1");
    const normalized = `${url.protocol}//${url.host}${pathname}`.replace(/\/+$/, "");
    return raw.startsWith("/") ? normalized.replace(/^http:\/\/st-bme\.local/i, "") : normalized;
  } catch {
    return raw.replace(/[?#].*$/, "").replace(/\/+$/, "").replace(/\/embeddings$/i, "");
  }
}

export function getVectorProviderKind(config = {}) {
  if (config?.mode === "authority" || config?.source === "authority-trivium") {
    return "authority-client";
  }
  if (config?.mode === "backend") {
    return "st-backend";
  }
  return "direct-openai-compatible";
}

export function getVectorEmbeddingMode(config = {}) {
  if (config?.mode === "backend") return "st-backend";
  if (config?.embeddingMode === "server") return "server";
  return "client";
}

export function deriveVectorSpace(config = {}, observedDim = 0, extra = {}) {
  const dim = Math.max(0, Math.floor(Number(observedDim) || 0));
  const providerKind = normalizeLower(extra.providerKind || getVectorProviderKind(config));
  const embeddingMode = normalizeLower(extra.embeddingMode || getVectorEmbeddingMode(config));
  const source = normalizeLower(config.embeddingSource || config.source || "");
  const normalizedApiUrl = normalizeVectorApiUrl(
    config.apiUrl || config.baseUrl || extra.apiUrl || "",
  );
  const model = normalizeString(config.model || extra.model || "");
  const material = {
    providerKind,
    embeddingMode,
    source,
    normalizedApiUrl,
    model,
    observedDim: dim,
  };
  const vectorSpaceId = dim > 0
    ? `vs_${stableHashString(JSON.stringify(material))}`
    : "";
  return {
    vectorSpaceId,
    providerKind,
    embeddingMode,
    source,
    normalizedApiUrl,
    model,
    observedDim: dim,
    settingsFingerprint: stableHashString(JSON.stringify({ ...material, observedDim: undefined })),
    probedAt: Number(extra.probedAt || Date.now()),
  };
}

export function createVectorManifest({
  backend = "local",
  chatId = "",
  collectionId = "",
  graphRevision = 0,
  vectorSpace = null,
  status = "missing",
  nodeCount = 0,
  embeddedNodeCount = 0,
  failedNodeCount = 0,
  lastError = "",
} = {}) {
  const observedDim = Math.max(0, Math.floor(Number(vectorSpace?.observedDim) || 0));
  const now = Date.now();
  return {
    manifestVersion: VECTOR_MANIFEST_VERSION,
    backend,
    chatId,
    collectionId,
    graphRevision: Math.max(0, Math.floor(Number(graphRevision) || 0)),
    vectorSpaceId: vectorSpace?.vectorSpaceId || "",
    observedDim,
    model: vectorSpace?.model || "",
    normalizedApiUrl: vectorSpace?.normalizedApiUrl || "",
    status,
    nodeCount: Math.max(0, Math.floor(Number(nodeCount) || 0)),
    embeddedNodeCount: Math.max(0, Math.floor(Number(embeddedNodeCount) || 0)),
    failedNodeCount: Math.max(0, Math.floor(Number(failedNodeCount) || 0)),
    createdAt: now,
    completedAt: status === "clean" ? now : 0,
    lastError: lastError || "",
  };
}

export function isVectorManifestCompatible(manifest, vectorSpace) {
  if (!manifest || !vectorSpace) return false;
  if (manifest.status !== "clean") return false;
  if (!manifest.vectorSpaceId || !vectorSpace.vectorSpaceId) return false;
  if (manifest.vectorSpaceId !== vectorSpace.vectorSpaceId) return false;
  return Number(manifest.observedDim || 0) === Number(vectorSpace.observedDim || 0);
}

export function summarizeVectorSpaceChange(previous, current) {
  if (!previous?.vectorSpaceId || !current?.vectorSpaceId) return "vector-space-missing";
  if (previous.vectorSpaceId === current.vectorSpaceId) return "unchanged";
  if (Number(previous.observedDim || 0) !== Number(current.observedDim || 0)) {
    return "dimension-changed";
  }
  if (previous.model !== current.model) return "model-changed";
  if (previous.normalizedApiUrl !== current.normalizedApiUrl) return "endpoint-changed";
  return "vector-space-changed";
}
