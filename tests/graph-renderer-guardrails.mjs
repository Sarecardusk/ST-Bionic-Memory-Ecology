import assert from "node:assert/strict";

globalThis.window = {
  devicePixelRatio: 1,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};
let mockNow = 1000;
globalThis.performance = { now: () => mockNow };
let rafId = 0;
const rafCallbacks = new Map();
let timerId = 0;
const timerCallbacks = new Map();
globalThis.requestAnimationFrame = (callback) => {
  const id = ++rafId;
  rafCallbacks.set(id, callback);
  return id;
};
globalThis.cancelAnimationFrame = (id) => {
  rafCallbacks.delete(id);
};
globalThis.setTimeout = (callback, delay = 0) => {
  const id = ++timerId;
  timerCallbacks.set(id, { callback, dueAt: mockNow + Math.max(0, Number(delay) || 0) });
  return id;
};
globalThis.clearTimeout = (id) => {
  timerCallbacks.delete(id);
};
globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  disconnect() {}
};

const canvasMockStats = {
  radialGradientCalls: 0,
  linearGradientCalls: 0,
  strokeCalls: 0,
};

function flushNextRaf(ms = 16) {
  const [id, callback] = rafCallbacks.entries().next().value || [];
  if (!id) return false;
  rafCallbacks.delete(id);
  mockNow += ms;
  callback(mockNow);
  return true;
}

function advanceMockTime(ms = 0) {
  mockNow += ms;
  let ran = false;
  for (const [id, timer] of [...timerCallbacks.entries()].sort((a, b) => a[1].dueAt - b[1].dueAt)) {
    if (timer.dueAt <= mockNow) {
      timerCallbacks.delete(id);
      timer.callback();
      ran = true;
    }
  }
  return ran;
}

function createNoopContext() {
  const noop = () => {};
  return {
    setTransform: noop,
    clearRect: noop,
    save: noop,
    restore: noop,
    translate: noop,
    scale: noop,
    beginPath: noop,
    arc: noop,
    arcTo: noop,
    fill: noop,
    stroke: () => {
      canvasMockStats.strokeCalls += 1;
    },
    moveTo: noop,
    lineTo: noop,
    quadraticCurveTo: noop,
    fillText: noop,
    closePath: noop,
    rect: noop,
    fillRect: noop,
    strokeRect: noop,
    measureText: (text = "") => ({ width: String(text).length * 6 }),
    createRadialGradient: () => {
      canvasMockStats.radialGradientCalls += 1;
      return { addColorStop: noop };
    },
    createLinearGradient: () => {
      canvasMockStats.linearGradientCalls += 1;
      return { addColorStop: noop };
    },
    set fillStyle(_value) {},
    set strokeStyle(_value) {},
    set lineWidth(_value) {},
    set font(_value) {},
    set textAlign(_value) {},
    set textBaseline(_value) {},
    set globalAlpha(_value) {},
    set lineCap(_value) {},
    set lineJoin(_value) {},
    set shadowColor(_value) {},
    set shadowBlur(_value) {},
  };
}

function createCanvas() {
  return {
    parentElement: { clientWidth: 640, clientHeight: 360 },
    width: 0,
    height: 0,
    style: {},
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 360 }),
    getContext: (type) => (type === "2d" ? createNoopContext() : null),
  };
}

function createGraphFixture() {
  return {
    nodes: [
      { id: "objective-1", type: "event", name: "Objective", importance: 6, scope: { layer: "objective" } },
      { id: "user-1", type: "concept", name: "User POV", importance: 5, scope: { layer: "pov", ownerType: "user", ownerName: "Host" } },
      { id: "char-1", type: "character", name: "Character POV", importance: 7, scope: { layer: "pov", ownerType: "character", ownerName: "Alice" } },
      { id: "archived-1", type: "event", name: "Archived", archived: true, scope: { layer: "objective" } },
    ],
    edges: [
      { fromId: "objective-1", toId: "user-1", relation: "related", strength: 0.7 },
      { fromId: "user-1", toId: "char-1", relation: "related", strength: 0.6 },
      { fromId: "objective-1", toId: "missing-node", relation: "invalid-target" },
      { fromId: "objective-1", toId: "char-1", relation: "invalidated", invalidAt: "2026-01-01T00:00:00.000Z" },
      { fromId: "char-1", toId: "user-1", relation: "expired", expiredAt: "2026-01-02T00:00:00.000Z" },
      { fromId: "archived-1", toId: "objective-1", relation: "archived-edge" },
    ],
  };
}

