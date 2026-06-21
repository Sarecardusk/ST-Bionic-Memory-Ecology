import assert from "node:assert/strict";

import {
  AUTHORITY_SESSION_HEADER,
  AuthorityHttpClient,
  AuthorityHttpError,
} from "../runtime/authority-http-client.js";

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return String(name || "").toLowerCase() === "content-type" ? "application/json" : "";
      },
    },
    async json() {
      return payload;
    },
  };
}

{
  const calls = [];
  const client = new AuthorityHttpClient({
    baseUrl: "https://authority.example.test/root",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith("/session/init") && calls.filter((call) => call.url.endsWith("/session/init")).length === 1) {
        return jsonResponse(200, { sessionToken: "old-session" });
      }
      if (url.endsWith("/session/init")) {
        return jsonResponse(200, { sessionToken: "new-session" });
      }
      if (url.endsWith("/data") && options.headers?.[AUTHORITY_SESSION_HEADER] === "old-session") {
        return jsonResponse(401, { code: "session-expired", message: "session expired" });
      }
      if (url.endsWith("/data") && options.headers?.[AUTHORITY_SESSION_HEADER] === "new-session") {
        return jsonResponse(200, { ok: true, value: 42 });
      }
      return jsonResponse(500, { error: "unexpected" });
    },
  });
  const result = await client.requestJson("/data", { session: true, body: { q: 1 } });
  assert.deepEqual(result, { ok: true, value: 42 });
  assert.deepEqual(
    calls.map((call) => [call.url, call.options.headers?.[AUTHORITY_SESSION_HEADER] || ""]),
    [
      ["https://authority.example.test/root/session/init", ""],
      ["https://authority.example.test/root/data", "old-session"],
      ["https://authority.example.test/root/session/init", ""],
      ["https://authority.example.test/root/data", "new-session"],
    ],
  );
}

{
  const calls = [];
  const client = new AuthorityHttpClient({
    baseUrl: "https://authority.example.test/root",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith("/session/init")) {
        return jsonResponse(200, { sessionToken: "permission-session" });
      }
      return jsonResponse(403, { code: "permission-denied", message: "permission denied" });
    },
  });
  await assert.rejects(
    () => client.requestJson("/private", { session: true, body: {} }),
    (error) => {
      assert.equal(error instanceof AuthorityHttpError, true);
      assert.equal(error.status, 403);
      assert.equal(error.category, "permission");
      return true;
    },
  );
  assert.equal(calls.filter((call) => call.url.endsWith("/session/init")).length, 1);
}

{
  const client = new AuthorityHttpClient({
    baseUrl: "https://authority.example.test/root",
    timeoutMs: 5,
    fetchImpl: async (_url, options = {}) => await new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }, { once: true });
    }),
  });
  await assert.rejects(
    () => client.requestJson("/slow", { session: false }),
    (error) => {
      assert.equal(error instanceof AuthorityHttpError, true);
      assert.equal(error.category, "timeout");
      assert.equal(error.code, "timeout");
      return true;
    },
  );
}

