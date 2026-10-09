import assert from "node:assert/strict";
import {
  TAURITAVERN_PAYLOAD_BUDGET_BYTES,
  TauriTavernGraphStore,
  buildTauriTavernNamespace,
  measureJsonBytes,
  shardOversizedPayload,
} from "../sync/tauritavern-graph-store.js";
import { createFakeTauriTavernDbApi } from "./helpers/fake-triviumdb.mjs";

function createStore(chatId = "chat-1", options = {}) {
  const dbApi = options.dbApi || createFakeTauriTavernDbApi();
  return {
    dbApi,
    store: new TauriTavernGraphStore(chatId, {
      dim: 8,
      dbApi,
      skipLegacyImport: true,
      ...options,
    }),
  };
}

const namespace = await buildTauriTavernNamespace("hello", 8);
assert.match(namespace, /^stbme-[0-9a-f]{32}-d8$/);

const { store } = createStore();
await store.open();
const empty = await store.isEmpty();
assert.equal(empty.empty, true);

const committed = await store.commitDelta({
  upsertNodes: [
    { id: "n1", type: "fact", content: "Alice opened the door", embedding: new Array(8).fill(0.1) },
    { id: "n2", type: "fact", content: "Bob waited outside" },
  ],
  upsertEdges: [{ id: "e1", fromId: "n1", toId: "n2", relation: "related", weight: 0.8 }],
}, { reason: "test-commit" });
assert.equal(committed.revision, 1);
assert.equal(store._db.flushCount, 1);

const snapshot = await store.exportSnapshot();
assert.equal(snapshot.nodes.length, 2);
assert.equal(snapshot.edges.length, 1);
assert.equal(snapshot.nodes.find((node) => node.id === "n1").content, "Alice opened the door");
assert.equal(snapshot.meta.storagePrimary, "tauritavern");
assert.equal(snapshot.edges[0].relation, "related");

const hits = await store.searchSimilar(new Array(8).fill(0.1), { topK: 2 });
assert.ok(hits.some((hit) => hit.id === "n1"));

await store.updateRecordVector("node", "n2", new Array(8).fill(0.2));
const n2 = await store._getRecord("node", "n2");
assert.deepEqual(n2.vector, new Array(8).fill(0.2));

const conflictStore = createStore("chat-conflict").store;
await conflictStore.open();
await conflictStore.commitDelta({ upsertNodes: [{ id: "a", type: "fact" }] });
await assert.rejects(
  () => conflictStore.commitDelta({ upsertNodes: [{ id: "b", type: "fact" }] }, { baseRevision: 0 }),
  /commit conflict/,
);

const shard = shardOversizedPayload("node", "big", { id: "big", content: "x".repeat(8 * 1024 * 1024) });
assert.ok(shard.shards.length >= 1);
assert.ok(measureJsonBytes(shard.payload) < TAURITAVERN_PAYLOAD_BUDGET_BYTES);

const { store: shardStore } = createStore("chat-shard");
await shardStore.open();
const huge = await shardStore.commitDelta({
  upsertNodes: [{ id: "huge", type: "fact", content: "y".repeat(200_000) }],
});
assert.equal(huge.revision, 1);
const hugeSnap = await shardStore.exportSnapshot();
assert.equal(hugeSnap.nodes[0].content.length, 200_000);

const { dbApi, store: walStore } = createStore("chat-wal");
await walStore.open();
walStore._db.upsert = async function crashAfterWal(id, vector, payload) {
  if (payload?.ttRecordKind === "node") {
    throw new Error("simulated crash during apply");
  }
  return FakeUpsert.call(this, id, vector, payload);
};
const FakeUpsert = Object.getPrototypeOf(walStore._db).upsert;
try {
  await walStore.commitDelta({ upsertNodes: [{ id: "crash", type: "fact", content: "pending" }] });
  assert.fail("expected crash");
} catch (error) {
  assert.match(String(error.message), /simulated crash/);
}
walStore._db.upsert = FakeUpsert.bind(walStore._db);
walStore._invalidateHandle();
walStore._db = await dbApi.open(walStore.namespace, { dim: 8 });
walStore._opened = true;
walStore._openPromise = Promise.resolve(walStore);
await walStore._ensureHead();
await walStore._recoverPendingWal();
const recovered = await walStore.exportSnapshot();
assert.equal(recovered.nodes.some((node) => node.id === "crash"), true, "complete WAL should replay after crash");

const { dbApi: busyApi, store: busyStore } = createStore("chat-busy");
await busyStore.open();
busyStore._db.setBusy(true);
await assert.rejects(() => busyStore.commitDelta({ upsertNodes: [{ id: "z", type: "fact" }] }), /busy/i);
const busyHandle = [...busyApi.handles.values()][0];
busyHandle.setBusy(false);
await busyStore.open();
const afterBusy = await busyStore.commitDelta({ upsertNodes: [{ id: "z", type: "fact" }] });
assert.equal(afterBusy.revision >= 1, true);

const { store: oversize } = createStore("chat-oversize");
await oversize.open();
const originalUpsert = oversize._db.upsert.bind(oversize._db);
oversize._db.upsert = async (id, vector, payload) => {
  assert.ok(
    measureJsonBytes(payload) <= TAURITAVERN_PAYLOAD_BUDGET_BYTES,
    `upsert payload ${measureJsonBytes(payload)} exceeded 7MiB budget`,
  );
  return originalUpsert(id, vector, payload);
};
const sharded = await oversize.commitDelta({
  upsertNodes: [{ id: "too-big", type: "fact", content: "n".repeat(TAURITAVERN_PAYLOAD_BUDGET_BYTES + 1024) }],
});
assert.equal(sharded.revision, 1);
const shardedSnap = await oversize.exportSnapshot();
assert.equal(shardedSnap.nodes[0].content.length, TAURITAVERN_PAYLOAD_BUDGET_BYTES + 1024);

const { dbApi: closedApi, store: closedStore } = createStore("chat-closed");
await closedStore.open();
await closedStore.commitDelta({ upsertNodes: [{ id: "keep", type: "fact", content: "survives close" }] });
closedStore._db.closed = true;
closedStore._invalidateHandle();
const afterClose = await closedStore.exportSnapshot();
assert.equal(afterClose.nodes.some((node) => node.id === "keep"), true, "reopen after host close must keep flushed records");
assert.equal(closedApi.handles.get(closedStore.namespace).closed, false);

let importCalls = 0;
const { store: importStore } = createStore("chat-legacy-import", {
  skipLegacyImport: false,
  legacyImporter: async () => {
    importCalls += 1;
    return {
      schemaVersion: 1,
      meta: { revision: 3, chatId: "chat-legacy-import" },
      nodes: [{ id: "legacy", type: "fact", content: "from indexeddb" }],
      edges: [],
      tombstones: [],
      state: { lastProcessedFloor: 2, extractionCount: 1 },
    };
  },
});
await importStore.open();
assert.equal(importCalls, 1);
const imported = await importStore.exportSnapshot();
assert.equal(imported.nodes[0].content, "from indexeddb");
assert.equal(imported.meta.migrationSource, "browser-local");
await importStore.close();
await importStore.open();
assert.equal(importCalls, 1, "legacy IndexedDB/OPFS import must run once for an empty namespace");

console.log("tauritavern-graph-store tests passed");
