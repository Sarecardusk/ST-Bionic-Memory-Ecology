import assert from "node:assert/strict";

import {
  AUTHORITY_GRAPH_STORE_KIND,
  AUTHORITY_GRAPH_STORE_MODE,
  AuthorityGraphStore,
  AuthoritySqlHttpClient,
  convertNamedParamsToPositional,
} from "../sync/authority-graph-store.js";
import {
  BME_DB_SCHEMA_VERSION,
  BME_TOMBSTONE_RETENTION_MS,
} from "../sync/bme-db.js";

const PREFIX = "[ST-BME][authority-graph-store]";

class MockAuthoritySqlClient {
  constructor() {
    this.meta = new Map();
    this.nodes = new Map();
    this.edges = new Map();
    this.tombstones = new Map();
    this.statements = [];
  }

  async transaction(statements = []) {
    for (const statement of statements) {
      await this.execute(statement.sql, statement.params || {});
    }
    return { executed: statements.length };
  }

  async execute(sql, params = {}) {
    this.statements.push({ sql, params });
    const normalizedSql = String(sql || "").toLowerCase();
    if (normalizedSql.startsWith("create table")) {
      return { ok: true };
    }
    if (normalizedSql.includes("insert into st_bme_graph_meta")) {
      this.meta.set(this._key(params.chatId, params.key), {
        chat_id: params.chatId,
        meta_key: params.key,
        value_json: params.valueJson,
        updated_at: params.updatedAt,
      });
      return { ok: true };
    }
    if (normalizedSql.includes("insert into st_bme_graph_nodes")) {
      this.nodes.set(this._key(params.chatId, params.id), {
        chat_id: params.chatId,
        record_id: params.id,
        payload_json: params.payloadJson,
        node_type: params.type,
        source_floor: params.sourceFloor,
        archived: params.archived,
        updated_at: params.updatedAt,
        deleted_at: params.deletedAt,
      });
      return { ok: true };
    }
    if (normalizedSql.includes("insert into st_bme_graph_edges")) {
      this.edges.set(this._key(params.chatId, params.id), {
        chat_id: params.chatId,
        record_id: params.id,
        payload_json: params.payloadJson,
        from_id: params.fromId,
        to_id: params.toId,
        relation: params.relation,
        source_floor: params.sourceFloor,
        updated_at: params.updatedAt,
        deleted_at: params.deletedAt,
      });
      return { ok: true };
    }
    if (normalizedSql.includes("insert into st_bme_graph_tombstones")) {
      this.tombstones.set(this._key(params.chatId, params.id), {
        chat_id: params.chatId,
        record_id: params.id,
        payload_json: params.payloadJson,
        tombstone_kind: params.kind,
        target_id: params.targetId,
        deleted_at: params.deletedAt,
        source_device_id: params.sourceDeviceId,
      });
      return { ok: true };
    }
    if (normalizedSql.startsWith("delete from st_bme_graph_nodes")) {
      this._deleteRows(this.nodes, params);
      return { ok: true };
    }
    if (normalizedSql.startsWith("delete from st_bme_graph_edges")) {
      this._deleteRows(this.edges, params);
      return { ok: true };
    }
    if (normalizedSql.startsWith("delete from st_bme_graph_tombstones")) {
      this._deleteRows(this.tombstones, params);
      return { ok: true };
    }
    if (normalizedSql.startsWith("delete from st_bme_graph_meta")) {
      this._deleteRows(this.meta, params);
      return { ok: true };
    }
    throw new Error(`Unhandled SQL execute: ${sql}`);
  }

  async query(sql, params = {}) {
    const normalizedSql = String(sql || "").toLowerCase();
    if (normalizedSql.includes("from st_bme_graph_meta")) {
      return this._readRows(this.meta, params).map((row) => ({
        key: row.meta_key,
        valueJson: row.value_json,
      }));
    }
    if (normalizedSql.includes("from st_bme_graph_nodes")) {
      if (normalizedSql.includes("count(*)")) {
        return [{ count: this._readRows(this.nodes, params).length }];
      }
      return this._readRows(this.nodes, params).map((row) => ({
        payloadJson: row.payload_json,
      }));
    }
    if (normalizedSql.includes("from st_bme_graph_edges")) {
      if (normalizedSql.includes("count(*)")) {
        return [{ count: this._readRows(this.edges, params).length }];
      }
      return this._readRows(this.edges, params).map((row) => ({
        payloadJson: row.payload_json,
      }));
    }
    if (normalizedSql.includes("from st_bme_graph_tombstones")) {
      if (normalizedSql.includes("count(*)")) {
        return [{ count: this._readRows(this.tombstones, params).length }];
      }
      if (normalizedSql.includes("deleted_at <")) {
        return this._readRows(this.tombstones, params)
          .filter((row) => Number(row.deleted_at) < Number(params.cutoffMs))
          .map((row) => ({ id: row.record_id }));
      }
      return this._readRows(this.tombstones, params).map((row) => ({
        payloadJson: row.payload_json,
      }));
    }
    throw new Error(`Unhandled SQL query: ${sql}`);
  }