function assertInputUnchanged(graph, beforeJson) {
  assert.equal(JSON.stringify(graph), beforeJson);
  for (const node of graph.nodes) {
    for (const key of ["x", "y", "regionKey", "diagnostics", "highlight"]) {
      assert.equal(Object.prototype.hasOwnProperty.call(node, key), false, `${node.id} gained ${key}`);
    }
  }
}

function resetCanvasStats() {
  canvasMockStats.radialGradientCalls = 0;
  canvasMockStats.linearGradientCalls = 0;
  canvasMockStats.strokeCalls = 0;
}

const { GraphRenderer } = await import("../ui/graph-renderer.js");

{
  const graph = createGraphFixture();
  const before = JSON.stringify(graph);
  const renderer = new GraphRenderer(createCanvas(), {
    runtimeConfig: { graphUseNativeLayout: false, graphNativeForceDisable: true },
    layoutConfig: { neuralIterations: 8 },
  });

  renderer.loadGraph(graph, { userPovAliases: ["Host"] });
  assertInputUnchanged(graph, before);
  renderer.destroy();
}

{
  const graph = createGraphFixture();
  const renderer = new GraphRenderer(createCanvas(), {
    runtimeConfig: { graphUseNativeLayout: false, graphNativeForceDisable: true },
    layoutConfig: { neuralIterations: 8 },
  });

  renderer.loadGraph(graph, { userPovAliases: ["Host"] });
  const diagnostics = renderer.getLastLayoutDiagnostics();
  assert.ok(diagnostics);
  assert.equal(diagnostics.rawNodeCount, 4);
  assert.equal(diagnostics.archivedNodeCount, 1);
  assert.equal(diagnostics.activeNodeCount, 3);
  assert.equal(diagnostics.visibleNodeCount, 3);
  assert.equal(diagnostics.nodeCount, 3);
  assert.equal(diagnostics.rawEdgeCount, 6);
  assert.equal(diagnostics.skippedEdgeCount, 4);
  assert.equal(diagnostics.activeEdgeCount, 2);
  assert.equal(diagnostics.visibleEdgeCount, 2);
  assert.equal(diagnostics.edgeCount, 2);
  assert.equal(diagnostics.objectiveNodeCount, 1);
  assert.equal(diagnostics.userPovNodeCount, 1);
  assert.equal(diagnostics.characterPovNodeCount, 1);
  assert.equal(diagnostics.characterPovPanelCount, 1);
  assert.equal(diagnostics.sampled, false);
  assert.equal(diagnostics.capped, false);
  assert.equal(diagnostics.renderOnly, true);
  assert.equal(Number.isFinite(diagnostics.totalMs), true);
  assert.ok(["js-main", "skipped"].includes(diagnostics.mode));
  renderer.destroy();
}

{
  const graph = createGraphFixture();
  const before = JSON.stringify(graph);
  const renderer = new GraphRenderer(createCanvas(), {
    runtimeConfig: { graphUseNativeLayout: false, graphNativeForceDisable: true },
    layoutConfig: { neuralIterations: 8 },
  });

  renderer.setEnabled(false);
  assert.doesNotThrow(() => renderer.loadGraph(graph));
  assertInputUnchanged(graph, before);
  const diagnostics = renderer.getLastLayoutDiagnostics();
  assert.ok(diagnostics);
  assert.equal(diagnostics.enabled, false);
  assert.equal(diagnostics.renderOnly, true);
  assert.equal(diagnostics.reason, "disabled");
  assert.equal(diagnostics.mode, "skipped");
  assert.equal(diagnostics.rawNodeCount, 4);
  assert.equal(diagnostics.rawEdgeCount, 6);
  assert.equal(diagnostics.activeNodeCount, 3);
  assert.equal(diagnostics.activeEdgeCount, 2);
  assert.equal(diagnostics.archivedNodeCount, 1);
  assert.equal(diagnostics.skippedEdgeCount, 4);
  renderer.destroy();
}

{
  const graph = createGraphFixture();
  const before = JSON.stringify(graph);
  const renderer = new GraphRenderer(createCanvas(), {
    runtimeConfig: { graphUseNativeLayout: false, graphNativeForceDisable: true },
    layoutConfig: {
      minNodeRadius: 4,
      maxNodeRadius: 14,
      neuralIterations: 8,
    },
  });

  const radius = renderer._nodeRadius({ type: "character", importance: 10 });
  assert.equal(radius, 14);
  renderer.loadGraph(graph, { userPovAliases: ["Host"] });
  renderer.highlightNode("char-1");
  assertInputUnchanged(graph, before);
  assert.ok(canvasMockStats.radialGradientCalls > 0);
  assert.ok(canvasMockStats.linearGradientCalls > 0);
  renderer.destroy();
}

