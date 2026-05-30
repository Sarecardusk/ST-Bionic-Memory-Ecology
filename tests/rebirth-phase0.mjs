// ST-BME restrained rebirth — Phase 0 policy characterization.

import assert from "node:assert/strict";
import {
  LEGACY_DATA_RUNTIME_POLICY,
  LEGACY_DATA_SOURCES,
  PHASE0_BACKUP_CHECKLIST,
  REBIRTH_FORMAT_VERSION,
  V3_STORAGE_NAMESPACES,
  getRebirthPhase0Inventory,
  shouldV3RuntimeReadLegacySource,
} from "../runtime/rebirth-policy.mjs";

assert.equal(REBIRTH_FORMAT_VERSION, 3);

for (const [key, namespace] of Object.entries(V3_STORAGE_NAMESPACES)) {
  assert.match(namespace, /v3/, `${key} namespace must be versioned as v3`);
}
assert.equal(new Set(Object.values(V3_STORAGE_NAMESPACES)).size, Object.keys(V3_STORAGE_NAMESPACES).length);

console.log("  ✓ v3 namespaces are explicit and collision-resistant");

assert.equal(LEGACY_DATA_RUNTIME_POLICY.permanentRuntimeLegacyRead, false);
assert.equal(LEGACY_DATA_RUNTIME_POLICY.darkReadDualWriteMigration, false);
assert.deepEqual(LEGACY_DATA_RUNTIME_POLICY.allowedLegacyAccess, [
  "one-shot-importer",
  "explicit-export",
  "manual-reset",
]);
assert.equal(LEGACY_DATA_RUNTIME_POLICY.fallbackWhenNoImporter, "rebuild-from-chat-history");

for (const source of LEGACY_DATA_SOURCES) {
  assert.equal(source.runtimeAction, "ignore", `${source.id} must remain inert for v3 runtime`);
  assert.equal(
    shouldV3RuntimeReadLegacySource(source.id),
    false,
    `${source.id} must not be read by the v3 runtime`,
  );
  assert.notEqual(source.phase0Action, "runtime-read", `${source.id} must not plan a runtime read`);
}

for (const requiredSource of [
  "metadata-full-legacy",
  "commit-marker-legacy",
  "vector-manifest-legacy",
  "authority-sql-legacy",
]) {
  assert.ok(
    LEGACY_DATA_SOURCES.some((source) => source.id === requiredSource),
    `${requiredSource} must be represented in Phase 0 policy`,
  );
}

console.log("  ✓ legacy sources are inert for the v3 runtime");

const inventory = getRebirthPhase0Inventory();
assert.equal(inventory.formatVersion, 3);
assert.equal(inventory.policy.permanentRuntimeLegacyRead, false);
assert.equal(inventory.policy.fallbackWhenNoImporter, "rebuild-from-chat-history");
assert.equal(inventory.namespaces.authorityGraph, "authority-graph-v3");
assert.equal(inventory.namespaces.lukerSidecar, "luker-graph-v3");
assert.ok(inventory.legacyDataSources.length >= 6);
assert.ok(PHASE0_BACKUP_CHECKLIST.some((item) => item.id === "manual-graph-export"));
assert.ok(PHASE0_BACKUP_CHECKLIST.some((item) => item.id === "authority-reset-plan"));

console.log("  ✓ Phase 0 inventory exposes backup and cutover gates");
console.log("rebirth-phase0 tests passed");
