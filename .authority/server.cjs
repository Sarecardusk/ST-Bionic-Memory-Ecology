'use strict';

/**
 * BME companion authority module server entry.
 *
 * Phase B: vector-only transactions (`vector.manifest`, `vector.apply`).
 *
 * Contract:
 *   module.exports.activate = async function activate(ctx) { ... }
 *
 * The DOA companion loader calls `activate(ctx)` once at startup. The
 * activation ctx exposes only safe metadata (`moduleId`, `ownerExtensionId`,
 * `moduleDir`, `logger`, `registerTransaction`). No raw DOA services are
 * available on the activation ctx.
 *
 * Each registered transaction handler receives a CompanionModuleTransactionContext
 * with a safe `trivium` wrapper that forces `extensionId = ownerExtensionId`
 * and authorizes `trivium.private` before each call. BME-specific vector logic
 * lives here; DOA stays generic.
 *
 * Payload shape (from `vector/authority-vector-primary-adapter.js`):
 *   {
 *     database, namespace, collectionId, chatId, graphRevision,
 *     modelScope, vectorSpaceId, observedDim, items, links, idempotencyKey
 *   }
 *
 * Return shape (consumed by the BME adapter):
 *   {
 *     ok: true,
 *     appliedAt: ISOString,
 *     database, manifest, upsert: {totalCount,successCount,failureCount},
 *     links: {totalCount,successCount,failureCount},
 *     skippedLinkCount
 *   }
 */

const DEFAULT_BME_DATABASE = 'st_bme_vectors';
const DEFAULT_NAMESPACE = 'default';

// BME graph SQL default database. Matches `DEFAULT_AUTHORITY_SQL_DATABASE`
// in sync/authority-graph-store.js — the value BME actually opens the graph
// store with when no explicit database is configured. Companion handlers use
// this when the request omits `database`.
const DEFAULT_BME_GRAPH_DATABASE = 'default';
const BME_GRAPH_SCHEMA_VERSION = 1;

const crypto = require('crypto');

// Server-side caps for recall.candidates. Mirrors the DOA companion
// trivium wrapper caps (MAX_SEARCH_TOP_K / MAX_SEARCH_EXPAND_DEPTH) so the
// handler clamps client requests before delegating to txCtx.trivium.
const MAX_SEARCH_TOP_K = 200;
const MAX_SEARCH_EXPAND_DEPTH = 5;
const DEFAULT_SEARCH_TOP_K = 10;
const DEFAULT_SEARCH_EXPAND_DEPTH = 0;

// --- helpers ---

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function clampInteger(value, fallback, min, max) {
  var parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function normalizeString(value, fallback) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return fallback;
}

function normalizeRecordId(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function normalizeVector(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((v) => typeof v === 'number' && Number.isFinite(v));
}

function resolveDatabase(payload) {
  return normalizeString(payload && payload.database, DEFAULT_BME_DATABASE);
}

function resolveNamespace(payload) {
  var ns = normalizeString(payload && payload.namespace, '');
  if (ns) return ns;
  var collectionId = normalizeString(payload && payload.collectionId, '');
  if (collectionId) return collectionId;
  var chatId = normalizeString(payload && payload.chatId, '');
  return chatId || DEFAULT_NAMESPACE;
}

function buildNodeReference(node) {
  if (!node || typeof node !== 'object') return { externalId: '', namespace: '' };
  var externalId = normalizeRecordId(node.externalId || node.nodeId || node.id);
  var namespace = normalizeString(node.namespace, '');
  return { externalId: externalId, namespace: namespace };
}

function buildV06PayloadSource(payload) {
  if (!payload || typeof payload !== 'object') return {};
  var source = {};
  var keys = ['nodeId', 'externalId', 'text', 'contentHash', 'index', 'collectionId', 'chatId', 'modelScope', 'graphRevision', 'vectorSpaceId', 'observedDim'];
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (payload[key] !== undefined && payload[key] !== null) {
      source[key] = payload[key];
    }
  }
  return source;
}

