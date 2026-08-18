'use strict';
const { randomUUID } = require('node:crypto');
const { wsList, wsPeek } = require('./ws-tree');
// dsh-plugin-desktop — companion plugin for DSH-desktop-for-Linux.
//
// Why this exists: the desktop shell used to (a) sniff webRequest bodies to
// learn the current session and (b) decompress ~/.dsh/sessions/**/session
// .jsonl.zstd to estimate usage — both depend on undocumented internals and
// break silently when dsh changes. Running inside the dsh server process, this
// plugin can observe the same events in memory and expose them as stable HTTP
// endpoints:
//
//   GET  /api/state   { currentSessionId, turn, lastTurnEndSeq, lastSummary,
//                       since }
//   GET  /api/usage   { since, byModel, sessions: [{ id, byModel,
//                       userMsgByModel, lastTurnEndSeq, lastSummary }] }
//   POST /api/prompt  { sessionId, text } — send a user message (best effort)
//
// Event semantics mirror usage-parse.js exactly (request/header sets the
// current model, user/message starts a turn, turn/end closes it, usage is read
// from assistant/chunk events only) so numbers stay consistent between the
// plugin path and the desktop's local-scan fallback.
//
// ── ADAPTER ──────────────────────────────────────────────────────────────
// Everything that touches a dsh/cordis internal API is in tryAttach*() below
// and tries several plausible shapes, because the plugin API is not yet
// documented. When adapting to a real dsh version, edit ONLY those three
// functions (and the EVENT BUS NAMES list) — the aggregation logic above them
// is plain data handling. See README.md for details.
//
// This plugin has ZERO npm dependencies on purpose: it is copied verbatim into
// the profile's node_modules by the desktop app (no npm/network needed).

// ── aggregation (pure, no dsh APIs) ──────────────────────────────────────

function emptyUsage() {
  return { input: 0, cacheRead: 0, output: 0, reasoning: 0 };
}

function addUsage(a, b) {
  a.input += b.input || 0;
  a.cacheRead += b.cacheRead || 0;
  a.output += b.output || 0;
  a.reasoning += b.reasoning || 0;
  return a;
}

function extractText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('')
    .trim();
}

// Fields the session id can hide behind in a request/header event — extend
// this list when adapting instead of scattering path guesses in the handler.
const SESSION_ID_PATHS = [
  (ev) => ev.data?.header?.session?.id,
  (ev) => ev.data?.header?.sessionId,
  (ev) => ev.data?.sessionId,
  (ev) => ev.sessionId,
];

// ── ADAPTER: approval event names (extend when adapting to a real dsh) ────
let pendingApprovalResolver = null;

const APPROVAL_REQUEST_TYPES = new Set([
  'tool/approval', 'tool/approval:request', 'approval/request', 'approval/asked',
  'permission/request', 'session/question', 'tool/waiting',
]);
const APPROVAL_CLEAR_TYPES = new Set([
  'tool/approval:response', 'approval/response', 'approval:resolve', 'approval/decided',
  'permission/response', 'session/answer',
]);

