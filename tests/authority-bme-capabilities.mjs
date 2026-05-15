import assert from "node:assert/strict";

import {
  normalizeAuthorityProbeResponse,
  normalizeAuthorityCapabilityState,
} from "../runtime/authority-capabilities.js";

const capability = normalizeAuthorityProbeResponse({
  healthy: true,
  features: {
    sql: { queryPage: true, stat: true },
    trivium: { bulkMutations: true, searchContext: true },
    jobs: { background: true, builtinTypes: ["delay", "trivium.flush"] },
    transfers: { blob: true, fs: true },
    bme: {
      protocolVersion: 1,
      vectorManifest: true,
      vectorApply: true,
      vectorApplyJobs: false,
      serverEmbeddingProbe: false,
      candidateSearch: false,
    },
  },
});

assert.equal(capability.bmeProtocolVersion, 1);
assert.equal(capability.bmeVectorManifestReady, true);
assert.equal(capability.bmeVectorApplyReady, true);
assert.equal(capability.bmeServerEmbeddingProbeReady, false);
assert.ok(capability.features.includes("bme.vectormanifest"));
assert.ok(capability.features.includes("bme.protocolversion"));

const legacy = normalizeAuthorityCapabilityState({
  installed: true,
  healthy: true,
  sessionReady: true,
  permissionReady: true,
  features: ["sql.query", "sql.mutation", "trivium.search"],
});
assert.equal(legacy.bmeVectorManifestReady, false);
assert.equal(legacy.bmeProtocolVersion, 0);

console.log("authority-bme-capabilities tests passed");