function validateVectorBatch(items, observedDim) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('BME vector.apply requires at least one item');
  }
  var detectedDim = 0;
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (!item || typeof item !== 'object') {
      throw new Error('BME vector.apply item at index ' + i + ' is not an object');
    }
    var vector = normalizeVector(item.vector || item.embedding);
    if (vector.length === 0) {
      throw new Error('BME vector.apply item at index ' + i + ' has no vector');
    }
    if (detectedDim === 0) {
      detectedDim = vector.length;
    } else if (vector.length !== detectedDim) {
      throw new Error('BME vector.apply items have inconsistent vector dimensions: ' + detectedDim + ' vs ' + vector.length + ' at index ' + i);
    }
    if (observedDim && Number(observedDim) > 0 && Number(observedDim) !== detectedDim) {
      throw new Error('BME vector.apply observedDim (' + observedDim + ') does not match item vector length (' + detectedDim + ')');
    }
  }
  return detectedDim;
}

function buildUpsertItems(items, namespace, payload) {
  return items.map(function (item) {
    var nodeId = normalizeRecordId(item.externalId || item.nodeId || item.id);
    var payloadSource = buildV06PayloadSource(item.payload || item);
    var vector = normalizeVector(item.vector || item.embedding);
    return {
      externalId: nodeId,
      namespace: namespace,
      vector: vector,
      payload: Object.assign({}, payloadSource, {
        nodeId: payloadSource.nodeId || nodeId,
        externalId: payloadSource.externalId || nodeId,
        collectionId: payload.collectionId || payloadSource.collectionId || '',
        text: payloadSource.text || item.text || '',
        contentHash: payloadSource.contentHash || item.hash || '',
        index: Number(item.index || payloadSource.index || 0) || 0,
      }),
    };
  });
}

function buildLinkItems(links, namespace) {
  return toArray(links).map(function (link) {
    if (!link || typeof link !== 'object') return null;
    var src = normalizeRecordId(link.fromId || link.src || link.sourceId);
    var dst = normalizeRecordId(link.toId || link.dst || link.targetId);
    if (!src || !dst) return null;
    return {
      src: buildNodeReference(Object.assign({}, link.src || {}, { externalId: src, namespace: namespace })),
      dst: buildNodeReference(Object.assign({}, link.dst || {}, { externalId: dst, namespace: namespace })),
      label: String(link.relation || link.label || 'related'),
      weight: Number(link.weight != null ? link.weight : link.strength != null ? link.strength : 1) || 1,
    };
  }).filter(Boolean);
}

function buildManifestFromStat(statResult, input) {
  return {
    database: resolveDatabase(input),
    exists: Boolean(statResult && statResult.exists),
    status: statResult && statResult.exists ? 'ready' : 'missing',
    nodeCount: Number(statResult && statResult.nodeCount) || 0,
    edgeCount: Number(statResult && statResult.edgeCount) || 0,
    mappingCount: Number(statResult && statResult.mappingCount) || 0,
    indexCount: Number(statResult && statResult.indexCount) || 0,
    orphanMappingCount: Number(statResult && statResult.orphanMappingCount) || 0,
    lastFlushAt: (statResult && statResult.lastFlushAt) || null,
    updatedAt: (statResult && statResult.updatedAt) || null,
    collectionId: normalizeString(input && input.collectionId, ''),
    chatId: normalizeString(input && input.chatId, ''),
    modelScope: normalizeString(input && input.modelScope, ''),
    graphRevision: Number(input && input.graphRevision) || 0,
    vectorSpaceId: normalizeString(input && input.vectorSpaceId, ''),
    observedDim: Number(input && input.observedDim) || 0,
    indexHealth: (statResult && statResult.indexHealth) || null,
  };
}

// --- recall.candidates helpers ---

// HARD OUTPUT BOUNDARY: sanitize a searchHybrid hit so only candidate node
// reference fields are returned. NEVER include payload/text/content/messages/
// prompt. The handler returns ONLY externalId/internalId/namespace/score.
function sanitizeSearchHit(hit) {
  if (!hit || typeof hit !== 'object') return null;
  var externalId = normalizeRecordId(hit.externalId || hit.nodeId || hit.id);
  if (!externalId) return null;
  var internalId = Number(hit.id != null ? hit.id : hit.internalId);
  var namespace = normalizeString(hit.namespace, '');
  var score = Math.max(0, Number(hit.score != null ? hit.score : hit.similarity) || 0);
  var sanitized = {
    externalId: externalId,
    score: score,
    source: 'search',
  };
  if (Number.isFinite(internalId) && internalId > 0) {
    sanitized.internalId = internalId;
  }
  if (namespace) {
    sanitized.namespace = namespace;
  }
  return sanitized;
}

