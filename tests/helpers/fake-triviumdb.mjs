const DEFAULT_PAYLOAD_LIMIT = 8 * 1024 * 1024;

function measureJsonBytes(value) {
  let json = "";
  try {
    json = JSON.stringify(value ?? null);
  } catch {
    json = "";
  }
  return new TextEncoder().encode(json).byteLength;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function cosine(left = [], right = []) {
  if (!left.length || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i += 1) {
    const a = Number(left[i]) || 0;
    const b = Number(right[i]) || 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm <= 0 || rightNorm <= 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function payloadTooLarge(sizeBytes, maxBytes) {
  const error = new Error(`Payload too large: ${sizeBytes} bytes, limit ${maxBytes} bytes`);
  error.name = "PayloadTooLarge";
  error.size_bytes = sizeBytes;
  error.max_bytes = maxBytes;
  return error;
}

function matchesFilter(payload, filter) {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) return true;
  for (const [key, expected] of Object.entries(filter)) {
    if (expected && typeof expected === "object" && !Array.isArray(expected) && "$eq" in expected) {
      if (payload?.[key] !== expected.$eq) return false;
      continue;
    }
    if (payload?.[key] !== expected) return false;
  }
  return true;
}

export class FakeTriviumHandle {
  constructor(namespace, options = {}) {
    this.namespace = namespace;
    this.dim = Math.max(1, Math.floor(Number(options.dim) || 1536));
    this.options = Object.freeze({ ...options, dim: this.dim });
    this.nodes = new Map();
    this.nextId = 1;
    this.closed = false;
    this.flushCount = 0;
    this.payloadLimitBytes = Number(options.payloadLimitBytes) || DEFAULT_PAYLOAD_LIMIT;
    this._busy = Boolean(options.busy);
  }

  setBusy(value) {
    this._busy = Boolean(value);
  }

  _assertOpen() {
    if (this.closed) {
      throw new Error(`Database ${this.namespace} is not open`);
    }
    if (this._busy) {
      throw new Error("Database is busy; retry synchronization when the current operation finishes");
    }
  }

  _assertVector(vector) {
    if (!Array.isArray(vector) || vector.length !== this.dim) {
      throw new Error(`Vector dimension mismatch: expected ${this.dim}, got ${Array.isArray(vector) ? vector.length : 0}`);
    }
  }

  _assertPayload(payload) {
    const size = measureJsonBytes(payload ?? null);
    if (size > this.payloadLimitBytes) {
      throw payloadTooLarge(size, this.payloadLimitBytes);
    }
  }

  _nodeView(node) {
    if (!node) return null;
    return {
      id: node.id,
      vector: node.vector.slice(),
      payload: clone(node.payload),
      edges: node.edges.map((edge) => ({ ...edge })),
    };
  }

  async insert(vector, payload = null) {
    this._assertOpen();
    this._assertVector(vector);
    this._assertPayload(payload);
    const id = this.nextId;
    this.nextId += 1;
    this.nodes.set(id, {
      id,
      vector: vector.slice(),
      payload: clone(payload),
      edges: [],
    });
    return id;
  }

  async batchInsert(vectors, payloads) {
    this._assertOpen();
    if (!Array.isArray(vectors) || !Array.isArray(payloads) || vectors.length !== payloads.length) {
      throw new Error("vectors and payloads must have the same length");
    }
    const ids = [];
    for (let i = 0; i < vectors.length; i += 1) {
      ids.push(await this.insert(vectors[i], payloads[i]));
    }
    return ids;
  }

  async upsert(id, vector, payload = null) {
    this._assertOpen();
    this._assertVector(vector);
    this._assertPayload(payload);
    const numericId = Number(id);
    const existing = this.nodes.get(numericId);
    this.nodes.set(numericId, {
      id: numericId,
      vector: vector.slice(),
      payload: clone(payload),
      edges: existing?.edges ? existing.edges.map((edge) => ({ ...edge })) : [],
    });
    this.nextId = Math.max(this.nextId, numericId + 1);
    return numericId;
  }

  async get(id) {
    this._assertOpen();
    return this._nodeView(this.nodes.get(Number(id)) || null);
  }

  async updatePayload(id, payload) {
    this._assertOpen();
    this._assertPayload(payload);
    const node = this.nodes.get(Number(id));
    if (!node) throw new Error(`Node not found: ${id}`);
    node.payload = clone(payload);
  }

  async patchPayload(id, patch) {
    this._assertOpen();
    const node = this.nodes.get(Number(id));
    if (!node) throw new Error(`Node not found: ${id}`);
    node.payload = { ...(node.payload && typeof node.payload === "object" ? node.payload : {}), ...patch };
    this._assertPayload(node.payload);
  }

  async updateVector(id, vector) {
    this._assertOpen();
    this._assertVector(vector);
    const node = this.nodes.get(Number(id));
    if (!node) throw new Error(`Node not found: ${id}`);
    node.vector = vector.slice();
  }

  async delete(id) {
    this._assertOpen();
    const numericId = Number(id);
    this.nodes.delete(numericId);
    for (const node of this.nodes.values()) {
      node.edges = node.edges.filter((edge) => edge.targetId !== numericId);
    }
  }

  async link(src, dst, label = "related", weight = 1) {
    this._assertOpen();
    const source = this.nodes.get(Number(src));
    if (!source) throw new Error(`Node not found: ${src}`);
    const targetId = Number(dst);
    const existing = source.edges.find((edge) => edge.targetId === targetId && edge.label === label);
    if (existing) {
      existing.weight = Number(weight) || 1;
      return;
    }
    source.edges.push({ targetId, label: String(label || "related"), weight: Number(weight) || 1, metadata: null });
  }

  async unlink(src, dst) {
    this._assertOpen();
    const source = this.nodes.get(Number(src));
    if (!source) return;
    const targetId = Number(dst);
    source.edges = source.edges.filter((edge) => edge.targetId !== targetId);
  }

  async shortestPath() {
    this._assertOpen();
    return null;
  }

  async subgraph() {
    this._assertOpen();
    return { nodes: [], edges: [] };
  }

  async indexText() {
    this._assertOpen();
  }

  async indexKeyword() {
    this._assertOpen();
  }

  async buildTextIndex() {
    this._assertOpen();
  }

  async search(vector = null, options = {}) {
    this._assertOpen();
    const filter = options.payloadFilter || options.filter || null;
    const topK = Math.max(1, Math.floor(Number(options.topK) || 5));
    const hits = [];
    for (const node of this.nodes.values()) {
      if (!matchesFilter(node.payload, filter)) continue;
      const score = vector ? cosine(vector, node.vector) : 0;
      hits.push({ id: node.id, score, payload: clone(node.payload) });
    }
    hits.sort((left, right) => right.score - left.score);
    return hits.slice(0, topK);
  }

  async searchBatch(vectors, options = {}) {
    const results = [];
    for (const vector of vectors || []) {
      results.push(await this.search(vector, options));
    }
    return results;
  }

  async searchAdvanced(vector = null, options = {}) {
    const hits = await this.search(vector, options);
    return { hits, context: { timingsMs: {}, stageCounts: {}, observations: {} } };
  }

  async query(text, params = {}) {
    this._assertOpen();
    const source = String(text || "");
    const nested = source.match(/\b([A-Za-z_][A-Za-z0-9_]*)\.[A-Za-z_][A-Za-z0-9_]*\./);
    if (nested) {
      throw new Error(
        `查询解析错误 (Query parse error): Unexpected token after identifier '${nested[1]}': Dot`,
      );
    }
    const limitMatch = source.match(/LIMIT\s+\$(\w+)/i);
    const offsetMatch = source.match(/OFFSET\s+\$(\w+)/i);
    const limit = limitMatch ? Math.max(0, Number(params[limitMatch[1]]) || 0) : this.nodes.size;
    const offset = offsetMatch ? Math.max(0, Number(params[offsetMatch[1]]) || 0) : 0;
    const kindParam = params.kind;
    const nodes = [...this.nodes.values()]
      .filter((node) => !kindParam || node.payload?.ttRecordKind === kindParam || node.payload?.kind === kindParam)
      .sort((left, right) => left.id - right.id)
      .slice(offset, offset + (limit || this.nodes.size));
    return {
      type: "query",
      rows: nodes.map((node) => ({
        n: { type: "node", value: this._nodeView(node) },
      })),
    };
  }

  async buildQuiverIndex() {
    this._assertOpen();
  }

  async compact() {
    this._assertOpen();
  }

  async flush() {
    this._assertOpen();
    this.flushCount += 1;
  }

  async close() {
    this.closed = true;
  }

  async stats() {
    this._assertOpen();
    let edgeCount = 0;
    for (const node of this.nodes.values()) edgeCount += node.edges.length;
    return {
      namespace: this.namespace,
      dim: this.dim,
      nodeCount: this.nodes.size,
      estimatedMemoryBytes: 0,
      graph: { node_count: this.nodes.size, edge_count: edgeCount },
    };
  }
}

export function createFakeTauriTavernDbApi(options = {}) {
  const handles = new Map();
  return {
    handles,
    async open(namespace, openOptions = {}) {
      const existing = handles.get(namespace);
      if (existing) {
        if (openOptions.dim && openOptions.dim !== existing.dim) {
          throw new Error(`Database ${namespace} has dimension ${existing.dim}, requested ${openOptions.dim}`);
        }
        existing.closed = false;
        existing.setBusy(false);
        return existing;
      }
      const handle = new FakeTriviumHandle(namespace, { ...options, ...openOptions });
      handles.set(namespace, handle);
      return handle;
    },
    async listNamespaces() {
      return [...handles.entries()].filter(([, handle]) => !handle.closed).map(([name]) => name);
    },
  };
}

export function installFakeTauriTavernHost(options = {}) {
  const db = options.dbApi || createFakeTauriTavernDbApi(options);
  const host = {
    ready: Promise.resolve(),
    api: {
      db,
      chat: options.chatApi || {
        current: {
          handle() {
            return {
              metadata: {
                async getExtension() {
                  return options.extensionMetadata || null;
                },
                async setExtension() {
                  return true;
                },
              },
            };
          },
        },
      },
    },
  };
  globalThis.__TAURITAVERN__ = host;
  globalThis.__TAURITAVERN_MAIN_READY__ = host.ready;
  return host;
}
