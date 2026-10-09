export const TAURITAVERN_VECTOR_MODE = "tauritavern";
export const TAURITAVERN_VECTOR_SOURCE = "tauritavern-trivium";
export const AUTHORITY_VECTOR_MODE = TAURITAVERN_VECTOR_MODE;
export const AUTHORITY_VECTOR_SOURCE = TAURITAVERN_VECTOR_SOURCE;

export function isTauriTavernVectorConfig(config = null) {
  const mode = String(config?.mode || "");
  const source = String(config?.source || "");
  return (
    mode === TAURITAVERN_VECTOR_MODE ||
    source === TAURITAVERN_VECTOR_SOURCE ||
    mode === "authority" ||
    source === "authority-trivium"
  );
}

export const isAuthorityVectorConfig = isTauriTavernVectorConfig;

export function normalizeTauriTavernVectorConfig(settings = {}, extra = {}) {
  const embeddingMode = settings.embeddingTransportMode === "backend" ? "backend" : "direct";
  return {
    mode: TAURITAVERN_VECTOR_MODE,
    source: TAURITAVERN_VECTOR_SOURCE,
    embeddingMode,
    embeddingSource: settings.embeddingBackendSource || "openai",
    apiUrl: String(settings.embeddingApiUrl || settings.embeddingBackendApiUrl || "").trim(),
    apiKey: String(settings.embeddingApiKey || "").trim(),
    model: String(settings.embeddingModel || settings.embeddingBackendModel || "").trim(),
    autoSuffix: settings.embeddingAutoSuffix !== false,
    graphStore: extra.graphStore || settings.graphStore || null,
    failOpen: settings.authorityVectorFailOpen !== false,
    bmeVectorApplyReady: false,
    bmeVectorManifestReady: false,
    bmeCandidateSearchReady: false,
  };
}

export const normalizeAuthorityVectorConfig = normalizeTauriTavernVectorConfig;

function getStore(config, options) {
  return options?.graphStore || config?.graphStore || null;
}

export async function upsertAuthorityTriviumEntries(graph, config, entries = [], options = {}) {
  const store = getStore(config, options);
  if (!store || typeof store.updateRecordVector !== "function") {
    throw new Error("TauriTavern graph store unavailable for vectors");
  }
  let upserted = 0;
  for (const entry of entries) {
    const vector = entry?.node?.embedding;
    if (Array.isArray(vector) && vector.length) {
      await store.updateRecordVector("node", entry.nodeId, vector);
      upserted += 1;
    }
  }
  return { diagnostics: { upserted, operation: "tauritavern-updateVector" } };
}

export async function searchAuthorityTriviumNodes(graph, text, config, options = {}) {
  const store = getStore(config, options);
  if (!store || typeof store.searchSimilar !== "function" || !Array.isArray(options.queryVector)) {
    return [];
  }
  const hits = await store.searchSimilar(options.queryVector, {
    topK: options.topK || 10,
    queryText: text,
  });
  const allowed = new Set(options.candidateIds || []);
  return hits
    .filter((hit) => !allowed.size || allowed.has(hit.id))
    .map((hit) => ({ nodeId: hit.id, score: hit.score, payload: hit.payload }));
}

export async function purgeAuthorityTriviumNamespace() {
  return { pages: 0, truncated: false, diagnostics: { operation: "tauritavern-noop-purge" } };
}

export async function deleteAuthorityTriviumNodes() {
  return { deleted: 0, diagnostics: { operation: "tauritavern-noop-delete" } };
}

export async function syncAuthorityTriviumLinks() {
  return { diagnostics: { operation: "tauritavern-native-links", linked: 0 } };
}

export async function applyAuthorityBmeVectorManifest() {
  const error = new Error("TauriTavern vector apply uses updateVector");
  error.code = "not_supported";
  throw error;
}

export async function fetchAuthorityBmeVectorManifest() {
  return null;
}

export async function testAuthorityTriviumConnection() {
  return { ok: true, source: TAURITAVERN_VECTOR_SOURCE };
}

export function createAuthorityTriviumClient() {
  return {};
}

export async function filterAuthorityTriviumNodes() {
  return { nodeIds: [], diagnostics: { operation: "tauritavern-noop-filter" } };
}

export async function queryAuthorityTriviumNeighbors() {
  return { nodeIds: [], diagnostics: { operation: "tauritavern-noop-neighbors" } };
}
