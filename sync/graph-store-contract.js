// ST-BME v3 GraphStore contract and pure router shell.
//
// Phase 6 only defines/validates the contract and route plans. Live adapters are
// ported in Phase 7 so durable routing is not switched accidentally.

export const GRAPH_STORE_CONTRACT_VERSION = 3;

export const GRAPH_STORE_KINDS = Object.freeze({
  AUTHORITY: "authority",
  OPFS: "opfs",
  INDEXEDDB: "indexeddb",
  LUKER_CHAT_STATE: "luker-chat-state",
  NONE: "none",
});

export const GRAPH_STORE_REQUIRED_METHODS = Object.freeze([
  "open",
  "close",
  "getMeta",
  "patchMeta",
  "commitDelta",
  "exportSnapshot",
  "exportSnapshotProbe",
  "importSnapshot",
]);

export const GRAPH_STORE_OPTIONAL_METHODS = Object.freeze([
  "readHead",
  "writeHead",
  "readCommitMarker",
  "writeCommitMarker",
  "isEmpty",
  "deleteAll",
]);

function normalizeStoreKind(value = "") {
  const kind = String(value || "").trim().toLowerCase();
  if (Object.values(GRAPH_STORE_KINDS).includes(kind)) return kind;
  return GRAPH_STORE_KINDS.NONE;
}

function methodExists(store = null, method = "") {
  return store && typeof store[method] === "function";
}

export function inspectGraphStoreContract(store = null, options = {}) {
  const requiredMethods = Array.isArray(options.requiredMethods)
    ? options.requiredMethods
    : GRAPH_STORE_REQUIRED_METHODS;
  const optionalMethods = Array.isArray(options.optionalMethods)
    ? options.optionalMethods
    : GRAPH_STORE_OPTIONAL_METHODS;
  const missingMethods = requiredMethods.filter((method) => !methodExists(store, method));
  const supportedOptionalMethods = optionalMethods.filter((method) => methodExists(store, method));
  return {
    contractVersion: GRAPH_STORE_CONTRACT_VERSION,
    valid: missingMethods.length === 0,
    storeKind: normalizeStoreKind(store?.storeKind || store?.kind),
    storeMode: String(store?.storeMode || store?.mode || ""),
    missingMethods,
    supportedOptionalMethods,
  };
}

export function assertGraphStoreContract(store = null, options = {}) {
  const inspection = inspectGraphStoreContract(store, options);
  if (!inspection.valid) {
    const error = new Error(`graph-store-contract-invalid:${inspection.missingMethods.join(",")}`);
    error.code = "graph_store_contract_invalid";
    error.contract = inspection;
    throw error;
  }
  return inspection;
}

function normalizeBoolean(value) {
  return value === true;
}

function normalizePreference(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "authority-sql") return GRAPH_STORE_KINDS.AUTHORITY;
  if (normalized === "opfs-primary" || normalized === "opfs-shadow") return GRAPH_STORE_KINDS.OPFS;
  if (normalized === "indexeddb") return GRAPH_STORE_KINDS.INDEXEDDB;
  if (normalized === "luker-chat-state") return GRAPH_STORE_KINDS.LUKER_CHAT_STATE;
  return "auto";
}

function pushUniqueRoute(routes, kind, reason = "") {
  const normalizedKind = normalizeStoreKind(kind);
  if (!normalizedKind || normalizedKind === GRAPH_STORE_KINDS.NONE) return;
  if (routes.some((route) => route.kind === normalizedKind)) return;
  routes.push({ kind: normalizedKind, reason: String(reason || normalizedKind) });
}

export function planGraphStoreRoute(input = {}) {
  const preference = normalizePreference(input.preference || input.primaryStorageTier || input.localStoreMode);
  const capabilities = input.capabilities && typeof input.capabilities === "object" ? input.capabilities : {};
  const environment = input.environment && typeof input.environment === "object" ? input.environment : {};
  const hardCutNamespace = input.hardCutNamespace && typeof input.hardCutNamespace === "object"
    ? input.hardCutNamespace
    : null;
  const routes = [];

  const authorityReady = normalizeBoolean(capabilities.authoritySqlReady || capabilities.storagePrimaryReady);
  const opfsReady = normalizeBoolean(capabilities.opfsReady || capabilities.opfsAvailable);
  const indexedDbReady =
    normalizeBoolean(capabilities.indexedDbReady) || normalizeBoolean(capabilities.indexedDbAvailable);
  const lukerReady = normalizeBoolean(environment.lukerChatStateReady || capabilities.lukerChatStateReady);

  if (preference === GRAPH_STORE_KINDS.AUTHORITY && authorityReady) {
    pushUniqueRoute(routes, GRAPH_STORE_KINDS.AUTHORITY, "preferred-authority-sql");
  }
  if (preference === GRAPH_STORE_KINDS.OPFS && opfsReady) {
    pushUniqueRoute(routes, GRAPH_STORE_KINDS.OPFS, "preferred-opfs");
  }
  if (preference === GRAPH_STORE_KINDS.INDEXEDDB && indexedDbReady) {
    pushUniqueRoute(routes, GRAPH_STORE_KINDS.INDEXEDDB, "preferred-indexeddb");
  }
  if (preference === GRAPH_STORE_KINDS.LUKER_CHAT_STATE && lukerReady) {
    pushUniqueRoute(routes, GRAPH_STORE_KINDS.LUKER_CHAT_STATE, "preferred-luker-chat-state");
  }

  if (authorityReady) pushUniqueRoute(routes, GRAPH_STORE_KINDS.AUTHORITY, "authority-sql-ready");
  if (opfsReady) pushUniqueRoute(routes, GRAPH_STORE_KINDS.OPFS, "opfs-ready");
  if (indexedDbReady) pushUniqueRoute(routes, GRAPH_STORE_KINDS.INDEXEDDB, "indexeddb-ready");
  if (lukerReady) pushUniqueRoute(routes, GRAPH_STORE_KINDS.LUKER_CHAT_STATE, "luker-chat-state-ready");

  return {
    contractVersion: GRAPH_STORE_CONTRACT_VERSION,
    hardCut: true,
    hotPathReadsLegacy: false,
    namespace: hardCutNamespace,
    primary: routes[0]?.kind || GRAPH_STORE_KINDS.NONE,
    fallback: routes.slice(1).map((route) => route.kind),
    routes,
    blocked: routes.length === 0,
    reason: routes.length ? routes[0].reason : "no-graph-store-route-ready",
  };
}
