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

// session id → workspace cwd, learned from session objects on the event bus
// (session/event + session/created). Read by /api/state's `workspace` field
// for the in-page files panel.
const sessionCwds = new Map();

// Resolve (or drop) the hanging answerer promise. Every path that clears
// tracker.pendingApproval MUST go through this — an unresolved answerer
// leaves the tool call waiting forever inside dsh.
function settleApprovalResolver(value) {
  if (typeof pendingApprovalResolver === 'function') {
    const resolve = pendingApprovalResolver;
    pendingApprovalResolver = null;
    try { resolve(value); } catch { /* already settled */ }
  }
}

const APPROVAL_REQUEST_TYPES = new Set([
  'tool/approval', 'tool/approval:request', 'approval/request', 'approval/asked',
  'permission/request', 'session/question', 'tool/waiting',
]);
const APPROVAL_CLEAR_TYPES = new Set([
  'tool/approval:response', 'approval/response', 'approval:resolve', 'approval/decided',
  'permission/response', 'session/answer',
]);

// ── ADAPTER: error event names (extend when adapting to a real dsh) ───────
// Error event names live in compat.js — version-aware table
// (`agent/*` on 0.1.2-alpha.1, `turn/*` guesses on 0.1.0-rc.*).
const { ERROR_EVENT_NAMES, spawnTerminalCompat } = require('./compat');
const ERROR_REQUEST_TYPES = new Set(ERROR_EVENT_NAMES);

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
    this.lastError = null; // { summary, since, sessionId } | null
    // ── turn stats (self-computed from the event stream) ──
    this.turnStartedAt = 0;      // Date.now() of the current user/message
    this.turnFirstChunkAt = 0;   // first assistant/chunk after it (→ TTFT)
    this.turnTokens = { input: 0, cacheRead: 0, output: 0 };
    this.lastTurn = null; // { ttftMs, durationMs, tokensPerSec, cacheHitRate } | null
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

  // Workspace cwd of a session (learned from session objects on the bus) —
  // alpha.1's spawnTerminal requires a cwd for the terminal bridge.
  workspaceOf(id) {
    return (id && sessionCwds.get(id)) || '';
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
      this.lastError = null; // a new user message supersedes any prior error
      // ── turn stats: new turn window ──
      this.turnStartedAt = Date.now();
      this.turnFirstChunkAt = 0;
      this.turnTokens = { input: 0, cacheRead: 0, output: 0 };
      return;
    }
    if (ev.type === 'turn/end') {
      r.lastTurnEndSeq = ev.seq || r.lastTurnEndSeq;
      r.lastSummary = r.msgText;
      this.turn = 'idle';
      // ── turn stats: finalize (guard against missing/clock-skewed data) ──
      const dur = this.turnStartedAt ? Date.now() - this.turnStartedAt : 0;
      const inTok = this.turnTokens.input + this.turnTokens.cacheRead;
      this.lastTurn = {
        ttftMs: this.turnFirstChunkAt && this.turnStartedAt
          ? Math.max(0, this.turnFirstChunkAt - this.turnStartedAt) : null,
        durationMs: dur > 0 ? dur : null,
        // Require a meaningful window: a sub-tick duration divides by ~0 and
        // yields absurd rates (e.g. 50000 tok/s) that are noise, not data.
        tokensPerSec: dur >= 200 && this.turnTokens.output > 0
          ? Math.round((this.turnTokens.output / (dur / 1000)) * 10) / 10 : null,
        cacheHitRate: inTok > 0
          ? Math.round((this.turnTokens.cacheRead / inTok) * 1000) / 1000 : null,
      };
      return;
    }
    // dsh 0.1.5-rc.1 把用量放在 data.usage（旧版 <=0.1.4 在 data.chunk.usage），
    // 且真正带用量的事件是 `assistant/message` —— 因此必须在按类型提前 return 之前
    // 就读用量，否则 byModel 恒空、面板费用/命中率全无数据（实测 1054 个用量事件全在此类）。
    const u = ev.data?.usage || ev.data?.chunk?.usage;
    if (u) {
      if (!this.turnFirstChunkAt) this.turnFirstChunkAt = Date.now();
      this.turnTokens.input += u.inputTokens || 0;
      this.turnTokens.cacheRead += u.cacheReadTokens || 0;
      this.turnTokens.output += u.outputTokens || 0;
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
    if (ev.type === 'assistant/message') {
      r.msgText = extractText(ev.data?.message?.content) || r.msgText;
      return;
    }
    if (!u) {
      this.onErrorEvent(ev);
      return;
    }
  }

  // ── error surfacing ─────────────────────────────────────────────────────
  // ADAPTER: event type names are guesses until dsh documents its plugin API.
  onErrorEvent(ev) {
    const t = ev.type || '';
    if (ERROR_REQUEST_TYPES.has(t)) {
      const summary = ev.data?.error?.message || ev.data?.message || ev.data?.error
        || ev.data?.reason || t;
      this.lastError = {
        summary: String(summary).slice(0, 160),
        since: Date.now(),
        sessionId: this.currentSessionId,
      };
    }
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
    // the pending state — a stale popup is worse than a missing one. The
    // hanging answerer promise must be settled too (the user answered in the
    // web UI: treat as allowed so the tool call is not stuck forever — dsh
    // will emit the authoritative decision event itself if it disagrees).
    if (APPROVAL_CLEAR_TYPES.has(t) || t === 'turn/end' || t === 'user/message') {
      if (this.pendingApproval) {
        settleApprovalResolver('allowed-once');
      }
      this.pendingApproval = null;
    }
  }

  // Serializable snapshots (fresh objects only — callers may hold them).
  state() {
    return {
      plugin: 'dsh-plugin-desktop',
      since: this.startedAt,
      currentSessionId: this.currentSessionId,
      workspace: this.currentSessionId ? (sessionCwds.get(this.currentSessionId) || '') : '',
      turn: this.turn,
      pendingApproval: this.pendingApproval,
      lastError: this.lastError,
      lastTurn: this.lastTurn,
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
  // the current one immediately. The session object itself carries the cwd —
  // remember it so /api/state can expose the current workspace for the
  // in-page files panel.
  (ctx, handler) => {
    if (typeof ctx.on !== 'function') return false;
    const offs = [];
    const rememberWorkspace = (session) => {
      const sid = session?.id || session?.header?.id;
      const cwd = session?.cwd || session?.header?.cwd || session?.header?.session?.cwd;
      if (sid && cwd) sessionCwds.set(sid, cwd);
    };
    const offEvent = ctx.on('session/event', (session, event) => {
      const sid = session?.id || session?.header?.id;
      rememberWorkspace(session);
      handler({ ...event, sessionId: sid });
    });
    offs.push(typeof offEvent === 'function' ? offEvent : () => {});
    const offCreated = ctx.on('session/created', (session) => {
      const sid = session?.id || session?.header?.id;
      rememberWorkspace(session);
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
    settleApprovalResolver(decision === 'reject' ? 'rejected' : 'allowed-once');
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

// ── terminal bridge ──────────────────────────────────────────────────────
// Mounts /api/shell (WebSocket upgrade) and bridges each connection to one
// interactive PTY via ctx.subprocess.spawnTerminal. Protocol (JSON frames):
//   client → host : {type:'start', shell?, rows?, cols?} | {type:'data', data}
//                   | {type:'resize', rows, cols}
//   host → client : {type:'data', data} | {type:'exit', code} | {type:'error', message}
const TERMINAL_UPGRADE_SHAPES = [
  (ctx, handler) => (ctx.webServer?.registerUpgrade
    ? ctx.webServer.registerUpgrade({ path: '/api/shell', handler }) : false),
  (ctx, handler) => (ctx.server?.registerUpgrade
    ? ctx.server.registerUpgrade({ path: '/api/shell', handler }) : false),
];

function tryAttachTerminal(ctx, tracker) {
  let WebSocketServer;
  try { WebSocketServer = require('ws').WebSocketServer; } catch { return null; } // ws not bundled
  const wss = new WebSocketServer({ noServer: true });
  const sessions = new Set();

  async function bridge(ws, req) {
    let handle = null;
    let alive = true;
    const send = (obj) => { try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch { /* gone */ } };
    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      try {
        if (msg.type === 'start' && !handle) {
          // spawnTerminalCompat probes both known spec shapes
          // (0.1.0-rc.* name form / 0.1.2-alpha argv form) and returns a
          // unified handle { write, onData, onExit, resize, kill }.
          handle = await spawnTerminalCompat(ctx, {
            shell: msg.shell,
            rows: Number(msg.rows),
            cols: Number(msg.cols),
            // Terminal must open in the CURRENT WORKSPACE (the user expects a
            // prompt in the active project dir). Prefer the session's learned cwd,
            // then the workspace the plugin reports in /api/state, then dsh's own
            // default. Without the workspace fallback the shell landed in $HOME.
            cwd: tracker.workspaceOf(tracker.currentSessionId)
              || (tracker.state && tracker.state().workspace)
              || undefined,
          });
          if (!handle) { send({ type: 'error', message: 'spawnTerminal not available in this dsh build' }); return; }
          sessions.add(ws);
          handle.onData((data) => send({ type: 'data', data }));
          handle.onExit(({ exitCode } = {}) => { send({ type: 'exit', code: exitCode }); alive = false; });
        } else if (msg.type === 'data' && handle) {
          if (typeof handle.write === 'function') handle.write(msg.data);
          else if (typeof handle.input === 'function') handle.input(msg.data);
        } else if (msg.type === 'resize' && handle) {
          try { handle.resize(Number(msg.cols) || 0, Number(msg.rows) || 0); } catch { /* alpha.1: ignored */ }
        }
      } catch (e) {
        send({ type: 'error', message: String(e && e.message || e) });
      }
    });
    ws.on('close', () => {
      sessions.delete(ws);
      if (handle && alive) { try { handle.kill?.(); handle.dispose?.(); } catch { /* already gone */ } }
    });
  }

  let attached = false;
  for (const shape of TERMINAL_UPGRADE_SHAPES) {
    try {
      const off = shape(ctx, (req, socket, head) => {
        wss.handleUpgrade(req, socket, head, (ws) => { wss.emit('connection', ws, req); });
      });
      if (off === false || off === undefined) continue;
      attached = true;
      break;
    } catch { /* try next shape */ }
  }
  if (!attached) return null;

  wss.on('connection', (ws, req) => bridge(ws, req));
  return {
    attached: true,
    dispose() {
      disposed = true;
      for (const ws of sessions) { try { ws.close(); } catch { /* gone */ } }
      sessions.clear();
      try { wss.close(); } catch { /* ignore */ }
    },
  };
}

// ── entry point ──────────────────────────────────────────────────────────

module.exports = function apply(ctx) {
  // 方案甲：把上游 UI 缺陷直接打进前端 bundle（幂等/可回滚/失配安全）
  try { require('./upstream-patch')(ctx); } catch { /* never block startup */ }
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
      // A second request while one is pending: settle the old promise
      // (dsh only has one in-flight approval per transport; leaving it
      // hanging would deadlock the first tool call).
      settleApprovalResolver('allowed-once');
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

  // ── terminal bridge: /api/shell WebSocket ↔ ctx.subprocess PTY ──────────
  // Same shape as dsh-web-shell (MIT): xterm.js in the desktop panel talks
  // WebSocket; each socket is bridged to one interactive PTY. Requires the
  // `ws` package (npm-installed plugins get it automatically; the desktop's
  // copy-install brings it along too). Degrades silently when absent.
  const terminal = tryAttachTerminal(ctx, tracker);

  // Diagnostics on the state endpoint so the desktop (and humans) can see
  // which adapters actually worked — essential while the plugin API is still
  // an assumption.
  const report = () => ({ events, routes, terminal });
  ctx.on?.('dispose', () => {
    tracker.sessions.clear();
    if (terminal && typeof terminal.dispose === 'function') terminal.dispose();
  });
  return { tracker, report };
};

module.exports.Tracker = Tracker; // for tests
module.exports.apply = module.exports;
