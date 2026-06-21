import assert from "node:assert/strict";

import {
  normalizeAuthorityProbeResponse,
  normalizeAuthorityCapabilityState,
  deriveModuleReadiness,
  probeAuthorityCapabilities,
  BME_AUTHORITY_MODULE_ID,
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

// Phase C: module readiness from /modules records sets bmeVectorApplyReady
// without needing features.bme.
{
  const state = normalizeAuthorityCapabilityState({
    installed: true,
    healthy: true,
    sessionReady: true,
    permissionReady: true,
    features: ["sql.query", "sql.mutation", "trivium.search", "jobs", "storage.blob"],
    moduleReadiness: {
      modulesReady: true,
      bmeModuleReady: true,
      bmeVectorManifestReady: true,
      bmeVectorApplyReady: true,
    },
  });
  assert.equal(state.modulesReady, true);
  assert.equal(state.bmeModuleReady, true);
  assert.equal(state.bmeVectorManifestReady, true);
  assert.equal(state.bmeVectorApplyReady, true);
}

// Phase C: load_error record does not set bmeVectorApplyReady.
{
  const state = normalizeAuthorityCapabilityState({
    installed: true,
    healthy: true,
    sessionReady: true,
    permissionReady: true,
    features: ["sql.query", "sql.mutation", "trivium.search", "jobs", "storage.blob"],
    moduleReadiness: {
      modulesReady: true,
      bmeModuleReady: false, // load_error
      bmeVectorManifestReady: false,
      bmeVectorApplyReady: false,
    },
  });
  assert.equal(state.bmeModuleReady, false);
  assert.equal(state.bmeVectorApplyReady, false);
  assert.equal(state.bmeVectorManifestReady, false);
}

// Phase C: missing transaction in manifest does not set readiness.
{
  const state = normalizeAuthorityCapabilityState({
    installed: true,
    healthy: true,
    sessionReady: true,
    permissionReady: true,
    features: ["sql.query", "sql.mutation", "trivium.search", "jobs", "storage.blob"],
    moduleReadiness: {
      modulesReady: true,
      bmeModuleReady: true,
      bmeVectorManifestReady: false, // manifest missing vector.manifest
      bmeVectorApplyReady: true,
    },
  });
  assert.equal(state.bmeModuleReady, true);
  assert.equal(state.bmeVectorApplyReady, true);
  assert.equal(state.bmeVectorManifestReady, false);
}

// Phase C: deriveModuleReadiness from /modules payload.
{
  const readiness = deriveModuleReadiness({
    modules: [
      {
        id: BME_AUTHORITY_MODULE_ID,
        transactions: {
          "vector.manifest": { name: "vector.manifest" },
          "vector.apply": { name: "vector.apply" },
        },
      },
    ],
    records: [
      {
        moduleId: BME_AUTHORITY_MODULE_ID,
        status: "loaded",
        manifest: {
          id: BME_AUTHORITY_MODULE_ID,
          transactions: {
            "vector.manifest": { name: "vector.manifest" },
            "vector.apply": { name: "vector.apply" },
          },
        },
      },
    ],
  });
  assert.equal(readiness.modulesReady, true);
  assert.equal(readiness.bmeModuleReady, true);
  assert.equal(readiness.bmeVectorManifestReady, true);
  assert.equal(readiness.bmeVectorApplyReady, true);
}

// Phase C: deriveModuleReadiness with load_error record.
{
  const readiness = deriveModuleReadiness({
    modules: [],
    records: [
      {
        moduleId: BME_AUTHORITY_MODULE_ID,
        status: "load_error",
        manifest: null,
      },
    ],
  });
  assert.equal(readiness.modulesReady, true);
  assert.equal(readiness.bmeModuleReady, false);
  assert.equal(readiness.bmeVectorApplyReady, false);
}

// Phase C: deriveModuleReadiness with available (not loaded) record.
{
  const readiness = deriveModuleReadiness({
    modules: [],
    records: [
      {
        moduleId: BME_AUTHORITY_MODULE_ID,
        status: "available",
        manifest: { id: BME_AUTHORITY_MODULE_ID, transactions: { "vector.apply": { name: "vector.apply" } } },
      },
    ],
  });
  assert.equal(readiness.bmeModuleReady, false); // available is not loaded
  assert.equal(readiness.bmeVectorApplyReady, false);
}

// Phase C: deriveModuleReadiness with no records at all.
{
  const readiness = deriveModuleReadiness({ modules: [], records: [] });
  assert.equal(readiness.modulesReady, false);
  assert.equal(readiness.bmeModuleReady, false);
}

// Phase C: module readiness takes priority over legacy features when present.
// When moduleReadiness is provided (modulesReady=true), legacy features.bme
// is NOT used for bmeVectorApplyReady. This test confirms a state where
// features.bme.vectorApply is true but the module record is NOT loaded;
// the result should be false because module readiness takes priority.
{
  const state = normalizeAuthorityCapabilityState({
    installed: true,
    healthy: true,
    sessionReady: true,
    permissionReady: true,
    features: ["bme.vector.apply", "bme.vectormanifest", "sql.query", "sql.mutation", "trivium.search", "jobs", "storage.blob"],
    moduleReadiness: {
      modulesReady: true,
      bmeModuleReady: false, // module not loaded
      bmeVectorManifestReady: false,
      bmeVectorApplyReady: false,
    },
  });
  assert.equal(state.bmeVectorApplyReady, false, "module readiness should take priority over legacy features");
}

// Phase C blocker fix: probeAuthorityCapabilities calls /modules with the
// x-authority-session-token header obtained from session/init, and the
// module readiness from /modules takes priority over legacy features.
{
  const fetchCalls = [];
  const mockFetch = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), headers: options.headers || {} });
    if (url.endsWith("/probe")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        async json() {
          return {
            healthy: true,
            features: {
              sql: { queryPage: true, stat: true },
              trivium: { bulkMutations: true, searchContext: true },
              jobs: { background: true, builtinTypes: ["delay"] },
              transfers: { blob: true, fs: true },
              modules: { enabled: true, count: 1 },
            },
            // Deliberately do NOT set features.bme.* so legacy readiness
            // would be false. Module readiness from /modules must set it.
          };
        },
      };
    }
    if (url.endsWith("/session/init")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        async json() { return { sessionToken: "probe-sess-token" }; },
      };
    }
    if (url.endsWith("/session/current")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        async json() { return { ok: true }; },
      };
    }
    if (url.endsWith("/permissions/evaluate-batch")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        async json() {
          return {
            results: [
              { decision: "granted" },
              { decision: "granted" },
              { decision: "granted" },
              { decision: "granted" },
            ],
          };
        },
      };
    }
    if (url.endsWith("/modules")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        async json() {
          return {
            modules: [],
            count: 0,
            records: [
              {
                moduleId: BME_AUTHORITY_MODULE_ID,
                status: "loaded",
                manifest: {
                  id: BME_AUTHORITY_MODULE_ID,
                  transactions: {
                    "vector.manifest": { name: "vector.manifest" },
                    "vector.apply": { name: "vector.apply" },
                  },
                },
              },
            ],
            recordCount: 1,
          };
        },
      };
    }
    return { ok: false, status: 404, headers: { get: () => "application/json" }, async json() { return { error: "not found" }; } };
  };

  const state = await probeAuthorityCapabilities({
    settings: { authorityEnabled: true, authorityBaseUrl: "https://authority.test" },
    fetchImpl: mockFetch,
    allowRelativeUrl: true,
  });

  // /modules must have been called.
  const modulesCall = fetchCalls.find((c) => c.url.endsWith("/modules"));
  assert.ok(modulesCall, "probe should have called /modules");

  // /modules must carry the session token header.
  assert.equal(
    modulesCall.headers["x-authority-session-token"],
    "probe-sess-token",
    "/modules must be called with x-authority-session-token from session/init",
  );

  // Module readiness should be derived from /modules, not legacy features.
  assert.equal(state.modulesReady, true);
  assert.equal(state.bmeModuleReady, true);
  assert.equal(state.bmeVectorManifestReady, true);
  assert.equal(state.bmeVectorApplyReady, true);

  // The session token must NOT leak into the public capability state.
  const stateJson = JSON.stringify(state);
  assert.ok(!stateJson.includes("probe-sess-token"), "session token must not leak into public capability state");
}

