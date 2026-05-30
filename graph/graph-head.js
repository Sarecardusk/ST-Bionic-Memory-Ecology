// ST-BME v3 GraphHead model.
//
// Pure helpers only. Phase 3 introduces the v3 data shape without switching
// storage routes. A GraphHead owns graph identity/revision/counts; replicas and
// commit markers are pointers to that head instead of competing authorities.

import { isAcceptedLegacyPersistenceTier } from "../sync/legacy-persistence-repair.js";
import { normalizeIdentityValue } from "../runtime/identity-resolver.js";
import { getGraphStats } from "./graph.js";

export const GRAPH_HEAD_FORMAT_VERSION = 3;
export const GRAPH_REPLICA_POINTER_FORMAT_VERSION = 3;
export const GRAPH_COMMIT_MARKER_V3_FORMAT_VERSION = 3;

function normalizeNonNegativeInteger(value = 0) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.floor(numeric);
}

function normalizeFloor(value = -1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return -1;
  return Math.floor(numeric);
}

function normalizeUpdatedAt(value = "") {
  return String(value || new Date().toISOString());
}

function normalizeCounts(value = {}) {
  return {
    nodeCount: normalizeNonNegativeInteger(value.nodeCount ?? value.nodes),
    edgeCount: normalizeNonNegativeInteger(value.edgeCount ?? value.edges),
    archivedCount: normalizeNonNegativeInteger(value.archivedCount ?? value.archivedNodes),
    tombstoneCount: normalizeNonNegativeInteger(value.tombstoneCount ?? value.tombstones),
  };
}

function firstIdentity(...values) {
  for (const value of values) {
    const normalized = normalizeIdentityValue(value);
    if (normalized) return normalized;
  }
  return "";
}

export function normalizeGraphHead(input = null, fallback = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const fallbackSource =
    fallback && typeof fallback === "object" && !Array.isArray(fallback) ? fallback : {};
  const counts = normalizeCounts({
    ...(fallbackSource.counts || fallbackSource),
    ...(source.counts || source),
  });
  const integrity = firstIdentity(source.integrity, fallbackSource.integrity);
  const chatId = firstIdentity(source.chatId, fallbackSource.chatId);
  const graphId = firstIdentity(source.graphId, fallbackSource.graphId, integrity, chatId);

  return {
    formatVersion: GRAPH_HEAD_FORMAT_VERSION,
    graphId,
    chatId,
    hostChatId: firstIdentity(source.hostChatId, fallbackSource.hostChatId),
    integrity,
    revision: normalizeNonNegativeInteger(source.revision ?? fallbackSource.revision),
    schemaVersion: normalizeNonNegativeInteger(
      source.schemaVersion ?? fallbackSource.schemaVersion,
    ),
    lastProcessedAssistantFloor: normalizeFloor(
      source.lastProcessedAssistantFloor ?? fallbackSource.lastProcessedAssistantFloor,
    ),
    extractionCount: normalizeNonNegativeInteger(
      source.extractionCount ?? fallbackSource.extractionCount,
    ),
    counts,
    updatedAt: normalizeUpdatedAt(source.updatedAt || fallbackSource.updatedAt),
    reason: String(source.reason || fallbackSource.reason || ""),
  };
}

export function buildGraphHeadFromGraph(
  graph = null,
  {
    graphId = "",
    chatId = "",
    hostChatId = "",
    integrity = "",
    revision = 0,
    reason = "",
    updatedAt = "",
  } = {},
) {
  const stats = graph ? getGraphStats(graph) : null;
  const historyState = graph?.historyState || {};
  return normalizeGraphHead({
    graphId,
    chatId: firstIdentity(chatId, historyState.chatId),
    hostChatId,
    integrity,
    revision,
    schemaVersion: graph?.version,
    lastProcessedAssistantFloor: Number.isFinite(Number(historyState.lastProcessedAssistantFloor))
      ? Number(historyState.lastProcessedAssistantFloor)
      : Number.isFinite(Number(stats?.lastProcessedSeq))
        ? Number(stats.lastProcessedSeq)
        : -1,
    extractionCount: historyState.extractionCount,
    counts: {
      nodeCount: stats?.activeNodes,
      edgeCount: stats?.totalEdges,
      archivedCount: stats?.archivedNodes,
      tombstoneCount: stats?.tombstones,
    },
    updatedAt,
    reason,
  });
}

export function normalizeReplicaPointer(input = null, fallback = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const fallbackSource =
    fallback && typeof fallback === "object" && !Array.isArray(fallback) ? fallback : {};
  const storageTier = String(source.storageTier || fallbackSource.storageTier || "none")
    .trim()
    .toLowerCase() || "none";
  const revision = normalizeNonNegativeInteger(source.revision ?? fallbackSource.revision);
  const graphId = firstIdentity(source.graphId, fallbackSource.graphId);
  const chatId = firstIdentity(source.chatId, fallbackSource.chatId);
  const integrity = firstIdentity(source.integrity, fallbackSource.integrity);
  const accepted =
    source.accepted === true &&
    revision > 0 &&
    Boolean(graphId) &&
    isAcceptedLegacyPersistenceTier(storageTier);

  return {
    formatVersion: GRAPH_REPLICA_POINTER_FORMAT_VERSION,
    graphId,
    revision,
    storageTier,
    accepted,
    chatId,
    integrity,
    persistedAt: String(source.persistedAt || source.updatedAt || fallbackSource.persistedAt || ""),
    source: String(source.source || fallbackSource.source || ""),
    reason: String(source.reason || fallbackSource.reason || ""),
  };
}

