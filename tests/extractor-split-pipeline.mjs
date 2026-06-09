import assert from "node:assert/strict";
import {
  installResolveHooks,
  toDataModuleUrl,
} from "./helpers/register-hooks-compat.mjs";

const extensionsShimSource = [
  "export const extension_settings = {};",
  "export function getContext() {",
  "  return globalThis.__stBmeTestContext || {",
  "    chat: [],",
  "    chatMetadata: {},",
  "    extensionSettings: {},",
  "    powerUserSettings: {},",
  "    characters: {},",
  "    characterId: null,",
  "    name1: '玩家',",
  "    name2: '艾琳',",
  "    chatId: 'test-chat',",
  "  };",
  "}",
].join("\n");

const scriptShimSource = [
  "export function getRequestHeaders() {",
  "  return {};",
  "}",
  "export function substituteParamsExtended(value) {",
  "  return String(value ?? '');",
  "}",
].join("\n");

const openAiShimSource = [
  "export const chat_completion_sources = {};",
  "export async function sendOpenAIRequest() {",
  "  throw new Error('sendOpenAIRequest should not be called in extractor-split-pipeline test');",
  "}",
].join("\n");

installResolveHooks([
  {
    specifiers: [
      "../../../extensions.js",
      "../../../../extensions.js",
      "../../../../../extensions.js",
    ],
    url: toDataModuleUrl(extensionsShimSource),
  },
  {
    specifiers: [
      "../../../../script.js",
      "../../../../../script.js",
    ],
    url: toDataModuleUrl(scriptShimSource),
  },
  {
    specifiers: [
      "../../../../openai.js",
      "../../../../../openai.js",
    ],
    url: toDataModuleUrl(openAiShimSource),
  },
]);

const { createEmptyGraph, createNode, addNode } = await import("../graph/graph.js");
const { DEFAULT_NODE_SCHEMA } = await import("../graph/schema.js");
const { extractMemories } = await import("../maintenance/extractor.js");

function setTestOverrides(overrides = {}) {
  globalThis.__stBmeTestOverrides = overrides;
  return () => {
    delete globalThis.__stBmeTestOverrides;
  };
}

globalThis.__stBmeTestContext = {
  chat: [],
  chatMetadata: {},
  extensionSettings: {},
  powerUserSettings: {},
  characters: {},
  characterId: null,
  name1: "玩家",
  name2: "艾琳",
  chatId: "test-chat",
};

function createGraphWithCharacter() {
  const graph = createEmptyGraph();
  addNode(
    graph,
    createNode({
      type: "character",
      fields: { name: "艾琳" },
      seq: 1,
    }),
  );
  return graph;
}

const baseExtractParams = {
  messages: [
    { seq: 20, role: "user", content: "钟楼里传来第二次钟声。", name: "玩家", speaker: "玩家" },
    { seq: 21, role: "assistant", content: "艾琳记下钟声，怀疑暗道就在附近。", name: "艾琳", speaker: "艾琳" },
  ],
  startSeq: 20,
  endSeq: 21,
  schema: DEFAULT_NODE_SCHEMA,
  embeddingConfig: null,
};

function objectivePayload() {
  return {
    operations: [
      {
        action: "create",
        type: "event",
        ref: "evt-clock",
        fields: {
          title: "钟楼钟声",
          summary: "钟楼传来第二次钟声，暗示暗道线索仍在附近。",
          participants: "玩家,艾琳",
          status: "ongoing",
        },
        scope: { layer: "objective" },
      },
    ],
    cognitionUpdates: [
      {
        ownerType: "character",
        ownerName: "艾琳",
        knownRefs: ["evt-clock"],
      },
    ],
    regionUpdates: {},
  };
}

function subjectivePayload() {
  return {
    operations: [
      {
        action: "create",
        type: "pov_memory",
        fields: {
          summary: "艾琳把第二次钟声记成暗道仍在呼唤她的证据。",
          belief: "暗道就在钟楼附近",
          emotion: "警觉",
          certainty: "unsure",
          about: "evt-clock",
        },
        scope: {
          layer: "pov",
          ownerType: "character",
          ownerName: "艾琳",
          ownerId: "艾琳",
        },
      },
    ],
    cognitionUpdates: [
      {
        ownerType: "character",
        ownerName: "艾琳",
        knownRefs: ["evt-clock"],
      },
    ],
    regionUpdates: {},
  };
}

function activeNodes(graph, type) {
  return graph.nodes.filter((node) => node.type === type && node.archived !== true);
}

