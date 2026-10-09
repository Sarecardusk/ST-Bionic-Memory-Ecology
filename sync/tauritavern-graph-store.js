import { createEmptyGraph, deserializeGraph } from "../graph/graph.js";
import { normalizeGraphRuntimeState } from "../runtime/runtime-state.js";
import { getTauriTavernDbApi, waitForTauriTavernReady } from "../runtime/tauritavern-host.js";
import {
  BME_DB_SCHEMA_VERSION,
  BME_LEGACY_RETENTION_MS,
  BME_TOMBSTONE_RETENTION_MS,
  buildSnapshotFromGraph,
  createGraphCommitConflictError,
} from "./bme-db.js";

export const TAURITAVERN_GRAPH_STORE_KIND = "tauritavern";
export const TAURITAVERN_GRAPH_STORE_MODE = "trivium-primary";
export const TAURITAVERN_PAYLOAD_BUDGET_BYTES = 7 * 1024 * 1024;
export const TAURITAVERN_DEFAULT_DIM = 1536;
export const GRAPH_OPERATIONAL_MODE_LOCAL_ONLY = "local-only";

const KIND_HEAD = "head";
const KIND_NODE = "node";
const KIND_EDGE = "edge";
const KIND_TOMBSTONE = "tombstone";
const KIND_META = "meta-entry";
const KIND_WAL = "wal";
const KIND_SHARD = "payload-shard";

const HEAD_ID = 1;
const WAL_ID_BASE = 2;
const MAX_WAL_SHARDS = 500;
const RESERVED_ID_MAX = 1023;
const LIST_PAGE_SIZE = 64;
const PROBE_LIMIT = 64;
const META_DEFAULT_LAST_PROCESSED_FLOOR = -1;
const META_DEFAULT_EXTRACTION_COUNT = 0;

const HEAD_META_KEYS = new Set([
  "chatId",
  "revision",
  "lastProcessedFloor",
  "extractionCount",
  "lastModified",
  "lastSyncUploadedAt",
  "lastSyncDownloadedAt",
  "lastSyncedRevision",
  "lastBackupUploadedAt",
  "lastBackupRestoredAt",
  "lastBackupRollbackAt",
  "lastBackupFilename",
  "syncDirtyReason",
  "deviceId",
  "nodeCount",
  "edgeCount",
  "tombstoneCount",
  "schemaVersion",
  "syncDirty",
  "migrationCompletedAt",
  "migrationSource",
  "legacyRetentionUntil",
  "storagePrimary",
  "storageMode",
  "lastMutationReason",
  "pendingWal",
  "dim",
  "namespace",
]);

const PERSIST_META_RESERVED_KEYS = new Set([
  "revision",
  "lastModified",
  "nodeCount",
  "edgeCount",
  "tombstoneCount",
  "syncDirty",
  "syncDirtyReason",
  "lastMutationReason",
  "pendingWal",
]);

function normalizeChatId(chatId) {
  return String(chatId ?? "").trim();
}

function normalizeRecordId(value) {
  return String(value ?? "").trim();
}

function normalizeRevision(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function normalizeTimestamp(value, fallbackValue = Date.now()) {
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return Math.floor(parsed);
  return Math.floor(Number(fallbackValue) || Date.now());
}

function normalizeNonNegativeInteger(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return Math.max(0, Math.floor(Number(fallback) || 0));
  }
  return Math.max(0, Math.floor(parsed));
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function toPlainData(value, fallbackValue = null) {
  if (value == null) return fallbackValue;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallbackValue;
  }
}

export function measureJsonBytes(value = null) {
  let json = "";
  try {
    json = JSON.stringify(value ?? null);
  } catch {
    json = "";
  }
  if (typeof TextEncoder === "function") {
    return new TextEncoder().encode(json).byteLength;
  }
  return json.length * 3;
}

function createDefaultHead(chatId = "", dim = TAURITAVERN_DEFAULT_DIM, namespace = "", nowMs = Date.now()) {
  return {
    ttRecordKind: KIND_HEAD,
    chatId: normalizeChatId(chatId),
    revision: 0,
    lastProcessedFloor: META_DEFAULT_LAST_PROCESSED_FLOOR,
    extractionCount: META_DEFAULT_EXTRACTION_COUNT,
    lastModified: normalizeTimestamp(nowMs),
    lastSyncUploadedAt: 0,
    lastSyncDownloadedAt: 0,
    lastSyncedRevision: 0,
    lastBackupUploadedAt: 0,
    lastBackupRestoredAt: 0,
    lastBackupRollbackAt: 0,
    lastBackupFilename: "",
    syncDirtyReason: "",
    deviceId: "",
    nodeCount: 0,
    edgeCount: 0,
    tombstoneCount: 0,
    schemaVersion: BME_DB_SCHEMA_VERSION,
    syncDirty: false,
    migrationCompletedAt: 0,
    migrationSource: "",
    legacyRetentionUntil: 0,
    storagePrimary: TAURITAVERN_GRAPH_STORE_KIND,
    storageMode: TAURITAVERN_GRAPH_STORE_MODE,
    lastMutationReason: "",
    pendingWal: null,
    dim: Math.max(1, Math.floor(Number(dim) || TAURITAVERN_DEFAULT_DIM)),
    namespace: String(namespace || ""),
  };
}

function bytesToHex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(text) {
  const encoded = new TextEncoder().encode(String(text || ""));
  if (globalThis.crypto?.subtle?.digest) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", encoded);
    return bytesToHex(digest);
  }
  const nodeCrypto = await import("node:crypto");
  return nodeCrypto.createHash("sha256").update(String(text || "")).digest("hex");
}

export async function buildTauriTavernNamespace(chatId, dim = TAURITAVERN_DEFAULT_DIM) {
  const hex = await sha256Hex(normalizeChatId(chatId));
  const safeDim = Math.max(1, Math.floor(Number(dim) || TAURITAVERN_DEFAULT_DIM));
  return `stbme-${hex.slice(0, 32)}-d${safeDim}`;
}

export function hashRecordId(kind, recordId) {
  const input = `${kind}:${recordId}`;
  let h1 = 2166136261;
  let h2 = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h1 ^= input.charCodeAt(i);
    h1 = Math.imul(h1, 16777619);
    h2 ^= input.charCodeAt(input.length - 1 - i);
    h2 = Math.imul(h2, 16777619);
  }
  const mixed = Math.abs((h1 >>> 0) * 2097151 + (h2 >>> 0));
  return (mixed % (Number.MAX_SAFE_INTEGER - RESERVED_ID_MAX - 2)) + RESERVED_ID_MAX + 1;
}

