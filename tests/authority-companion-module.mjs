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

// Mock ctx for graph.getHead / graph.loadSnapshot tests. The mock ctx.sql
// has `query` and `exec` methods. The query mock inspects the statement
// string to decide which rows to return (meta rows, node/edge record_ids
// for getHead, or node/edge/tombstone payloads for loadSnapshot).
function createMockSqlTxCtx(options = {}) {
  const {
    meta = {},
    nodes = [],
    edges = [],
    tombstones = [],
  } = options;
  const calls = { query: [], exec: [] };

  const metaRows = Object.entries(meta).map(([key, value]) => ({
    meta_key: key,
    value_json: JSON.stringify(value),
  }));
  const nodeRecordIdRows = nodes.map((n) => ({ record_id: String(n.id) }));
  const nodePayloadRows = nodes.map((n) => ({ payload_json: JSON.stringify(n) }));
  const edgeRecordIdRows = edges.map((e) => ({ record_id: String(e.id) }));
  const edgePayloadRows = edges.map((e) => ({ payload_json: JSON.stringify(e) }));
  const tombstonePayloadRows = tombstones.map((t) => ({ payload_json: JSON.stringify(t) }));

  const sql = {
    exec: async (database, statement, params) => {
      calls.exec.push({ database, statement, params });
      return { kind: 'exec', rowsAffected: 0, lastInsertRowid: null };
    },
    query: async (database, statement, params) => {
      calls.query.push({ database, statement, params });
      let rows = [];
      let columns = [];
      if (statement.includes('st_bme_graph_meta')) {
        rows = metaRows;
        columns = ['meta_key', 'value_json'];
      } else if (statement.includes('st_bme_graph_nodes') && statement.includes('record_id')) {
        rows = nodeRecordIdRows;
        columns = ['record_id'];
      } else if (statement.includes('st_bme_graph_nodes')) {
        rows = nodePayloadRows;
        columns = ['payload_json'];
      } else if (statement.includes('st_bme_graph_edges') && statement.includes('record_id')) {
        rows = edgeRecordIdRows;
        columns = ['record_id'];
      } else if (statement.includes('st_bme_graph_edges')) {
        rows = edgePayloadRows;
        columns = ['payload_json'];
      } else if (statement.includes('st_bme_graph_tombstones')) {
        rows = tombstonePayloadRows;
        columns = ['payload_json'];
      }
      return { kind: 'query', columns, rows, rowCount: rows.length };
    },
  };

  return {
    calls,
    ctx: {
      moduleId: 'third-party.st-bme',
      ownerExtensionId: 'third-party/st-bme',
      moduleVersion: '7.8.4',
      transactionName: '',
      transactionVersion: '1',
      callerExtensionId: 'third-party/test-extension',
      requestId: 'test-req-graph-1',
      limits: { maxRequestBytes: 67108864, maxResponseBytes: 67108864, timeoutMs: 120000, source: 'manifest' },
      logger: { info() {}, warn() {}, error() {} },
      audit: { logUsage: async () => {}, logWarning: async () => {}, logError: async () => {} },
      authorize: async () => true,
      signal: new AbortController().signal,
      sql,
    },
  };
}

