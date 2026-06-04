import assert from "node:assert/strict";

globalThis.window = {
  devicePixelRatio: 1,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};
globalThis.performance ??= { now: () => Date.now() };
globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(performance.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  disconnect() {}
};

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
    stroke: noop,
    moveTo: noop,
    lineTo: noop,
    quadraticCurveTo: noop,
    fillText: noop,
    closePath: noop,
    rect: noop,
    fillRect: noop,
    strokeRect: noop,
    measureText: (text = "") => ({ width: String(text).length * 6 }),
    createRadialGradient: () => ({ addColorStop: noop }),
    set fillStyle(_value) {},
    set strokeStyle(_value) {},
    set lineWidth(_value) {},
    set font(_value) {},
    set textAlign(_value) {},
    set textBaseline(_value) {},
    set globalAlpha(_value) {},
    set lineCap(_value) {},
    set lineJoin(_value) {},
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

console.log("graph-renderer guardrail tests passed");