function isDatabaseUnavailableError(error = null) {
  const message = String(error?.message || error || "").toLowerCase();
  const code = String(error?.code || "").toLowerCase();
  return (
    message.includes("not open") ||
    message.includes("is busy") ||
    message.includes("database closed") ||
    message.includes("database is busy") ||
    code.includes("not_open") ||
    code.includes("busy")
  );
}

function isPayloadTooLargeError(error = null) {
  const message = String(error?.message || "").toLowerCase();
  return (
    error?.name === "PayloadTooLarge" ||
    message.includes("payload too large") ||
    message.includes("payload 过大")
  );
}

function createPayloadBudgetError(sizeBytes, budgetBytes = TAURITAVERN_PAYLOAD_BUDGET_BYTES) {
  const error = new Error(
    `TauriTavern payload exceeds ${budgetBytes} byte budget (${sizeBytes} bytes)`,
  );
  error.name = "TauriTavernPayloadTooLargeError";
  error.code = "payload_too_large";
  error.category = "payload-too-large";
  error.terminal = true;
  error.nonRetryable = true;
  error.estimatedBytes = sizeBytes;
  error.budgetBytes = budgetBytes;
  return error;
}

function readPersistCommitNow() {
  if (typeof performance === "object" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function normalizePersistCommitMs(value = 0) {
  return Math.round((Number(value) || 0) * 10) / 10;
}

function zeroVector(dim) {
  return new Array(Math.max(1, Math.floor(Number(dim) || TAURITAVERN_DEFAULT_DIM))).fill(0);
}

function splitUtf8(text, maxBytes) {
  const encoded = new TextEncoder().encode(String(text || ""));
  if (encoded.byteLength <= maxBytes) return [String(text || "")];
  const decoder = new TextDecoder();
  const chunks = [];
  let start = 0;
  while (start < encoded.length) {
    let end = Math.min(start + maxBytes, encoded.length);
    while (end > start && (encoded[end] & 0b11000000) === 0b10000000) end -= 1;
    if (end <= start) end = Math.min(start + maxBytes, encoded.length);
    chunks.push(decoder.decode(encoded.subarray(start, end)));
    start = end;
  }
  return chunks.length ? chunks : [""];
}

export function shardOversizedPayload(kind, recordId, payload, budget = TAURITAVERN_PAYLOAD_BUDGET_BYTES) {
  const source = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  if (measureJsonBytes(source) <= budget) {
    return { payload: source, shards: [] };
  }
  const stub = { ...source, payloadShards: [] };
  const shards = [];
  const chunkBudget = Math.max(16 * 1024, Math.floor(budget * 0.6));
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== "string") continue;
    if (measureJsonBytes(value) < 64 * 1024) continue;
    const chunks = splitUtf8(value, chunkBudget);
    stub[key] = "";
    stub.payloadShards.push({ field: key, shardCount: chunks.length });
    chunks.forEach((chunk, shardIndex) => {
      shards.push({
        kind: KIND_SHARD,
        recordId,
        parentKind: kind,
        field: key,
        shardIndex,
        shardCount: chunks.length,
        chunk,
      });
    });
  }
  if (measureJsonBytes(stub) <= budget) {
    return { payload: stub, shards };
  }
  const packedChunks = splitUtf8(JSON.stringify(source), chunkBudget);
  return {
    payload: {
      ttRecordKind: kind,
      ttRecordId: recordId,
      packedPayload: true,
      payloadShards: [{ field: "__packed__", shardCount: packedChunks.length }],
    },
    shards: packedChunks.map((chunk, shardIndex) => ({
      kind: KIND_SHARD,
      recordId,
      parentKind: kind,
      field: "__packed__",
      shardIndex,
      shardCount: packedChunks.length,
      chunk,
    })),
  };
}

function normalizeNodeRecords(nodes = [], fallbackNowMs = Date.now()) {
  const nowMs = normalizeTimestamp(fallbackNowMs);
  return toArray(nodes)
    .map((node) => {
      if (!node || typeof node !== "object" || Array.isArray(node)) return null;
      const id = normalizeRecordId(node.id);
      if (!id) return null;
      return { ...toPlainData(node, node), id, updatedAt: normalizeTimestamp(node.updatedAt, nowMs) };
    })
    .filter(Boolean);
}

function normalizeEdgeRecords(edges = [], fallbackNowMs = Date.now()) {
  const nowMs = normalizeTimestamp(fallbackNowMs);
  return toArray(edges)
    .map((edge) => {
      if (!edge || typeof edge !== "object" || Array.isArray(edge)) return null;
      const id = normalizeRecordId(edge.id);
      if (!id) return null;
      return {
        ...toPlainData(edge, edge),
        id,
        fromId: normalizeRecordId(edge.fromId),
        toId: normalizeRecordId(edge.toId),
        updatedAt: normalizeTimestamp(edge.updatedAt, nowMs),
      };
    })
    .filter(Boolean);
}

function normalizeTombstoneRecords(tombstones = [], fallbackNowMs = Date.now()) {
  const nowMs = normalizeTimestamp(fallbackNowMs);
  return toArray(tombstones)
    .map((record) => {
      if (!record || typeof record !== "object" || Array.isArray(record)) return null;
      const id = normalizeRecordId(record.id);
      if (!id) return null;
      return {
        ...toPlainData(record, record),
        id,
        kind: normalizeRecordId(record.kind),
        targetId: normalizeRecordId(record.targetId),
        sourceDeviceId: normalizeRecordId(record.sourceDeviceId),
        deletedAt: normalizeTimestamp(record.deletedAt, nowMs),
      };
    })
    .filter(Boolean);
}

function normalizeUpsertCountDelta(delta = {}) {
  const source = delta && typeof delta === "object" && !Array.isArray(delta) ? delta : {};
  const next = source.next && typeof source.next === "object" ? source.next : null;
  if (!next) return null;
  return {
    nodes: normalizeNonNegativeInteger(next.nodes, 0),
    edges: normalizeNonNegativeInteger(next.edges, 0),
    tombstones: normalizeNonNegativeInteger(next.tombstones, 0),
  };
}

function sanitizeSnapshot(snapshot = {}) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return { meta: {}, state: {}, nodes: [], edges: [], tombstones: [] };
  }
  return {
    meta: snapshot.meta && typeof snapshot.meta === "object" && !Array.isArray(snapshot.meta)
      ? toPlainData(snapshot.meta, {})
      : {},
    state: snapshot.state && typeof snapshot.state === "object" && !Array.isArray(snapshot.state)
      ? toPlainData(snapshot.state, {})
      : {},
    nodes: toArray(snapshot.nodes).filter(Boolean).map((node) => toPlainData(node, node)),
    edges: toArray(snapshot.edges).filter(Boolean).map((edge) => toPlainData(edge, edge)),
    tombstones: toArray(snapshot.tombstones).filter(Boolean).map((record) => toPlainData(record, record)),
  };
}