// Phase C: requestModuleTransaction posts to /modules/:moduleId/transactions/:transactionName
// with an envelope body { input, idempotencyKey, options } and session headers.
{
  const calls = [];
  const client = new AuthorityHttpClient({
    baseUrl: "https://authority.example.test",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith("/session/init")) {
        return jsonResponse(200, { sessionToken: "sess-mod" });
      }
      if (url.includes("/modules/third-party.st-bme/transactions/vector.apply")) {
        return jsonResponse(200, {
          ok: true,
          moduleId: "third-party.st-bme",
          transaction: "vector.apply",
          result: { ok: true, upsert: { successCount: 2 }, links: { successCount: 1 } },
        });
      }
      return jsonResponse(500, { error: "unexpected" });
    },
  });

  const input = { database: "st_bme_vectors", items: [{ externalId: "a", vector: [1, 2, 3] }] };
  const response = await client.requestModuleTransaction("third-party.st-bme", "vector.apply", input, {
    idempotencyKey: "idem-xyz",
  });

  // Verify the URL is the module transaction route, NOT /bme/vector-apply.
  const modCall = calls.find((c) => c.url.includes("/modules/"));
  assert.ok(modCall, "should have called /modules/ route");
  assert.ok(modCall.url.includes("/modules/third-party.st-bme/transactions/vector.apply"));
  assert.ok(!modCall.url.includes("/bme/"));

  // Verify the body envelope has input + idempotencyKey at the top level.
  const body = JSON.parse(modCall.options.body);
  assert.equal(body.input.items.length, 1);
  assert.equal(body.idempotencyKey, "idem-xyz");
  assert.ok(!body.input.idempotencyKey, "idempotencyKey should be on envelope, not input");

  // Verify session header is present.
  assert.equal(modCall.options.headers[AUTHORITY_SESSION_HEADER], "sess-mod");

  // Verify the response is the full DOA payload (caller unwraps .result).
  assert.equal(response.ok, true);
  assert.equal(response.moduleId, "third-party.st-bme");
  assert.equal(response.result.upsert.successCount, 2);
}

// Phase 1: requestModuleTransaction also covers vector.manifest (no
// idempotencyKey required since vector.manifest has idempotency: "none").
// The DOA module host still returns { ok, moduleId, transaction, result, ... };
// the BME adapter unwraps response.result.
{
  const calls = [];
  const client = new AuthorityHttpClient({
    baseUrl: "https://authority.example.test",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith("/session/init")) {
        return jsonResponse(200, { sessionToken: "sess-manifest" });
      }
      if (url.includes("/modules/third-party.st-bme/transactions/vector.manifest")) {
        const body = JSON.parse(options.body);
        return jsonResponse(200, {
          ok: true,
          moduleId: "third-party.st-bme",
          transaction: "vector.manifest",
          result: {
            ok: true,
            appliedAt: "2024-01-01T00:00:00.000Z",
            database: body.input?.database || "st_bme_vectors",
            manifest: {
              database: body.input?.database || "st_bme_vectors",
              exists: true,
              status: "ready",
              nodeCount: 42,
              edgeCount: 7,
              mappingCount: 42,
              indexCount: 3,
              orphanMappingCount: 0,
              lastFlushAt: null,
              updatedAt: "2024-01-01T00:00:00.000Z",
              collectionId: body.input?.collectionId || "",
              chatId: body.input?.chatId || "",
              modelScope: body.input?.modelScope || "",
              graphRevision: Number(body.input?.graphRevision) || 0,
              vectorSpaceId: body.input?.vectorSpaceId || "",
              observedDim: Number(body.input?.observedDim) || 0,
              indexHealth: null,
            },
          },
        });
      }
      return jsonResponse(500, { error: "unexpected" });
    },
  });

  const input = {
    database: "st_bme_vectors",
    collectionId: "col-1",
    chatId: "chat-1",
    modelScope: "gpt-4",
    graphRevision: 5,
    vectorSpaceId: "vs-1",
    observedDim: 3,
    includeMappingIntegrity: true,
  };
  const response = await client.requestModuleTransaction("third-party.st-bme", "vector.manifest", input);

  // Verify the URL is the vector.manifest module transaction route.
  const modCall = calls.find((c) => c.url.includes("/modules/third-party.st-bme/transactions/vector.manifest"));
  assert.ok(modCall, "should have called /modules/third-party.st-bme/transactions/vector.manifest");
  assert.ok(!modCall.url.includes("/bme/"));

  // Verify the body envelope has input but NO idempotencyKey (vector.manifest
  // is not idempotency-required in .authority/module.json).
  const body = JSON.parse(modCall.options.body);
  assert.equal(body.input.collectionId, "col-1");
  assert.equal(body.input.vectorSpaceId, "vs-1");
  assert.equal(body.input.observedDim, 3);
  assert.equal(body.idempotencyKey, undefined, "vector.manifest envelope must NOT carry idempotencyKey");

  // Verify session header is present.
  assert.equal(modCall.options.headers[AUTHORITY_SESSION_HEADER], "sess-manifest");

  // Verify the response is the full DOA payload (caller unwraps .result).
  assert.equal(response.ok, true);
  assert.equal(response.moduleId, "third-party.st-bme");
  assert.equal(response.transaction, "vector.manifest");
  assert.equal(response.result.manifest.nodeCount, 42);
  assert.equal(response.result.manifest.vectorSpaceId, "vs-1");
  assert.equal(response.result.manifest.observedDim, 3);
}