function sessionIdOf(ev) {
  for (const get of SESSION_ID_PATHS) {
    const v = get(ev);
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

class Tracker {
  constructor() {
    this.startedAt = Date.now();
    this.currentSessionId = null;
    this.turn = 'idle'; // 'working' | 'idle'
    this.sessions = new Map(); // id -> record
    this.totalByModel = {};
    this.pendingApproval = null; // { id, summary, since } | null
  }

  record(id) {
    let r = this.sessions.get(id);
    if (!r) {
      r = {
        id,
        byModel: {},
        userMsgByModel: {}, // usage since the last user/message (current turn)
        currentModel: null,
        lastTurnEndSeq: 0,
        lastSummary: '',
        msgText: '',
        updatedAt: 0,
      };
      this.sessions.set(id, r);
    }
    return r;
  }

  // Desktop shell calls this when the user opens/switches a session in the
  // web UI — server events alone cannot tell which session the user is
  // viewing, so without this the DS-pet / desktop would see a stale
  // currentSessionId whenever navigation happens without an event.
  setSession(id) {
    if (typeof id !== 'string' || !id) return;
    this.currentSessionId = id;
    this.record(id);
  }

  // One event from the dsh event stream (same JSON objects that get appended
  // to session.jsonl.zstd). Unknown/malformed events are ignored.
  onEvent(ev) {
    if (!ev || typeof ev.type !== 'string') return;
    try { this.onApprovalEvent(ev); } catch { /* never break the host */ }
    // Session association: any event that carries a session id updates the
    // current session (the user is working there).
    const sid = sessionIdOf(ev);
    if (sid) this.currentSessionId = sid;
    const r = this.record(sid || this.currentSessionId);
    if (!r) return; // no session known yet — nothing to attribute
    r.updatedAt = Date.now();

    if (ev.type === 'request/header') {
      r.currentModel = ev.data?.header?.config?.model || r.currentModel;
      return;
    }
    if (ev.type === 'user/message') {
      for (const k of Object.keys(r.userMsgByModel)) delete r.userMsgByModel[k];
      r.msgText = '';
      this.turn = 'working';
      return;
    }
    if (ev.type === 'turn/end') {
      r.lastTurnEndSeq = ev.seq || r.lastTurnEndSeq;
      r.lastSummary = r.msgText;
      this.turn = 'idle';
      return;
    }
    if (ev.type === 'assistant/message') {
      r.msgText = extractText(ev.data?.message?.content) || r.msgText;
      return;
    }
    const u = ev.data?.chunk?.usage;
    if (!u) return;
    const model = r.currentModel || 'unknown';
    const norm = {
      input: u.inputTokens || 0,
      cacheRead: u.cacheReadTokens || 0,
      output: u.outputTokens || 0,
      reasoning: u.reasoningTokens || 0,
    };
    addUsage((r.byModel[model] = r.byModel[model] || emptyUsage()), norm);
    addUsage((r.userMsgByModel[model] = r.userMsgByModel[model] || emptyUsage()), norm);
    addUsage((this.totalByModel[model] = this.totalByModel[model] || emptyUsage()), norm);
  }

  // ── approval / permission waiting ──────────────────────────────────────
  // ADAPTER: event type names + payload paths are guesses until dsh documents
  // its plugin API — extend these two lists when adapting (see README).

  onApprovalEvent(ev) {
    const t = ev.type || '';
    if (APPROVAL_REQUEST_TYPES.has(t)) {
      const summary = ev.data?.summary || ev.data?.approval?.summary
        || ev.data?.reason || ev.data?.toolName || ev.data?.title || ev.data?.tool
        || (ev.data?.input ? JSON.stringify(ev.data.input).slice(0, 120) : '')
        || t;
      this.pendingApproval = {
        id: String(ev.data?.id || ev.seq || Date.now()),
        summary: String(summary).slice(0, 160),
        since: Date.now(),
        sessionId: this.currentSessionId,
      };
      return;
    }
    // Anything that implies the user answered (or the turn moved on) clears
    // the pending state — a stale popup is worse than a missing one.
    if (APPROVAL_CLEAR_TYPES.has(t) || t === 'turn/end' || t === 'user/message') {
      this.pendingApproval = null;
    }
  }

  // Serializable snapshots (fresh objects only — callers may hold them).
  state() {
    return {
      plugin: 'dsh-plugin-desktop',
      since: this.startedAt,
      currentSessionId: this.currentSessionId,
      turn: this.turn,
      pendingApproval: this.pendingApproval,
      lastTurnEndSeq: this.currentSessionId
        ? (this.record(this.currentSessionId).lastTurnEndSeq || 0)
        : 0,
      lastSummary: this.currentSessionId
        ? (this.record(this.currentSessionId).lastSummary || '')
        : '',
    };
  }

  usage() {
    // `complete: false` — the tracker only covers events seen since the dsh
    // process (re)started; the desktop keeps its file scan for totals and
    // treats this as a realtime delta for the sessions it does cover.
    const sessions = [...this.sessions.values()].map((r) => ({
      id: r.id,
      byModel: r.byModel,
      userMsgByModel: r.userMsgByModel,
      lastTurnEndSeq: r.lastTurnEndSeq,
      lastSummary: r.lastSummary,
      updatedAt: r.updatedAt,
    }));
    return { plugin: 'dsh-plugin-desktop', since: this.startedAt, complete: false, byModel: this.totalByModel, sessions };
  }
}

// ── ADAPTER: event bus ───────────────────────────────────────────────────
// Names/shapes tried, in order. Replace with the real one when dsh documents
// its plugin API; keep onEvent() as the handler.
const EVENT_BUS_SHAPES = [
  // Real dsh emits session-scoped events: ctx.on('session/event', (session, event)).
  // Enrich each event with the session id so association does not depend on the
  // payload carrying it; also observe session/created so a fresh session becomes
  // the current one immediately.
  (ctx, handler) => {
    if (typeof ctx.on !== 'function') return false;
    const offs = [];
    const offEvent = ctx.on('session/event', (session, event) => {
      const sid = session?.id || session?.header?.id;
      handler({ ...event, sessionId: sid });
    });
    offs.push(typeof offEvent === 'function' ? offEvent : () => {});
    const offCreated = ctx.on('session/created', (session) => {
      const sid = session?.id || session?.header?.id;
      handler({ type: 'session/created', data: { sessionId: sid } });
    });
    offs.push(typeof offCreated === 'function' ? offCreated : () => {});
    return () => offs.forEach((off) => off());
  },
  (ctx, handler) => ctx.on('dsh/event', handler),
  (ctx, handler) => ctx.on('session/event', handler),
  (ctx, handler) => ctx.on('event', (type, payload) => handler({ type, data: payload })),
  (ctx, handler) => (ctx.events?.on ? ctx.events.on('dsh/event', handler) : false),
];

function tryAttachEvents(ctx, tracker) {
  const disposers = [];
  const handler = (ev) => {
    try { tracker.onEvent(ev); } catch { /* never break the host */ }
  };
  for (const attach of EVENT_BUS_SHAPES) {
    try {
      const off = attach(ctx, handler);
      if (off === false) continue; // shape existed but refused
      disposers.push(typeof off === 'function' ? off : () => {});
      return { attached: true, shape: EVENT_BUS_SHAPES.indexOf(attach) };
    } catch { /* shape not available — try next */ }
  }
  return { attached: false };
}

// ── ADAPTER: HTTP routes ─────────────────────────────────────────────────
// Current dsh exposes the `webServer` service: register({ kind, path,
// handler }) with node:http req/res. Older/alternative builds may expose
// Koa-style `ctx.server.get/post(path, fn)` or router-style
// `ctx.router.get/post`. Handlers are framework-agnostic: they receive
// ({ query, body, params }) and return { status, json }.
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1_000_000) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const ROUTER_SHAPES = [
  {
    name: 'ctx.webServer.register (via effect)',
    register(ctx, method, path, fn) {
      if (!ctx.effect || typeof ctx.effect !== 'function') return false;
      ctx.effect(() => {
        const handle = async (req, res) => {
          const u = new URL(req.url || '/', 'http://x');
          const query = Object.fromEntries(u.searchParams);
          const body = method === 'post' ? await readJsonBody(req).catch(() => ({})) : {};
          const result = await safe(fn, { query, body, params: {} });
          res.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(result.json));
        };
        return ctx.webServer.register({ kind: 'exact', path, handler: handle });
      }, `dsh-plugin-desktop ${method} ${path}`);
      return true;
    },
  },
  {
    name: 'ctx.server[method]',
    register(ctx, method, path, fn) {
      if (!ctx.server || typeof ctx.server[method] !== 'function') return false;
      ctx.server[method](path, async (c) => {
        const res = await safe(fn, { query: c.query, body: c.request?.body || c.body || {}, params: c.params });
        if (res.status !== 200) c.status = res.status;
        c.body = res.json;
      });
      return true;
    },
  },
  {
    name: 'ctx.router[method]',
    register(ctx, method, path, fn) {
      if (!ctx.router || typeof ctx.router[method] !== 'function') return false;
      ctx.router[method](path, async (c) => {
        const res = await safe(fn, { query: c.query, body: c.request?.body || c.body || {}, params: c.params });
        if (res.status !== 200) c.status = res.status;
        c.body = res.json;
      });
      return true;
    },
  },
];

