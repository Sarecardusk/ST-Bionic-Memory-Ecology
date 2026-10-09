import assert from "node:assert/strict";
import { addNode, createEmptyGraph, createNode } from "../graph/graph.js";
import {
  installResolveHooks,
  toDataModuleUrl,
} from "./helpers/register-hooks-compat.mjs";

installResolveHooks([
  {
    specifiers: ["../../../../../script.js"],
    url: toDataModuleUrl("export function getRequestHeaders() { return {}; }"),
  },
  {
    specifiers: ["../../../../extensions.js"],
    url: toDataModuleUrl("export const extension_settings = { st_bme: {} };"),
  },
]);

globalThis.__stBmeTestOverrides = {
  embedding: {
    async embedText() {
      return [0.1, 0.2, 0.3];
    },
  },
};

const { normalizeAuthorityVectorConfig } = await import(
  "../vector/tauritavern-vector-adapter.js"
);
const { resolveAuthorityRecallCandidates } = await import(
  "../retrieval/authority-candidate-provider.js"
);

function createRecallGraph() {
  const graph = createEmptyGraph();
  graph.historyState.chatId = "chat-tt-candidates";
  graph.vectorIndexState.collectionId = "st-bme:chat-tt-candidates:nodes";
  const node = createNode({
    type: "event",
    seq: 10,
    fields: { title: "Alice enters the archive", summary: "Alice reaches the archive gate" },
    importance: 6,
  });
  node.id = "node-archive";
  const extra = createNode({
    type: "event",
    seq: 11,
    fields: { title: "Market rumor", summary: "A rumor spreads in the market" },
    importance: 2,
  });
  extra.id = "node-market";
  addNode(graph, node);
  addNode(graph, extra);
  return { graph, nodes: [node, extra] };
}

{
  const { graph, nodes } = createRecallGraph();
  const graphStore = {
    async searchSimilar() {
      return [{ id: "node-archive", score: 0.91, payload: { ttRecordId: "node-archive" } }];
    },
  };
  const config = normalizeAuthorityVectorConfig({}, { graphStore });
  const result = await resolveAuthorityRecallCandidates({
    graph,
    userMessage: "Alice in the archive",
    recentMessages: [],
    embeddingConfig: config,
    availableNodes: nodes,
    options: {
      enabled: true,
      topK: 4,
      maxRecallNodes: 1,
      limit: 6,
      minimumUsedCandidateCount: 1,
    },
  });
  assert.equal(result.available, true);
  assert.equal(result.used, true);
  assert.equal(result.candidateNodes[0]?.id, "node-archive");
}

{
  const { graph, nodes } = createRecallGraph();
  const config = normalizeAuthorityVectorConfig({}, { graphStore: null });
  const result = await resolveAuthorityRecallCandidates({
    graph,
    userMessage: "archive",
    recentMessages: [],
    embeddingConfig: { ...config, failOpen: true },
    availableNodes: nodes,
    options: { enabled: true, topK: 4 },
  });
  assert.equal(result.available, true);
  assert.equal(result.used, false);
}

{
  const { graph, nodes } = createRecallGraph();
  const graphStore = {
    async searchSimilar() {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    },
  };
  const config = normalizeAuthorityVectorConfig({ authorityVectorFailOpen: true }, { graphStore });
  await assert.rejects(
    () =>
      resolveAuthorityRecallCandidates({
        graph,
        userMessage: "archive",
        recentMessages: [],
        embeddingConfig: config,
        availableNodes: nodes,
        options: { enabled: true, topK: 4 },
      }),
    (error) => error.name === "AbortError",
  );
}

console.log("authority-recall-candidates tests passed");