function sanitizeNeighborNode(node) {
  if (!node || typeof node !== 'object') return null;
  var externalId = normalizeRecordId(node.externalId || node.nodeId || node.id);
  if (!externalId) return null;
  var internalId = Number(node.id != null ? node.id : node.internalId);
  var namespace = normalizeString(node.namespace, '');
  var sanitized = {
    externalId: externalId,
    score: 0,
    source: 'expand',
  };
  if (Number.isFinite(internalId) && internalId > 0) {
    sanitized.internalId = internalId;
  }
  if (namespace) {
    sanitized.namespace = namespace;
  }
  return sanitized;
}

// Validate the recall.candidates input shape before delegating to the DOA
// trivium wrapper. Throws on validation errors.
function validateRecallCandidatesInput(input, observedDim) {
  var queryTexts = toArray(input && input.queryTexts)
    .filter(function (t) { return typeof t === 'string' && t.trim().length > 0; });
  var queryVectors = toArray(input && input.queryVectors);
  if (queryTexts.length === 0 && queryVectors.length === 0) {
    throw new Error('BME recall.candidates requires at least one of queryTexts or queryVectors');
  }
  for (var i = 0; i < queryVectors.length; i++) {
    var vec = queryVectors[i];
    if (!Array.isArray(vec) || vec.length === 0) {
      throw new Error('BME recall.candidates queryVectors[' + i + '] must be a non-empty array');
    }
    if (observedDim && Number(observedDim) > 0 && Number(observedDim) !== vec.length) {
      throw new Error(
        'BME recall.candidates queryVectors[' + i + '] length (' + vec.length +
        ') does not match observedDim (' + observedDim + ')'
      );
    }
  }
}

// --- graph helpers (graph.getHead / graph.loadSnapshot) ---

// SQL result rows come back as `{ kind: 'query', columns, rows: [...] }` from
// the DOA `ctx.sql.query` wrapper (see SqlQueryResult in @stdo/shared-types).
// Test mocks may pass a bare array or `{ rows }` / `{ data }`. Normalize all
// shapes to a plain array of row objects.
function normalizeSqlRows(result) {
  if (Array.isArray(result)) return result;
  if (!result || typeof result !== 'object') return [];
  if (Array.isArray(result.rows)) return result.rows;
  if (Array.isArray(result.data)) return result.data;
  if (Array.isArray(result.result && result.result.rows)) return result.result.rows;
  return [];
}

function parseJsonValue(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (e) {
    return fallback;
  }
}

function readRowValue(row, keys) {
  if (!row || typeof row !== 'object') return undefined;
  for (var i = 0; i < keys.length; i++) {
    if (Object.prototype.hasOwnProperty.call(row, keys[i])) {
      return row[keys[i]];
    }
  }
  return undefined;
}

function toMetaMap(rows) {
  var output = {};
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!row || typeof row !== 'object') continue;
    var key = String(readRowValue(row, ['key', 'meta_key', 'metaKey']) || '').trim();
    if (!key) continue;
    var rawValue = readRowValue(row, ['valueJson', 'value_json', 'value']);
    output[key] = parseJsonValue(rawValue, null);
  }
  return output;
}

function normalizePayloadRows(rows) {
  return rows
    .map(function (row) {
      var raw = readRowValue(row, ['payloadJson', 'payload_json', 'payload']);
      return parseJsonValue(raw, null);
    })
    .filter(function (record) {
      return record && typeof record === 'object' && !Array.isArray(record);
    });
}

function extractRecordIds(rows) {
  var ids = [];
  for (var i = 0; i < rows.length; i++) {
    var id = String(readRowValue(rows[i], ['record_id', 'recordId', 'id']) || '').trim();
    if (id) ids.push(id);
  }
  return ids;
}

function extractRecordIdFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  return String(payload.id || payload.recordId || payload.record_id || '').trim();
}