// Phase C: requestModuleTransaction pulls idempotencyKey from input when options.idempotencyKey is absent.
{
  const calls = [];
  const client = new AuthorityHttpClient({
    baseUrl: "https://authority.example.test",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith("/session/init")) {
        return jsonResponse(200, { sessionToken: "sess-2" });
      }
      if (url.includes("/modules/")) {
        return jsonResponse(200, { ok: true, result: { ok: true } });
      }
      return jsonResponse(500, { error: "unexpected" });
    },
  });

  const input = { idempotencyKey: "from-input", items: [] };
  await client.requestModuleTransaction("third-party.st-bme", "vector.apply", input);

  const modCall = calls.find((c) => c.url.includes("/modules/"));
  const body = JSON.parse(modCall.options.body);
  assert.equal(body.idempotencyKey, "from-input", "idempotencyKey should be pulled from input.idempotencyKey");
}

// Phase C: module load errors are surfaced with the DOA error payload.
// (Enrichment to say "BME companion module not loaded" happens in
// AuthorityTriviumHttpClient.bmeVectorApply, tested in the vector adapter
// test file.)
{
  const client = new AuthorityHttpClient({
    baseUrl: "https://authority.example.test",
    fetchImpl: async (url) => {
      if (url.endsWith("/session/init")) {
        return jsonResponse(200, { sessionToken: "sess-err" });
      }
      if (url.includes("/modules/")) {
        return jsonResponse(409, {
          error: "Module not loaded: third-party.st-bme",
          code: "validation_error",
          category: "validation",
          details: { code: "module_not_loaded", moduleId: "third-party.st-bme", status: "available" },
        });
      }
      return jsonResponse(500, { error: "unexpected" });
    },
  });

  let caught = null;
  try {
    await client.requestModuleTransaction("third-party.st-bme", "vector.apply", { items: [] });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof AuthorityHttpError);
  assert.equal(caught.status, 409);
  assert.equal(caught.payload.details.code, "module_not_loaded");
}

// Phase C blocker fix: session init body includes module.execute declarations.
{
  let sessionInitBody = null;
  const client = new AuthorityHttpClient({
    baseUrl: "https://authority.example.test",
    fetchImpl: async (url, options = {}) => {
      if (url.endsWith("/session/init")) {
        sessionInitBody = JSON.parse(options.body);
        return jsonResponse(200, { sessionToken: "sess-perms" });
      }
      return jsonResponse(200, { ok: true });
    },
  });
  await client.requestJson("/data", { session: true, body: {} });

  assert.ok(sessionInitBody, "session init body should have been sent");
  const perms = sessionInitBody.declaredPermissions;
  assert.ok(perms, "declaredPermissions must be present");
  assert.ok(perms.modules, "modules permission must be declared");
  assert.ok(Array.isArray(perms.modules.execute), "modules.execute must be an array");
  assert.ok(perms.modules.execute.includes("third-party.st-bme:vector.manifest"), "must declare vector.manifest execute");
  assert.ok(perms.modules.execute.includes("third-party.st-bme:vector.apply"), "must declare vector.apply execute");
  // Existing permissions preserved.
  assert.equal(perms.storage.kv, true);
  assert.equal(perms.storage.blob, true);
  assert.equal(perms.fs.private, true);
  assert.equal(perms.sql.private, true);
  assert.equal(perms.trivium.private, true);
  assert.equal(perms.jobs.background, true);
  assert.equal(perms.events.channels, true);
}

console.log("authority-http-client tests passed");
