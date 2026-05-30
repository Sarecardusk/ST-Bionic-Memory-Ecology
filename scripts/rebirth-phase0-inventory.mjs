#!/usr/bin/env node

import { getRebirthPhase0Inventory } from "../runtime/rebirth-policy.mjs";

const inventory = getRebirthPhase0Inventory();

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(inventory, null, 2));
  process.exit(0);
}

console.log("ST-BME v3 restrained rebirth — Phase 0 policy inventory / cutover checklist");
console.log(`formatVersion: ${inventory.formatVersion}`);
console.log("\nV3 namespaces:");
for (const [key, value] of Object.entries(inventory.namespaces)) {
  console.log(`  - ${key}: ${value}`);
}

console.log("\nLegacy runtime policy:");
console.log(`  permanentRuntimeLegacyRead: ${inventory.policy.permanentRuntimeLegacyRead}`);
console.log(`  darkReadDualWriteMigration: ${inventory.policy.darkReadDualWriteMigration}`);
console.log(`  allowedLegacyAccess: ${inventory.policy.allowedLegacyAccess.join(", ")}`);
console.log(`  fallbackWhenNoImporter: ${inventory.policy.fallbackWhenNoImporter}`);

console.log("\nLive adapter targets to port (not rewrite):");
for (const target of inventory.liveAdapterTargets) {
  console.log(`  - ${target}`);
}

console.log("\nLegacy data sources:");
for (const source of inventory.legacyDataSources) {
  console.log(`  - ${source.id}: runtime=${source.runtimeAction}, phase0=${source.phase0Action}`);
}

console.log("\nBackup / cutover checklist:");
for (const item of inventory.backupChecklist) {
  console.log(`  - [${item.id}] ${item.label}`);
}
