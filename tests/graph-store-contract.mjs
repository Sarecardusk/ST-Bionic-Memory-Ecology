// ST-BME restrained rebirth — Phase 6 GraphStore contract/router shell tests.

import assert from "node:assert/strict";
import {
  GRAPH_LEGACY_NAMESPACE_VALUES,
  GRAPH_V3_AUTHORITY_TABLES,
  GRAPH_V3_CHAT_STATE_NAMESPACE,
  GRAPH_V3_COMMIT_MARKER_KEY,
  GRAPH_V3_INDEXEDDB_NAME_PREFIX,
  GRAPH_V3_LUKER_CHECKPOINT_NAMESPACE,
  GRAPH_V3_LUKER_JOURNAL_NAMESPACE,
  GRAPH_V3_LUKER_MANIFEST_NAMESPACE,
  GRAPH_V3_METADATA_KEY,
  GRAPH_V3_MODULE_NAME,
  GRAPH_V3_OPFS_ROOT_DIRECTORY_NAME,
  buildGraphV3AuthorityPartition,
  buildGraphV3IndexedDbName,
  buildGraphV3OpfsChatPath,
  listGraphV3NamespaceValues,
  validateGraphV3NamespaceIsolation,
} from "../graph/graph-v3-namespace.js";
import {
  GRAPH_STORE_CONTRACT_VERSION,
  GRAPH_STORE_KINDS,
  assertGraphStoreContract,
  inspectGraphStoreContract,
  planGraphStoreRoute,
} from "../sync/graph-store-contract.js";

const v3Values = listGraphV3NamespaceValues();
assert.ok(v3Values.includes(GRAPH_V3_MODULE_NAME));
assert.ok(v3Values.includes(GRAPH_V3_METADATA_KEY));
assert.ok(v3Values.includes(GRAPH_V3_COMMIT_MARKER_KEY));
assert.ok(v3Values.includes(GRAPH_V3_CHAT_STATE_NAMESPACE));
assert.ok(v3Values.includes(GRAPH_V3_LUKER_MANIFEST_NAMESPACE));
assert.ok(v3Values.includes(GRAPH_V3_LUKER_JOURNAL_NAMESPACE));
assert.ok(v3Values.includes(GRAPH_V3_LUKER_CHECKPOINT_NAMESPACE));
assert.ok(v3Values.includes(GRAPH_V3_INDEXEDDB_NAME_PREFIX));
assert.ok(v3Values.includes(GRAPH_V3_OPFS_ROOT_DIRECTORY_NAME));
assert.ok(v3Values.includes(GRAPH_V3_AUTHORITY_TABLES.meta));

const isolation = validateGraphV3NamespaceIsolation();
assert.equal(isolation.isolated, true);
assert.deepEqual(isolation.conflicts, []);
assert.deepEqual(isolation.unsafePrefixConflicts, []);

for (const value of v3Values) {
  assert.equal(
    GRAPH_LEGACY_NAMESPACE_VALUES.includes(value),
    false,
    `v3 namespace must not reuse legacy value: ${value}`,
  );
}

assert.equal(buildGraphV3IndexedDbName("chat/a b"), "ST_BME_V3_chat_a_b");
assert.equal(buildGraphV3OpfsChatPath("chat/a b"), "stbme-v3/chats/chat_a_b");
assert.equal(buildGraphV3IndexedDbName("chat").startsWith("STBME_"), false);
assert.equal(buildGraphV3OpfsChatPath("chat").startsWith("st-bme"), false);
assert.equal(buildGraphV3AuthorityPartition("graph/a b"), "st_bme_v3:graph_a_b");

console.log("  ✓ v3 hard-cut namespaces are isolated from legacy keys");

function createMockStore(extra = {}) {
  return {
    storeKind: "authority",
    storeMode: "authority-sql-primary",
    async open() {},
    async close() {},
    async getMeta() {},
    async patchMeta() {},
    async commitDelta() {},
    async exportSnapshot() {},
    async exportSnapshotProbe() {},
    async importSnapshot() {},
    ...extra,
  };
}

const contract = inspectGraphStoreContract(createMockStore({ async readHead() {} }));
assert.equal(contract.contractVersion, GRAPH_STORE_CONTRACT_VERSION);
assert.equal(contract.valid, true);
assert.equal(contract.storeKind, GRAPH_STORE_KINDS.AUTHORITY);
assert.deepEqual(contract.missingMethods, []);
assert.ok(contract.supportedOptionalMethods.includes("readHead"));
assert.doesNotThrow(() => assertGraphStoreContract(createMockStore()));

assert.throws(
  () => assertGraphStoreContract(createMockStore({ commitDelta: undefined })),
  /graph-store-contract-invalid:commitDelta/,
);

console.log("  ✓ GraphStore contract validates existing adapter-shaped stores");

const authorityPlan = planGraphStoreRoute({
  preference: "authority-sql",
  capabilities: { authoritySqlReady: true, opfsReady: true, indexedDbReady: true },
  environment: { lukerChatStateReady: true },
  hardCutNamespace: { moduleName: GRAPH_V3_MODULE_NAME },
});
assert.equal(authorityPlan.hardCut, true);
assert.equal(authorityPlan.hotPathReadsLegacy, false);
assert.equal(authorityPlan.primary, GRAPH_STORE_KINDS.AUTHORITY);
assert.deepEqual(authorityPlan.fallback, [
  GRAPH_STORE_KINDS.OPFS,
  GRAPH_STORE_KINDS.INDEXEDDB,
  GRAPH_STORE_KINDS.LUKER_CHAT_STATE,
]);
assert.equal(authorityPlan.namespace.moduleName, GRAPH_V3_MODULE_NAME);

const lukerPlan = planGraphStoreRoute({
  primaryStorageTier: "luker-chat-state",
  capabilities: { authoritySqlReady: false, opfsReady: false, indexedDbReady: false },
  environment: { lukerChatStateReady: true },
});
assert.equal(lukerPlan.primary, GRAPH_STORE_KINDS.LUKER_CHAT_STATE);

const blockedPlan = planGraphStoreRoute({
  capabilities: { authoritySqlReady: false, opfsReady: false, indexedDbReady: false },
  environment: { lukerChatStateReady: false },
});
assert.equal(blockedPlan.blocked, true);
assert.equal(blockedPlan.reason, "no-graph-store-route-ready");

const emptyCapabilityPlan = planGraphStoreRoute({});
assert.equal(
  emptyCapabilityPlan.blocked,
  true,
  "Phase 6 shell must not assume IndexedDB readiness when callers omit capabilities",
);

console.log("  ✓ v3 router shell plans routes without switching live persistence");
console.log("graph-store-contract tests passed");