{
  const graph = createGraphFixture();
  const before = JSON.stringify(graph);
  const renderer = new GraphRenderer(createCanvas(), {
    theme: "paperDawn",
    runtimeConfig: { graphUseNativeLayout: false, graphNativeForceDisable: true },
    layoutConfig: { neuralIterations: 8 },
  });

  assert.doesNotThrow(() => renderer.loadGraph(graph, { userPovAliases: ["Host"] }));
  renderer.highlightNode("objective-1");
  assertInputUnchanged(graph, before);
  renderer.destroy();
}

{
  resetCanvasStats();
  const graph = createGraphFixture();
  const before = JSON.stringify(graph);
  const renderer = new GraphRenderer(createCanvas(), {
    runtimeConfig: { graphUseNativeLayout: false, graphNativeForceDisable: true },
    layoutConfig: { neuralIterations: 8 },
  });

  renderer.loadGraph(graph, { userPovAliases: ["Host"] });
  renderer.setTransientHighlights({
    recallNodeIds: ["objective-1", { nodeId: "user-1" }],
    extractedNodeIds: [{ id: "char-1" }, "objective-1"],
    ttlMs: 80,
    reason: "test",
  });
  assertInputUnchanged(graph, before);
  let diagnostics = renderer.getTransientHighlightDiagnostics();
  assert.equal(diagnostics.count, 3);
  assert.equal(diagnostics.activeCount, 3);
  assert.equal(diagnostics.reducedMotion, false);
  assert.ok(flushNextRaf());
  assert.ok(canvasMockStats.radialGradientCalls > 0);
  assert.ok(canvasMockStats.strokeCalls > 0);
  diagnostics = renderer.getTransientHighlightDiagnostics();
  assert.equal(diagnostics.count, 3);
  mockNow += 120;
  diagnostics = renderer.getTransientHighlightDiagnostics();
  assert.equal(diagnostics.count, 0);
  assert.equal(diagnostics.animationScheduled, false);
  renderer.destroy();
}

{
  const graph = createGraphFixture();
  const renderer = new GraphRenderer(createCanvas(), {
    runtimeConfig: { graphUseNativeLayout: false, graphNativeForceDisable: true },
    layoutConfig: { neuralIterations: 8 },
  });

  renderer.loadGraph(graph, { userPovAliases: ["Host"] });
  renderer.setTransientHighlights({ recallNodeIds: ["objective-1"], ttlMs: 1000 });
  assert.equal(renderer.getTransientHighlightDiagnostics().count, 1);
  renderer.setEnabled(false);
  const diagnostics = renderer.getTransientHighlightDiagnostics();
  assert.equal(diagnostics.count, 0);
  assert.equal(diagnostics.animationScheduled, false);
  renderer.destroy();
}

{
  const previousMatchMedia = globalThis.window.matchMedia;
  globalThis.window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  const graph = createGraphFixture();
  const before = JSON.stringify(graph);
  const renderer = new GraphRenderer(createCanvas(), {
    runtimeConfig: { graphUseNativeLayout: false, graphNativeForceDisable: true },
    layoutConfig: { neuralIterations: 8 },
  });

  renderer.loadGraph(graph, { userPovAliases: ["Host"] });
  resetCanvasStats();
  renderer.setTransientHighlights({ recallNodeIds: ["objective-1"], ttlMs: 1000 });
  flushNextRaf();
  let diagnostics = renderer.getTransientHighlightDiagnostics();
  assert.equal(diagnostics.reducedMotion, true);
  assert.equal(diagnostics.count, 1);
  assert.equal(diagnostics.animationScheduled, false);
  assert.equal(diagnostics.expiryScheduled, true);
  assert.ok(canvasMockStats.strokeCalls > 0);
  advanceMockTime(1002);
  assert.ok(flushNextRaf());
  diagnostics = renderer.getTransientHighlightDiagnostics();
  assert.equal(diagnostics.count, 0);
  assert.equal(diagnostics.animationScheduled, false);
  assert.equal(diagnostics.expiryScheduled, false);
  assertInputUnchanged(graph, before);
  renderer.destroy();
  globalThis.window.matchMedia = previousMatchMedia;
}

console.log("graph-renderer guardrail tests passed");