  _key(chatId, id) {
    return `${String(chatId || "")}\u0000${String(id || "")}`;
  }

  _readRows(table, params = {}) {
    const chatId = String(params.chatId || "");
    const id = params.id ?? params.key;
    return Array.from(table.values()).filter((row) => {
      if (String(row.chat_id || "") !== chatId) return false;
      if (id == null) return true;
      return String(row.record_id ?? row.meta_key ?? "") === String(id);
    });
  }

  _deleteRows(table, params = {}) {
    const chatId = String(params.chatId || "");
    const id = params.id ?? params.key;
    for (const [key, row] of table.entries()) {
      if (String(row.chat_id || "") !== chatId) continue;
      if (id != null && String(row.record_id ?? row.meta_key ?? "") !== String(id)) continue;
      table.delete(key);
    }
  }
}

function createLimitError() {
  const error = new Error("length limit exceeded");
  error.status = 413;
  error.category = "limit";
  error.code = "length_limit_exceeded";
  return error;
}

function isNodeUpsertStatement(statement = {}) {
  return String(statement.sql || "").toLowerCase().includes("insert into st_bme_graph_nodes");
}

async function testOpenSeedsAuthorityMeta() {
  const sqlClient = new MockAuthoritySqlClient();
  const store = new AuthorityGraphStore("authority-chat-a", { sqlClient });
  await store.open();

  assert.equal(store.storeKind, AUTHORITY_GRAPH_STORE_KIND);
  assert.equal(store.storeMode, AUTHORITY_GRAPH_STORE_MODE);
  assert.equal(await store.getMeta("schemaVersion"), BME_DB_SCHEMA_VERSION);
  assert.equal(await store.getMeta("storagePrimary"), AUTHORITY_GRAPH_STORE_KIND);
  assert.equal(await store.getRevision(), 0);

  const diagnostics = store.getStorageDiagnosticsSync();
  assert.equal(diagnostics.storageKind, AUTHORITY_GRAPH_STORE_KIND);
  assert.equal(diagnostics.browserCacheMode, "minimal");
}

async function testImportCommitAndExportSnapshot() {
  const sqlClient = new MockAuthoritySqlClient();
  const store = new AuthorityGraphStore("authority-chat-b", { sqlClient });
  await store.open();

  const importResult = await store.importSnapshot(
    {
      meta: {
        revision: 7,
        lastProcessedFloor: 3,
        extractionCount: 4,
      },
      nodes: [
        { id: "node-1", type: "event", sourceFloor: 1, updatedAt: 10 },
        { id: "node-2", type: "event", archived: true, updatedAt: 20 },
        { id: "node-3", type: "memory", deletedAt: 30, updatedAt: 30 },
      ],
      edges: [
        {
          id: "edge-1",
          fromId: "node-1",
          toId: "node-3",
          relation: "refers",
          updatedAt: 40,
        },
      ],
      tombstones: [
        {
          id: "tombstone-1",
          kind: "node",
          targetId: "node-old",
          deletedAt: 50,
        },
      ],
    },
    { preserveRevision: true },
  );

  assert.equal(importResult.revision, 7);
  assert.deepEqual(importResult.imported, { nodes: 3, edges: 1, tombstones: 1 });
  assert.equal((await store.listNodes()).length, 3);
  assert.deepEqual(
    (await store.listNodes({ includeArchived: false, includeDeleted: false })).map((node) => node.id),
    ["node-1"],
  );
  assert.deepEqual((await store.listEdges({ relation: "refers" })).map((edge) => edge.id), ["edge-1"]);

  const commitResult = await store.commitDelta(
    {
      upsertNodes: [{ id: "node-4", type: "event", updatedAt: 60 }],
      deleteNodeIds: ["node-2"],
      countDelta: {
        previous: { nodes: 3, edges: 1, tombstones: 1 },
        delta: { nodes: 0, edges: 0, tombstones: 0 },
      },
      runtimeMetaPatch: {
        lastProcessedFloor: 8,
        revision: 999,
      },
    },
    {
      reason: "test-commit",
      requestedRevision: 9,
    },
  );

  assert.equal(commitResult.revision, 9);
  assert.deepEqual(commitResult.imported, { nodes: 3, edges: 1, tombstones: 1 });
  assert.equal(await store.getMeta("lastProcessedFloor"), 8);
  assert.equal(await store.getRevision(), 9);
  assert.equal(await store.getMeta("lastMutationReason"), "test-commit");
  assert.equal(await store.getMeta("syncDirty"), true);
  assert.deepEqual((await store.listNodes()).map((node) => node.id).sort(), ["node-1", "node-3", "node-4"]);

  const snapshot = await store.exportSnapshot();
  assert.equal(snapshot.meta.revision, 9);
  assert.equal(snapshot.meta.storagePrimary, AUTHORITY_GRAPH_STORE_KIND);
  assert.equal(snapshot.meta.storageMode, AUTHORITY_GRAPH_STORE_MODE);
  assert.equal(snapshot.meta.nodeCount, 3);
  assert.equal(snapshot.nodes.length, 3);
  assert.equal(snapshot.edges.length, 1);
  assert.equal(snapshot.tombstones.length, 1);
  assert.equal(snapshot.state.lastProcessedFloor, 8);
}

