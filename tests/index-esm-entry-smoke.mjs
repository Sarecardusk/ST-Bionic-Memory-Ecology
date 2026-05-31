import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { saveGraphToIndexedDbImpl } from "../sync/graph-persistence-io.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.resolve(moduleDir, "../index.js");
const indexSource = await fs.readFile(indexPath, "utf8");

function extractSnippet(startMarker, endMarker) {
  const start = indexSource.indexOf(startMarker);
  const end = indexSource.indexOf(endMarker, start);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`无法提取 index.js 片段: ${startMarker} -> ${endMarker}`);
  }
  return indexSource.slice(start, end).replace(/^export\s+/gm, "");
}

const saveGraphSnippet = extractSnippet(
  "async function saveGraphToIndexedDb(",
  "function normalizePersistObservabilityKey(",
);

const tempModulePath = path.resolve(
  moduleDir,
  "../.tmp-index-esm-entry-smoke.mjs",
);

await fs.writeFile(
  tempModulePath,
  `
const GRAPH_LOAD_STATES = { SHADOW_RESTORED: "shadow-restored", LOADED: "loaded" };
const AUTHORITY_GRAPH_STORE_KIND = "authority";
const BME_INDEXEDDB_FALLBACK_LOAD_STATE_SET = new Set(["idle", "loading", "blocked", "shadow-restored"]);
let currentGraph = null;
let graphPersistenceState = {
  metadataIntegrity: "",
  loadState: "loaded",
  revision: 0,
  lastPersistedRevision: 0,
  lastAcceptedRevision: 0,
  cacheMirrorState: "idle",
  persistDiagnosticTier: "none",
  hostProfile: "generic-st",
  primaryStorageTier: "indexeddb",
  cacheStorageTier: "none",
  shadowSnapshotRevision: 0,
  shadowSnapshotUpdatedAt: "",
  shadowSnapshotReason: "",
};
let nativePersistDeltaInstallPromise = null;
let nativeHydrateInstallPromise = null;
const bmeIndexedDbLatestQueuedRevisionByChatId = new Map();
const bmeIndexedDbWriteInFlightByChatId = new Map();
const saveGraphToIndexedDbImpl = globalThis.__saveGraphToIndexedDbImpl;
function normalizeChatIdCandidate(value = "") { return String(value ?? "").trim(); }
function normalizeIndexedDbRevision(value, fallbackValue = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : Math.max(0, Number(fallbackValue) || 0);
}
function getContext() { return { chatId: "chat-esm", chatMetadata: {}, characterId: "char-esm" }; }
function getSettings() {
  return {
    persistNativeDeltaBridgeMode: "json",
    persistUseNativeDelta: false,
    graphNativeForceDisable: false,
    nativeEngineFailOpen: true,
  };
}
function ensureBmeChatManager() {
  return {
    async getCurrentDb() {
      return {
        async exportSnapshot() {
          return { meta: { revision: 0 }, nodes: [], edges: [], tombstones: [], state: { lastProcessedFloor: -1, extractionCount: 0 } };
        },
        async commitDelta(delta, options = {}) {
          if (globalThis.__testCommitShouldThrow) {
            throw new Error("commit-failed");
          }
          return {
            revision: Number(options.requestedRevision || 1),
            lastModified: Date.now(),
            delta,
          };
        },
      };
    },
  };
}
function getPreferredGraphLocalStorePresentationSync() {
  return { storagePrimary: "indexeddb", storageMode: "indexeddb", statusLabel: "IndexedDB", reasonPrefix: "indexeddb" };
}
function resolveDbGraphStorePresentation(db) {
  return { storagePrimary: "indexeddb", storageMode: "indexeddb", statusLabel: "IndexedDB", reasonPrefix: "indexeddb" };
}
function buildPersistenceEnvironment() {
  return { hostProfile: "generic-st", primaryStorageTier: "indexeddb", cacheStorageTier: "none" };
}
function resolveCurrentChatIdentity() {
  return { integrity: "meta-esm", hostChatId: "host-esm" };
}
function readCachedIndexedDbSnapshot() { return null; }
function resolvePersistRevisionFloor(revision = 0) { return Number(revision) || 1; }
function buildPersistDeltaFromGraphDirtyState() { return null; }
function pruneGraphPersistDirtyState() { return null; }
function buildSnapshotFromGraph(graph, options = {}) {
  return {
    meta: {
      revision: Number(options.revision || 1),
      storagePrimary: "indexeddb",
      storageMode: "indexeddb",
      integrity: "meta-esm",
    },
    nodes: [],
    edges: [],
    tombstones: [],
    state: { lastProcessedFloor: -1, extractionCount: 0 },
  };
}
function evaluatePersistNativeDeltaGate() {
  return {
    allowed: false,
    reasons: [],
    minSnapshotRecords: 0,
    minStructuralDelta: 0,
    minCombinedSerializedChars: 0,
    beforeRecordCount: 0,
    afterRecordCount: 0,
    maxSnapshotRecords: 0,
    structuralDelta: 0,
  };
}
function readPersistDeltaDiagnosticsNow() { return Date.now(); }
function normalizePersistDeltaDiagnosticsMs(value = 0) { return Math.round((Number(value) || 0) * 10) / 10; }
function updatePersistDeltaDiagnostics() {}
function buildPersistObservabilitySummary() { return { totalSamples: 1 }; }
function buildPersistDelta() {
  return {
    upsertNodes: [],
    upsertEdges: [],
    deleteNodeIds: [],
    deleteEdgeIds: [],
    tombstones: [],
    runtimeMetaPatch: {},
  };
}
function cloneRuntimeDebugValue(value, fallback = null) { return value == null ? fallback : JSON.parse(JSON.stringify(value)); }
function buildBmeSyncRuntimeOptions() { return {}; }
function scheduleUpload() {}
function cacheIndexedDbSnapshot() {}
function stampGraphPersistenceMeta() {}
function getChatMetadataIntegrity() { return "meta-esm"; }
function clearPendingGraphPersistRetry() {}
function areChatIdsEquivalentForResolvedIdentity() { return false; }
function applyGraphLoadState() {}
function rememberResolvedGraphIdentityAlias() {}
function resolveLocalStoreTierFromPresentation() { return "indexeddb"; }
function updateGraphPersistenceState(patch = {}) { graphPersistenceState = { ...graphPersistenceState, ...(patch || {}) }; return graphPersistenceState; }
function getCurrentGraph() { return currentGraph; }
function setCurrentGraph(graph) { currentGraph = graph; return currentGraph; }
function getGraphPersistenceState() { return graphPersistenceState; }
function setGraphPersistenceState(patch = {}) { graphPersistenceState = { ...graphPersistenceState, ...(patch || {}) }; return graphPersistenceState; }
function getNativePersistDeltaInstallPromise() { return nativePersistDeltaInstallPromise; }
function setNativePersistDeltaInstallPromise(promise) { nativePersistDeltaInstallPromise = promise; }
function getNativeHydrateInstallPromise() { return nativeHydrateInstallPromise; }
function setNativeHydrateInstallPromise(promise) { nativeHydrateInstallPromise = promise; }
function createGraphPersistenceIoRuntime() {
  return {
    AUTHORITY_GRAPH_STORE_KIND,
    BME_INDEXEDDB_FALLBACK_LOAD_STATE_SET,
    GRAPH_LOAD_STATES,
    applyGraphLoadState,
    areChatIdsEquivalentForResolvedIdentity,
    bmeIndexedDbLatestQueuedRevisionByChatId,
    bmeIndexedDbWriteInFlightByChatId,
    buildBmeSyncRuntimeOptions,
    buildPersistDelta,
    buildPersistDeltaFromGraphDirtyState,
    buildPersistObservabilitySummary,
    buildPersistenceEnvironment,
    buildSnapshotFromGraph,
    cacheIndexedDbSnapshot,
    clearPendingGraphPersistRetry,
    cloneRuntimeDebugValue,
    console,
    ensureBmeChatManager,
    evaluatePersistNativeDeltaGate,
    getChatMetadataIntegrity,
    getContext,
    getCurrentChatId: () => "chat-esm",
    getCurrentGraph,
    getGraphPersistenceState,
    getNativeHydrateInstallPromise,
    getNativePersistDeltaInstallPromise,
    getPreferredGraphLocalStorePresentationSync,
    getSettings,
    normalizeChatIdCandidate,
    normalizeIndexedDbRevision,
    normalizePersistDeltaDiagnosticsMs,
    pruneGraphPersistDirtyState,
    readCachedIndexedDbSnapshot,
    readPersistDeltaDiagnosticsNow,
    recordLocalPersistEarlyFailure: () => {},
    rememberResolvedGraphIdentityAlias,
    resolveCurrentChatIdentity,
    resolveDbGraphStorePresentation,
    resolveLocalStoreTierFromPresentation,
    resolvePersistRevisionFloor,
    scheduleUpload,
    setCurrentGraph,
    setGraphPersistenceState,
    setNativeHydrateInstallPromise,
    setNativePersistDeltaInstallPromise,
    stampGraphPersistenceMeta,
    updateGraphPersistenceState,
    updatePersistDeltaDiagnostics,
  };
}
${saveGraphSnippet}
export { saveGraphToIndexedDb };
`,
  "utf8",
);

try {
  globalThis.__saveGraphToIndexedDbImpl = saveGraphToIndexedDbImpl;
  const smokeModule = await import(
    `${pathToFileURL(tempModulePath).href}?t=${Date.now()}`
  );
  const success = await smokeModule.saveGraphToIndexedDb(
    "chat-esm",
    { historyState: {} },
    { revision: 2, reason: "esm-success" },
  );
  assert.equal(success.saved, true);
  assert.equal(success.accepted, true);

  globalThis.__testCommitShouldThrow = true;
  const failed = await smokeModule.saveGraphToIndexedDb(
    "chat-esm",
    { historyState: {} },
    { revision: 3, reason: "esm-failure" },
  );
  assert.equal(failed.saved, false);
  assert.equal(failed.reason, "indexeddb-write-failed");
} finally {
  delete globalThis.__testCommitShouldThrow;
  delete globalThis.__saveGraphToIndexedDbImpl;
  await fs.unlink(tempModulePath).catch(() => {});
}

console.log("index-esm-entry-smoke tests passed");
