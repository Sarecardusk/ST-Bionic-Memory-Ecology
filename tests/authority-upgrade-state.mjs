import assert from "node:assert/strict";

import {
  createAuthorityUpgradeState,
  deriveAuthorityUpgradeState,
  formatAuthorityUpgradeMeta,
} from "../runtime/authority-upgrade-state.js";
import { createGraphPersistenceState } from "../ui/ui-status.js";

const initial = createAuthorityUpgradeState();
assert.equal(initial.mode, "standalone");
assert.equal(initial.ready, false);

const graphState = createGraphPersistenceState();
assert.equal(graphState.authorityUpgradeMode, "standalone");
assert.equal(graphState.authorityUpgradeReady, false);
assert.equal(graphState.authorityUpgradeState.text, "纯前端模式");

const absent = deriveAuthorityUpgradeState({
  settings: { authorityEnabled: "auto" },
  capability: { installed: false, reason: "not-installed" },
  browserState: { mode: "minimal" },
});
assert.equal(absent.mode, "standalone");
assert.equal(absent.text, "纯前端模式");
assert.equal(absent.ready, false);

const degraded = deriveAuthorityUpgradeState({
  settings: { authorityEnabled: "auto" },
  capability: {
    installed: true,
    healthy: false,
    sessionReady: false,
    permissionReady: false,
    reason: "probe-failed",
  },
});
assert.equal(degraded.mode, "authority-degraded");
assert.equal(degraded.level, "warning");
assert.match(degraded.meta, /probe-failed/);

const enhanced = deriveAuthorityUpgradeState({
  settings: {
    authorityEnabled: "auto",
    authorityPrimaryWhenAvailable: true,
  },
  capability: {
    installed: true,
    healthy: true,
    sessionReady: true,
    permissionReady: true,
    serverPrimaryReady: true,
    storagePrimaryReady: true,
    triviumPrimaryReady: true,
    jobsReady: true,
    bmeVectorManifestReady: true,
    bmeProtocolVersion: 1,
  },
  browserState: { mode: "off" },
});
assert.equal(enhanced.mode, "authority-enhanced");
assert.equal(enhanced.ready, true);
assert.equal(enhanced.text, "服务端增强已启用");
assert.equal(enhanced.bmeVectorManifestReady, true);
assert.equal(enhanced.bmeProtocolVersion, 1);

assert.equal(
  formatAuthorityUpgradeMeta("准备就绪", enhanced),
  "准备就绪 · 服务端增强已启用",
);

console.log("authority-upgrade-state tests passed");