function normalizeStateSnapshot(snapshot = {}) {
  const state = snapshot?.state && typeof snapshot.state === "object" ? snapshot.state : {};
  const meta = snapshot?.meta && typeof snapshot.meta === "object" ? snapshot.meta : {};
  return {
    lastProcessedFloor: Number.isFinite(Number(state.lastProcessedFloor ?? meta.lastProcessedFloor))
      ? Number(state.lastProcessedFloor ?? meta.lastProcessedFloor)
      : META_DEFAULT_LAST_PROCESSED_FLOOR,
    extractionCount: Number.isFinite(Number(state.extractionCount ?? meta.extractionCount))
      ? Number(state.extractionCount ?? meta.extractionCount)
      : META_DEFAULT_EXTRACTION_COUNT,
  };
}

function applyListOptions(records, options = {}) {
  let nextRecords = toArray(records);
  const orderBy = String(options.orderBy || "updatedAt").trim();
  const reverse = options.reverse !== false;
  nextRecords = nextRecords.sort((left, right) => {
    const leftValue = Number(left?.[orderBy]);
    const rightValue = Number(right?.[orderBy]);
    if (!Number.isFinite(leftValue) && !Number.isFinite(rightValue)) return 0;
    if (!Number.isFinite(leftValue)) return reverse ? 1 : -1;
    if (!Number.isFinite(rightValue)) return reverse ? -1 : 1;
    return reverse ? rightValue - leftValue : leftValue - rightValue;
  });
  const limit = Number(options.limit);
  if (Number.isFinite(limit) && limit > 0) {
    nextRecords = nextRecords.slice(0, Math.floor(limit));
  }
  return toPlainData(nextRecords, []);
}

function unwrapQueryNode(row) {
  const value = row?.n ?? row?.node ?? row;
  if (!value) return null;
  if (value.type === "node") return value.value || value;
  if (value.id != null) return value;
  return null;
}

function nodeTextForIndex(record) {
  const parts = [
    record?.content,
    record?.text,
    record?.summary,
    record?.title,
    record?.name,
    record?.label,
  ];
  return parts.map((part) => String(part || "").trim()).filter(Boolean).join("\n");
}

function recordVector(record, dim) {
  if (Array.isArray(record?.embedding) && record.embedding.length === dim) {
    return record.embedding.map((value) => Number(value) || 0);
  }
  if (Array.isArray(record?.vector) && record.vector.length === dim) {
    return record.vector.map((value) => Number(value) || 0);
  }
  return zeroVector(dim);
}

export class TauriTavernGraphStore {
  constructor(chatId, options = {}) {
    this.chatId = normalizeChatId(chatId);
    this.options = options;
    this.storeKind = TAURITAVERN_GRAPH_STORE_KIND;
    this.storeMode = TAURITAVERN_GRAPH_STORE_MODE;
    this.dim = Math.max(1, Math.floor(Number(options.dim) || TAURITAVERN_DEFAULT_DIM));
    this.namespace = String(options.namespace || "");
    this._db = options.db || null;
    this._dbApi = options.dbApi || null;
    this._opened = false;
    this._openPromise = null;
    this._writeChain = Promise.resolve();
  }

  getStorageDiagnosticsSync() {
    return {
      formatVersion: 1,
      migrationState: "idle",
      resolvedStoreMode: this.storeMode,
      storageKind: this.storeKind,
      browserCacheMode: "none",
    };
  }

  async open() {
    if (this._opened && this._db) return this;
    if (!this._openPromise) {
      this._openPromise = this._openInternal().catch((error) => {
        this._openPromise = null;
        this._opened = false;
        this._db = null;
        throw error;
      });
    }
    return await this._openPromise;
  }

  async _openInternal() {
    if (!this.namespace) {
      this.namespace = await buildTauriTavernNamespace(this.chatId, this.dim);
    }
    if (!this._db) {
      const dbApi = this._dbApi || getTauriTavernDbApi();
      if (!dbApi) {
        await waitForTauriTavernReady();
      }
      const api = this._dbApi || getTauriTavernDbApi();
      if (!api) {
        const error = new Error("TauriTavern database API is unavailable");
        error.code = "tauritavern_db_missing";
        throw error;
      }
      this._db = await api.open(this.namespace, {
        dim: this.dim,
        syncMode: this.options.syncMode || "normal",
        storageMode: this.options.storageMode || "mmap",
        loadTextIndex: this.options.loadTextIndex !== false,
        autoBuildQuiver: this.options.autoBuildQuiver !== false,
      });
      this.dim = Number(this._db.dim || this.dim);
    }
    this._opened = true;
    await this._ensureHead();
    await this._recoverPendingWal();
    if (this.options.skipLegacyImport !== true) {
      await this._importLegacyLocalIfEmpty();
    }
    return this;
  }

  _invalidateHandle() {
    this._opened = false;
    this._db = this.options.db || null;
    this._openPromise = null;
  }

  async close() {
    if (this._db && typeof this._db.close === "function" && !this.options.db) {
      try {
        await this._db.close();
      } catch {
      }
    }
    this._invalidateHandle();
  }

