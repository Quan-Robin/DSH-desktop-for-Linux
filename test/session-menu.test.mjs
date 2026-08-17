'use strict';
// Smoke test for src/inject/session-menu.js in a vm sandbox with a minimal
// fake DOM. Covers the load contract (__ModuleLoader__), the pins:hello
// handshake, pinned-section insertion point (before the session list) and
// click-to-jump. Run: node test/session-menu.test.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// ---- minimal fake DOM ----
function makeElement(tag) {
  const el = {
    tagName: tag,
    style: {},
    dataset: {},
    className: '',
    _text: '',
    children: [],
    parentNode: null,
    handlers: {},
    isConnected: true,
    get textContent() { return el._text; },
    set textContent(v) { el._text = v; if (v === '') el.children.length = 0; },
    setAttribute(k, v) { el['@' + k] = v; },
    getAttribute(k) { return el['@' + k]; },
    appendChild(c) { el.children.push(c); c.parentNode = el; return c; },
    remove() {},
    addEventListener(type, fn) { (el.handlers[type] = el.handlers[type] || []).push(fn); },
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    contains() { return false; },
    closest() { return null; },
    get childElementCount() { return el.children.length; },
    get firstElementChild() { return el.children[0] || null; },
    get lastElementChild() { return el.children[el.children.length - 1] || null; },
    get parentElement() { return el.parentNode; },
    get nextElementSibling() {
      if (!el.parentNode) return null;
      const sibs = el.parentNode.children;
      const i = sibs.indexOf(el);
      return i >= 0 ? (sibs[i + 1] || null) : null;
    },
  };
  return el;
}

const opened = [];
const sessionsService = {
  list: { getSnapshot: () => ({
    byId: { 'session-a': { id: 'session-a', title: 'A 会话', displayTitle: 'A 会话' } },
    ids: ['session-a'],
    current: null,
  }) },
  open: (id) => opened.push(id),
};
const workspacesService = { list: { getSnapshot: () => ({ items: [], archivedSessionIds: [] }) } };

// sidebar structure: row.parentElement = list, list.parentNode = sidebar
const row = makeElement('div');
const list = makeElement('div');
const sidebar = makeElement('div');
list.appendChild(row);
sidebar.appendChild(list);
const insertions = [];

const listeners = new Map();
const windowObj = {
  addEventListener(type, fn) { (listeners.set(type, listeners.get(type) || []).get ? null : listeners.set(type, [])); listeners.get(type).push(fn); },
  removeEventListener() {},
  dispatchEvent(ev) { (listeners.get(ev.type) || []).slice().forEach((fn) => fn(ev)); return true; },
  innerWidth: 1280,
  innerHeight: 800,
};

const toMainCapture = [];
const mailbox = makeElement('div');
mailbox.id = '__dsh_desktop_bridge__';

const documentObj = {
  hidden: false,
  head: makeElement('head'),
  body: makeElement('body'),
  documentElement: makeElement('html'),
  getElementById: (id) => (id === '__dsh_desktop_bridge__' ? mailbox : null),
  querySelector: (sel) => (sel === '[role="treeitem"]' ? row : null),
  querySelectorAll: () => [],
  createElement: makeElement,
  addEventListener() {},
  removeEventListener() {},
};

let loaded = null;
const sandbox = {
  window: windowObj,
  document: documentObj,
  MutationObserver: class { observe() {} disconnect() {} },
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
  requestAnimationFrame: (fn) => fn(),
  Event: class { constructor(type) { this.type = type; } },
  CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
  console,
  Symbol, Promise, JSON, Math, Number, String, Array, Object, RegExp, Set, Map, URL,
  get globalThis() { return sandbox; },
};
sandbox.window.__ModuleLoader__ = { load(def) { loaded = def; } };
windowObj.addEventListener('dsh-desktop-to-main', () => {
  toMainCapture.push({ kind: mailbox.dataset.kind, payload: mailbox.dataset.payload });
});
sandbox.Element = class {};
sandbox.MouseEvent = class {};
sandbox.InputEvent = class {};
sandbox.HTMLInputElement = class {};
sandbox.HTMLTextAreaElement = class {};
sandbox.navigator = {};

vm.createContext(sandbox);
const src = fs.readFileSync(path.join(here, '..', 'src', 'inject', 'session-menu.js'), 'utf8');
vm.runInContext(src, sandbox);

// 1) the module registered with the page's own loader, same contract as the
//    community plugin (inject list drives ctx.get provisioning)
assert.ok(loaded, '__ModuleLoader__.load called');
assert.strictEqual(loaded.id, 'dsh-desktop-session-menu');
const mod = loaded.factory();
assert.strictEqual(mod.inject.join(','), 'sessions,workspaces', 'inject contract (cross-realm array)');
assert.strictEqual(typeof mod.apply, 'function');

// fake sidebar insert (listContainer().parentNode.insertBefore)
sidebar.insertBefore = (node, ref) => {
  insertions.push({ node, ref });
  node.parentNode = sidebar;
  const i = sidebar.children.indexOf(ref);
  if (i >= 0) sidebar.children.splice(i, 0, node);
  else sidebar.children.push(node);
};

// 2) apply() wires up and greets the shell
const ctx = { get: (name) => (name === 'sessions' ? sessionsService : workspacesService) };
const dispose = mod.apply(ctx);
assert.ok(toMainCapture.some((m) => m.kind === 'pins:hello'), 'pins:hello handshake sent');

// 3) pins arriving from the shell render a section before the session list
mailbox.dataset.kind = 'pins';
mailbox.dataset.payload = JSON.stringify([{ id: 'session-a', title: 'A 会话' }]);
windowObj.dispatchEvent(new sandbox.Event('dsh-desktop-to-page'));
assert.strictEqual(insertions.length, 1, 'pinned section inserted');
assert.strictEqual(insertions[0].ref, list, 'inserted before the session list container');
const section = insertions[0].node;
assert.strictEqual(section.className, 'dshdp-section');
assert.strictEqual(section.children.length, 2, 'header + list');

// 4) clicking a pinned item jumps via the official sessions.open()
const pinList = section.children[1];
assert.strictEqual(pinList.children.length, 1, 'one pinned item');
const item = pinList.children[0];
const title = item.children.find((c) => c.className === 'dshdp-title');
assert.strictEqual(title.textContent, 'A 会话', 'live title from the session service');
(item.handlers.click[0])();
assert.deepStrictEqual(opened, ['session-a'], 'click → sessions.open(id)');

// 5) un-pinning through the mailbox round-trip is main-side logic (covered by
//    desktop-utils togglePin tests); dispose cleanly tears down
assert.strictEqual(typeof dispose, 'function');
dispose();

console.log('session-menu inject tests OK');
