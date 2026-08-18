'use strict';
// Mock-ctx test for dsh-plugin-desktop: fake event bus + koa-ish router.
// Run: node test/run.js   (zero deps)
import assert from 'node:assert';
import pluginPkg from '../lib/index.js';
const plugin = pluginPkg;

function makeMockCtx() {
  const listeners = new Map();
  const routes = new Map();
  return {
    calls: [],
    on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name); },
    emit(name, ...args) { const fn = listeners.get(name); if (fn) fn(...args); },
    server: {
      get(path, fn) { routes.get(path).handler = fn; },
      post(path, fn) { routes.get(path).handler = fn; },
      call(method, params) { this._rpc = { method, params }; return { ok: true }; },
    },
    // pre-declare route paths so register() can attach handlers
    _declare(path) { routes.set(path, { handler: null }); },
    async request(method, path, body) {
      const r = routes.get(path);
      if (!r || !r.handler) return { status: 404 };
      // koa-ish object
      const c = { query: {}, body, params: {}, status: 200, _body: undefined };
      Object.defineProperty(c, 'body', {
        get() { return this._body; },
        set(v) { this._body = v; },
      });
      c.request = { body };
      await r.handler(c);
      return { status: c.status, json: c._body };
    },
  };
}

const ctx = makeMockCtx();
['/api/state', '/api/usage', '/api/prompt', '/api/approve', '/api/set-session', '/api/tree', '/api/peek', '/api/gitstatus'].forEach((p) => ctx._declare(p));
const { report } = plugin.apply(ctx);
const diag = report();
assert.strictEqual(diag.events.attached, true, 'event adapter should attach');
assert.strictEqual(diag.routes.attached, true, 'route adapter should attach');

// --- event aggregation (mirrors the scenario from the desktop's conv test) ---
const S = 'session-abc';
const ev = (type, data, seq) => ({ type, data, seq, sessionId: S });
ctx.emit('session/event', { id: S }, ev('request/header', { header: { config: { model: 'deepseek-v4-flash' }, session: { id: S } } }));
ctx.emit('session/event', { id: S }, ev('user/message', {}));
ctx.emit('session/event', { id: S }, ev('assistant/chunk', { chunk: { usage: { inputTokens: 1000, cacheReadTokens: 500, outputTokens: 200 } } }));
ctx.emit('session/event', { id: S }, ev('assistant/message', { message: { content: [{ type: 'text', text: '你好呀' }] } }));
ctx.emit('session/event', { id: S }, ev('turn/end', {}, 3));

let r = await ctx.request('GET', '/api/state');
assert.deepStrictEqual([r.status, r.json.currentSessionId, r.json.turn, r.json.lastTurnEndSeq, r.json.lastSummary],
  [200, S, 'idle', 3, '你好呀'], `state: ${JSON.stringify(r.json)}`);

r = await ctx.request('GET', '/api/usage');
const sess = r.json.sessions.find((x) => x.id === S);
assert.ok(sess, 'usage lists the session');
assert.deepStrictEqual(sess.byModel['deepseek-v4-flash'], { input: 1000, cacheRead: 500, output: 200, reasoning: 0 });
assert.deepStrictEqual(sess.userMsgByModel['deepseek-v4-flash'], { input: 1000, cacheRead: 500, output: 200, reasoning: 0 });
assert.strictEqual(r.json.complete, false);

// new user message resets the turn accumulation only
ctx.emit('session/event', { id: S }, ev('user/message', {}));
ctx.emit('session/event', { id: S }, ev('assistant/chunk', { chunk: { usage: { inputTokens: 10, outputTokens: 5 } } }));
r = await ctx.request('GET', '/api/usage');
const s2 = r.json.sessions.find((x) => x.id === S);
assert.deepStrictEqual(s2.userMsgByModel['deepseek-v4-flash'], { input: 10, cacheRead: 0, output: 5, reasoning: 0 }, 'turn cost resets on user/message');
assert.deepStrictEqual(s2.byModel['deepseek-v4-flash'], { input: 1010, cacheRead: 500, output: 205, reasoning: 0 }, 'session total accumulates');

// --- prompt: happy path via mock server.call ---
r = await ctx.request('POST', '/api/prompt', { sessionId: S, text: ' 继续优化 ' });
assert.strictEqual(r.status, 200, `prompt ok: ${JSON.stringify(r.json)}`);
assert.deepStrictEqual(ctx.server._rpc, { method: 'session.prompt', params: { sessionId: S, text: '继续优化' } });

// --- prompt: validation ---
r = await ctx.request('POST', '/api/prompt', { text: '' });
assert.strictEqual(r.status, 400);
r = await ctx.request('POST', '/api/prompt', { sessionId: 'session-none', text: 'x' });
assert.strictEqual(r.status, 200); // explicit sessionId is honored

// --- set-session: desktop reports UI-navigation current session ---
r = await ctx.request('POST', '/api/set-session', { sessionId: 'session-nav-1' });
assert.strictEqual(r.status, 200, `set-session ok: ${JSON.stringify(r.json)}`);
assert.strictEqual(r.json.currentSessionId, 'session-nav-1', 'set-session updates currentSessionId');
r = await ctx.request('GET', '/api/state');
assert.strictEqual(r.json.currentSessionId, 'session-nav-1', '/api/state reflects set-session');
// validation: missing sessionId → 400
r = await ctx.request('POST', '/api/set-session', {});
assert.strictEqual(r.status, 400, 'set-session requires sessionId');