async function safe(fn, arg) {
  try {
    // Handlers may return a plain payload or an explicit { status, json }
    // envelope (for non-200 responses).
    const r = await fn(arg);
    if (r && typeof r === 'object' && typeof r.status === 'number' && 'json' in r) return r;
    return { status: 200, json: r };
  } catch (e) {
    return { status: 500, json: { error: String(e && e.message || e) } };
  }
}

function tryAttachRoutes(ctx, handlers) {
  const used = [];
  let ok = 0;
  for (const { method, path, fn } of handlers) {
    for (const shape of ROUTER_SHAPES) {
      try {
        if (shape.register(ctx, method, path, fn)) { used.push(`${shape.name} ${path}`); ok++; break; }
      } catch { /* try next shape */ }
    }
  }
  return { attached: ok === handlers.length, via: used };
}

// ── ADAPTER: sending a prompt / answering an approval ────────────────────
// POST /api/prompt and /api/approve need dsh internals; tried shapes below.
// If none works the endpoints answer 501 and the desktop falls back to
// focusing the main window.
const PROMPT_SHAPES = [
  // Real dsh: host API gateway exposes apiProxy.sessions.prompt.
  async (ctx, sessionId, text) => ctx.apiProxy?.sessions?.prompt({
    rpcId: randomUUID(),
    payload: {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    },
  }),
  async (ctx, sessionId, text) => ctx.server?.call?.('session.prompt', { sessionId, text }),
  async (ctx, sessionId, text) => ctx.call?.('session.prompt', { sessionId, text }),
  async (ctx, sessionId, text) => ctx.server?.rpc?.('session.prompt', { sessionId, text }),
];