// Phase C blocker fix: /modules failure is non-fatal; legacy features still apply.
{
  const mockFetch = async (url) => {
    if (url.endsWith("/probe")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        async json() {
          return {
            healthy: true,
            features: {
              sql: { queryPage: true, stat: true },
              trivium: { bulkMutations: true, searchContext: true },
              jobs: { background: true, builtinTypes: ["delay"] },
              transfers: { blob: true, fs: true },
              modules: { enabled: true, count: 0 },
              bme: { protocolVersion: 1, vectorManifest: true, vectorApply: true },
            },
          };
        },
      };
    }
    if (url.endsWith("/session/init")) {
      return { ok: true, status: 200, headers: { get: () => "application/json" }, async json() { return { sessionToken: "fail-sess" }; } };
    }
    if (url.endsWith("/session/current")) {
      return { ok: true, status: 200, headers: { get: () => "application/json" }, async json() { return { ok: true }; } };
    }
    if (url.endsWith("/permissions/evaluate-batch")) {
      return { ok: true, status: 200, headers: { get: () => "application/json" }, async json() { return { results: [{ decision: "granted" }, { decision: "granted" }, { decision: "granted" }, { decision: "granted" }] }; } };
    }
    if (url.endsWith("/modules")) {
      return { ok: false, status: 500, headers: { get: () => "application/json" }, async json() { return { error: "server error" }; } };
    }
    return { ok: false, status: 404, headers: { get: () => "application/json" }, async json() { return { error: "not found" }; } };
  };

  const state = await probeAuthorityCapabilities({
    settings: { authorityEnabled: true, authorityBaseUrl: "https://authority.test" },
    fetchImpl: mockFetch,
    allowRelativeUrl: true,
  });

  // /modules failed, so module readiness is false, but legacy features
  // should still set bmeVectorApplyReady from features.bme.vectorApply.
  assert.equal(state.modulesReady, false);
  assert.equal(state.bmeModuleReady, false);
  // Legacy fallback: features.bme.vectorApply is present, so readiness
  // should be true via the legacy path.
  assert.equal(state.bmeVectorApplyReady, true);
}

console.log("authority-bme-capabilities tests passed");
