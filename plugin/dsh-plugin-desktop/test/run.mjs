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
    emit(name, ev) { const fn = listeners.get(name); if (fn) fn(ev); },
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
['/api/state', '/api/usage', '/api/prompt', '/api/approve'].forEach((p) => ctx._declare(p));
const { report } = plugin.apply(ctx);
const diag = report();
assert.strictEqual(diag.events.attached, true, 'event adapter should attach');
assert.strictEqual(diag.routes.attached, true, 'route adapter should attach');

// --- event aggregation (mirrors the scenario from the desktop's conv test) ---
const S = 'session-abc';
const ev = (type, data, seq) => ({ type, data, seq, sessionId: S });
ctx.emit('dsh/event', ev('request/header', { header: { config: { model: 'deepseek-v4-flash' }, session: { id: S } } }));
ctx.emit('dsh/event', ev('user/message', {}));
ctx.emit('dsh/event', ev('assistant/chunk', { chunk: { usage: { inputTokens: 1000, cacheReadTokens: 500, outputTokens: 200 } } }));
ctx.emit('dsh/event', ev('assistant/message', { message: { content: [{ type: 'text', text: '你好呀' }] } }));
ctx.emit('dsh/event', ev('turn/end', {}, 3));

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
ctx.emit('dsh/event', ev('user/message', {}));
ctx.emit('dsh/event', ev('assistant/chunk', { chunk: { usage: { inputTokens: 10, outputTokens: 5 } } }));
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
ctx.emit('dsh/event', ev('tool/approval', { summary: 'rm -rf build' }, 7));
r = await ctx.request('GET', '/api/state');
assert.deepStrictEqual(
  [r.json.pendingApproval.id, r.json.pendingApproval.summary],
  ['7', 'rm -rf build'],
  `pending approval surfaced: ${JSON.stringify(r.json.pendingApproval)}`,
);
// user/message clears it (the user answered in the web UI)
ctx.emit('dsh/event', ev('user/message', {}, 8));
r = await ctx.request('GET', '/api/state');
assert.strictEqual(r.json.pendingApproval, null, 'user/message clears pending approval');

// approve via endpoint with a fresh request
ctx.emit('dsh/event', ev('approval/request', { id: 'apr-1', title: 'write file' }, 9));
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
['/api/state', '/api/usage', '/api/prompt', '/api/approve'].forEach((p) => noRpc._declare(p));
noRpc.server._rpcs = [];
delete noRpc.server.call;
noRpc.server.call = null;
plugin.apply(noRpc);
noRpc.emit('dsh/event', ev('tool/approval', { summary: 'x' }, 1));
r = await noRpc.request('POST', '/api/approve', { decision: 'reject' });
assert.strictEqual(r.status, 501, 'missing approval RPC → 501');

console.log('dsh-plugin-desktop mock tests OK');