  async _withWriteLock(fn) {
    const previous = this._writeChain;
    let release = () => {};
    this._writeChain = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async _read(fn) {
    try {
      await this.open();
      return await fn(this._db);
    } catch (error) {
      if (!isDatabaseUnavailableError(error)) throw error;
      this._invalidateHandle();
      await this.open();
      return await fn(this._db);
    }
  }

  async _write(fn) {
    try {
      await this.open();
      return await fn(this._db);
    } catch (error) {
      if (isDatabaseUnavailableError(error)) {
        this._invalidateHandle();
        this.open().catch(() => {});
      }
      throw error;
    }
  }

  _zero() {
    return zeroVector(this.dim);
  }

  async _ensureHead() {
    const existing = await this._db.get(HEAD_ID);
    if (existing?.payload?.ttRecordKind === KIND_HEAD) return existing.payload;
    const head = createDefaultHead(this.chatId, this.dim, this.namespace);
    await this._db.upsert(HEAD_ID, this._zero(), head);
    return head;
  }

  async _readHead() {
    const node = await this._db.get(HEAD_ID);
    if (node?.payload?.ttRecordKind === KIND_HEAD) return toPlainData(node.payload, node.payload);
    return await this._ensureHead();
  }

  async _writeHead(head) {
    const payload = { ...createDefaultHead(this.chatId, this.dim, this.namespace), ...head, ttRecordKind: KIND_HEAD };
    if (measureJsonBytes(payload) > TAURITAVERN_PAYLOAD_BUDGET_BYTES) {
      throw createPayloadBudgetError(measureJsonBytes(payload));
    }
    await this._db.upsert(HEAD_ID, this._zero(), payload);
    return payload;
  }

  async _resolveId(kind, recordId, allocate) {
    const normalizedKind = normalizeRecordId(kind);
    const normalizedId = normalizeRecordId(recordId);
    if (!normalizedKind || !normalizedId) return null;
    let id = hashRecordId(normalizedKind, normalizedId);
    for (let probe = 0; probe < PROBE_LIMIT; probe += 1) {
      if (id <= RESERVED_ID_MAX) id = RESERVED_ID_MAX + 1;
      const existing = await this._db.get(id);
      if (!existing) return allocate ? id : null;
      const payload = existing.payload || {};
      if (payload.ttRecordKind === normalizedKind && payload.ttRecordId === normalizedId) return id;
      id += 1;
      if (id >= Number.MAX_SAFE_INTEGER) id = RESERVED_ID_MAX + 1;
    }
    throw new Error(`Trivium ID probe exhausted for ${normalizedKind}:${normalizedId}`);
  }

  async _getRecord(kind, recordId) {
    const id = await this._resolveId(kind, recordId, false);
    if (id == null) return null;
    return await this._db.get(id);
  }

  _stripEnvelope(payload) {
    if (!payload || typeof payload !== "object") return payload;
    const assembled = { ...payload };
    delete assembled.ttRecordKind;
    delete assembled.ttRecordId;
    delete assembled.payloadShards;
    delete assembled.packedPayload;
    delete assembled.parentKind;
    return assembled;
  }

  async _reassemblePayload(payload) {
    if (!payload) return null;
    if (!payload.payloadShards?.length) {
      return this._stripEnvelope(toPlainData(payload, payload));
    }
    const assembled = { ...payload };
    for (const spec of payload.payloadShards) {
      const chunks = [];
      for (let shardIndex = 0; shardIndex < Number(spec.shardCount || 0); shardIndex += 1) {
        const shardId = `${payload.ttRecordId}:${spec.field}:${shardIndex}`;
        const shard = await this._getRecord(KIND_SHARD, shardId);
        chunks.push(String(shard?.payload?.chunk || ""));
      }
      const joined = chunks.join("");
      if (spec.field === "__packed__") {
        return JSON.parse(joined);
      }
      assembled[spec.field] = joined;
    }
    return this._stripEnvelope(assembled);
  }

  async _listKind(kind, options = {}) {
    const records = [];
    let offset = 0;
    while (true) {
      const result = await this._db.query(
        "MATCH (n) WHERE n.ttRecordKind == $kind RETURN n LIMIT $limit OFFSET $offset",
        { kind, limit: LIST_PAGE_SIZE, offset },
      );
      const rows = toArray(result?.rows);
      if (!rows.length) break;
      for (const row of rows) {
        const node = unwrapQueryNode(row);
        if (!node?.payload) continue;
        const record = await this._reassemblePayload(node.payload);
        if (!record) continue;
        if (kind === KIND_META) {
          records.push({ key: record.key || node.payload.ttRecordId, value: record.value });
          continue;
        }
        records.push(record);
      }
      if (rows.length < LIST_PAGE_SIZE) break;
      offset += LIST_PAGE_SIZE;
      if (options.maxRecords && records.length >= options.maxRecords) break;
    }
    return records;
  }

  async _pageAllNodes() {
    const nodes = [];
    let offset = 0;
    while (true) {
      const result = await this._db.query(
        "MATCH (n) RETURN n LIMIT $limit OFFSET $offset",
        { limit: LIST_PAGE_SIZE, offset },
      );
      const rows = toArray(result?.rows);
      if (!rows.length) break;
      for (const row of rows) {
        const node = unwrapQueryNode(row);
        if (node) nodes.push(node);
      }
      if (rows.length < LIST_PAGE_SIZE) break;
      offset += LIST_PAGE_SIZE;
    }
    return nodes;
  }

  async _upsertKindRecord(kind, recordId, record, vector = null) {
    const envelope = { ...toPlainData(record, record), ttRecordKind: kind, ttRecordId: recordId };
    const { payload, shards } = shardOversizedPayload(kind, recordId, envelope);
    if (measureJsonBytes(payload) > TAURITAVERN_PAYLOAD_BUDGET_BYTES) {
      throw createPayloadBudgetError(measureJsonBytes(payload));
    }
    for (const shard of shards) {
      const shardRecordId = `${recordId}:${shard.field}:${shard.shardIndex}`;
      const shardPayload = { ...shard, ttRecordKind: KIND_SHARD, ttRecordId: shardRecordId };
      if (measureJsonBytes(shardPayload) > TAURITAVERN_PAYLOAD_BUDGET_BYTES) {
        throw createPayloadBudgetError(measureJsonBytes(shardPayload));
      }
      const shardId = await this._resolveId(KIND_SHARD, shardRecordId, true);
      await this._db.upsert(shardId, this._zero(), shardPayload);
    }
    const id = await this._resolveId(kind, recordId, true);
    await this._db.upsert(id, vector || this._zero(), payload);
    return { id, payload };
  }

  async _deleteKindRecord(kind, recordId) {
    const existing = await this._getRecord(kind, recordId);
    if (!existing) return false;
    for (const spec of existing.payload?.payloadShards || []) {
      for (let shardIndex = 0; shardIndex < Number(spec.shardCount || 0); shardIndex += 1) {
        const shardRecordId = `${recordId}:${spec.field}:${shardIndex}`;
        const shardId = await this._resolveId(KIND_SHARD, shardRecordId, false);
        if (shardId != null) await this._db.delete(shardId);
      }
    }
    await this._db.delete(existing.id);
    return true;
  }

  _buildWalOps(delta, nowMs) {
    const ops = [];
    for (const id of toArray(delta.deleteEdgeIds).map(normalizeRecordId).filter(Boolean)) {
      ops.push({ op: "delete", kind: KIND_EDGE, recordId: id });
    }
    for (const id of toArray(delta.deleteNodeIds).map(normalizeRecordId).filter(Boolean)) {
      ops.push({ op: "delete", kind: KIND_NODE, recordId: id });
    }
    for (const id of toArray(delta.deleteTombstoneIds).map(normalizeRecordId).filter(Boolean)) {
      ops.push({ op: "delete", kind: KIND_TOMBSTONE, recordId: id });
    }
    for (const node of normalizeNodeRecords(delta.upsertNodes, nowMs)) {
      this._pushShardedUpsertOps(ops, KIND_NODE, node.id, node, recordVector(node, this.dim));
    }
    for (const edge of normalizeEdgeRecords(delta.upsertEdges, nowMs)) {
      this._pushShardedUpsertOps(ops, KIND_EDGE, edge.id, edge);
      if (edge.fromId && edge.toId) {
        ops.push({
          op: "link",
          fromId: edge.fromId,
          toId: edge.toId,
          relation: String(edge.relation || "related"),
          weight: Number(edge.weight) || 1,
        });
      }
    }
    for (const tombstone of normalizeTombstoneRecords(delta.tombstones, nowMs)) {
      this._pushShardedUpsertOps(ops, KIND_TOMBSTONE, tombstone.id, tombstone);
    }
    const runtimeMetaPatch =
      delta.runtimeMetaPatch && typeof delta.runtimeMetaPatch === "object" && !Array.isArray(delta.runtimeMetaPatch)
        ? delta.runtimeMetaPatch
        : {};
    for (const [rawKey, value] of Object.entries(runtimeMetaPatch)) {
      const key = normalizeRecordId(rawKey);
      if (!key || PERSIST_META_RESERVED_KEYS.has(key) || HEAD_META_KEYS.has(key)) continue;
      this._pushShardedUpsertOps(ops, KIND_META, key, { key, value });
    }
    return ops;
  }

  _pushShardedUpsertOps(ops, kind, recordId, record, vector = null) {
    const envelope = { ...toPlainData(record, record), ttRecordKind: kind, ttRecordId: recordId };
    const { payload, shards } = shardOversizedPayload(kind, recordId, envelope);
    for (const shard of shards) {
      const shardRecordId = `${recordId}:${shard.field}:${shard.shardIndex}`;
      ops.push({
        op: "upsert",
        kind: KIND_SHARD,
        recordId: shardRecordId,
        record: { ...shard, ttRecordKind: KIND_SHARD, ttRecordId: shardRecordId },
      });
    }
    const stub = { ...payload };
    delete stub.ttRecordKind;
    delete stub.ttRecordId;
    ops.push({
      op: "upsert",
      kind,
      recordId,
      record: stub,
      ...(vector ? { vector } : {}),
    });
  }

  _packWalShards(commitId, ops) {
    const shards = [];
    let current = [];
    const pushCurrent = (complete) => {
      if (!current.length && !complete) return;
      shards.push({
        ttRecordKind: KIND_WAL,
        commitId,
        shardIndex: shards.length,
        ops: current,
        complete: false,
      });
      current = [];
    };
    for (const op of ops) {
      const candidate = [...current, op];
      const estimated = measureJsonBytes({
        ttRecordKind: KIND_WAL,
        commitId,
        shardIndex: shards.length,
        ops: candidate,
        complete: true,
        shardCount: 99,
      });
      if (current.length && estimated > TAURITAVERN_PAYLOAD_BUDGET_BYTES) {
        pushCurrent(false);
      }
      current.push(op);
      if (measureJsonBytes(op) > TAURITAVERN_PAYLOAD_BUDGET_BYTES) {
        throw createPayloadBudgetError(measureJsonBytes(op));
      }
    }
    if (current.length || !shards.length) {
      shards.push({
        ttRecordKind: KIND_WAL,
        commitId,
        shardIndex: shards.length,
        ops: current,
        complete: true,
      });
    } else {
      shards[shards.length - 1].complete = true;
    }
    if (shards.length > MAX_WAL_SHARDS) {
      throw new Error(`WAL shard count ${shards.length} exceeds ${MAX_WAL_SHARDS}`);
    }
    return shards.map((shard) => ({ ...shard, shardCount: shards.length }));
  }

  async _writeWalShards(shards) {
    for (const shard of shards) {
      const payload = shard;
      if (measureJsonBytes(payload) > TAURITAVERN_PAYLOAD_BUDGET_BYTES) {
        throw createPayloadBudgetError(measureJsonBytes(payload));
      }
      await this._db.upsert(WAL_ID_BASE + shard.shardIndex, this._zero(), payload);
    }
  }

  async _deleteWalShards(shardCount) {
    const count = Math.max(0, Number(shardCount) || 0);
    for (let i = 0; i < count; i += 1) {
      try {
        await this._db.delete(WAL_ID_BASE + i);
      } catch {
      }
    }
  }

  async _applyOp(op) {
    if (op.op === "delete") {
      if (op.kind === KIND_EDGE) {
        const existing = await this._getRecord(KIND_EDGE, op.recordId);
        const record = existing ? await this._reassemblePayload(existing.payload) : null;
        if (record?.fromId && record?.toId) {
          const fromId = await this._resolveId(KIND_NODE, record.fromId, false);
          const toId = await this._resolveId(KIND_NODE, record.toId, false);
          if (fromId != null && toId != null) await this._db.unlink(fromId, toId);
        }
      }
      await this._deleteKindRecord(op.kind, op.recordId);
      return;
    }
    if (op.op === "upsert") {
      const vector = Array.isArray(op.vector) && op.vector.length === this.dim ? op.vector : this._zero();
      const written = await this._upsertKindRecord(op.kind, op.recordId, op.record, vector);
      if (op.kind === KIND_NODE) {
        const text = nodeTextForIndex(op.record);
        if (text && typeof this._db.indexText === "function") {
          await this._db.indexText(written.id, text);
        }
      }
      return;
    }
    if (op.op === "link") {
      const fromId = await this._resolveId(KIND_NODE, op.fromId, false);
      const toId = await this._resolveId(KIND_NODE, op.toId, false);
      if (fromId != null && toId != null) {
        await this._db.link(fromId, toId, op.relation || "related", Number(op.weight) || 1);
      }
      return;
    }
    if (op.op === "meta") {
      await this._upsertKindRecord(KIND_META, op.key, { key: op.key, value: op.value }, this._zero());
      return;
    }
  }

  async _replayWal(pendingWal) {
    const shardCount = Number(pendingWal?.shardCount || 0);
    if (!pendingWal?.complete || shardCount <= 0) {
      await this._deleteWalShards(shardCount || MAX_WAL_SHARDS);
      return;
    }
    for (let i = 0; i < shardCount; i += 1) {
      const shard = await this._db.get(WAL_ID_BASE + i);
      for (const op of toArray(shard?.payload?.ops)) {
        await this._applyOp(op);
      }
    }
    if (typeof this._db.buildTextIndex === "function") {
      await this._db.buildTextIndex();
    }
  }

  async _recoverPendingWal() {
    const head = await this._readHead();
    const pending = head.pendingWal;
    if (!pending) return;
    if (pending.complete) {
      await this._replayWal(pending);
    } else {
      await this._deleteWalShards(pending.shardCount || MAX_WAL_SHARDS);
    }
    await this._writeHead({ ...head, pendingWal: null });
  }

  async _importLegacyLocalIfEmpty() {
    const empty = await this.isEmpty();
    if (!empty.empty) return;
    if (typeof this.options.legacyImporter !== "function") return;
    const snapshot = await this.options.legacyImporter(this.chatId);
    if (!snapshot) return;
    await this.importSnapshot(snapshot, {
      mode: "replace",
      preserveRevision: true,
      markSyncDirty: false,
    });
    const nowMs = Date.now();
    await this.patchMeta({
      migrationCompletedAt: nowMs,
      migrationSource: "browser-local",
    });
  }

  async getMeta(key, fallbackValue = null) {
    return await this._read(async () => {
      const normalizedKey = normalizeRecordId(key);
      if (!normalizedKey) return fallbackValue;
      if (HEAD_META_KEYS.has(normalizedKey)) {
        const head = await this._readHead();
        return Object.prototype.hasOwnProperty.call(head, normalizedKey)
          ? head[normalizedKey]
          : fallbackValue;
      }
      const existing = await this._getRecord(KIND_META, normalizedKey);
      if (!existing) return fallbackValue;
      const assembled = await this._reassemblePayload(existing.payload);
      return assembled?.value ?? fallbackValue;
    });
  }

  async setMeta(key, value) {
    await this.patchMeta({ [key]: value });
    return { key: normalizeRecordId(key), value: toPlainData(value, value), updatedAt: Date.now() };
  }

  async patchMeta(record) {
    return await this._withWriteLock(() => this._write(async () => {
      if (!record || typeof record !== "object" || Array.isArray(record)) return {};
      const nowMs = Date.now();
      const head = await this._readHead();
      const headPatch = {};
      for (const [rawKey, value] of Object.entries(record)) {
        const key = normalizeRecordId(rawKey);
        if (!key) continue;
        if (HEAD_META_KEYS.has(key)) {
          headPatch[key] = value;
        } else {
          await this._upsertKindRecord(KIND_META, key, { key, value }, this._zero());
        }
      }
      if (Object.keys(headPatch).length) {
        await this._writeHead({ ...head, ...headPatch, lastModified: nowMs });
      }
      return Object.fromEntries(Object.entries(record).filter(([key]) => normalizeRecordId(key)));
    }));
  }

  async getRevision() {
    return normalizeRevision(await this.getMeta("revision", 0));
  }

  async bumpRevision(reason = "mutation") {
    const result = await this.commitDelta({}, { reason });
    return result.revision;
  }

  async markSyncDirty(reason = "mutation") {
    await this.patchMeta({
      syncDirty: true,
      syncDirtyReason: String(reason || "mutation"),
    });
    return true;
  }

  async commitDelta(delta = {}, options = {}) {
    return await this._withWriteLock(() => this._write(async () => {
      const commitRequestedAt = readPersistCommitNow();
      const nowMs = Date.now();
      const normalizedDelta = delta && typeof delta === "object" && !Array.isArray(delta) ? delta : {};
      const reason = String(options.reason || "commitDelta");
      const requestedRevision = normalizeRevision(options.requestedRevision);
      const shouldMarkSyncDirty = options.markSyncDirty !== false;
      const payloadBytes = measureJsonBytes(normalizedDelta);
      const head = await this._readHead();
      const currentRevision = normalizeRevision(head.revision);
      if (options.baseRevision != null && normalizeRevision(options.baseRevision) !== currentRevision) {
        throw createGraphCommitConflictError(options.baseRevision, currentRevision);
      }
      const nextRevision = Math.max(currentRevision + 1, requestedRevision);
      const ops = this._buildWalOps(normalizedDelta, nowMs);
      const commitId = `c${nowMs}-${nextRevision}`;
      const shards = this._packWalShards(commitId, ops);
      const transactionStartedAt = readPersistCommitNow();
      await this._writeHead({
        ...head,
        pendingWal: { commitId, shardCount: shards.length, complete: false },
      });
      await this._writeWalShards(shards);
      await this._writeHead({
        ...head,
        pendingWal: { commitId, shardCount: shards.length, complete: true },
      });
      await this._replayWal({ commitId, shardCount: shards.length, complete: true });
      let counts = normalizeUpsertCountDelta(normalizedDelta.countDelta);
      if (!counts) {
        const empty = await this._countRecords();
        counts = empty;
      }
      const runtimeMetaPatch =
        normalizedDelta.runtimeMetaPatch && typeof normalizedDelta.runtimeMetaPatch === "object"
          ? normalizedDelta.runtimeMetaPatch
          : {};
      const headPatch = {};
      for (const [rawKey, value] of Object.entries(runtimeMetaPatch)) {
        const key = normalizeRecordId(rawKey);
        if (HEAD_META_KEYS.has(key) && !PERSIST_META_RESERVED_KEYS.has(key)) {
          headPatch[key] = value;
        }
      }
      await this._writeHead({
        ...head,
        ...headPatch,
        chatId: this.chatId,
        schemaVersion: BME_DB_SCHEMA_VERSION,
        storagePrimary: TAURITAVERN_GRAPH_STORE_KIND,
        storageMode: TAURITAVERN_GRAPH_STORE_MODE,
        revision: nextRevision,
        lastModified: nowMs,
        lastMutationReason: reason,
        syncDirty: shouldMarkSyncDirty,
        syncDirtyReason: shouldMarkSyncDirty ? reason : "",
        nodeCount: counts.nodes,
        edgeCount: counts.edges,
        tombstoneCount: counts.tombstones,
        pendingWal: null,
      });
      await this._deleteWalShards(shards.length);
      try {
        await this._db.flush();
      } catch (error) {
        console.warn("[ST-BME] TauriTavern flush after commit failed:", error?.message || error);
      }
      return {
        revision: nextRevision,
        lastModified: nowMs,
        imported: counts,
        delta: {
          upsertNodes: normalizeNodeRecords(normalizedDelta.upsertNodes, nowMs).length,
          upsertEdges: normalizeEdgeRecords(normalizedDelta.upsertEdges, nowMs).length,
          deleteNodeIds: toArray(normalizedDelta.deleteNodeIds).length,
          deleteEdgeIds: toArray(normalizedDelta.deleteEdgeIds).length,
          tombstones: normalizeTombstoneRecords(normalizedDelta.tombstones, nowMs).length,
        },
        diagnostics: {
          storageKind: TAURITAVERN_GRAPH_STORE_KIND,
          storeMode: TAURITAVERN_GRAPH_STORE_MODE,
          queueWaitMs: 0,
          commitMs: normalizePersistCommitMs(readPersistCommitNow() - commitRequestedAt),
          txMs: normalizePersistCommitMs(readPersistCommitNow() - transactionStartedAt),
          payloadBytes,
          walShards: shards.length,
          runtimeMetaKeyCount: Object.keys(runtimeMetaPatch).length,
          browserCacheMode: "none",
        },
      };
    }));
  }

  async _countRecords() {
    const [nodes, edges, tombstones] = await Promise.all([
      this._listKind(KIND_NODE),
      this._listKind(KIND_EDGE),
      this._listKind(KIND_TOMBSTONE),
    ]);
    return { nodes: nodes.length, edges: edges.length, tombstones: tombstones.length };
  }

  async bulkUpsertNodes(nodes = []) {
    const records = normalizeNodeRecords(nodes);
    if (!records.length) return { upserted: 0, revision: await this.getRevision() };
    const result = await this.commitDelta({ upsertNodes: records }, { reason: "bulkUpsertNodes" });
    return { upserted: records.length, revision: result.revision };
  }

  async bulkUpsertEdges(edges = []) {
    const records = normalizeEdgeRecords(edges);
    if (!records.length) return { upserted: 0, revision: await this.getRevision() };
    const result = await this.commitDelta({ upsertEdges: records }, { reason: "bulkUpsertEdges" });
    return { upserted: records.length, revision: result.revision };
  }

  async bulkUpsertTombstones(tombstones = []) {
    const records = normalizeTombstoneRecords(tombstones);
    if (!records.length) return { upserted: 0, revision: await this.getRevision() };
    const result = await this.commitDelta({ tombstones: records }, { reason: "bulkUpsertTombstones" });
    return { upserted: records.length, revision: result.revision };
  }

  async listNodes(options = {}) {
    return await this._read(async () => {
      let records = await this._listKind(KIND_NODE);
      if (options.includeDeleted === false) {
        records = records.filter((item) => !Number.isFinite(Number(item?.deletedAt)));
      }
      if (options.includeArchived === false) {
        records = records.filter((item) => !item?.archived);
      }
      if (typeof options.type === "string" && options.type.trim()) {
        records = records.filter((item) => String(item?.type || "") === options.type);
      }
      return applyListOptions(records, options);
    });
  }

  async listEdges(options = {}) {
    return await this._read(async () => {
      let records = await this._listKind(KIND_EDGE);
      if (options.includeDeleted === false) {
        records = records.filter((item) => !Number.isFinite(Number(item?.deletedAt)));
      }
      if (typeof options.relation === "string" && options.relation.trim()) {
        records = records.filter((item) => String(item?.relation || "") === options.relation);
      }
      return applyListOptions(records, options);
    });
  }

  async listTombstones(options = {}) {
    return await this._read(async () => {
      let records = await this._listKind(KIND_TOMBSTONE);
      if (typeof options.kind === "string" && options.kind.trim()) {
        records = records.filter((item) => String(item?.kind || "") === options.kind);
      }
      if (typeof options.targetId === "string" && options.targetId.trim()) {
        records = records.filter((item) => String(item?.targetId || "") === options.targetId);
      }
      return applyListOptions(records, options);
    });
  }

  async isEmpty(options = {}) {
    return await this._read(async () => {
      const counts = await this._countRecords();
      const includeTombstones = options.includeTombstones === true;
      return {
        empty: includeTombstones
          ? counts.nodes === 0 && counts.edges === 0 && counts.tombstones === 0
          : counts.nodes === 0 && counts.edges === 0,
        nodes: counts.nodes,
        edges: counts.edges,
        tombstones: counts.tombstones,
        includeTombstones,
      };
    });
  }

  async importLegacyGraph(legacyGraph, options = {}) {
    await this.open();
    const nowMs = normalizeTimestamp(options.nowMs, Date.now());
    const migrationSource = normalizeRecordId(options.source || "chat_metadata") || "chat_metadata";
    const requestedRetentionMs = Number(options.legacyRetentionMs);
    const legacyRetentionMs =
      Number.isFinite(requestedRetentionMs) && requestedRetentionMs >= 0
        ? Math.floor(requestedRetentionMs)
        : BME_LEGACY_RETENTION_MS;
    const legacyRetentionUntil = nowMs + legacyRetentionMs;
    const migrationCompletedAt = normalizeTimestamp(await this.getMeta("migrationCompletedAt", 0), 0);
    if (migrationCompletedAt > 0) {
      const counts = await this._countRecords();
      return {
        migrated: false,
        skipped: true,
        reason: "migration-already-completed",
        revision: await this.getRevision(),
        imported: counts,
        migrationCompletedAt,
        migrationSource,
        legacyRetentionUntil: normalizeTimestamp(await this.getMeta("legacyRetentionUntil", 0), 0),
      };
    }
    const emptyStatus = await this.isEmpty();
    if (!emptyStatus?.empty) {
      return {
        migrated: false,
        skipped: true,
        reason: "tauritavern-store-not-empty",
        revision: await this.getRevision(),
        imported: {
          nodes: emptyStatus.nodes,
          edges: emptyStatus.edges,
          tombstones: emptyStatus.tombstones,
        },
        migrationCompletedAt: 0,
        migrationSource,
        legacyRetentionUntil,
      };
    }
    const runtimeLegacyGraph = normalizeGraphRuntimeState(
      deserializeGraph(toPlainData(legacyGraph, createEmptyGraph())),
      this.chatId,
    );
    const snapshot = buildSnapshotFromGraph(runtimeLegacyGraph, {
      chatId: this.chatId,
      nowMs,
      revision: normalizeRevision(options.revision ?? runtimeLegacyGraph?.__stBmePersistence?.revision),
      meta: {
        migrationCompletedAt: nowMs,
        migrationSource,
        legacyRetentionUntil,
        storagePrimary: TAURITAVERN_GRAPH_STORE_KIND,
        storageMode: TAURITAVERN_GRAPH_STORE_MODE,
      },
    });
    const importResult = await this.importSnapshot(snapshot, {
      mode: "replace",
      preserveRevision: true,
      revision: normalizeRevision(options.revision ?? snapshot.meta?.revision),
      markSyncDirty: true,
    });
    return {
      migrated: true,
      skipped: false,
      reason: "migrated",
      revision: importResult.revision,
      imported: toPlainData(importResult.imported, importResult.imported),
      migrationCompletedAt: nowMs,
      migrationSource,
      legacyRetentionUntil,
    };
  }

  async exportSnapshot(options = {}) {
    return await this._read(async () => {
      const includeTombstones = options && typeof options === "object" ? options.includeTombstones !== false : options !== false;
      const [head, nodes, edges, tombstones, metaEntries] = await Promise.all([
        this._readHead(),
        this.listNodes(),
        this.listEdges(),
        includeTombstones ? this.listTombstones() : Promise.resolve([]),
        this._listKind(KIND_META),
      ]);
      const extraMeta = {};
      for (const entry of metaEntries) {
        if (entry?.key) extraMeta[entry.key] = entry.value;
      }
      const meta = {
        ...createDefaultHead(this.chatId, this.dim, this.namespace),
        ...head,
        ...extraMeta,
        schemaVersion: BME_DB_SCHEMA_VERSION,
        chatId: this.chatId,
        revision: normalizeRevision(head.revision),
        nodeCount: nodes.length,
        edgeCount: edges.length,
        tombstoneCount: includeTombstones ? tombstones.length : normalizeNonNegativeInteger(head.tombstoneCount, 0),
        storagePrimary: TAURITAVERN_GRAPH_STORE_KIND,
        storageMode: TAURITAVERN_GRAPH_STORE_MODE,
      };
      delete meta.ttRecordKind;
      delete meta.pendingWal;
      const snapshot = {
        schemaVersion: BME_DB_SCHEMA_VERSION,
        meta,
        nodes,
        edges,
        tombstones: includeTombstones ? tombstones : [],
        state: normalizeStateSnapshot({ meta }),
      };
      if (!includeTombstones) snapshot.__stBmeTombstonesOmitted = true;
      return snapshot;
    });
  }

  async exportSnapshotProbe() {
    const snapshot = await this.exportSnapshot({ includeTombstones: false });
    return {
      ...snapshot,
      nodes: [],
      edges: [],
      tombstones: [],
      __stBmeProbeOnly: true,
      __stBmeTombstonesOmitted: true,
    };
  }

  async importSnapshot(snapshot, options = {}) {
    const normalizedSnapshot = sanitizeSnapshot(snapshot);
    const mode = String(options.mode || "replace").toLowerCase() === "merge" ? "merge" : "replace";
    if (mode === "replace") {
      await this.clearAll({ preserveHead: true });
    }
    const nowMs = Date.now();
    const nodes = normalizeNodeRecords(normalizedSnapshot.nodes, nowMs);
    const edges = normalizeEdgeRecords(normalizedSnapshot.edges, nowMs);
    const tombstones = normalizeTombstoneRecords(normalizedSnapshot.tombstones, nowMs);
    const state = normalizeStateSnapshot(normalizedSnapshot);
    const meta = normalizedSnapshot.meta || {};
    const runtimeMetaPatch = {};
    for (const [key, value] of Object.entries(meta)) {
      if (HEAD_META_KEYS.has(key) || PERSIST_META_RESERVED_KEYS.has(key)) continue;
      runtimeMetaPatch[key] = value;
    }
    const result = await this.commitDelta({
      upsertNodes: nodes,
      upsertEdges: edges,
      tombstones,
      countDelta: { next: { nodes: nodes.length, edges: edges.length, tombstones: tombstones.length } },
      runtimeMetaPatch: {
        ...runtimeMetaPatch,
        lastProcessedFloor: state.lastProcessedFloor,
        extractionCount: state.extractionCount,
      },
    }, {
      reason: String(options.reason || "importSnapshot"),
      requestedRevision: options.preserveRevision === true
        ? normalizeRevision(options.revision ?? meta.revision)
        : undefined,
      markSyncDirty: options.markSyncDirty !== false,
    });
    return result;
  }

  async clearAll(options = {}) {
    return await this._withWriteLock(() => this._write(async () => {
      const nodes = await this._pageAllNodes();
      for (const node of nodes) {
        if (options.preserveHead && Number(node.id) === HEAD_ID) continue;
        try {
          await this._db.delete(node.id);
        } catch {
        }
      }
      if (options.preserveHead) {
        await this._writeHead(createDefaultHead(this.chatId, this.dim, this.namespace));
      } else {
        await this._ensureHead();
      }
      try {
        await this._db.flush();
      } catch {
      }
      return { cleared: true };
    }));
  }

  async pruneExpiredTombstones(nowMs = Date.now()) {
    const records = await this.listTombstones();
    const expired = records.filter((record) => {
      const deletedAt = Number(record?.deletedAt || 0);
      return Number.isFinite(deletedAt) && deletedAt > 0 && nowMs - deletedAt > BME_TOMBSTONE_RETENTION_MS;
    });
    if (!expired.length) return { pruned: 0, revision: await this.getRevision() };
    const result = await this.commitDelta({
      deleteTombstoneIds: expired.map((record) => record.id),
    }, { reason: "pruneExpiredTombstones" });
    return { pruned: expired.length, revision: result.revision };
  }

  async copyFrom(sourceStore) {
    const snapshot = await sourceStore.exportSnapshot({ includeTombstones: true });
    return await this.importSnapshot(snapshot, {
      mode: "replace",
      preserveRevision: true,
      markSyncDirty: true,
      reason: "namespace-dim-migration",
    });
  }

  async updateRecordVector(kind, recordId, vector) {
    return await this._write(async () => {
      const id = await this._resolveId(kind, recordId, false);
      if (id == null) return false;
      await this._db.updateVector(id, Array.isArray(vector) && vector.length === this.dim ? vector : this._zero());
      return true;
    });
  }

  async searchSimilar(vector, options = {}) {
    return await this._read(async () => {
      const hits = await this._db.search(vector, {
        topK: Math.max(1, Math.floor(Number(options.topK) || 10)),
        payloadFilter: options.payloadFilter || { ttRecordKind: KIND_NODE },
        ...(options.queryText ? { queryText: options.queryText } : {}),
      });
      return toArray(hits).map((hit) => ({
        id: hit.payload?.ttRecordId || hit.payload?.recordId || hit.id,
        triviumId: hit.id,
        score: Number(hit.score) || 0,
        payload: hit.payload,
      }));
    });
  }

  getHandle() {
    return this._db;
  }
}