// --- degradation: no RPC shape works → 501, not a crash ---
const bare = makeMockCtx();
['/api/state', '/api/usage', '/api/prompt'].forEach((p) => bare._declare(p));
delete bare.server.call;
plugin.apply(bare);
r = await bare.request('POST', '/api/prompt', { sessionId: S, text: 'hi' });
assert.strictEqual(r.status, 501, 'missing RPC → 501');
r = await bare.request('GET', '/api/state');
assert.strictEqual(r.status, 200, 'state still served without RPC');

// --- degradation: no event bus at all → endpoints exist, empty data ---
const noBus = { server: { get() {}, post() {} } };
const res = plugin.apply(noBus);
assert.strictEqual(res.report().events.attached, false);
assert.strictEqual(res.tracker.state().currentSessionId, null);

// --- approval lifecycle: request → pending in state → approve clears ---
ctx.emit('session/event', { id: S }, ev('tool/approval', { summary: 'rm -rf build' }, 7));
r = await ctx.request('GET', '/api/state');
assert.deepStrictEqual(
  [r.json.pendingApproval.id, r.json.pendingApproval.summary],
  ['7', 'rm -rf build'],
  `pending approval surfaced: ${JSON.stringify(r.json.pendingApproval)}`,
);
// user/message clears it (the user answered in the web UI)
ctx.emit('session/event', { id: S }, ev('user/message', {}, 8));
r = await ctx.request('GET', '/api/state');
assert.strictEqual(r.json.pendingApproval, null, 'user/message clears pending approval');

// approve via endpoint with a fresh request
ctx.emit('session/event', { id: S }, ev('approval/request', { id: 'apr-1', title: 'write file' }, 9));
r = await ctx.request('POST', '/api/approve', { decision: 'approve' });
assert.strictEqual(r.status, 200, `approve ok: ${JSON.stringify(r.json)}`);
assert.deepStrictEqual(ctx.server._rpc, { method: 'tool.approve', params: { id: 'apr-1', decision: 'approve' } });
r = await ctx.request('GET', '/api/state');
assert.strictEqual(r.json.pendingApproval, null, 'approve clears pending');

// no pending → 409
r = await ctx.request('POST', '/api/approve', { decision: 'approve' });
assert.strictEqual(r.status, 409);

// no approval RPC shape → 501 (degrade, not crash)
const noRpc = makeMockCtx();
['/api/state', '/api/usage', '/api/prompt', '/api/approve', '/api/set-session'].forEach((p) => noRpc._declare(p));
noRpc.server._rpcs = [];
delete noRpc.server.call;
noRpc.server.call = null;
plugin.apply(noRpc);
noRpc.emit('session/event', { id: S }, ev('tool/approval', { summary: 'x' }, 1));
r = await noRpc.request('POST', '/api/approve', { decision: 'reject' });
assert.strictEqual(r.status, 501, 'missing approval RPC → 501');

// --- real dsh shapes: webServer + apiProxy + approval/request answerer ---
function makeRealCtx() {
  const routes = new Map();
  const listeners = new Map();
  const promptCalls = [];
  const ctx = {
    effect(fn) { return fn(); },
    webServer: {
      register(route) { routes.set(route.path, route); return () => routes.delete(route.path); },
    },
    apiProxy: {
      sessions: {
        prompt: async (req) => { promptCalls.push(req); return { rpcId: req.rpcId, result: { ok: true, value: { accepted: true } } }; },
      },
    },
    on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name); },
    emit(name, ...args) { const fn = listeners.get(name); if (fn) return fn(...args); },
    async request(method, path, body) {
      const route = routes.get(path);
      if (!route) return { status: 404 };
      const req = { url: path, on(ev, cb) { if (ev === 'data' && body !== undefined) cb(JSON.stringify(body)); if (ev === 'end') cb(); } };
      const res = { status: 200, body: '', writeHead(status) { this.status = status; }, end(payload) { this.body = payload; } };
      await route.handler(req, res);
      return { status: res.status, json: JSON.parse(res.body) };
    },
    promptCalls,
  };
  return ctx;
}

{
  const real = makeRealCtx();
  const app = plugin.apply(real);
  assert.strictEqual(app.report().routes.attached, true, 'real webServer route adapter should attach');
  real.emit('session/event', { id: 'session-real' }, { type: 'user/message', data: {}, seq: 1 });
  let r = await real.request('GET', '/api/state');
  assert.strictEqual(r.json.currentSessionId, 'session-real', 'session/event shape should update current session');
  r = await real.request('POST', '/api/prompt', { sessionId: 'session-real', text: 'hi' });
  assert.strictEqual(r.status, 200, 'prompt via apiProxy should succeed');
  assert.strictEqual(real.promptCalls.length, 1, 'apiProxy.sessions.prompt should be called');
  assert.strictEqual(real.promptCalls[0].payload.sessionId, 'session-real');
  assert.strictEqual(real.promptCalls[0].payload.content[0].text, 'hi');

  const approvalPromise = real.emit('approval/request', { agent: { session: { id: 'session-real' } }, toolName: 'bash', reason: 'run command' });
  r = await real.request('POST', '/api/approve', { decision: 'approve' });
  assert.strictEqual(r.status, 200, 'approve via approval/request answerer should succeed');
  assert.strictEqual(await approvalPromise, 'allowed-once', 'approval request should resolve allowed-once');
}

console.log('dsh-plugin-desktop mock tests OK');