async function testPruneAndClear() {
  const sqlClient = new MockAuthoritySqlClient();
  const store = new AuthorityGraphStore("authority-chat-c", { sqlClient });
  await store.importSnapshot({
    nodes: [{ id: "node-1", type: "event", updatedAt: 1 }],
    tombstones: [
      { id: "old-tombstone", kind: "node", targetId: "old", deletedAt: 1 },
      {
        id: "new-tombstone",
        kind: "node",
        targetId: "new",
        deletedAt: BME_TOMBSTONE_RETENTION_MS,
      },
    ],
  });

  const pruneResult = await store.pruneExpiredTombstones(BME_TOMBSTONE_RETENTION_MS + 100);
  assert.equal(pruneResult.pruned, 1);
  assert.deepEqual((await store.listTombstones()).map((item) => item.id), ["new-tombstone"]);

  const clearResult = await store.clearAll();
  assert.equal(clearResult.cleared, true);
  assert.equal((await store.isEmpty({ includeTombstones: true })).empty, true);
  assert.equal(await store.getMeta("storagePrimary"), AUTHORITY_GRAPH_STORE_KIND);
}

async function testHttpSqlClientBoundary() {
  const requests = [];
  const client = new AuthoritySqlHttpClient({
    baseUrl: "https://authority.example.test/root/",
    headerProvider: () => ({ "X-Test": "1" }),
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith("/session/init")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { sessionToken: "sql-session-token" };
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { rows: [{ value: 1 }] };
        },
      };
    },
  });

  const result = await client.query("SELECT 1", { chatId: "chat" });
  assert.deepEqual(result, { rows: [{ value: 1 }] });
  assert.deepEqual(
    requests.map((request) => request.url),
    [
      "https://authority.example.test/root/session/init",
      "https://authority.example.test/root/sql/query",
    ],
  );
  assert.equal(requests[1].init.method, "POST");
  assert.equal(requests[1].init.headers["X-Test"], "1");
  assert.equal(requests[1].init.headers["x-authority-session-token"], "sql-session-token");
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    database: "default",
    statement: "SELECT 1",
    params: [],
  });
}

async function testConvertNamedParamsToPositional() {
  // Named params with :placeholders get converted to positional ? with array
  const r1 = convertNamedParamsToPositional(
    "SELECT * FROM t WHERE chat_id = :chatId AND meta_key = :key",
    { chatId: "abc", key: "rev" },
  );
  assert.equal(r1.sql, "SELECT * FROM t WHERE chat_id = ? AND meta_key = ?");
  assert.deepEqual(r1.params, ["abc", "rev"]);

  // Duplicate named params produce multiple positional entries
  const r2 = convertNamedParamsToPositional(
    "INSERT INTO t (a, b) VALUES (:chatId, :chatId)",
    { chatId: "dup" },
  );
  assert.equal(r2.sql, "INSERT INTO t (a, b) VALUES (?, ?)");
  assert.deepEqual(r2.params, ["dup", "dup"]);

  // No placeholders → empty array
  const r3 = convertNamedParamsToPositional("SELECT 1", { chatId: "x" });
  assert.equal(r3.sql, "SELECT 1");
  assert.deepEqual(r3.params, []);

  // Already-array params pass through unchanged
  const r4 = convertNamedParamsToPositional("SELECT ?", [42]);
  assert.equal(r4.sql, "SELECT ?");
  assert.deepEqual(r4.params, [42]);

  // Empty/null params → empty array
  const r5 = convertNamedParamsToPositional("SELECT 1", null);
  assert.deepEqual(r5.params, []);
  const r6 = convertNamedParamsToPositional("SELECT 1", undefined);
  assert.deepEqual(r6.params, []);

  // Missing param name → null in array
  const r7 = convertNamedParamsToPositional(
    "WHERE x = :x AND y = :y",
    { x: 1 },
  );
  assert.equal(r7.sql, "WHERE x = ? AND y = ?");
  assert.deepEqual(r7.params, [1, null]);

  // ::typecast is not treated as a named param
  const r8 = convertNamedParamsToPositional(
    "SELECT x::text FROM t WHERE id = :id",
    { id: 5 },
  );
  assert.equal(r8.sql, "SELECT x::text FROM t WHERE id = ?");
  assert.deepEqual(r8.params, [5]);
}

