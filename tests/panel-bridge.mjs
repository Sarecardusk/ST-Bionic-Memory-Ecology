import assert from "node:assert/strict";

let timerId = 0;
const timers = new Map();
globalThis.setTimeout = (callback, delay = 0) => {
  const id = ++timerId;
  timers.set(id, { callback, delay });
  return id;
};

function runNextTimer() {
  const [id, timer] = timers.entries().next().value || [];
  if (!id) return false;
  timers.delete(id);
  timer.callback();
  return true;
}

class FakeElement {
  constructor(tagName, document) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = document;
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.dataset = {};
    this.listeners = new Map();
    this.className = "";
    this.innerHTML = "";
    this.textContent = "";
    this._id = "";
  }

  set id(value) {
    if (this._id) this.ownerDocument.unregisterId(this._id, this);
    this._id = String(value || "");
    if (this._id) this.ownerDocument.registerId(this._id, this);
  }

  get id() {
    return this._id;
  }

  setAttribute(name, value) {
    if (name === "id") this.id = value;
    else if (name === "class") this.className = String(value || "");
    else this[name] = String(value || "");
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    if (child.id) this.ownerDocument.registerId(child.id, child);
    return child;
  }

  insertBefore(child, reference) {
    child.parentNode = this;
    const index = this.children.indexOf(reference);
    if (index >= 0) this.children.splice(index, 0, child);
    else this.children.push(child);
    if (child.id) this.ownerDocument.registerId(child.id, child);
    return child;
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  async click() {
    for (const listener of this.listeners.get("click") || []) {
      await listener({ target: this });
    }
  }
}

class FakeDocument {
  constructor() {
    this.byId = new Map();
    this.documentElement = new FakeElement("html", this);
    this.body = new FakeElement("body", this);
    this.documentElement.appendChild(this.body);
  }

  registerId(id, element) {
    this.byId.set(id, element);
  }

  unregisterId(id, element) {
    if (this.byId.get(id) === element) this.byId.delete(id);
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  getElementById(id) {
    return this.byId.get(id) || null;
  }

  querySelector(selector) {
    if (selector === "#options .options-content") {
      const options = this.getElementById("options");
      return options?.children.find((child) => String(child.className || "").split(/\s+/).includes("options-content")) || null;
    }
    return null;
  }
}

function appendElement(document, parent, tagName, { id, className, style } = {}) {
  const element = document.createElement(tagName);
  if (id) element.id = id;
  if (className) element.className = className;
  if (style) Object.assign(element.style, style);
  parent.appendChild(element);
  return element;
}

function buildDocument({ includeExtensionsMenu = true } = {}) {
  const document = new FakeDocument();
  const overlay = appendElement(document, document.body, "div", { id: "st-bme-panel-overlay" });
  appendElement(document, overlay, "div", { id: "st-bme-panel" });
  const options = appendElement(document, document.body, "div", { id: "options" });
  const optionsContent = appendElement(document, options, "div", { className: "options-content" });
  appendElement(document, optionsContent, "a", { id: "option_toggle_logprobs" });
  if (includeExtensionsMenu) {
    appendElement(document, document.body, "div", { id: "extensionsMenuButton", style: { display: "none" } });
    appendElement(document, document.body, "div", { id: "extensionsMenu", className: "options-content" });
  }
  return document;
}

function buildRuntime(document) {
  const calls = { opened: 0, hidden: [], css: [] };
  const panelModule = { openPanel: () => { calls.opened += 1; } };
  return {
    calls,
    console,
    document,
    getPanelModule: () => panelModule,
    getSettings: () => ({}),
    $: (selector) => ({
      hide: () => calls.hidden.push(selector),
      css: (name, value) => calls.css.push([selector, name, value]),
    }),
  };
}

const { initializePanelBridgeController } = await import("../ui/panel-bridge.js");

{
  const document = buildDocument();
  const runtime = buildRuntime(document);

  await initializePanelBridgeController(runtime);

  const optionsEntry = document.getElementById("option_st_bme_panel");
  const wandEntry = document.getElementById("st_bme_extensions_menu_entry");
  assert.ok(optionsEntry, "legacy options menu entry is injected");
  assert.ok(wandEntry, "magic-wand extensions menu entry is injected");
  assert.equal(document.getElementById("extensionsMenuButton")?.style.display, "flex", "magic-wand button is shown after BME entry injection");
  assert.equal(timers.size, 0, "no retry remains when both menu targets are ready");

  await wandEntry.click();
  assert.equal(runtime.calls.opened, 1, "magic-wand entry opens BME panel");
  assert.ok(runtime.calls.hidden.includes("#extensionsMenu"), "magic-wand entry closes extensions menu");
}

{
  const document = buildDocument({ includeExtensionsMenu: false });
  const runtime = buildRuntime(document);

  await initializePanelBridgeController(runtime);
  assert.ok(document.getElementById("option_st_bme_panel"), "options entry is injected even before wand DOM exists");
  assert.equal(document.getElementById("st_bme_extensions_menu_entry"), null, "wand entry waits for wand DOM");
  assert.ok(timers.size > 0, "retry remains scheduled until wand DOM exists");

  appendElement(document, document.body, "div", { id: "extensionsMenuButton", style: { display: "none" } });
  appendElement(document, document.body, "div", { id: "extensionsMenu", className: "options-content" });
  runNextTimer();

  assert.ok(document.getElementById("st_bme_extensions_menu_entry"), "retry injects magic-wand entry once wand DOM appears");
  assert.equal(document.getElementById("extensionsMenuButton")?.style.display, "flex", "retry also shows magic-wand button");
}

console.log("panel-bridge tests passed");
