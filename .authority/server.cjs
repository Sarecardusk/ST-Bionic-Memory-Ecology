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

  if (logger.info) {
    logger.info('[st-bme] Companion authority module activated: third-party.st-bme');
  }
};

module.exports.DEFAULT_BME_DATABASE = DEFAULT_BME_DATABASE;
module.exports.DEFAULT_NAMESPACE = DEFAULT_NAMESPACE;
module.exports._validateVectorBatch = validateVectorBatch;
module.exports._buildUpsertItems = buildUpsertItems;
module.exports._buildLinkItems = buildLinkItems;
module.exports._buildManifestFromStat = buildManifestFromStat;
module.exports._resolveDatabase = resolveDatabase;
module.exports._resolveNamespace = resolveNamespace;
module.exports._validateRecallCandidatesInput = validateRecallCandidatesInput;
module.exports._sanitizeSearchHit = sanitizeSearchHit;
module.exports._sanitizeNeighborNode = sanitizeNeighborNode;
module.exports.MAX_SEARCH_TOP_K = MAX_SEARCH_TOP_K;
module.exports.MAX_SEARCH_EXPAND_DEPTH = MAX_SEARCH_EXPAND_DEPTH;
