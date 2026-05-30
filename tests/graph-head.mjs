// ST-BME restrained rebirth — Phase 3 GraphHead model tests.

import assert from "node:assert/strict";
import { createEmptyGraph } from "../graph/graph.js";
import {
  GRAPH_COMMIT_MARKER_V3_FORMAT_VERSION,
  GRAPH_HEAD_FORMAT_VERSION,
  buildCommitMarkerV3,
  buildGraphHeadFromGraph,
  commitMarkerV3ToLegacyMarker,
  graphHeadFromLegacyCommitMarker,
  graphHeadFromLegacyPersistenceMeta,
  isReplicaAccepted,
  normalizeCommitMarkerV3,
  normalizeGraphHead,
  normalizeReplicaPointer,
} from "../graph/graph-head.js";

const graph = createEmptyGraph();
graph.version = 9;
graph.historyState.chatId = "chat-a";
graph.historyState.lastProcessedAssistantFloor = 8.9;
graph.historyState.extractionCount = 3.2;
graph.lastProcessedSeq = 7;
graph.nodes.push(
  { id: "n1", type: "event", archived: false },
  { id: "n2", type: "event", archived: true },
);
graph.edges.push({ id: "e1", from: "n1", to: "n2" });

const head = buildGraphHeadFromGraph(graph, {
  graphId: "graph-a",
  chatId: "chat-a",
  hostChatId: "host-chat-a",
  integrity: "integrity-a",
  revision: 12.7,
  reason: "unit-test",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

assert.equal(head.formatVersion, GRAPH_HEAD_FORMAT_VERSION);
assert.equal(head.graphId, "graph-a");
assert.equal(head.chatId, "chat-a");
assert.equal(head.hostChatId, "host-chat-a");
assert.equal(head.integrity, "integrity-a");
assert.equal(head.revision, 12);
assert.equal(head.schemaVersion, 9);
assert.equal(head.lastProcessedAssistantFloor, 8);
assert.equal(head.extractionCount, 3);
assert.deepEqual(head.counts, {
  nodeCount: 1,
  edgeCount: 1,
  archivedCount: 1,
  tombstoneCount: 0,
});

console.log("  ✓ GraphHead owns normalized graph identity, revision, and counts");

const acceptedPointer = normalizeReplicaPointer({
  graphId: head.graphId,
  revision: head.revision,
  storageTier: "authority-sql",
  accepted: true,
  chatId: head.chatId,
  integrity: head.integrity,
  persistedAt: "2026-01-01T00:00:01.000Z",
});
assert.equal(isReplicaAccepted(acceptedPointer), true);

const unsafePointer = normalizeReplicaPointer({
  graphId: head.graphId,
  revision: head.revision,
  storageTier: "metadata-full",
  accepted: true,
});
assert.equal(unsafePointer.accepted, false);
assert.equal(isReplicaAccepted(unsafePointer), false);

const missingGraphIdPointer = normalizeReplicaPointer({
  revision: head.revision,
  storageTier: "authority-sql",
  accepted: true,
});
assert.equal(
  missingGraphIdPointer.accepted,
  false,
  "accepted replica pointers must carry graphId evidence",
);

console.log("  ✓ ReplicaPointer accepts only canonical storage tiers");

const marker = buildCommitMarkerV3({
  head,
  replica: acceptedPointer,
  reason: "accepted-save",
});
assert.equal(marker.formatVersion, GRAPH_COMMIT_MARKER_V3_FORMAT_VERSION);
assert.equal(marker.graphId, "graph-a");
assert.equal(marker.revision, 12);
assert.equal(marker.accepted, true);
assert.equal(marker.storageTier, "authority-sql");
assert.equal(marker.nodeCount, 1);
assert.equal(marker.edgeCount, 1);
assert.equal(marker.archivedCount, 1);
assert.equal(marker.lastProcessedAssistantFloor, 8);
assert.equal(marker.extractionCount, 3);

assert.deepEqual(normalizeCommitMarkerV3(marker), marker);

const mismatchedReplicaMarker = buildCommitMarkerV3({
  head,
  replica: {
    ...acceptedPointer,
    revision: head.revision - 1,
  },
});
assert.equal(
  mismatchedReplicaMarker.accepted,
  false,
  "v3 marker must not accept head revision from a mismatched replica pointer",
);

console.log("  ✓ v3 commit marker is a small accepted replica pointer plus head diagnostics");

const legacyMarker = commitMarkerV3ToLegacyMarker(marker);
assert.deepEqual(legacyMarker, {
  revision: 12,
  lastProcessedAssistantFloor: 8,
  extractionCount: 3,
  nodeCount: 1,
  edgeCount: 1,
  archivedCount: 1,
  persistedAt: acceptedPointer.persistedAt,
  storageTier: "authority-sql",
  accepted: true,
  reason: "accepted-save",
  chatId: "chat-a",
  integrity: "integrity-a",
});

const headFromLegacyMarker = graphHeadFromLegacyCommitMarker(legacyMarker);
assert.equal(headFromLegacyMarker.revision, 12);
assert.equal(headFromLegacyMarker.counts.nodeCount, 1);
assert.equal(headFromLegacyMarker.counts.edgeCount, 1);
assert.equal(headFromLegacyMarker.graphId, "integrity-a");

const headFromLegacyMeta = graphHeadFromLegacyPersistenceMeta({
  graph,
  meta: {
    revision: 9,
    chatId: "meta-chat",
    integrity: "meta-integrity",
    updatedAt: "2026-01-02T00:00:00.000Z",
    reason: "legacy-meta",
  },
});
assert.equal(headFromLegacyMeta.revision, 9);
assert.equal(headFromLegacyMeta.chatId, "meta-chat");
assert.equal(headFromLegacyMeta.graphId, "meta-integrity");
assert.equal(headFromLegacyMeta.counts.archivedCount, 1);

console.log("  ✓ legacy marker/meta can be converted without becoming runtime compatibility paths");

const normalizedHead = normalizeGraphHead({
  revision: -5,
  lastProcessedAssistantFloor: "bad",
  counts: { nodeCount: -1, edgeCount: 2.9 },
});
assert.equal(normalizedHead.revision, 0);
assert.equal(normalizedHead.lastProcessedAssistantFloor, -1);
assert.equal(normalizedHead.counts.nodeCount, 0);
assert.equal(normalizedHead.counts.edgeCount, 2);
assert.equal(
  head.counts.tombstoneCount,
  0,
  "tombstoneCount is reserved until a canonical tombstone collection is introduced",
);

console.log("  ✓ GraphHead normalization is safe for malformed inputs");
console.log("graph-head tests passed");
