// ST-BME restrained rebirth policy.
//
// Phase 0 deliberately keeps this module side-effect free. It records the
// project-level cutover contract so later phases cannot quietly reintroduce a
// permanent legacy data-format compatibility layer.

export const REBIRTH_FORMAT_VERSION = 3;

export const V3_STORAGE_NAMESPACES = Object.freeze({
  root: "st-bme-v3",
  graph: "graph-v3",
  commitMarker: "commit-marker-v3",
  vectorManifest: "vector-manifest-v3",
  authorityGraph: "authority-graph-v3",
  lukerSidecar: "luker-graph-v3",
});

export const LEGACY_DATA_RUNTIME_POLICY = Object.freeze({
  permanentRuntimeLegacyRead: false,
  darkReadDualWriteMigration: false,
  allowedLegacyAccess: Object.freeze(["one-shot-importer", "explicit-export", "manual-reset"]),
  fallbackWhenNoImporter: "rebuild-from-chat-history",
});

export const LIVE_ADAPTER_TARGETS = Object.freeze([
  "indexeddb",
  "opfs",
  "authority-sql",
  "luker-chat-state",
  "vector-manifest",
]);

export const LEGACY_DATA_SOURCES = Object.freeze([
  Object.freeze({
    id: "indexeddb-legacy",
    kind: "graph-store",
    runtimeAction: "ignore",
    phase0Action: "inventory-or-export",
    notes: "Old IndexedDB snapshots/migration stores must not be auto-read by v3 runtime.",
  }),
  Object.freeze({
    id: "opfs-legacy",
    kind: "graph-store",
    runtimeAction: "ignore",
    phase0Action: "inventory-or-export",
    notes: "Old OPFS v1/v2 graph layouts require explicit import or reset.",
  }),
  Object.freeze({
    id: "authority-sql-legacy",
    kind: "server-graph-store",
    runtimeAction: "ignore",
    phase0Action: "inventory-or-export",
    notes: "Authority v3 must use a graphId/schema-version namespace and reject old rows by default.",
  }),
  Object.freeze({
    id: "luker-sidecar-legacy",
    kind: "host-chat-state",
    runtimeAction: "ignore",
    phase0Action: "inventory-or-export",
    notes: "Legacy Luker manifest/journal/checkpoint keys remain inert unless an importer reads them.",
  }),
  Object.freeze({
    id: "metadata-full-legacy",
    kind: "chat-metadata",
    runtimeAction: "ignore",
    phase0Action: "inventory-or-export",
    notes: "Old full graph blobs in chat metadata are not a v3 runtime source.",
  }),
  Object.freeze({
    id: "commit-marker-legacy",
    kind: "chat-metadata",
    runtimeAction: "ignore",
    phase0Action: "inventory-or-export",
    notes: "Old commit markers are evidence only for a one-shot importer, not v3 acceptance state.",
  }),
  Object.freeze({
    id: "vector-manifest-legacy",
    kind: "vector-state",
    runtimeAction: "ignore",
    phase0Action: "reset-or-rebuild",
    notes: "Vectors are rebuildable; legacy vector manifests must not contaminate v3 graphId/vectorSpaceId.",
  }),
]);

export const PHASE0_BACKUP_CHECKLIST = Object.freeze([
  Object.freeze({
    id: "manual-graph-export",
    label: "Export current graph JSON from the ST-BME panel before enabling v3.",
    source: "ui-actions-controller:onExportGraphController",
  }),
  Object.freeze({
    id: "server-backup",
    label: "If Authority/server backup is used, create a server backup envelope first.",
    source: "sync/bme-sync:backupToServer",
  }),
  Object.freeze({
    id: "authority-reset-plan",
    label: "Plan an explicit Authority v3 namespace/reset so old SQL/blob/vector rows cannot be selected.",
    source: "runtime/rebirth-policy:V3_STORAGE_NAMESPACES.authorityGraph",
  }),
  Object.freeze({
    id: "legacy-import-decision",
    label: "Decide per legacy source: one-shot import, export-only backup, rebuild from chat history, or discard.",
    source: "runtime/rebirth-policy:LEGACY_DATA_SOURCES",
  }),
]);

export function getRebirthPhase0Inventory() {
  return {
    formatVersion: REBIRTH_FORMAT_VERSION,
    namespaces: { ...V3_STORAGE_NAMESPACES },
    policy: {
      permanentRuntimeLegacyRead: LEGACY_DATA_RUNTIME_POLICY.permanentRuntimeLegacyRead,
      darkReadDualWriteMigration: LEGACY_DATA_RUNTIME_POLICY.darkReadDualWriteMigration,
      allowedLegacyAccess: [...LEGACY_DATA_RUNTIME_POLICY.allowedLegacyAccess],
      fallbackWhenNoImporter: LEGACY_DATA_RUNTIME_POLICY.fallbackWhenNoImporter,
    },
    liveAdapterTargets: [...LIVE_ADAPTER_TARGETS],
    legacyDataSources: LEGACY_DATA_SOURCES.map((source) => ({ ...source })),
    backupChecklist: PHASE0_BACKUP_CHECKLIST.map((item) => ({ ...item })),
  };
}

export function shouldV3RuntimeReadLegacySource(sourceId) {
  const source = LEGACY_DATA_SOURCES.find((entry) => entry.id === sourceId);
  if (!source) return false;
  return source.runtimeAction === "read";
}
