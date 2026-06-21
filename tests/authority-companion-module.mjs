'use strict';

import assert from 'node:assert';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SERVER_CJS = path.resolve(__dirname, '..', '.authority', 'server.cjs');
const MODULE_JSON = path.resolve(__dirname, '..', '.authority', 'module.json');

function createMockTxCtx() {
  const calls = {
    bulkUpsert: [],
    bulkLink: [],
    stat: [],
    searchHybrid: [],
    resolveMany: [],
    neighbors: [],
  };
  const trivium = {
    listDatabases: async () => ({ databases: [] }),
    stat: async (req) => {
      calls.stat.push(req);
      return {
        exists: true,
        nodeCount: 42,
        edgeCount: 7,
        mappingCount: 42,
        indexCount: 3,
        orphanMappingCount: 0,
        lastFlushAt: null,
        updatedAt: '2024-01-01T00:00:00Z',
        indexHealth: null,
      };
    },
    bulkUpsert: async (req) => {
      calls.bulkUpsert.push(req);
      return {
        totalCount: req.items.length,
        successCount: req.items.length,
        failureCount: 0,
        failures: [],
        items: req.items.map((item, i) => ({ index: i, id: i + 1, action: 'insert', externalId: item.externalId, namespace: item.namespace })),
      };
    },
    bulkLink: async (req) => {
      calls.bulkLink.push(req);
      return {
        totalCount: req.items.length,
        successCount: req.items.length,
        failureCount: 0,
        failures: [],
      };
    },
    searchHybrid: async (req) => {
      calls.searchHybrid.push(req);
      return [
        { id: 1, externalId: 'node-a', namespace: 'ns-1', score: 0.92, payload: { text: 'secret', content: 'should-strip' } },
        { id: 2, externalId: 'node-b', namespace: 'ns-1', score: 0.85, payload: { text: 'hidden', messages: ['no'] } },
      ];
    },
    resolveMany: async (req) => {
      calls.resolveMany.push(req);
      return {
        items: (req.items || []).map((item, i) => ({
          index: i,
          id: i + 1,
          externalId: item.externalId,
          namespace: item.namespace || null,
        })),
      };
    },
    neighbors: async (req) => {
      calls.neighbors.push(req);
      return {
        ids: [10, 11],
        nodes: [
          { id: 10, externalId: 'node-c', namespace: 'ns-1' },
          { id: 11, externalId: 'node-d', namespace: 'ns-1' },
        ],
      };
    },
  };
  return {
    calls,
    ctx: {
      moduleId: 'third-party.st-bme',
      ownerExtensionId: 'third-party/st-bme',
      moduleVersion: '7.8.4',
      transactionName: '',
      transactionVersion: '1.0.0',
      callerExtensionId: 'third-party/test-extension',
      requestId: 'test-req-1',
      limits: { maxRequestBytes: 67108864, maxResponseBytes: 67108864, timeoutMs: 120000, source: 'manifest' },
      logger: { info() {}, warn() {}, error() {} },
      audit: { logUsage: async () => {}, logWarning: async () => {}, logError: async () => {} },
      authorize: async () => true,
      signal: new AbortController().signal,
      trivium,
    },
  };
}