async function testTransactionBatchingUsesByteBudget() {
  const sqlClient = new MockAuthoritySqlClient();
  const batchSizes = [];
  const originalTransaction = sqlClient.transaction.bind(sqlClient);
  sqlClient.transaction = async (statements = []) => {
    if (statements.some(isNodeUpsertStatement)) {
      batchSizes.push(statements.length);
    }
    return await originalTransaction(statements);
  };
  const store = new AuthorityGraphStore("authority-chat-byte-budget", {
    sqlClient,
    sqlTransactionBatchSize: 150,
    sqlTransactionMaxBytes: 4096,
  });
  const nodes = Array.from({ length: 8 }, (_, index) => ({
    id: `node-${index}`,
    type: "event",
    text: `payload-${index}-${"測試".repeat(260)}`,
    updatedAt: index + 1,
  }));

  await store.bulkUpsertNodes(nodes);

  assert.equal((await store.listNodes()).length, nodes.length);
  assert.ok(batchSizes.length > 1, "expected large payload to split into multiple transactions");
  assert.ok(batchSizes.every((size) => size < nodes.length), "expected no single node transaction batch to contain all records");
}

async function testTransaction413SplitsWithoutRepeatingOversizedBatch() {
  const sqlClient = new MockAuthoritySqlClient();
  const attemptedBatchSizes = [];
  const originalTransaction = sqlClient.transaction.bind(sqlClient);
  sqlClient.transaction = async (statements = []) => {
    const nodeBatchSize = statements.filter(isNodeUpsertStatement).length;
    if (nodeBatchSize > 0) {
      attemptedBatchSizes.push(nodeBatchSize);
      if (nodeBatchSize > 2) {
        throw createLimitError();
      }
    }
    return await originalTransaction(statements);
  };
  const store = new AuthorityGraphStore("authority-chat-413-split", {
    sqlClient,
    sqlTransactionBatchSize: 150,
    sqlTransactionMaxBytes: 512 * 1024,
  });
  const nodes = Array.from({ length: 6 }, (_, index) => ({
    id: `node-${index}`,
    type: "event",
    text: `payload-${index}`,
    updatedAt: index + 1,
  }));

  await store.bulkUpsertNodes(nodes);

  assert.equal((await store.listNodes()).length, nodes.length);
  assert.equal(attemptedBatchSizes[0], 6);
  assert.ok(attemptedBatchSizes.some((size) => size <= 2), "expected oversized request to be split below the failing size");
  assert.ok(attemptedBatchSizes.length <= 10, "expected bounded split attempts instead of an endless retry loop");
}

async function testSingleStatement413IsTerminal() {
  const sqlClient = new MockAuthoritySqlClient();
  let oversizedAttempts = 0;
  sqlClient.transaction = async (statements = []) => {
    if (statements.some(isNodeUpsertStatement)) {
      oversizedAttempts += 1;
      throw createLimitError();
    }
    for (const statement of statements) {
      await sqlClient.execute(statement.sql, statement.params || {});
    }
    return { executed: statements.length };
  };
  const store = new AuthorityGraphStore("authority-chat-single-413", { sqlClient });

  await assert.rejects(
    () => store.bulkUpsertNodes([{ id: "too-large", type: "event", text: "x".repeat(1024), updatedAt: 1 }]),
    (error) => {
      assert.equal(error.name, "AuthoritySqlPayloadTooLargeError");
      assert.equal(error.nonRetryable, true);
      assert.equal(error.terminal, true);
      return true;
    },
  );
  assert.ok(oversizedAttempts >= 1, "expected the oversized record to be attempted at least once");
  assert.ok(oversizedAttempts <= 4, "single oversized record must not retry forever");
}

await testConvertNamedParamsToPositional();
await testOpenSeedsAuthorityMeta();
await testImportCommitAndExportSnapshot();
await testPruneAndClear();
await testHttpSqlClientBoundary();
await testTransactionBatchingUsesByteBudget();
await testTransaction413SplitsWithoutRepeatingOversizedBatch();
await testSingleStatement413IsTerminal();

console.log(`${PREFIX} all tests passed`);