// ADAPTER: approval decision RPCs — (ctx, id, decision) with decision
// 'approve' | 'reject'.
const APPROVE_SHAPES = [
  async (ctx, id, decision) => ctx.server?.call?.('tool.approve', { id, decision }),
  async (ctx, id, decision) => ctx.call?.('tool.approve', { id, decision }),
  async (ctx, id, decision) => ctx.server?.call?.('approval.respond', { id, decision }),
  async (ctx, id, decision) => ctx.call?.('session.approve', { id, decision }),
];

async function trySendPrompt(ctx, sessionId, text) {
  for (const shape of PROMPT_SHAPES) {
    try {
      const r = await shape(ctx, sessionId, text);
      if (r !== undefined) return { sent: true, result: r === undefined ? null : r };
    } catch { /* try next shape */ }
  }
  return { sent: false };
}

async function tryApprove(ctx, id, decision) {
  // Real dsh: this plugin registers an `approval/request` answerer ahead of the
  // web transport, so the desktop can resolve the pending request directly.
  if (typeof pendingApprovalResolver === 'function') {
    const resolve = pendingApprovalResolver;
    pendingApprovalResolver = null;
    resolve(decision === 'reject' ? 'rejected' : 'allowed-once');
    return { sent: true, result: { id, decision } };
  }
  for (const shape of APPROVE_SHAPES) {
    try {
      const r = await shape(ctx, id, decision);
      if (r !== undefined) return { sent: true, result: r === undefined ? null : r };
    } catch { /* try next shape */ }
  }
  return { sent: false };
}

// ── entry point ──────────────────────────────────────────────────────────