// Compute a content hash for same-revision divergence detection. Hashes
// sorted node + edge record_ids + revision so two chats with the same
// revision but different contents produce different headHashes. SHA-256 is
// always available server-side via node:crypto.
function computeHeadHash(nodeIds, edgeIds, revision) {
  var parts = [];
  for (var i = 0; i < nodeIds.length; i++) {
    if (nodeIds[i]) parts.push('n:' + nodeIds[i]);
  }
  for (var j = 0; j < edgeIds.length; j++) {
    if (edgeIds[j]) parts.push('e:' + edgeIds[j]);
  }
  parts.sort();
  parts.push('r:' + revision);
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

// CREATE TABLE IF NOT EXISTS for all 4 BME graph tables. Matches the schema
// in sync/authority-graph-store.js `_ensureSchema` (:1067-1086). Safe to call
// repeatedly — companion handlers call this lazily before reads so a fresh
// database does not error on SELECT from a missing table.
var GRAPH_TABLES = {
  meta: 'st_bme_graph_meta',
  nodes: 'st_bme_graph_nodes',
  edges: 'st_bme_graph_edges',
  tombstones: 'st_bme_graph_tombstones',
};

var GRAPH_SCHEMA_STATEMENTS = [
  'CREATE TABLE IF NOT EXISTS ' + GRAPH_TABLES.meta + ' (chat_id TEXT NOT NULL, meta_key TEXT NOT NULL, value_json TEXT, updated_at INTEGER, PRIMARY KEY(chat_id, meta_key))',
  'CREATE TABLE IF NOT EXISTS ' + GRAPH_TABLES.nodes + ' (chat_id TEXT NOT NULL, record_id TEXT NOT NULL, payload_json TEXT NOT NULL, node_type TEXT, source_floor INTEGER, archived INTEGER, updated_at INTEGER, deleted_at INTEGER, PRIMARY KEY(chat_id, record_id))',
  'CREATE TABLE IF NOT EXISTS ' + GRAPH_TABLES.edges + ' (chat_id TEXT NOT NULL, record_id TEXT NOT NULL, payload_json TEXT NOT NULL, from_id TEXT, to_id TEXT, relation TEXT, source_floor INTEGER, updated_at INTEGER, deleted_at INTEGER, PRIMARY KEY(chat_id, record_id))',
  'CREATE TABLE IF NOT EXISTS ' + GRAPH_TABLES.tombstones + ' (chat_id TEXT NOT NULL, record_id TEXT NOT NULL, payload_json TEXT NOT NULL, tombstone_kind TEXT, target_id TEXT, deleted_at INTEGER, source_device_id TEXT, PRIMARY KEY(chat_id, record_id))',
];

async function ensureGraphSchema(txCtx, database) {
  if (!txCtx || typeof txCtx.sql !== 'object' || typeof txCtx.sql.exec !== 'function') {
    throw new Error('BME graph transaction requires ctx.sql.exec (sql.private)');
  }
  for (var i = 0; i < GRAPH_SCHEMA_STATEMENTS.length; i++) {
    await txCtx.sql.exec(database, GRAPH_SCHEMA_STATEMENTS[i]);
  }
}

function resolveGraphDatabase(payload) {
  return normalizeString(payload && payload.database, DEFAULT_BME_GRAPH_DATABASE);
}

function resolveGraphChatId(payload) {
  var chatId = normalizeString(payload && payload.chatId, '');
  if (!chatId) {
    throw new Error('BME graph transaction requires chatId');
  }
  return chatId;
}

// Meta keys surfaced by graph.getHead. Mirrors the reserved meta keys in
// sync/authority-graph-store.js PERSIST_META_RESERVED_KEYS plus the runtime
// state keys (lastProcessedFloor, extractionCount, schemaVersion).
var GRAPH_META_REPORT_KEYS = [
  'revision',
  'lastModified',
  'syncDirty',
  'syncDirtyReason',
  'lastProcessedFloor',
  'extractionCount',
  'schemaVersion',
  'nodeCount',
  'edgeCount',
  'tombstoneCount',
];

function buildGraphMetaReport(meta) {
  var report = {};
  for (var i = 0; i < GRAPH_META_REPORT_KEYS.length; i++) {
    var key = GRAPH_META_REPORT_KEYS[i];
    if (Object.prototype.hasOwnProperty.call(meta, key)) {
      report[key] = meta[key];
    }
  }
  return report;
}

// Read head info for a chat: revision, headHash, meta. Used by both
// graph.getHead (full response) and graph.loadSnapshot (minRevision check).
// Returns { exists, revision, headHash, meta }.
async function readGraphHead(txCtx, database, chatId) {
  var metaRows = normalizeSqlRows(
    await txCtx.sql.query(
      database,
      'SELECT meta_key, value_json FROM ' + GRAPH_TABLES.meta + ' WHERE chat_id = ?',
      [chatId]
    )
  );
  if (metaRows.length === 0) {
    return { exists: false, revision: 0, headHash: null, meta: {} };
  }
  var meta = toMetaMap(metaRows);
  var revision = Number(meta.revision) || 0;

  var nodeRows = normalizeSqlRows(
    await txCtx.sql.query(
      database,
      'SELECT record_id FROM ' + GRAPH_TABLES.nodes + ' WHERE chat_id = ? AND deleted_at IS NULL',
      [chatId]
    )
  );
  var edgeRows = normalizeSqlRows(
    await txCtx.sql.query(
      database,
      'SELECT record_id FROM ' + GRAPH_TABLES.edges + ' WHERE chat_id = ? AND deleted_at IS NULL',
      [chatId]
    )
  );
  var nodeIds = extractRecordIds(nodeRows);
  var edgeIds = extractRecordIds(edgeRows);
  var headHash = computeHeadHash(nodeIds, edgeIds, revision);
  return { exists: true, revision: revision, headHash: headHash, meta: meta };
}

// --- activate ---

module.exports.activate = async function activate(ctx) {
  if (!ctx || typeof ctx !== 'object') {
    throw new Error('BME companion module: activation ctx is required');
  }
  if (typeof ctx.registerTransaction !== 'function') {
    throw new Error('BME companion module: ctx.registerTransaction is required');
  }
  var logger = ctx.logger || console;

  ctx.registerTransaction('vector.manifest', {
    handler: async function (txCtx, input) {
      var database = resolveDatabase(input);
      var includeMappingIntegrity = Boolean(input && input.includeMappingIntegrity);
      var statResult = await txCtx.trivium.stat({
        database: database,
        includeMappingIntegrity: includeMappingIntegrity,
      });
      var manifest = buildManifestFromStat(statResult, input || {});
      return {
        result: {
          ok: true,
          appliedAt: new Date().toISOString(),
          database: database,
          manifest: manifest,
        },
      };
    },
  });

  ctx.registerTransaction('vector.apply', {
    handler: async function (txCtx, input) {
      input = input || {};
      var database = resolveDatabase(input);
      var namespace = resolveNamespace(input);
      var observedDim = Number(input.observedDim) || 0;
      var items = toArray(input.items);
      var links = toArray(input.links);

      // Validate the vector batch: items required, each has a non-empty
      // vector, all vectors have consistent dimension, observedDim if
      // provided must match.
      var detectedDim = validateVectorBatch(items, observedDim);

      // Map BME items to DOA Trivium bulkUpsert request shape.
      var upsertItems = buildUpsertItems(items, namespace, input);
      var openOptions = {
        database: database,
        dim: detectedDim,
      };
      if (input.dtype) openOptions.dtype = input.dtype;
      if (input.metric) openOptions.metric = input.metric;
      if (input.syncMode) openOptions.syncMode = input.syncMode;
      if (input.storageMode) openOptions.storageMode = input.storageMode;

      var upsertResult = await txCtx.trivium.bulkUpsert(Object.assign({}, openOptions, {
        items: upsertItems,
      }));

      // Map BME links to DOA Trivium bulkLink request shape.
      var linkItems = buildLinkItems(links, namespace);
      var linkResult;
      var skippedLinkCount = 0;
      if (linkItems.length > 0) {
        linkResult = await txCtx.trivium.bulkLink({
          database: database,
          items: linkItems,
        });
      } else {
        linkResult = {
          totalCount: 0,
          successCount: 0,
          failureCount: 0,
          failures: [],
        };
        skippedLinkCount = links.length;
      }

      var ok = Number(upsertResult.failureCount || 0) === 0 && Number(linkResult.failureCount || 0) === 0;

      return {
        result: {
          ok: ok,
          appliedAt: new Date().toISOString(),
          database: database,
          manifest: {
            database: database,
            namespace: namespace,
            observedDim: detectedDim,
            collectionId: normalizeString(input.collectionId, ''),
            chatId: normalizeString(input.chatId, ''),
            modelScope: normalizeString(input.modelScope, ''),
            graphRevision: Number(input.graphRevision) || 0,
            vectorSpaceId: normalizeString(input.vectorSpaceId, ''),
          },
          upsert: {
            totalCount: Number(upsertResult.totalCount) || 0,
            successCount: Number(upsertResult.successCount) || 0,
            failureCount: Number(upsertResult.failureCount) || 0,
            failures: toArray(upsertResult.failures),
          },
          links: {
            totalCount: Number(linkResult.totalCount) || 0,
            successCount: Number(linkResult.successCount) || 0,
            failureCount: Number(linkResult.failureCount) || 0,
            failures: toArray(linkResult.failures),
          },
          skippedLinkCount: skippedLinkCount,
        },
      };
    },
  });

  ctx.registerTransaction('recall.candidates', {
    handler: async function (txCtx, input) {
      input = input || {};
      var database = resolveDatabase(input);
      var collectionId = normalizeString(input.collectionId, '');
      var chatId = normalizeString(input.chatId, '');
      var namespace = resolveNamespace(input);
      var graphRevision = Math.max(0, Math.floor(Number(input.graphRevision) || 0));
      var modelScope = normalizeString(input.modelScope, '');
      var vectorSpaceId = normalizeString(input.vectorSpaceId, '');
      var observedDim = Math.max(0, Math.floor(Number(input.observedDim) || 0));

      // Validate input shape. Throws on missing queries or observedDim mismatch.
      validateRecallCandidatesInput(input, observedDim);

      var queryTexts = toArray(input.queryTexts)
        .filter(function (t) { return typeof t === 'string' && t.trim().length > 0; });
      var queryVectors = toArray(input.queryVectors);
      var topK = clampInteger(input.topK, DEFAULT_SEARCH_TOP_K, 1, MAX_SEARCH_TOP_K);
      var expandDepth = clampInteger(input.expandDepth, DEFAULT_SEARCH_EXPAND_DEPTH, 0, MAX_SEARCH_EXPAND_DEPTH);
      var minScore = Number.isFinite(Number(input.minScore)) ? Number(input.minScore) : undefined;
      var hybridAlpha = Number.isFinite(Number(input.hybridAlpha)) ? Number(input.hybridAlpha) : undefined;
      var payloadFilter = (input.payloadFilter && typeof input.payloadFilter === 'object' && !Array.isArray(input.payloadFilter))
        ? input.payloadFilter
        : undefined;
      var filters = (input.filters && typeof input.filters === 'object' && !Array.isArray(input.filters))
        ? input.filters
        : undefined;

      // Pair queryTexts[i] and queryVectors[i] if both arrays; iterate the
      // longer one. Skip indices where neither is present.
      var queryCount = Math.max(queryTexts.length, queryVectors.length);
      var candidates = [];
      var seenExternalIds = new Set();

      for (var q = 0; q < queryCount; q++) {
        var queryText = queryTexts[q];
        var vector = queryVectors[q];
        var hasQueryText = typeof queryText === 'string' && queryText.trim().length > 0;
        var hasVector = Array.isArray(vector) && vector.length > 0;
        if (!hasQueryText && !hasVector) continue;

        var searchReq = {
          database: database,
          vector: vector,
          topK: topK,
          // Expansion is done below via resolveMany + neighbors so the
          // candidate set is fully under our control (sanitized).
          expandDepth: 0,
        };
        if (hasQueryText) searchReq.queryText = queryText;
        if (minScore !== undefined) searchReq.minScore = minScore;
        if (hybridAlpha !== undefined) searchReq.hybridAlpha = hybridAlpha;
        if (payloadFilter !== undefined) searchReq.payloadFilter = payloadFilter;
        if (filters !== undefined) searchReq.filters = filters;

        var hits = await txCtx.trivium.searchHybrid(searchReq);
        hits = toArray(hits);

        for (var h = 0; h < hits.length; h++) {
          var sanitized = sanitizeSearchHit(hits[h]);
          if (!sanitized) continue;
          if (seenExternalIds.has(sanitized.externalId)) continue;
          seenExternalIds.add(sanitized.externalId);
          candidates.push(sanitized);
        }
      }

      // If expandDepth > 0 and hits found, optionally call resolveMany then
      // neighbors to expand the candidate set. Best-effort: failures are
      // logged but do NOT fail the request.
      if (expandDepth > 0 && candidates.length > 0) {
        var topHits = candidates.slice(0, Math.min(candidates.length, topK));
        try {
          var resolved = await txCtx.trivium.resolveMany({
            database: database,
            items: topHits.map(function (h) {
              var ref = { externalId: h.externalId };
              if (h.namespace) ref.namespace = h.namespace;
              return ref;
            }),
          });
          var resolvedItems = toArray(resolved && resolved.items);
          for (var r = 0; r < resolvedItems.length; r++) {
            var item = resolvedItems[r];
            var internalId = Number(item && item.id);
            if (!Number.isFinite(internalId) || internalId <= 0) continue;

            // Attach internalId to the existing candidate.
            for (var c = 0; c < candidates.length; c++) {
              if (candidates[c].externalId === (item && item.externalId)) {
                candidates[c].internalId = internalId;
                break;
              }
            }

            var neighborResult = await txCtx.trivium.neighbors({
              database: database,
              id: internalId,
              depth: expandDepth,
            });
            var neighborNodes = toArray(
              neighborResult && (neighborResult.nodes || neighborResult.neighbors)
            );
            for (var n = 0; n < neighborNodes.length; n++) {
              var sanitizedNeighbor = sanitizeNeighborNode(neighborNodes[n]);
              if (!sanitizedNeighbor) continue;
              if (seenExternalIds.has(sanitizedNeighbor.externalId)) continue;
              seenExternalIds.add(sanitizedNeighbor.externalId);
              candidates.push(sanitizedNeighbor);
            }
          }
        } catch (expandError) {
          // Expansion is best-effort; return search results without expansion.
          if (logger.warn) {
            logger.warn('[st-bme] recall.candidates expand failed:', expandError && expandError.message);
          }
        }
      }

      return {
        result: {
          ok: true,
          database: database,
          collectionId: collectionId,
          chatId: chatId,
          graphRevision: graphRevision,
          modelScope: modelScope,
          vectorSpaceId: vectorSpaceId,
          observedDim: observedDim,
          candidates: candidates,
          queryCount: queryCount,
          searchedAt: new Date().toISOString(),
        },
      };
    },
  });

  ctx.registerTransaction('graph.getHead', {
    handler: async function (txCtx, input) {
      input = input || {};
      var database = resolveGraphDatabase(input);
      var chatId = resolveGraphChatId(input);

      await ensureGraphSchema(txCtx, database);

      var head = await readGraphHead(txCtx, database, chatId);
      if (!head.exists) {
        return {
          result: {
            ok: true,
            chatId: chatId,
            revision: 0,
            headHash: null,
            exists: false,
          },
        };
      }

      var metaReport = buildGraphMetaReport(head.meta);
      return {
        result: {
          ok: true,
          chatId: chatId,
          revision: head.revision,
          headHash: head.headHash,
          lastModified: metaReport.lastModified != null ? metaReport.lastModified : null,
          syncDirty: Boolean(metaReport.syncDirty),
          exists: true,
          meta: metaReport,
        },
      };
    },
  });

  ctx.registerTransaction('graph.loadSnapshot', {
    handler: async function (txCtx, input) {
      input = input || {};
      var database = resolveGraphDatabase(input);
      var chatId = resolveGraphChatId(input);

      await ensureGraphSchema(txCtx, database);

      var head = await readGraphHead(txCtx, database, chatId);

      // minRevision short-circuit: if the caller already has this revision,
      // skip the payload and tell them nothing changed.
      if (input.minRevision !== undefined && input.minRevision !== null) {
        var minRevision = Number(input.minRevision);
        if (Number.isFinite(minRevision) && head.exists && head.revision === minRevision) {
          return {
            result: {
              ok: true,
              unchanged: true,
              chatId: chatId,
              revision: head.revision,
              headHash: head.headHash,
            },
          };
        }
      }

      if (!head.exists) {
        // No meta rows: return an empty snapshot at revision 0.
        return {
          result: {
            ok: true,
            chatId: chatId,
            revision: 0,
            headHash: null,
            schemaVersion: BME_GRAPH_SCHEMA_VERSION,
            meta: {},
            nodes: [],
            edges: [],
            tombstones: [],
            state: {
              lastProcessedFloor: 0,
              extractionCount: 0,
            },
          },
        };
      }

      var nodeRows = normalizeSqlRows(
        await txCtx.sql.query(
          database,
          'SELECT payload_json FROM ' + GRAPH_TABLES.nodes + ' WHERE chat_id = ? AND deleted_at IS NULL',
          [chatId]
        )
      );
      var edgeRows = normalizeSqlRows(
        await txCtx.sql.query(
          database,
          'SELECT payload_json FROM ' + GRAPH_TABLES.edges + ' WHERE chat_id = ? AND deleted_at IS NULL',
          [chatId]
        )
      );
      var tombstoneRows = normalizeSqlRows(
        await txCtx.sql.query(
          database,
          'SELECT payload_json FROM ' + GRAPH_TABLES.tombstones + ' WHERE chat_id = ?',
          [chatId]
        )
      );

      var nodes = normalizePayloadRows(nodeRows);
      var edges = normalizePayloadRows(edgeRows);
      var tombstones = normalizePayloadRows(tombstoneRows);

      // Compute headHash from the loaded payloads (same algorithm as getHead).
      var nodeIds = nodes.map(extractRecordIdFromPayload).filter(Boolean);
      var edgeIds = edges.map(extractRecordIdFromPayload).filter(Boolean);
      var headHash = computeHeadHash(nodeIds, edgeIds, head.revision);

      var meta = head.meta;
      var lastProcessedFloor = Number(meta.lastProcessedFloor);
      if (!Number.isFinite(lastProcessedFloor)) lastProcessedFloor = 0;
      var extractionCount = Number(meta.extractionCount);
      if (!Number.isFinite(extractionCount)) extractionCount = 0;

      return {
        result: {
          ok: true,
          chatId: chatId,
          revision: head.revision,
          headHash: headHash,
          schemaVersion: BME_GRAPH_SCHEMA_VERSION,
          meta: meta,
          nodes: nodes,
          edges: edges,
          tombstones: tombstones,
          state: {
            lastProcessedFloor: lastProcessedFloor,
            extractionCount: extractionCount,
          },
        },
      };
    },
  });

  if (logger.info) {
    logger.info('[st-bme] Companion authority module activated: third-party.st-bme');
  }
};

module.exports.DEFAULT_BME_DATABASE = DEFAULT_BME_DATABASE;
module.exports.DEFAULT_NAMESPACE = DEFAULT_NAMESPACE;
module.exports.DEFAULT_BME_GRAPH_DATABASE = DEFAULT_BME_GRAPH_DATABASE;
module.exports.BME_GRAPH_SCHEMA_VERSION = BME_GRAPH_SCHEMA_VERSION;
module.exports.GRAPH_TABLES = GRAPH_TABLES;
module.exports.GRAPH_SCHEMA_STATEMENTS = GRAPH_SCHEMA_STATEMENTS;
module.exports.GRAPH_META_REPORT_KEYS = GRAPH_META_REPORT_KEYS;
module.exports._validateVectorBatch = validateVectorBatch;
module.exports._buildUpsertItems = buildUpsertItems;
module.exports._buildLinkItems = buildLinkItems;
module.exports._buildManifestFromStat = buildManifestFromStat;
module.exports._resolveDatabase = resolveDatabase;
module.exports._resolveNamespace = resolveNamespace;
module.exports._validateRecallCandidatesInput = validateRecallCandidatesInput;
module.exports._sanitizeSearchHit = sanitizeSearchHit;
module.exports._sanitizeNeighborNode = sanitizeNeighborNode;
module.exports._ensureGraphSchema = ensureGraphSchema;
module.exports._readGraphHead = readGraphHead;
module.exports._computeHeadHash = computeHeadHash;
module.exports._normalizeSqlRows = normalizeSqlRows;
module.exports._toMetaMap = toMetaMap;
module.exports._normalizePayloadRows = normalizePayloadRows;
module.exports._resolveGraphDatabase = resolveGraphDatabase;
module.exports._resolveGraphChatId = resolveGraphChatId;
module.exports._buildGraphMetaReport = buildGraphMetaReport;
module.exports.MAX_SEARCH_TOP_K = MAX_SEARCH_TOP_K;
module.exports.MAX_SEARCH_EXPAND_DEPTH = MAX_SEARCH_EXPAND_DEPTH;
