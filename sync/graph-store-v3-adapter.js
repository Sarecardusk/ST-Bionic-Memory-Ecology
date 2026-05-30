// ST-BME v3 GraphStore adapter wrappers.
//
// These wrappers add v3 head/marker sidecar methods to existing stores without
// changing their legacy load/save behavior. Physical namespace cutover is handled
// by dedicated constructors/routes later.

import {
  GRAPH_V3_COMMIT_MARKER_KEY,
  GRAPH_V3_HEAD_KEY,
} from "../graph/graph-v3-namespace.js";
import {
  normalizeCommitMarkerV3,
  normalizeGraphHead,
} from "../graph/graph-head.js";
import {
  readGraphChatStateNamespaces,
  writeGraphChatStatePayload,
} from "../graph/graph-persistence.js";
import { assertGraphStoreContract } from "./graph-store-contract.js";

const GRAPH_STORE_V3_WRAPPED = Symbol.for("st-bme.graph-store-v3-wrapped");

function bindStoreMethod(store = null, method = "") {
  const value = store?.[method];
  return typeof value === "function" ? value.bind(store) : value;
}

export function isGraphStoreV3Wrapped(store = null) {
  return Boolean(store?.[GRAPH_STORE_V3_WRAPPED]);
}

export function wrapDbLikeGraphStoreV3(store = null) {
  assertGraphStoreContract(store);
  if (isGraphStoreV3Wrapped(store)) return store;

  const wrapper = Object.create(store);
  Object.defineProperty(wrapper, GRAPH_STORE_V3_WRAPPED, {
    value: true,
    enumerable: false,
  });

  for (const key of Reflect.ownKeys(store)) {
    if (key === GRAPH_STORE_V3_WRAPPED) continue;
    const descriptor = Object.getOwnPropertyDescriptor(store, key);
    if (descriptor) Object.defineProperty(wrapper, key, descriptor);
  }

  for (const method of [
    "open",
    "close",
    "getMeta",
    "setMeta",
    "patchMeta",
    "commitDelta",
    "exportSnapshot",
    "exportSnapshotProbe",
    "importSnapshot",
    "isEmpty",
    "clearAll",
  ]) {
    if (typeof store[method] === "function") {
      wrapper[method] = bindStoreMethod(store, method);
    }
  }

  wrapper.readHead = async ({ fallback = null } = {}) => {
    const raw = await store.getMeta(GRAPH_V3_HEAD_KEY, null);
    return raw == null ? fallback : normalizeGraphHead(raw, fallback || {});
  };

  wrapper.writeHead = async (head = null, { fallback = null } = {}) => {
    const normalized = normalizeGraphHead(head, fallback || {});
    await store.patchMeta({ [GRAPH_V3_HEAD_KEY]: normalized });
    return normalized;
  };

  wrapper.readCommitMarker = async ({ fallback = null } = {}) => {
    const raw = await store.getMeta(GRAPH_V3_COMMIT_MARKER_KEY, null);
    return normalizeCommitMarkerV3(raw) || fallback;
  };

  wrapper.writeCommitMarker = async (marker = null) => {
    const normalized = normalizeCommitMarkerV3(marker);
    if (!normalized) {
      const error = new Error("graph-store-v3-commit-marker-invalid");
      error.code = "graph_store_v3_commit_marker_invalid";
      throw error;
    }
    await store.patchMeta({ [GRAPH_V3_COMMIT_MARKER_KEY]: normalized });
    return normalized;
  };

  wrapper.deleteAll = async (...args) => {
    if (typeof store.clearAll !== "function") {
      const error = new Error("graph-store-v3-delete-all-unavailable");
      error.code = "graph_store_v3_delete_all_unavailable";
      throw error;
    }
    return store.clearAll(...args);
  };

  return wrapper;
}

export function createLukerChatStateGraphStoreV3({
  context = null,
  chatStateTarget = null,
  storeKind = "luker-chat-state",
  storeMode = "luker-chat-state-v3",
} = {}) {
  async function readNamespace(namespace = "", fallback = null) {
    const payloads = await readGraphChatStateNamespaces(context, [namespace], {
      target: chatStateTarget,
    });
    return payloads.get(namespace) ?? fallback;
  }

  async function writeNamespace(namespace = "", payload = null) {
    const result = await writeGraphChatStatePayload(context, namespace, payload, {
      target: chatStateTarget,
    });
    if (result?.ok !== true) {
      const error = new Error(result?.reason || "luker-graph-store-v3-write-failed");
      error.code = "luker_graph_store_v3_write_failed";
      error.result = result;
      throw error;
    }
    return payload;
  }

  return {
    storeKind,
    storeMode,
    async open() {
      return this;
    },
    async close() {},
    async getMeta(key = "", fallbackValue = null) {
      return readNamespace(String(key || ""), fallbackValue);
    },
    async patchMeta(record = {}) {
      const entries = Object.entries(record && typeof record === "object" ? record : {});
      for (const [key, value] of entries) {
        await writeNamespace(key, value);
      }
      return record;
    },
    async readHead({ fallback = null } = {}) {
      const raw = await readNamespace(GRAPH_V3_HEAD_KEY, null);
      return raw == null ? fallback : normalizeGraphHead(raw, fallback || {});
    },
    async writeHead(head = null, { fallback = null } = {}) {
      const normalized = normalizeGraphHead(head, fallback || {});
      await writeNamespace(GRAPH_V3_HEAD_KEY, normalized);
      return normalized;
    },
    async readCommitMarker({ fallback = null } = {}) {
      const raw = await readNamespace(GRAPH_V3_COMMIT_MARKER_KEY, null);
      return normalizeCommitMarkerV3(raw) || fallback;
    },
    async writeCommitMarker(marker = null) {
      const normalized = normalizeCommitMarkerV3(marker);
      if (!normalized) {
        const error = new Error("luker-graph-store-v3-commit-marker-invalid");
        error.code = "luker_graph_store_v3_commit_marker_invalid";
        throw error;
      }
      await writeNamespace(GRAPH_V3_COMMIT_MARKER_KEY, normalized);
      return normalized;
    },
  };
}