module.exports = function apply(ctx) {
  const tracker = new Tracker();

  const events = tryAttachEvents(ctx, tracker);

  // Real dsh answerer: claim approval requests before the web transport so the
  // desktop / pet popup can approve or reject from /api/approve.
  if (typeof ctx.on === 'function') {
    ctx.on('approval/request', (req) => {
      const sessionId = req?.agent?.session?.id;
      const approvalId = tracker.pendingApproval?.id
        || (req?.callId ? `call-${req.callId}` : null)
        || `req-${Date.now()}`;
      const summary = req?.reason || req?.toolName || 'approval request';
      tracker.pendingApproval = {
        id: approvalId,
        summary: String(summary).slice(0, 160),
        since: Date.now(),
        sessionId,
      };
      return new Promise((resolve) => {
        pendingApprovalResolver = resolve;
      });
    }, { prepend: true });
  }

  const routes = tryAttachRoutes(ctx, [
    { method: 'get', path: '/api/state', fn: () => tracker.state() },
    { method: 'get', path: '/api/usage', fn: () => tracker.usage() },
    {
      method: 'post',
      path: '/api/set-session',
      fn: ({ body }) => {
        const sessionId = body && (body.sessionId || body.id);
        if (typeof sessionId !== 'string' || !sessionId) {
          return { status: 400, json: { error: 'sessionId required' } };
        }
        tracker.setSession(sessionId);
        return { ok: true, currentSessionId: tracker.currentSessionId };
      },
    },
    {
      method: 'post',
      path: '/api/prompt',
      fn: async ({ body }) => {
        const sessionId = body.sessionId || tracker.currentSessionId;
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (!text) return { status: 400, json: { error: 'text required' } };
        if (!sessionId) return { status: 409, json: { error: 'no current session' } };
        const r = await trySendPrompt(ctx, sessionId, text);
        if (!r.sent) return { status: 501, json: { error: 'prompt RPC not available in this dsh build', sessionId, text } };
        return { sessionId, text };
      },
    },
    {
      method: 'post',
      path: '/api/approve',
      fn: async ({ body }) => {
        const decision = body?.decision === 'reject' ? 'reject' : 'approve';
        const id = tracker.pendingApproval ? tracker.pendingApproval.id
          : (typeof body?.id === 'string' && body.id) || null;
        if (!id) return { status: 409, json: { error: 'no pending approval' } };
        const r = await tryApprove(ctx, id, decision);
        if (!r.sent) return { status: 501, json: { error: 'approval RPC not available in this dsh build', id, decision } };
        tracker.pendingApproval = null;
        return { id, decision };
      },
    },
    // ── file panel (v0.3): tree / peek / git status for the in-page right
    // side panel. The panel passes the workspace root (session cwd) from the
    // page's workspaces service; paths are validated against traversal.
    {
      method: 'get',
      path: '/api/tree',
      fn: ({ query }) => {
        const root = typeof query.root === 'string' ? query.root : '';
        const rel = typeof query.rel === 'string' ? query.rel : '';
        if (!root) return { status: 400, json: { error: 'root required' } };
        return wsList(root, rel);
      },
    },
    {
      method: 'get',
      path: '/api/peek',
      fn: ({ query }) => {
        const p = typeof query.path === 'string' ? query.path : '';
        if (!p) return { status: 400, json: { error: 'path required' } };
        const r = wsPeek(p);
        return r.ok ? r : { status: 404, json: r };
      },
    },
    {
      method: 'get',
      path: '/api/gitstatus',
      fn: ({ query }) => {
        const root = typeof query.root === 'string' ? query.root : '';
        if (!root) return { status: 400, json: { error: 'root required' } };
        try {
          const { execFileSync } = require('node:child_process');
          const branch = execFileSync('git', ['-C', root, 'branch', '--show-current'], { encoding: 'utf8', timeout: 3000 }).trim();
          const status = execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8', timeout: 3000 });
          const dirty = status.split('\n').filter(Boolean).map((l) => l.slice(0, 2) + ' ' + l.slice(3));
          return { branch, dirty };
        } catch (e) {
          return { branch: '', dirty: [], error: e.message };
        }
      },
    },
  ]);

  // Diagnostics on the state endpoint so the desktop (and humans) can see
  // which adapters actually worked — essential while the plugin API is still
  // an assumption.
  const report = () => ({ events, routes });
  ctx.on?.('dispose', () => { tracker.sessions.clear(); });
  return { tracker, report };
};

module.exports.Tracker = Tracker; // for tests
module.exports.apply = module.exports;
