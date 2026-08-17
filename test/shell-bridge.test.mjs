'use strict';
// Smoke test for src/inject/shell-bridge.js in a vm sandbox: module contract,
// workspace reporting, composer insertion (textarea + input event) and the
// composer:miss fallback. Run: node test/shell-bridge.test.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function makeElement(tag) {
  const el = {
    tagName: tag, style: { cssText: '' }, dataset: {}, className: '',
    _text: '', value: '', children: [], parentNode: null, handlers: {},
    isConnected: true, selectionStart: null, selectionEnd: null,
    title: '', type: '',
    get textContent() { return el._text; },
    set textContent(v) { el._text = v; if (v === '') el.children.length = 0; },
    setAttribute(k, v) { el['@' + k] = v; },
    appendChild(c) { el.children.push(c); c.parentNode = el; return c; },
    remove() { el.isConnected = false; },
    addEventListener(type, fn) { (el.handlers[type] = el.handlers[type] || []).push(fn); },
    dispatchEvent(ev) { (el.handlers[ev.type] || []).slice().forEach((fn) => fn(ev)); return true; },
    focus() { el.focused = true; },
    setRangeText(text, start, end) {
      el.value = el.value.slice(0, start) + text + el.value.slice(end);
      el.selectionStart = el.selectionEnd = start + text.length;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    contains() { return false; },
    closest() { return null; },
  };
  return el;
}

const mailbox = makeElement('div');
mailbox.id = '__dsh_desktop_bridge__';
const toMainCapture = [];
const windowListeners = new Map();
const windowObj = {
  addEventListener(type, fn) { if (!windowListeners.has(type)) windowListeners.set(type, []); windowListeners.get(type).push(fn); },
  removeEventListener() {},
  dispatchEvent(ev) { (windowListeners.get(ev.type) || []).slice().forEach((fn) => fn(ev)); return true; },
};
windowObj.addEventListener('dsh-desktop-to-main', () => {
  toMainCapture.push({ kind: mailbox.dataset.kind, payload: mailbox.dataset.payload });
});

const composer = makeElement('textarea');
composer.value = 'existing draft';
composer.selectionStart = composer.selectionEnd = composer.value.length;

const sessionsService = {
  list: { getSnapshot: () => ({
    current: 'session-1',
    byId: { 'session-1': { id: 'session-1', cwd: '/home/u/proj' } },
    ids: ['session-1'],
  }) },
};
const workspacesService = {
  list: { getSnapshot: () => ({ items: [
    { workspaceId: 'w1', title: 'proj', path: '/home/u/proj', sessionIds: ['session-1'] },
    { workspaceId: 'w2', title: 'other', path: '/data/other', sessionIds: [] },
  ] }) },
};

let loaded = null;
const sandbox = {
  window: windowObj,
  document: {
    hidden: false,
    head: makeElement('head'),
    body: makeElement('body'),
    documentElement: makeElement('html'),
    getElementById: (id) => (id === '__dsh_desktop_bridge__' ? mailbox : null),
    querySelector: (sel) => (sel === '[data-composer-card] textarea' ? composer : null),
    querySelectorAll: () => [],
    createElement: makeElement,
    addEventListener() {},
    removeEventListener() {},
  },
  MutationObserver: class { observe() {} disconnect() {} },
  setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0,
  Event: class { constructor(type) { this.type = type; } },
  InputEvent: class { constructor(type, init) { this.type = type; Object.assign(this, { bubbles: !!init && init.bubbles }); } },
  console, Symbol, Promise, JSON, Math, Number, String, Array, Object, RegExp, Set, Map,
  get globalThis() { return sandbox; },
};
sandbox.navigator = {};
sandbox.window.__ModuleLoader__ = { load(def) { loaded = def; } };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(here, '..', 'src', 'inject', 'shell-bridge.js'), 'utf8'), sandbox);

// 1) loader contract
assert.ok(loaded, '__ModuleLoader__.load called');
assert.strictEqual(loaded.id, 'dsh-desktop-shell-bridge');
const mod = loaded.factory();
assert.strictEqual(mod.inject.join(','), 'sessions,workspaces');

// 2) apply → toggle button + ws:report with the session cwd
const dispose = mod.apply({ get: (n) => (n === 'sessions' ? sessionsService : workspacesService) });
const report = toMainCapture.find((m) => m.kind === 'ws:report');
assert.ok(report, 'ws:report sent');
const snap = JSON.parse(report.payload);
assert.deepStrictEqual(snap.list.map((w) => w.path), ['/home/u/proj', '/data/other']);
assert.strictEqual(snap.currentPath, '/home/u/proj');
assert.strictEqual(snap.currentSessionId, 'session-1');
assert.strictEqual(sandbox.document.body.children.length, 1, 'toggle button appended');
const btn = sandbox.document.body.children[0];
assert.strictEqual(btn.textContent, '📁');

// 3) toggle button click → panel:toggle
(btn.handlers.click[0])();
assert.ok(toMainCapture.some((m) => m.kind === 'panel:toggle'), 'panel:toggle sent');

// 4) insert-composer: appends with newline separator + fires input event
const inputEvents = [];
composer.addEventListener('input', (e) => inputEvents.push(e));
mailbox.dataset.kind = 'insert-composer';
mailbox.dataset.payload = JSON.stringify({ text: '[file: src/main.js]' });
windowObj.dispatchEvent(new sandbox.Event('dsh-desktop-to-page'));
assert.strictEqual(composer.value, 'existing draft\n[file: src/main.js]');
assert.strictEqual(inputEvents.length, 1, 'input event dispatched (React picks it up)');
assert.ok(composer.focused, 'composer focused');

// 5) composer missing → composer:miss
sandbox.document.querySelector = () => null;
toMainCapture.length = 0;
windowObj.dispatchEvent(new sandbox.Event('dsh-desktop-to-page'));
assert.ok(toMainCapture.some((m) => m.kind === 'composer:miss'), 'composer:miss fallback');

dispose();
console.log('shell-bridge inject tests OK');
