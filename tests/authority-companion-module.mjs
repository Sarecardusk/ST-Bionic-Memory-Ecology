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
    assert.deepStrictEqual(keys, ['vector.apply', 'vector.manifest'], 'must register exactly vector.manifest and vector.apply');
    assert.strictEqual(typeof registered['vector.manifest'].handler, 'function', 'vector.manifest handler must be a function');
    assert.strictEqual(typeof registered['vector.apply'].handler, 'function', 'vector.apply handler must be a function');
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

    // Verify stat was called with the right database and includeMappingIntegrity
    assert.strictEqual(calls.stat.length, 1, 'stat should be called once');
    assert.strictEqual(calls.stat[0].database, 'st_bme_vectors');
    assert.strictEqual(calls.stat[0].includeMappingIntegrity, true);
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
    assert.strictEqual(manifest.transactions['vector.apply'].idempotency, 'required', 'vector.apply idempotency must be required');
    assert.ok(manifest.transactions['vector.manifest'].requiredResources.some(function (r) { return r.resource === 'trivium.private'; }), 'vector.manifest must require trivium.private');
    assert.ok(manifest.transactions['vector.apply'].requiredResources.some(function (r) { return r.resource === 'trivium.private'; }), 'vector.apply must require trivium.private');
    assert.ok(manifest.transactions['vector.manifest'].requiredResources.every(function (r) { return r.target === undefined; }), 'vector.manifest must not pin a static database target');
    assert.ok(manifest.transactions['vector.apply'].requiredResources.every(function (r) { return r.target === undefined; }), 'vector.apply must not pin a static database target');
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