export function isReplicaAccepted(pointer = null) {
  return normalizeReplicaPointer(pointer).accepted === true;
}

export function buildCommitMarkerV3({ head = null, replica = null, reason = "", persistedAt = "" } = {}) {
  const normalizedHead = normalizeGraphHead(head);
  const normalizedReplica = normalizeReplicaPointer(replica, {
    graphId: normalizedHead.graphId,
    revision: normalizedHead.revision,
    chatId: normalizedHead.chatId,
    integrity: normalizedHead.integrity,
    reason,
    persistedAt,
  });
  const replicaMatchesHead =
    normalizedReplica.accepted === true &&
    normalizedReplica.graphId === normalizedHead.graphId &&
    normalizedReplica.revision === normalizedHead.revision;
  return {
    formatVersion: GRAPH_COMMIT_MARKER_V3_FORMAT_VERSION,
    graphId: normalizedHead.graphId,
    revision: normalizedHead.revision,
    accepted: replicaMatchesHead,
    storageTier: normalizedReplica.storageTier,
    chatId: normalizedHead.chatId || normalizedReplica.chatId,
    hostChatId: normalizedHead.hostChatId,
    integrity: normalizedHead.integrity || normalizedReplica.integrity,
    nodeCount: normalizedHead.counts.nodeCount,
    edgeCount: normalizedHead.counts.edgeCount,
    archivedCount: normalizedHead.counts.archivedCount,
    tombstoneCount: normalizedHead.counts.tombstoneCount,
    lastProcessedAssistantFloor: normalizedHead.lastProcessedAssistantFloor,
    extractionCount: normalizedHead.extractionCount,
    persistedAt: normalizedReplica.persistedAt || persistedAt || normalizedHead.updatedAt,
    reason: String(reason || normalizedReplica.reason || normalizedHead.reason || ""),
  };
}

export function normalizeCommitMarkerV3(marker = null) {
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return null;
  const head = normalizeGraphHead({
    graphId: marker.graphId,
    chatId: marker.chatId,
    hostChatId: marker.hostChatId,
    integrity: marker.integrity,
    revision: marker.revision,
    lastProcessedAssistantFloor: marker.lastProcessedAssistantFloor,
    extractionCount: marker.extractionCount,
    counts: marker,
    updatedAt: marker.persistedAt,
    reason: marker.reason,
  });
  const replica = normalizeReplicaPointer({
    graphId: head.graphId,
    revision: head.revision,
    storageTier: marker.storageTier,
    accepted: marker.accepted,
    chatId: head.chatId,
    integrity: head.integrity,
    persistedAt: marker.persistedAt,
    reason: marker.reason,
  });
  return buildCommitMarkerV3({ head, replica, reason: marker.reason, persistedAt: marker.persistedAt });
}

export function graphHeadFromLegacyPersistenceMeta({ meta = null, graph = null } = {}) {
  const legacyMeta = meta && typeof meta === "object" && !Array.isArray(meta) ? meta : {};
  return buildGraphHeadFromGraph(graph, {
    graphId: legacyMeta.graphId,
    chatId: legacyMeta.chatId,
    integrity: legacyMeta.integrity,
    revision: legacyMeta.revision,
    reason: legacyMeta.reason,
    updatedAt: legacyMeta.updatedAt,
  });
}

export function graphHeadFromLegacyCommitMarker(marker = null) {
  return normalizeGraphHead({
    graphId: marker?.graphId,
    chatId: marker?.chatId,
    integrity: marker?.integrity,
    revision: marker?.revision,
    lastProcessedAssistantFloor: marker?.lastProcessedAssistantFloor,
    extractionCount: marker?.extractionCount,
    counts: marker,
    updatedAt: marker?.persistedAt,
    reason: marker?.reason,
  });
}

// Test/importer/diagnostic bridge only. Do not use this in v3 runtime hot paths;
// v3 storage routes should write v3 GraphHead/ReplicaPointer directly.
export function commitMarkerV3ToLegacyMarker(marker = null) {
  const normalized = normalizeCommitMarkerV3(marker);
  if (!normalized) return null;
  return {
    revision: normalized.revision,
    lastProcessedAssistantFloor: normalized.lastProcessedAssistantFloor,
    extractionCount: normalized.extractionCount,
    nodeCount: normalized.nodeCount,
    edgeCount: normalized.edgeCount,
    archivedCount: normalized.archivedCount,
    persistedAt: normalized.persistedAt,
    storageTier: normalized.storageTier,
    accepted: normalized.accepted,
    reason: normalized.reason,
    chatId: normalized.chatId,
    integrity: normalized.integrity,
  };
}
