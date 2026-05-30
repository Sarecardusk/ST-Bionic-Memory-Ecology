// ST-BME restrained rebirth — Phase 7 v3 GraphStore adapter tests.

import assert from "node:assert/strict";
import {
  GRAPH_V3_COMMIT_MARKER_KEY,
  GRAPH_V3_HEAD_KEY,
  GRAPH_V3_METADATA_KEY,
} from "../graph/graph-v3-namespace.js";
import {
  buildCommitMarkerV3,
  normalizeGraphHead,
  normalizeReplicaPointer,
} from "../graph/graph-head.js";
import { GRAPH_STORE_REQUIRED_METHODS, inspectGraphStoreContract } from "../sync/graph-store-contract.js";
import {
  createLukerChatStateGraphStoreV3,
  isGraphStoreV3Wrapped,
  wrapDbLikeGraphStoreV3,
} from "../sync/graph-store-v3-adapter.js";

function createMockDbLikeStore() {
  const meta = new Map();
  const calls = [];
  return {
    storeKind: "indexeddb",
    storeMode: "indexeddb-v3-test",
    meta,
    calls,
    async open() {
      calls.push(["open"]);
      return this;
    },
    async close() {
      calls.push(["close"]);
    },
    async getMeta(key, fallbackValue = null) {
      calls.push(["getMeta", key]);
      return meta.has(key) ? meta.get(key) : fallbackValue;
    },
    async patchMeta(record = {}) {
      calls.push(["patchMeta", Object.keys(record).sort()]);
      for (const [key, value] of Object.entries(record)) {
        meta.set(key, value);
      }
      return record;
    },
    async commitDelta() {},
    async exportSnapshot() {},
    async exportSnapshotProbe() {},
    async importSnapshot() {},
    async clearAll() {
      calls.push(["clearAll"]);
      meta.clear();
      return { ok: true };
    },
  };
}

const rawStore = createMockDbLikeStore();
const wrapped = wrapDbLikeGraphStoreV3(rawStore);
assert.equal(isGraphStoreV3Wrapped(wrapped), true);
assert.equal(wrapDbLikeGraphStoreV3(wrapped), wrapped);

const wrappedContract = inspectGraphStoreContract(wrapped);
assert.equal(wrappedContract.valid, true);
assert.ok(wrappedContract.supportedOptionalMethods.includes("readHead"));
assert.ok(wrappedContract.supportedOptionalMethods.includes("writeCommitMarker"));
assert.ok(wrappedContract.supportedOptionalMethods.includes("deleteAll"));

const head = normalizeGraphHead({
  graphId: "graph-a",
  chatId: "chat-a",
  integrity: "integrity-a",
  revision: 9,
  counts: { nodeCount: 2, edgeCount: 1 },
});
const writtenHead = await wrapped.writeHead(head);
assert.equal(writtenHead.graphId, "graph-a");
assert.deepEqual(await wrapped.readHead(), writtenHead);
assert.deepEqual(rawStore.meta.get(GRAPH_V3_HEAD_KEY), writtenHead);
assert.equal(rawStore.meta.has(GRAPH_V3_METADATA_KEY), false, "head must use dedicated v3 head key");

const marker = buildCommitMarkerV3({
  head,
  replica: normalizeReplicaPointer({
    graphId: head.graphId,
    revision: head.revision,
    storageTier: "indexeddb",
    accepted: true,
  }),
});
const writtenMarker = await wrapped.writeCommitMarker(marker);
assert.equal(writtenMarker.accepted, true);
assert.deepEqual(await wrapped.readCommitMarker(), writtenMarker);
assert.deepEqual(rawStore.meta.get(GRAPH_V3_COMMIT_MARKER_KEY), writtenMarker);
assert.equal(rawStore.meta.has("st_bme_commit_marker"), false, "legacy marker key must stay untouched");

await wrapped.deleteAll();
assert.equal(rawStore.meta.size, 0);

console.log("  ✓ DB-like v3 wrapper adds head/marker methods without legacy key writes");

class ClassBackedStore {
  constructor() {
    this.storeKind = "opfs";
    this.storeMode = "class-backed-test";
    this.meta = new Map();
    this.clearCount = 0;
  }

  async open() {
    return this;
  }

  async close() {}

  async getMeta(key, fallbackValue = null) {
    assert.equal(this instanceof ClassBackedStore, true, "wrapped methods must keep class instance this");
    return this.meta.has(key) ? this.meta.get(key) : fallbackValue;
  }

  async patchMeta(record = {}) {
    assert.equal(this instanceof ClassBackedStore, true, "patchMeta must run on the original class instance");
    for (const [key, value] of Object.entries(record)) {
      this.meta.set(key, value);
    }
    return record;
  }

  async commitDelta() {}
  async exportSnapshot() {}
  async exportSnapshotProbe() {}
  async importSnapshot() {}

  async clearAll() {
    assert.equal(this instanceof ClassBackedStore, true, "deleteAll must delegate to class-backed clearAll");
    this.clearCount += 1;
  }
}

const classBackedRaw = new ClassBackedStore();
const classBackedWrapped = wrapDbLikeGraphStoreV3(classBackedRaw);
await classBackedWrapped.writeHead(head);
assert.equal((await classBackedWrapped.readHead()).graphId, "graph-a");
await classBackedWrapped.deleteAll();
assert.equal(classBackedRaw.clearCount, 1);

console.log("  ✓ DB-like wrapper preserves class-instance method binding");

const chatState = new Map();
const updatedNamespaces = [];
const lukerContext = {
  getChatState(namespace) {
    return chatState.get(namespace) || null;
  },
  getChatStateBatch(namespaces) {
    return new Map(namespaces.map((namespace) => [namespace, chatState.get(namespace) || null]));
  },
  updateChatState(namespace, updater) {
    updatedNamespaces.push(namespace);
    const next = updater(chatState.get(namespace) || null);
    chatState.set(namespace, next);
    return { ok: true, updated: true };
  },
};

const lukerStore = createLukerChatStateGraphStoreV3({ context: lukerContext });
const lukerContract = inspectGraphStoreContract(lukerStore, {
  requiredMethods: ["open", "close", "getMeta", "patchMeta", "readHead", "writeHead", "readCommitMarker", "writeCommitMarker"],
});
assert.equal(lukerContract.valid, true);
for (const requiredMethod of GRAPH_STORE_REQUIRED_METHODS) {
  if (["commitDelta", "exportSnapshot", "exportSnapshotProbe", "importSnapshot"].includes(requiredMethod)) {
    assert.equal(
      typeof lukerStore[requiredMethod],
      "undefined",
      `Luker thin wrapper must not claim unsupported DB-like method ${requiredMethod}`,
    );
  }
}

await lukerStore.writeHead(head);
await lukerStore.writeCommitMarker(marker);
assert.deepEqual(await lukerStore.readHead(), head);
assert.deepEqual(await lukerStore.readCommitMarker(), marker);
assert.deepEqual(updatedNamespaces, [GRAPH_V3_HEAD_KEY, GRAPH_V3_COMMIT_MARKER_KEY]);
assert.equal(chatState.has("st_bme_graph_state"), false, "Luker wrapper must not write legacy chat-state namespace");

console.log("  ✓ Luker v3 wrapper writes only v3 head/marker namespaces");
console.log("graph-store-v3-adapter tests passed");