async function run() {
  console.log('[test:authority-companion-module] loading server.cjs');
  const mod = require(SERVER_CJS);
  assert.strictEqual(typeof mod.activate, 'function', 'activate must be a function');

  // --- activate registers exactly the 5 transactions ---
  console.log('[test:authority-companion-module] testing activate registers all five transactions');
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
    assert.deepStrictEqual(
      keys,
      ['graph.getHead', 'graph.loadSnapshot', 'recall.candidates', 'vector.apply', 'vector.manifest'],
      'must register exactly vector.manifest, vector.apply, recall.candidates, graph.getHead, and graph.loadSnapshot',
    );
    assert.strictEqual(typeof registered['vector.manifest'].handler, 'function', 'vector.manifest handler must be a function');
    assert.strictEqual(typeof registered['vector.apply'].handler, 'function', 'vector.apply handler must be a function');
    assert.strictEqual(typeof registered['recall.candidates'].handler, 'function', 'recall.candidates handler must be a function');
    assert.strictEqual(typeof registered['graph.getHead'].handler, 'function', 'graph.getHead handler must be a function');
    assert.strictEqual(typeof registered['graph.loadSnapshot'].handler, 'function', 'graph.loadSnapshot handler must be a function');
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
    assert.ok(manifest.transactions['graph.getHead'], 'must declare graph.getHead');
    assert.ok(manifest.transactions['graph.loadSnapshot'], 'must declare graph.loadSnapshot');
    assert.strictEqual(manifest.transactions['vector.apply'].idempotency, 'required', 'vector.apply idempotency must be required');
    assert.strictEqual(manifest.transactions['recall.candidates'].idempotency, 'none', 'recall.candidates idempotency must be none');
    assert.strictEqual(manifest.transactions['recall.candidates'].riskLevel, 'low', 'recall.candidates riskLevel must be low');
    assert.strictEqual(manifest.transactions['recall.candidates'].version, '1', 'recall.candidates version must be "1"');
    assert.strictEqual(manifest.transactions['recall.candidates'].timeoutMs, 120000, 'recall.candidates timeoutMs must be 120000');
    assert.strictEqual(manifest.transactions['recall.candidates'].maxRequestBytes, 67108864, 'recall.candidates maxRequestBytes must be 64 MiB');
    assert.strictEqual(manifest.transactions['recall.candidates'].maxResponseBytes, 67108864, 'recall.candidates maxResponseBytes must be 64 MiB');
    // graph.getHead declaration
    assert.strictEqual(manifest.transactions['graph.getHead'].idempotency, 'none', 'graph.getHead idempotency must be none');
    assert.strictEqual(manifest.transactions['graph.getHead'].riskLevel, 'low', 'graph.getHead riskLevel must be low');
    assert.strictEqual(manifest.transactions['graph.getHead'].version, '1', 'graph.getHead version must be "1"');
    assert.strictEqual(manifest.transactions['graph.getHead'].timeoutMs, 120000, 'graph.getHead timeoutMs must be 120000');
    assert.strictEqual(manifest.transactions['graph.getHead'].maxRequestBytes, 67108864, 'graph.getHead maxRequestBytes must be 64 MiB');
    assert.strictEqual(manifest.transactions['graph.getHead'].maxResponseBytes, 67108864, 'graph.getHead maxResponseBytes must be 64 MiB');
    assert.ok(
      manifest.transactions['graph.getHead'].requiredResources.some(function (r) { return r.resource === 'sql.private'; }),
      'graph.getHead must require sql.private',
    );
    assert.ok(
      manifest.transactions['graph.getHead'].requiredResources.every(function (r) { return r.target === undefined; }),
      'graph.getHead must not pin a static database target',
    );
    // graph.loadSnapshot declaration
    assert.strictEqual(manifest.transactions['graph.loadSnapshot'].idempotency, 'none', 'graph.loadSnapshot idempotency must be none');
    assert.strictEqual(manifest.transactions['graph.loadSnapshot'].riskLevel, 'low', 'graph.loadSnapshot riskLevel must be low');
    assert.strictEqual(manifest.transactions['graph.loadSnapshot'].version, '1', 'graph.loadSnapshot version must be "1"');
    assert.strictEqual(manifest.transactions['graph.loadSnapshot'].timeoutMs, 120000, 'graph.loadSnapshot timeoutMs must be 120000');
    assert.strictEqual(manifest.transactions['graph.loadSnapshot'].maxRequestBytes, 67108864, 'graph.loadSnapshot maxRequestBytes must be 64 MiB');
    assert.strictEqual(manifest.transactions['graph.loadSnapshot'].maxResponseBytes, 67108864, 'graph.loadSnapshot maxResponseBytes must be 64 MiB');
    assert.ok(
      manifest.transactions['graph.loadSnapshot'].requiredResources.some(function (r) { return r.resource === 'sql.private'; }),
      'graph.loadSnapshot must require sql.private',
    );
    assert.ok(
      manifest.transactions['graph.loadSnapshot'].requiredResources.every(function (r) { return r.target === undefined; }),
      'graph.loadSnapshot must not pin a static database target',
    );
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

  // ===========================================================================
  // Phase D: graph.getHead / graph.loadSnapshot
  // ===========================================================================

  console.log('[test:authority-companion-module] testing graph.getHead returns revision + headHash + meta when chat exists');
  {
    const { calls, ctx } = createMockSqlTxCtx({
      meta: {
        revision: 5,
        lastModified: 1700000000000,
        syncDirty: false,
        syncDirtyReason: null,
        lastProcessedFloor: 3,
        extractionCount: 12,
        schemaVersion: 1,
        nodeCount: 2,
        edgeCount: 1,
        tombstoneCount: 0,
      },
      nodes: [{ id: 'node-a' }, { id: 'node-b' }],
      edges: [{ id: 'edge-1' }],
    });
    ctx.transactionName = 'graph.getHead';
    const result = await (await getHandler(mod, 'graph.getHead'))(ctx, { chatId: 'chat-1' }, {});
    assert.strictEqual(result.result.ok, true, 'graph.getHead should return ok: true');
    assert.strictEqual(result.result.chatId, 'chat-1');
    assert.strictEqual(result.result.revision, 5, 'revision should be 5');
    assert.strictEqual(result.result.exists, true, 'exists should be true when meta rows present');
    assert.strictEqual(typeof result.result.headHash, 'string', 'headHash must be a string when chat exists');
    assert.ok(result.result.headHash.length > 0, 'headHash must be non-empty');
    assert.strictEqual(result.result.lastModified, 1700000000000, 'lastModified should be echoed from meta');
    assert.strictEqual(result.result.syncDirty, false, 'syncDirty should be false');
    assert.ok(result.result.meta, 'meta must be present');
    assert.strictEqual(result.result.meta.revision, 5);
    assert.strictEqual(result.result.meta.nodeCount, 2);
    assert.strictEqual(result.result.meta.edgeCount, 1);
    assert.strictEqual(result.result.meta.tombstoneCount, 0);
    assert.strictEqual(result.result.meta.lastProcessedFloor, 3);
    assert.strictEqual(result.result.meta.extractionCount, 12);
    assert.strictEqual(result.result.meta.schemaVersion, 1);
    assert.strictEqual(result.result.meta.syncDirty, false);
    assert.strictEqual(result.result.meta.syncDirtyReason, null);

    // ensureGraphSchema called first — exec called with 4 CREATE TABLE statements.
    const createTableCalls = calls.exec.filter((c) => c.statement.includes('CREATE TABLE'));
    assert.strictEqual(createTableCalls.length, 4, 'must run 4 CREATE TABLE statements before reading');
    assert.ok(createTableCalls.every((c) => c.statement.includes('IF NOT EXISTS')), 'CREATE TABLE must be idempotent (IF NOT EXISTS)');

    // Database defaults to BME's graph default ('default') when not specified.
    assert.strictEqual(calls.exec[0].database, 'default', 'exec database must default to BME graph default');
    assert.strictEqual(calls.query[0].database, 'default', 'query database must default to BME graph default');

    // Only ctx.sql.query and ctx.sql.exec are used (no other ctx methods).
    assert.ok(calls.query.length > 0, 'must use ctx.sql.query for reads');
    assert.ok(calls.exec.length > 0, 'must use ctx.sql.exec for schema ensure');
  }

  console.log('[test:authority-companion-module] testing graph.getHead returns exists:false for new chat');
  {
    const { calls, ctx } = createMockSqlTxCtx({ meta: {}, nodes: [], edges: [] });
    ctx.transactionName = 'graph.getHead';
    const result = await (await getHandler(mod, 'graph.getHead'))(ctx, { chatId: 'new-chat' }, {});
    assert.strictEqual(result.result.ok, true);
    assert.strictEqual(result.result.chatId, 'new-chat');
    assert.strictEqual(result.result.revision, 0, 'revision should be 0 for new chat');
    assert.strictEqual(result.result.exists, false, 'exists should be false when no meta rows');
    assert.strictEqual(result.result.headHash, null, 'headHash must be null for new chat');

    // Schema ensure still runs even for new chats.
    const createTableCalls = calls.exec.filter((c) => c.statement.includes('CREATE TABLE'));
    assert.strictEqual(createTableCalls.length, 4, 'ensureGraphSchema must run before the meta read');
  }

  console.log('[test:authority-companion-module] testing graph.getHead respects explicit database');
  {
    const { calls, ctx } = createMockSqlTxCtx({ meta: { revision: 1 }, nodes: [], edges: [] });
    ctx.transactionName = 'graph.getHead';
    const result = await (await getHandler(mod, 'graph.getHead'))(ctx, { chatId: 'chat-1', database: 'custom-db' }, {});
    assert.strictEqual(result.result.ok, true);
    assert.strictEqual(calls.exec[0].database, 'custom-db', 'exec must use explicit database');
    assert.strictEqual(calls.query[0].database, 'custom-db', 'query must use explicit database');
  }

  console.log('[test:authority-companion-module] testing graph.getHead requires chatId');
  {
    const { ctx } = createMockSqlTxCtx({ meta: {}, nodes: [], edges: [] });
    ctx.transactionName = 'graph.getHead';
    await assert.rejects(
      async () => await (await getHandler(mod, 'graph.getHead'))(ctx, {}, {}),
      /requires chatId/,
      'should reject missing chatId',
    );
  }

  console.log('[test:authority-companion-module] testing graph.loadSnapshot returns full snapshot when chat exists');
  {
    const testNodes = [{ id: 'node-a', type: 'concept' }, { id: 'node-b', type: 'fact' }];
    const testEdges = [{ id: 'edge-1', from: 'node-a', to: 'node-b', relation: 'related' }];
    const testTombstones = [{ id: 'tomb-1', kind: 'node', targetId: 'node-c' }];
    const testMeta = {
      revision: 7,
      lastModified: 1700000000001,
      syncDirty: true,
      syncDirtyReason: 'test',
      lastProcessedFloor: 4,
      extractionCount: 20,
      schemaVersion: 1,
      nodeCount: 2,
      edgeCount: 1,
      tombstoneCount: 1,
    };
    const { calls, ctx } = createMockSqlTxCtx({
      meta: testMeta,
      nodes: testNodes,
      edges: testEdges,
      tombstones: testTombstones,
    });
    ctx.transactionName = 'graph.loadSnapshot';
    const result = await (await getHandler(mod, 'graph.loadSnapshot'))(ctx, { chatId: 'chat-snap' }, {});
    assert.strictEqual(result.result.ok, true);
    assert.strictEqual(result.result.chatId, 'chat-snap');
    assert.strictEqual(result.result.revision, 7);
    assert.strictEqual(result.result.schemaVersion, 1, 'schemaVersion should be 1');
    assert.strictEqual(typeof result.result.headHash, 'string', 'headHash must be a string');
    assert.ok(result.result.headHash.length > 0);

    assert.ok(Array.isArray(result.result.nodes), 'nodes must be an array');
    assert.strictEqual(result.result.nodes.length, 2, 'nodes should have 2 entries');
    assert.strictEqual(result.result.nodes[0].id, 'node-a');
    assert.strictEqual(result.result.nodes[1].id, 'node-b');
    assert.ok(Array.isArray(result.result.edges), 'edges must be an array');
    assert.strictEqual(result.result.edges.length, 1);
    assert.strictEqual(result.result.edges[0].id, 'edge-1');
    assert.ok(Array.isArray(result.result.tombstones), 'tombstones must be an array');
    assert.strictEqual(result.result.tombstones.length, 1);
    assert.strictEqual(result.result.tombstones[0].id, 'tomb-1');

    assert.ok(result.result.meta, 'meta must be present');
    assert.strictEqual(result.result.meta.revision, 7);
    assert.strictEqual(result.result.meta.syncDirty, true);
    assert.strictEqual(result.result.meta.syncDirtyReason, 'test');

    assert.ok(result.result.state, 'state must be present');
    assert.strictEqual(result.result.state.lastProcessedFloor, 4);
    assert.strictEqual(result.result.state.extractionCount, 20);

    // ensureGraphSchema called first.
    const createTableCalls = calls.exec.filter((c) => c.statement.includes('CREATE TABLE'));
    assert.strictEqual(createTableCalls.length, 4, 'must run 4 CREATE TABLE statements before reading');

    // Only ctx.sql.query and ctx.sql.exec are used.
    assert.ok(calls.query.length > 0, 'must use ctx.sql.query for reads');
    assert.ok(calls.exec.length > 0, 'must use ctx.sql.exec for schema ensure');
  }

  console.log('[test:authority-companion-module] testing graph.loadSnapshot returns unchanged when minRevision matches');
  {
    const { calls, ctx } = createMockSqlTxCtx({
      meta: { revision: 7 },
      nodes: [{ id: 'node-a' }],
      edges: [],
    });
    ctx.transactionName = 'graph.loadSnapshot';
    const result = await (await getHandler(mod, 'graph.loadSnapshot'))(ctx, { chatId: 'chat-unchanged', minRevision: 7 }, {});
    assert.strictEqual(result.result.ok, true);
    assert.strictEqual(result.result.unchanged, true, 'unchanged must be true when minRevision matches current revision');
    assert.strictEqual(result.result.revision, 7);
    assert.strictEqual(result.result.chatId, 'chat-unchanged');
    assert.strictEqual(typeof result.result.headHash, 'string', 'headHash must still be present');

    // Should NOT have queried payload tables — short-circuit before the payload reads.
    const payloadQueries = calls.query.filter((c) => c.statement.includes('payload_json'));
    assert.strictEqual(payloadQueries.length, 0, 'should not query payload tables when unchanged');
  }

  console.log('[test:authority-companion-module] testing graph.loadSnapshot returns full snapshot when minRevision does not match');
  {
    const { calls, ctx } = createMockSqlTxCtx({
      meta: { revision: 7 },
      nodes: [{ id: 'node-a' }],
      edges: [{ id: 'edge-1' }],
    });
    ctx.transactionName = 'graph.loadSnapshot';
    const result = await (await getHandler(mod, 'graph.loadSnapshot'))(ctx, { chatId: 'chat-changed', minRevision: 5 }, {});
    assert.strictEqual(result.result.ok, true);
    assert.strictEqual(result.result.unchanged, undefined, 'unchanged must NOT be set when minRevision differs');
    assert.strictEqual(result.result.revision, 7);
    assert.ok(Array.isArray(result.result.nodes), 'nodes must be returned when revision differs');
    assert.strictEqual(result.result.nodes.length, 1);
    assert.strictEqual(result.result.nodes[0].id, 'node-a');
    assert.ok(Array.isArray(result.result.edges));
    assert.strictEqual(result.result.edges.length, 1);
    assert.strictEqual(result.result.edges[0].id, 'edge-1');

    // Payload tables were queried because the revision differed.
    const payloadQueries = calls.query.filter((c) => c.statement.includes('payload_json'));
    assert.ok(payloadQueries.length >= 3, 'should query nodes, edges, and tombstones payload tables');
  }

  console.log('[test:authority-companion-module] testing graph.loadSnapshot returns empty snapshot for new chat');
  {
    const { ctx } = createMockSqlTxCtx({ meta: {}, nodes: [], edges: [], tombstones: [] });
    ctx.transactionName = 'graph.loadSnapshot';
    const result = await (await getHandler(mod, 'graph.loadSnapshot'))(ctx, { chatId: 'new-chat-snap' }, {});
    assert.strictEqual(result.result.ok, true);
    assert.strictEqual(result.result.chatId, 'new-chat-snap');
    assert.strictEqual(result.result.revision, 0);
    assert.strictEqual(result.result.headHash, null);
    assert.strictEqual(result.result.schemaVersion, 1);
    assert.deepStrictEqual(result.result.nodes, []);
    assert.deepStrictEqual(result.result.edges, []);
    assert.deepStrictEqual(result.result.tombstones, []);
    assert.deepStrictEqual(result.result.state, { lastProcessedFloor: 0, extractionCount: 0 });
  }

  console.log('[test:authority-companion-module] testing graph.loadSnapshot respects explicit database');
  {
    const { calls, ctx } = createMockSqlTxCtx({
      meta: { revision: 1 },
      nodes: [{ id: 'n1' }],
      edges: [],
    });
    ctx.transactionName = 'graph.loadSnapshot';
    const result = await (await getHandler(mod, 'graph.loadSnapshot'))(ctx, { chatId: 'chat-1', database: 'graph-db' }, {});
    assert.strictEqual(result.result.ok, true);
    assert.strictEqual(calls.exec[0].database, 'graph-db', 'exec must use explicit database');
    assert.strictEqual(calls.query[0].database, 'graph-db', 'query must use explicit database');
  }

  console.log('[test:authority-companion-module] testing graph headHash divergence detection');
  {
    // Same revision, different node sets -> different headHash.
    const { ctx: ctxA } = createMockSqlTxCtx({
      meta: { revision: 5 },
      nodes: [{ id: 'node-a' }, { id: 'node-b' }],
      edges: [{ id: 'edge-1' }],
    });
    ctxA.transactionName = 'graph.getHead';
    const resultA = await (await getHandler(mod, 'graph.getHead'))(ctxA, { chatId: 'chat-A' }, {});

    const { ctx: ctxB } = createMockSqlTxCtx({
      meta: { revision: 5 },
      nodes: [{ id: 'node-a' }, { id: 'node-c' }],
      edges: [{ id: 'edge-1' }],
    });
    ctxB.transactionName = 'graph.getHead';
    const resultB = await (await getHandler(mod, 'graph.getHead'))(ctxB, { chatId: 'chat-B' }, {});

    assert.strictEqual(resultA.result.revision, 5);
    assert.strictEqual(resultB.result.revision, 5);
    assert.strictEqual(resultA.result.exists, true);
    assert.strictEqual(resultB.result.exists, true);
    assert.ok(typeof resultA.result.headHash === 'string');
    assert.ok(typeof resultB.result.headHash === 'string');
    assert.notStrictEqual(
      resultA.result.headHash,
      resultB.result.headHash,
      'same revision with different node ids must produce different headHashes',
    );

    // Same revision + same node ids + same edge ids -> same headHash.
    const { ctx: ctxC } = createMockSqlTxCtx({
      meta: { revision: 5 },
      nodes: [{ id: 'node-a' }, { id: 'node-b' }],
      edges: [{ id: 'edge-1' }],
    });
    ctxC.transactionName = 'graph.getHead';
    const resultC = await (await getHandler(mod, 'graph.getHead'))(ctxC, { chatId: 'chat-C' }, {});
    assert.strictEqual(
      resultA.result.headHash,
      resultC.result.headHash,
      'same revision + same node/edge ids must produce the same headHash',
    );
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