async function run() {
  console.log('[test:authority-companion-module] loading server.cjs');
  const mod = require(SERVER_CJS);
  assert.strictEqual(typeof mod.activate, 'function', 'activate must be a function');

  // --- activate registers exactly vector.manifest and vector.apply ---
  console.log('[test:authority-companion-module] testing activate registers both transactions');
  {
    const registered = {};
    const ctx = {
      moduleId: 'third-party.st-bme',
      ownerExtensionId: 'third-party/st-bme',
      moduleDir: '/fake/.authority',
      logger: { info() {}, warn() {}, error() {} },
      registerTransaction(name, definition) {
        registered[name] = definition;
      },
    };
    await mod.activate(ctx);
    const keys = Object.keys(registered).sort();
    assert.deepStrictEqual(keys, ['recall.candidates', 'vector.apply', 'vector.manifest'], 'must register exactly vector.manifest, vector.apply, and recall.candidates');
    assert.strictEqual(typeof registered['vector.manifest'].handler, 'function', 'vector.manifest handler must be a function');
    assert.strictEqual(typeof registered['vector.apply'].handler, 'function', 'vector.apply handler must be a function');
    assert.strictEqual(typeof registered['recall.candidates'].handler, 'function', 'recall.candidates handler must be a function');
  }

  // --- vector.apply calls bulkUpsert and bulkLink with correct payload ---
  console.log('[test:authority-companion-module] testing vector.apply with items and links');
  {
    const { calls, ctx } = createMockTxCtx();
    const input = {
      database: 'st_bme_vectors',
      namespace: 'test-ns',
      collectionId: 'col-1',
      chatId: 'chat-1',
      graphRevision: 5,
      modelScope: 'gpt-4',
      observedDim: 3,
      items: [
        { externalId: 'node-a', vector: [1, 2, 3], payload: { text: 'hello', contentHash: 'abc' } },
        { externalId: 'node-b', vector: [4, 5, 6], payload: { text: 'world', contentHash: 'def' } },
      ],
      links: [
        { fromId: 'node-a', toId: 'node-b', label: 'related', weight: 1.0 },
      ],
    };
    const { calls: calls2, ctx: ctx2 } = createMockTxCtx();
    ctx2.transactionName = 'vector.apply';
    const result = await (await getHandler(mod, 'vector.apply'))(ctx2, input, { idempotencyKey: 'test-key' });
    assert.strictEqual(result.result.ok, true, 'vector.apply should return ok: true');
    assert.strictEqual(result.result.database, 'st_bme_vectors');
    assert.strictEqual(result.result.upsert.successCount, 2, 'upsert successCount should be 2');
    assert.strictEqual(result.result.links.successCount, 1, 'links successCount should be 1');
    assert.strictEqual(result.result.skippedLinkCount, 0, 'skippedLinkCount should be 0 when links present');

    // Verify bulkUpsert was called with the right database and dim
    assert.strictEqual(calls2.bulkUpsert.length, 1, 'bulkUpsert should be called once');
    assert.strictEqual(calls2.bulkUpsert[0].database, 'st_bme_vectors');
    assert.strictEqual(calls2.bulkUpsert[0].dim, 3, 'dim should be detected as 3');
    assert.strictEqual(calls2.bulkUpsert[0].items.length, 2);

    // Verify bulkLink was called with the right shape
    assert.strictEqual(calls2.bulkLink.length, 1, 'bulkLink should be called once');
    assert.strictEqual(calls2.bulkLink[0].database, 'st_bme_vectors');
    assert.strictEqual(calls2.bulkLink[0].items.length, 1);
    assert.strictEqual(calls2.bulkLink[0].items[0].src.externalId, 'node-a');
    assert.strictEqual(calls2.bulkLink[0].items[0].dst.externalId, 'node-b');
    assert.strictEqual(calls2.bulkLink[0].items[0].label, 'related');
  }

  // --- vector.apply handles empty links ---
  console.log('[test:authority-companion-module] testing vector.apply with empty links');
  {
    const { calls, ctx } = createMockTxCtx();
    ctx.transactionName = 'vector.apply';
    const input = {
      database: 'st_bme_vectors',
      namespace: 'test-ns',
      items: [
        { externalId: 'node-a', vector: [1, 2, 3] },
      ],
      links: [],
    };
    const result = await (await getHandler(mod, 'vector.apply'))(ctx, input, { idempotencyKey: 'k' });
    assert.strictEqual(result.result.ok, true);
    assert.strictEqual(result.result.links.successCount, 0, 'links successCount should be 0 when no links');
    assert.strictEqual(result.result.skippedLinkCount, 0, 'skippedLinkCount should be 0 for empty links array');
    assert.strictEqual(calls.bulkLink.length, 0, 'bulkLink should NOT be called when links array is empty');
  }

  // --- vector.apply rejects mixed dimensions ---
  console.log('[test:authority-companion-module] testing vector.apply rejects mixed dimensions');
  {
    const { ctx } = createMockTxCtx();
    ctx.transactionName = 'vector.apply';
    const input = {
      database: 'st_bme_vectors',
      items: [
        { externalId: 'node-a', vector: [1, 2, 3] },
        { externalId: 'node-b', vector: [4, 5] },
      ],
    };
    await assert.rejects(
      async () => await (await getHandler(mod, 'vector.apply'))(ctx, input, {}),
      /inconsistent vector dimensions/,
      'should reject mixed dimensions',
    );
  }

  // --- vector.apply rejects observedDim mismatch ---
  console.log('[test:authority-companion-module] testing vector.apply rejects observedDim mismatch');
  {
    const { ctx } = createMockTxCtx();
    ctx.transactionName = 'vector.apply';
    const input = {
      database: 'st_bme_vectors',
      observedDim: 128,
      items: [
        { externalId: 'node-a', vector: [1, 2, 3] },
      ],
    };
    await assert.rejects(
      async () => await (await getHandler(mod, 'vector.apply'))(ctx, input, {}),
      /observedDim.*does not match/,
      'should reject observedDim mismatch',
    );
  }

  // --- vector.apply rejects empty items ---
  console.log('[test:authority-companion-module] testing vector.apply rejects empty items');
  {
    const { ctx } = createMockTxCtx();
    ctx.transactionName = 'vector.apply';
    const input = {
      database: 'st_bme_vectors',
      items: [],
    };
    await assert.rejects(
      async () => await (await getHandler(mod, 'vector.apply'))(ctx, input, {}),
      /at least one item/,
      'should reject empty items',
    );
  }

  // --- vector.manifest calls stat and returns expected fields ---
  console.log('[test:authority-companion-module] testing vector.manifest');
  {
    const { calls, ctx } = createMockTxCtx();
    ctx.transactionName = 'vector.manifest';
    const input = {
      database: 'st_bme_vectors',
      collectionId: 'col-1',
      chatId: 'chat-1',
      modelScope: 'gpt-4',
      graphRevision: 5,
      vectorSpaceId: 'vs-1',
      observedDim: 3,
      includeMappingIntegrity: true,
    };
    const result = await (await getHandler(mod, 'vector.manifest'))(ctx, input, {});
    assert.strictEqual(result.result.ok, true);
    assert.strictEqual(result.result.database, 'st_bme_vectors');
    assert.strictEqual(result.result.manifest.exists, true);
    assert.strictEqual(result.result.manifest.nodeCount, 42);
    assert.strictEqual(result.result.manifest.edgeCount, 7);
    assert.strictEqual(result.result.manifest.mappingCount, 42);
    assert.strictEqual(result.result.manifest.collectionId, 'col-1');
    assert.strictEqual(result.result.manifest.chatId, 'chat-1');
    assert.strictEqual(result.result.manifest.modelScope, 'gpt-4');
    assert.strictEqual(result.result.manifest.graphRevision, 5);
    assert.strictEqual(result.result.manifest.vectorSpaceId, 'vs-1', 'vector.manifest manifest must echo vectorSpaceId from input');
    assert.strictEqual(result.result.manifest.observedDim, 3, 'vector.manifest manifest must echo observedDim from input');

    // Verify stat was called with the right database and includeMappingIntegrity
    assert.strictEqual(calls.stat.length, 1, 'stat should be called once');
    assert.strictEqual(calls.stat[0].database, 'st_bme_vectors');
    assert.strictEqual(calls.stat[0].includeMappingIntegrity, true);
  }

  // --- vector.manifest echoes empty vectorSpaceId/observedDim when absent ---
  console.log('[test:authority-companion-module] testing vector.manifest echoes empty echo fields when absent');
  {
    const { ctx } = createMockTxCtx();
    ctx.transactionName = 'vector.manifest';
    const input = {
      database: 'st_bme_vectors',
      collectionId: 'col-1',
      chatId: 'chat-1',
    };
    const result = await (await getHandler(mod, 'vector.manifest'))(ctx, input, {});
    assert.strictEqual(result.result.manifest.vectorSpaceId, '', 'vector.manifest should echo empty vectorSpaceId when input has none');
    assert.strictEqual(result.result.manifest.observedDim, 0, 'vector.manifest should echo 0 observedDim when input has none');
  }

  // --- module.json shape ---
  console.log('[test:authority-companion-module] testing module.json shape');
  {
    const manifest = JSON.parse(fs.readFileSync(MODULE_JSON, 'utf8'));
    assert.strictEqual(manifest.schemaVersion, 1, 'schemaVersion must be 1');
    assert.strictEqual(manifest.id, 'third-party.st-bme', 'module id must be third-party.st-bme');
    assert.strictEqual(manifest.ownerExtensionId, 'third-party/st-bme', 'ownerExtensionId must be third-party/st-bme');
    assert.strictEqual(manifest.entry, './server.cjs', 'entry must be ./server.cjs');
    assert.strictEqual(manifest.protocolVersion, 1, 'protocolVersion must be 1');
    assert.ok(manifest.transactions['vector.manifest'], 'must declare vector.manifest');
    assert.ok(manifest.transactions['vector.apply'], 'must declare vector.apply');
    assert.ok(manifest.transactions['recall.candidates'], 'must declare recall.candidates');
    assert.strictEqual(manifest.transactions['vector.apply'].idempotency, 'required', 'vector.apply idempotency must be required');
    assert.strictEqual(manifest.transactions['recall.candidates'].idempotency, 'none', 'recall.candidates idempotency must be none');
    assert.strictEqual(manifest.transactions['recall.candidates'].riskLevel, 'low', 'recall.candidates riskLevel must be low');
    assert.strictEqual(manifest.transactions['recall.candidates'].version, '1', 'recall.candidates version must be "1"');
    assert.strictEqual(manifest.transactions['recall.candidates'].timeoutMs, 120000, 'recall.candidates timeoutMs must be 120000');
    assert.strictEqual(manifest.transactions['recall.candidates'].maxRequestBytes, 67108864, 'recall.candidates maxRequestBytes must be 64 MiB');
    assert.strictEqual(manifest.transactions['recall.candidates'].maxResponseBytes, 67108864, 'recall.candidates maxResponseBytes must be 64 MiB');
    assert.ok(manifest.transactions['vector.manifest'].requiredResources.some(function (r) { return r.resource === 'trivium.private'; }), 'vector.manifest must require trivium.private');
    assert.ok(manifest.transactions['vector.apply'].requiredResources.some(function (r) { return r.resource === 'trivium.private'; }), 'vector.apply must require trivium.private');
    assert.ok(manifest.transactions['recall.candidates'].requiredResources.some(function (r) { return r.resource === 'trivium.private'; }), 'recall.candidates must require trivium.private');
    assert.ok(manifest.transactions['vector.manifest'].requiredResources.every(function (r) { return r.target === undefined; }), 'vector.manifest must not pin a static database target');
    assert.ok(manifest.transactions['vector.apply'].requiredResources.every(function (r) { return r.target === undefined; }), 'vector.apply must not pin a static database target');
    assert.ok(manifest.transactions['recall.candidates'].requiredResources.every(function (r) { return r.target === undefined; }), 'recall.candidates must not pin a static database target');
    assert.strictEqual(manifest.transactions['vector.apply'].maxRequestBytes, 67108864, 'vector.apply maxRequestBytes should be 64 MiB');
    assert.strictEqual(manifest.transactions['vector.apply'].timeoutMs, 120000, 'vector.apply timeoutMs should be 120000');
  }

  // --- vector.apply uses default database when not specified ---
  console.log('[test:authority-companion-module] testing vector.apply default database');
  {
    const { calls, ctx } = createMockTxCtx();
    ctx.transactionName = 'vector.apply';
    const input = {
      items: [{ externalId: 'node-a', vector: [1, 2, 3] }],
    };
    const result = await (await getHandler(mod, 'vector.apply'))(ctx, input, { idempotencyKey: 'k' });
    assert.strictEqual(result.result.database, 'st_bme_vectors', 'should default to st_bme_vectors database');
    assert.strictEqual(calls.bulkUpsert[0].database, 'st_bme_vectors');
  }

  // --- vector.apply echoes metadata in manifest field ---
  console.log('[test:authority-companion-module] testing vector.apply metadata echo');
  {
    const { ctx } = createMockTxCtx();
    ctx.transactionName = 'vector.apply';
    const input = {
      database: 'st_bme_vectors',
      namespace: 'test-ns',
      collectionId: 'col-1',
      chatId: 'chat-1',
      modelScope: 'gpt-4',
      graphRevision: 7,
      vectorSpaceId: 'vs-1',
      observedDim: 3,
      items: [{ externalId: 'node-a', vector: [1, 2, 3] }],
    };
    const result = await (await getHandler(mod, 'vector.apply'))(ctx, input, { idempotencyKey: 'k' });
    assert.strictEqual(result.result.manifest.namespace, 'test-ns');
    assert.strictEqual(result.result.manifest.observedDim, 3);
    assert.strictEqual(result.result.manifest.collectionId, 'col-1');
    assert.strictEqual(result.result.manifest.chatId, 'chat-1');
    assert.strictEqual(result.result.manifest.modelScope, 'gpt-4');
    assert.strictEqual(result.result.manifest.graphRevision, 7);
    assert.strictEqual(result.result.manifest.vectorSpaceId, 'vs-1');
  }

  // --- recall.candidates handler returns candidates with externalId/internalId/namespace/score only ---
  console.log('[test:authority-companion-module] testing recall.candidates returns sanitized candidates');
  {
    const { calls, ctx } = createMockTxCtx();
    ctx.transactionName = 'recall.candidates';
    const input = {
      database: 'st_bme_vectors',
      namespace: 'test-ns',
      collectionId: 'col-1',
      chatId: 'chat-1',
      graphRevision: 5,
      modelScope: 'gpt-4',
      vectorSpaceId: 'vs-1',
      observedDim: 3,
      queryTexts: ['hello world'],
      queryVectors: [[1, 2, 3]],
      topK: 10,
      expandDepth: 2,
    };
    const result = await (await getHandler(mod, 'recall.candidates'))(ctx, input, {});
    assert.strictEqual(result.result.ok, true, 'recall.candidates should return ok: true');
    assert.strictEqual(result.result.database, 'st_bme_vectors');
    assert.strictEqual(result.result.collectionId, 'col-1');
    assert.strictEqual(result.result.chatId, 'chat-1');
    assert.strictEqual(result.result.graphRevision, 5);
    assert.strictEqual(result.result.modelScope, 'gpt-4');
    assert.strictEqual(result.result.vectorSpaceId, 'vs-1');
    assert.strictEqual(result.result.observedDim, 3);
    assert.strictEqual(result.result.queryCount, 1, 'queryCount should be 1');
    assert.ok(Array.isArray(result.result.candidates), 'candidates must be an array');
    assert.ok(result.result.candidates.length > 0, 'candidates must be non-empty');

    // HARD OUTPUT BOUNDARY: no text/payload/prompt/messages fields in result.
    const candidateKeys = new Set();
    for (const candidate of result.result.candidates) {
      for (const key of Object.keys(candidate)) candidateKeys.add(key);
    }
    assert.ok(!candidateKeys.has('text'), 'candidates must NOT include text');
    assert.ok(!candidateKeys.has('payload'), 'candidates must NOT include payload');
    assert.ok(!candidateKeys.has('prompt'), 'candidates must NOT include prompt');
    assert.ok(!candidateKeys.has('messages'), 'candidates must NOT include messages');
    assert.ok(!candidateKeys.has('content'), 'candidates must NOT include content');

    // Each candidate has only the allowed fields.
    const allowedFields = new Set(['externalId', 'internalId', 'namespace', 'score', 'source']);
    for (const candidate of result.result.candidates) {
      for (const key of Object.keys(candidate)) {
        assert.ok(allowedFields.has(key), `unexpected candidate field: ${key}`);
      }
      assert.ok(candidate.externalId, 'candidate must have externalId');
      assert.strictEqual(typeof candidate.score, 'number');
      assert.ok(candidate.source === 'search' || candidate.source === 'expand', `unexpected source: ${candidate.source}`);
    }

    // searchHybrid was called once per query.
    assert.strictEqual(calls.searchHybrid.length, 1, 'searchHybrid should be called once');
    // resolveMany + neighbors called because expandDepth > 0.
    assert.strictEqual(calls.resolveMany.length, 1, 'resolveMany should be called once when expandDepth > 0');
    assert.ok(calls.neighbors.length > 0, 'neighbors should be called when expandDepth > 0');

    // No payload content anywhere in the response.
    const responseJson = JSON.stringify(result.result);
    assert.ok(!responseJson.includes('secret'), 'response must not include search hit payload text');
    assert.ok(!responseJson.includes('hidden'), 'response must not include search hit payload text');
    assert.ok(!responseJson.includes('should-strip'), 'response must not include search hit payload content');
  }

  // --- recall.candidates rejects empty queryTexts/queryVectors ---
  console.log('[test:authority-companion-module] testing recall.candidates rejects empty queries');
  {
    const { ctx } = createMockTxCtx();
    ctx.transactionName = 'recall.candidates';
    const input = {
      database: 'st_bme_vectors',
      observedDim: 3,
      queryTexts: [],
      queryVectors: [],
    };
    await assert.rejects(
      async () => await (await getHandler(mod, 'recall.candidates'))(ctx, input, {}),
      /requires at least one of queryTexts or queryVectors/,
      'should reject empty queryTexts and queryVectors',
    );
  }

  // --- recall.candidates rejects observedDim mismatch ---
  console.log('[test:authority-companion-module] testing recall.candidates rejects observedDim mismatch');
  {
    const { ctx } = createMockTxCtx();
    ctx.transactionName = 'recall.candidates';
    const input = {
      database: 'st_bme_vectors',
      observedDim: 128,
      queryTexts: ['hello'],
      queryVectors: [[1, 2, 3]],
    };
    await assert.rejects(
      async () => await (await getHandler(mod, 'recall.candidates'))(ctx, input, {}),
      /does not match observedDim/,
      'should reject observedDim mismatch',
    );
  }

  // --- recall.candidates rejects non-array queryVector ---
  console.log('[test:authority-companion-module] testing recall.candidates rejects malformed queryVector');
  {
    const { ctx } = createMockTxCtx();
    ctx.transactionName = 'recall.candidates';
    const input = {
      database: 'st_bme_vectors',
      queryVectors: [[1, 2, 3], 'not-an-array'],
    };
    await assert.rejects(
      async () => await (await getHandler(mod, 'recall.candidates'))(ctx, input, {}),
      /must be a non-empty array/,
      'should reject non-array queryVector',
    );
  }

  // --- recall.candidates returns empty candidates when searchHybrid returns no hits ---
  console.log('[test:authority-companion-module] testing recall.candidates empty search result');
  {
    const { calls, ctx } = createMockTxCtx();
    // Override searchHybrid to return empty array.
    ctx.trivium.searchHybrid = async () => [];
    ctx.transactionName = 'recall.candidates';
    const input = {
      database: 'st_bme_vectors',
      observedDim: 3,
      queryTexts: ['nothing matches'],
      queryVectors: [[1, 2, 3]],
      topK: 5,
      expandDepth: 0,
    };
    const result = await (await getHandler(mod, 'recall.candidates'))(ctx, input, {});
    assert.strictEqual(result.result.ok, true, 'empty result is NOT an error');
    assert.deepStrictEqual(result.result.candidates, [], 'candidates should be empty array');
    assert.strictEqual(result.result.queryCount, 1);
    // resolveMany should NOT be called when there are no hits.
    assert.strictEqual(calls.resolveMany.length, 0);
    assert.strictEqual(calls.neighbors.length, 0);
  }

  // --- recall.candidates echoes all metadata fields ---
  console.log('[test:authority-companion-module] testing recall.candidates metadata echo');
  {
    const { ctx } = createMockTxCtx();
    ctx.transactionName = 'recall.candidates';
    const input = {
      database: 'st_bme_vectors',
      collectionId: 'col-echo',
      chatId: 'chat-echo',
      graphRevision: 9,
      modelScope: 'echo-model',
      vectorSpaceId: 'vs-echo',
      observedDim: 3,
      queryTexts: ['echo'],
      queryVectors: [[1, 2, 3]],
      topK: 5,
      expandDepth: 0,
    };
    const result = await (await getHandler(mod, 'recall.candidates'))(ctx, input, {});
    assert.strictEqual(result.result.database, 'st_bme_vectors');
    assert.strictEqual(result.result.collectionId, 'col-echo');
    assert.strictEqual(result.result.chatId, 'chat-echo');
    assert.strictEqual(result.result.graphRevision, 9);
    assert.strictEqual(result.result.modelScope, 'echo-model');
    assert.strictEqual(result.result.vectorSpaceId, 'vs-echo');
    assert.strictEqual(result.result.observedDim, 3);
    assert.ok(result.result.searchedAt, 'searchedAt should be set');
  }

  // --- recall.candidates works with queryTexts only (no queryVectors) ---
  console.log('[test:authority-companion-module] testing recall.candidates with queryTexts only');
  {
    const { calls, ctx } = createMockTxCtx();
    ctx.transactionName = 'recall.candidates';
    const input = {
      database: 'st_bme_vectors',
      queryTexts: ['text-only-query'],
      topK: 5,
      expandDepth: 0,
    };
    const result = await (await getHandler(mod, 'recall.candidates'))(ctx, input, {});
    assert.strictEqual(result.result.ok, true);
    assert.strictEqual(result.result.queryCount, 1);
    assert.strictEqual(calls.searchHybrid.length, 1);
    assert.strictEqual(calls.searchHybrid[0].queryText, 'text-only-query');
    // vector should be undefined since we only passed queryTexts.
    assert.strictEqual(calls.searchHybrid[0].vector, undefined);
  }

  // --- recall.candidates works with queryVectors only (no queryTexts) ---
  console.log('[test:authority-companion-module] testing recall.candidates with queryVectors only');
  {
    const { calls, ctx } = createMockTxCtx();
    ctx.transactionName = 'recall.candidates';
    const input = {
      database: 'st_bme_vectors',
      observedDim: 3,
      queryVectors: [[1, 2, 3]],
      topK: 5,
      expandDepth: 0,
    };
    const result = await (await getHandler(mod, 'recall.candidates'))(ctx, input, {});
    assert.strictEqual(result.result.ok, true);
    assert.strictEqual(result.result.queryCount, 1);
    assert.strictEqual(calls.searchHybrid.length, 1);
    assert.deepStrictEqual(calls.searchHybrid[0].vector, [1, 2, 3]);
  }

  // --- recall.candidates clamps topK and expandDepth to server caps ---
  console.log('[test:authority-companion-module] testing recall.candidates clamps topK/expandDepth');
  {
    const { calls, ctx } = createMockTxCtx();
    ctx.transactionName = 'recall.candidates';
    const input = {
      database: 'st_bme_vectors',
      queryTexts: ['clamp-test'],
      topK: 99999,
      expandDepth: 99999,
    };
    const result = await (await getHandler(mod, 'recall.candidates'))(ctx, input, {});
    assert.strictEqual(result.result.ok, true);
    assert.strictEqual(calls.searchHybrid[0].topK, mod.MAX_SEARCH_TOP_K, 'topK should be clamped to MAX_SEARCH_TOP_K');
    // neighbors depth should be clamped to MAX_SEARCH_EXPAND_DEPTH.
    assert.strictEqual(calls.neighbors[0].depth, mod.MAX_SEARCH_EXPAND_DEPTH, 'expandDepth should be clamped to MAX_SEARCH_EXPAND_DEPTH');
  }

  console.log('[test:authority-companion-module] all tests passed');
}

async function getHandler(mod, name) {
  const registered = {};
  const ctx = {
    moduleId: 'third-party.st-bme',
    ownerExtensionId: 'third-party/st-bme',
    moduleDir: '/fake/.authority',
    logger: { info() {}, warn() {}, error() {} },
    registerTransaction(n, def) { registered[n] = def; },
  };
  await mod.activate(ctx);
  return registered[name].handler;
}

run().catch((error) => {
  console.error('[test:authority-companion-module] FAILED:', error.message);
  console.error(error.stack);
  process.exit(1);
});