function hasActiveEdgeBetween(graph, leftId, rightId) {
  return graph.edges.some((edge) => {
    if (edge.invalidAt || edge.expiredAt) return false;
    return (
      (edge.fromId === leftId && edge.toId === rightId) ||
      (edge.fromId === rightId && edge.toId === leftId)
    );
  });
}

function characterKnowledgeEntries(graph) {
  return Object.values(graph.knowledgeState?.owners || {}).filter(
    (entry) =>
      String(entry?.ownerType || "") === "character" &&
      String(entry?.ownerName || "") === "艾琳",
  );
}

// split-v1 calls objective then subjective, merges both stage outputs, and commits once.
{
  const graph = createGraphWithCharacter();
  const capturedTaskTypes = [];
  const restore = setTestOverrides({
    llm: {
      async callLLMForJSON(payload = {}) {
        capturedTaskTypes.push(payload.taskType);
        if (payload.taskType === "extract_objective") return objectivePayload();
        if (payload.taskType === "extract_subjective") return subjectivePayload();
        return { operations: [], cognitionUpdates: [], regionUpdates: {} };
      },
    },
  });

  try {
    const result = await extractMemories({
      graph,
      ...baseExtractParams,
      settings: { extractPipelineVersion: "split-v1" },
    });

    assert.deepEqual(
      capturedTaskTypes,
      ["extract_objective", "extract_subjective"],
      "split-v1 should call the LLM once for objective extraction, then once for subjective extraction",
    );
    assert.equal(result.success, true);
    assert.equal(result.newNodes, 2, "objective event and subjective POV memory should be committed together");

    const [eventNode] = activeNodes(graph, "event");
    const [povNode] = activeNodes(graph, "pov_memory");
    assert.ok(eventNode, "objective event operation should be committed");
    assert.ok(povNode, "subjective pov_memory operation should be committed");
    assert.equal(povNode.scope?.ownerType, "character");
    assert.equal(povNode.scope?.ownerName, "艾琳");
    assert.equal(graph.lastProcessedSeq, 21);
    assert.ok(
      hasActiveEdgeBetween(graph, eventNode.id, povNode.id),
      "merged split stages should be committed as one batch so default batch edges see both nodes",
    );

    const knowledgeEntry = characterKnowledgeEntries(graph).find((entry) =>
      Array.isArray(entry.knownNodeIds) && entry.knownNodeIds.includes(eventNode.id),
    );
    assert.ok(
      knowledgeEntry,
      "subjective cognitionUpdates should apply through the merged ref map",
    );
  } finally {
    restore();
  }
}

// Invalid subjective output fails the split extraction before any objective-only commit mutates the graph.
{
  const graph = createGraphWithCharacter();
  const initialNodeCount = graph.nodes.length;
  const initialEdgeCount = graph.edges.length;
  const capturedTaskTypes = [];
  const restore = setTestOverrides({
    llm: {
      async callLLMForJSON(payload = {}) {
        capturedTaskTypes.push(payload.taskType);
        if (payload.taskType === "extract_objective") return objectivePayload();
        if (payload.taskType === "extract_subjective") return { thought: "missing operations" };
        return { thought: "legacy path should not be used for split-v1" };
      },
    },
  });

  try {
    const result = await extractMemories({
      graph,
      ...baseExtractParams,
      settings: { extractPipelineVersion: "split-v1" },
    });

    assert.deepEqual(
      capturedTaskTypes,
      ["extract_objective", "extract_subjective"],
      "split-v1 should validate both objective and subjective payloads before commit",
    );
    assert.equal(result.success, false);
    assert.equal(graph.nodes.length, initialNodeCount, "invalid subjective payload should not commit objective nodes");
    assert.equal(graph.edges.length, initialEdgeCount, "invalid subjective payload should not create edges");
    assert.equal(graph.lastProcessedSeq ?? -1, -1, "invalid split extraction should not advance extraction progress");
  } finally {
    restore();
  }
}

// Legacy/default extraction keeps the single extract taskType path.
{
  const graph = createGraphWithCharacter();
  const capturedTaskTypes = [];
  const restore = setTestOverrides({
    llm: {
      async callLLMForJSON(payload = {}) {
        capturedTaskTypes.push(payload.taskType);
        return { operations: [], cognitionUpdates: [], regionUpdates: {} };
      },
    },
  });

  try {
    const result = await extractMemories({
      graph,
      ...baseExtractParams,
      settings: {},
    });

    assert.equal(result.success, true);
    assert.deepEqual(
      capturedTaskTypes,
      ["extract"],
      "default extraction should keep calling only legacy taskType extract",
    );
  } finally {
    restore();
  }
}

console.log("extractor-split-pipeline tests passed");
