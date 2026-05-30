// ST-BME v3 hard-cut namespace constants.
//
// These constants intentionally do not alias legacy st_bme/st-bme/STBME keys.
// Phase 6 introduces the namespace contract only; live routes are ported later.

export const GRAPH_V3_NAMESPACE_VERSION = 3;
export const GRAPH_V3_MODULE_NAME = "st_bme_v3";

export const GRAPH_V3_METADATA_KEY = `${GRAPH_V3_MODULE_NAME}_graph`;
export const GRAPH_V3_COMMIT_MARKER_KEY = `${GRAPH_V3_MODULE_NAME}_commit_marker`;
export const GRAPH_V3_CHAT_STATE_NAMESPACE = `${GRAPH_V3_MODULE_NAME}_graph_state`;
export const GRAPH_V3_LUKER_MANIFEST_NAMESPACE = `${GRAPH_V3_MODULE_NAME}_graph_manifest`;
export const GRAPH_V3_LUKER_JOURNAL_NAMESPACE = `${GRAPH_V3_MODULE_NAME}_graph_journal`;
export const GRAPH_V3_LUKER_CHECKPOINT_NAMESPACE = `${GRAPH_V3_MODULE_NAME}_graph_checkpoint`;
export const GRAPH_V3_SHADOW_SNAPSHOT_STORAGE_PREFIX = `${GRAPH_V3_MODULE_NAME}:graph-shadow:`;
export const GRAPH_V3_IDENTITY_ALIAS_STORAGE_KEY = `${GRAPH_V3_MODULE_NAME}:chat-identity-aliases`;

export const GRAPH_V3_INDEXEDDB_NAME_PREFIX = "ST_BME_V3";
export const GRAPH_V3_OPFS_ROOT_DIRECTORY_NAME = "stbme-v3";
export const GRAPH_V3_AUTHORITY_TABLES = Object.freeze({
  meta: `${GRAPH_V3_MODULE_NAME}_graph_meta`,
  nodes: `${GRAPH_V3_MODULE_NAME}_graph_nodes`,
  edges: `${GRAPH_V3_MODULE_NAME}_graph_edges`,
  tombstones: `${GRAPH_V3_MODULE_NAME}_graph_tombstones`,
});

export const GRAPH_LEGACY_NAMESPACE_VALUES = Object.freeze([
  "st_bme",
  "st_bme_graph",
  "st_bme_commit_marker",
  "st_bme_graph_state",
  "st_bme_graph_manifest",
  "st_bme_graph_journal",
  "st_bme_graph_checkpoint",
  "st_bme:graph-shadow:",
  "st_bme:chat-identity-aliases",
  "STBME_",
  "st-bme",
  "st_bme_graph_meta",
  "st_bme_graph_nodes",
  "st_bme_graph_edges",
  "st_bme_graph_tombstones",
]);

function normalizeNamespaceSegment(value = "") {
  return String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "default";
}

export function buildGraphV3IndexedDbName(chatId = "") {
  return `${GRAPH_V3_INDEXEDDB_NAME_PREFIX}_${normalizeNamespaceSegment(chatId)}`;
}

export function buildGraphV3OpfsChatPath(chatId = "") {
  return `${GRAPH_V3_OPFS_ROOT_DIRECTORY_NAME}/chats/${normalizeNamespaceSegment(chatId)}`;
}

export function buildGraphV3AuthorityPartition(graphId = "") {
  return `${GRAPH_V3_MODULE_NAME}:${normalizeNamespaceSegment(graphId)}`;
}

export function listGraphV3NamespaceValues() {
  return Object.freeze([
    GRAPH_V3_MODULE_NAME,
    GRAPH_V3_METADATA_KEY,
    GRAPH_V3_COMMIT_MARKER_KEY,
    GRAPH_V3_CHAT_STATE_NAMESPACE,
    GRAPH_V3_LUKER_MANIFEST_NAMESPACE,
    GRAPH_V3_LUKER_JOURNAL_NAMESPACE,
    GRAPH_V3_LUKER_CHECKPOINT_NAMESPACE,
    GRAPH_V3_SHADOW_SNAPSHOT_STORAGE_PREFIX,
    GRAPH_V3_IDENTITY_ALIAS_STORAGE_KEY,
    GRAPH_V3_INDEXEDDB_NAME_PREFIX,
    GRAPH_V3_OPFS_ROOT_DIRECTORY_NAME,
    ...Object.values(GRAPH_V3_AUTHORITY_TABLES),
  ]);
}

export function validateGraphV3NamespaceIsolation(legacyValues = GRAPH_LEGACY_NAMESPACE_VALUES) {
  const legacy = new Set((Array.isArray(legacyValues) ? legacyValues : []).map((value) => String(value)));
  const conflicts = listGraphV3NamespaceValues().filter((value) => legacy.has(String(value)));
  const unsafePrefixConflicts = [];
  if (GRAPH_V3_INDEXEDDB_NAME_PREFIX.startsWith("STBME_")) {
    unsafePrefixConflicts.push({ surface: "indexeddb", legacyPrefix: "STBME_" });
  }
  if (GRAPH_V3_OPFS_ROOT_DIRECTORY_NAME.startsWith("st-bme")) {
    unsafePrefixConflicts.push({ surface: "opfs", legacyPrefix: "st-bme" });
  }
  return {
    isolated: conflicts.length === 0 && unsafePrefixConflicts.length === 0,
    conflicts,
    unsafePrefixConflicts,
    namespaceVersion: GRAPH_V3_NAMESPACE_VERSION,
  };
}
