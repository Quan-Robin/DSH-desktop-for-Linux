'use strict';
// dsh balance & usage estimation.
//
// Sources:
//  - official balance: DeepSeek API GET /user/balance, keyed by the API key
//    stored in $DSH_HOME/.credentials.yaml (used locally only, never persisted
//    or shown by this app).
//  - usage: every model call is logged in $DSH_HOME/sessions/**/session.jsonl.zstd
//    as assistant/chunk events with a usage chunk carrying inputTokens,
//    cacheReadTokens, outputTokens and reasoningTokens; the model of each call
//    is carried by the preceding request/header event (paired in stream order).
//  - estimate: after a calibration ("校准"), the estimated balance is
//    baselineBalance − (consumedNow − baselineConsumed).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { decompress } = require('fzstd');

// dsh data home — default ~/.dsh, overridable via config.dshHome (portable
// mode keeps all dsh data next to the app instead of polluting ~/.dsh).
let dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
function setDshHome(h) { if (h) dshHome = h; }
function getDshHome() { return dshHome; }

// DeepSeek official pricing (CNY per 1M tokens) — api-docs.deepseek.com.
// Peak/off-peak pricing takes effect 2026-08-17 00:00 (Beijing time);
// peak hours are 09:00–12:00 and 14:00–18:00 Beijing time.
const PEAK_START = new Date('2026-08-17T00:00:00+08:00').getTime();

const DEFAULT_PRICING = {
  'deepseek-v4-flash': {
    input: 1, cacheHit: 0.02, output: 2,
    peak: { input: 3.0, cacheHit: 0.10, output: 9.0 },
    offpeak: { input: 1.5, cacheHit: 0.05, output: 4.5 },
  },
  'deepseek-v4-pro': {
    input: 3, cacheHit: 0.025, output: 6,
    peak: { input: 9.0, cacheHit: 0.30, output: 27.0 },
    offpeak: { input: 4.5, cacheHit: 0.15, output: 13.5 },
  },
  'deepseek-chat': { input: 2, cacheHit: 0.5, output: 8 },
  'deepseek-reasoner': { input: 4, cacheHit: 1, output: 16 },
};

function isBeijingPeak(now) {
  const d = new Date(now);
  const h = d.getHours(); // local time (UTC+8 for CN users)
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

function priceFor(model, pricing, now) {
  const p = { ...(DEFAULT_PRICING[model] || DEFAULT_PRICING['deepseek-v4-flash']), ...(pricing && pricing[model]) };
  if (p.peak && p.offpeak && now >= PEAK_START) {
    return isBeijingPeak(now) ? p.peak : p.offpeak;
  }
  return p;
}

function getApiKey() {
  try {
    const yaml = fs.readFileSync(path.join(dshHome, '.credentials.yaml'), 'utf8');
    const m = yaml.match(/^\s*DEEPSEEK_API_KEY\s*:\s*["']?([^\s"']+)/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function fetchOfficialBalance(apiKey) {
  const res = await fetch('https://api.deepseek.com/user/balance', {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const infos = data.balance_infos || [];
  const total = infos.reduce((s, i) => s + (Number(i.total_balance) || 0), 0);
  return { total, currency: infos[0]?.currency || 'CNY', isAvailable: !!data.is_available };
}

// Single-session parse (used for the "current turn" cost on the server path),
// cached by mtime+size so the 10s refresh only re-parses when the file changed.
const singleCache = new Map();
function findSessionFile(id) {
  if (!id) return null;
  return findSessionFiles().find((f) => f.includes(id)) || null;
}
function parseSessionFileById(id) {
  const file = findSessionFile(id);
  if (!file) return null;
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const c = singleCache.get(file);
  if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.data;
  const data = parseUsageFile(file);
  singleCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, data });
  return data;
}

// Server-side session list via dsh web's JSON-RPC (authoritative: dsh tracks
// token usage and updates updatedAt when the user switches/opens a session).
async function fetchSessions(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/session.list`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'desktop-' + Date.now(), method: 'session.list', params: {}, payload: {} }),
    signal: AbortSignal.timeout(2500),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const items = data?.result?.value?.items;
  if (!Array.isArray(items)) throw new Error('unexpected session.list response');
  return items.map((it) => {
    const v = it.projections?.values || {};
    const tokens = v.tokenUsage || {};
    return {
      id: it.sessionId,
      updatedAt: it.updatedAt || 0,
      running: !!it.running,
      blank: !!it.blank,
      title: v.title || null,
      tokens: {
        uncachedInputTokens: tokens.uncachedInputTokens || 0,
        cacheReadTokens: tokens.cacheReadTokens || 0,
        outputTokens: tokens.outputTokens || 0,
      },
    };
  });
}

function findSessionFiles() {
  const root = path.join(dshHome, 'sessions');
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl.zstd')) out.push(p);
    }
  };
  walk(root);
  return out;
}

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

// Parse one session file. Returns per-model usage, the max turn number, and the
// usage of that max turn. The model of each call is paired from the preceding
// request/header event (stream order). Usage is read from assistant/chunk
// usage events only (assistant/message also carries usage — a duplicate).
function extractText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('')
    .trim();
}

function parseUsageFile(file) {
  const byModel = {};
  const userMsgByModel = {}; // usage since the last user/message — the "current turn" cost
  let currentModel = null;
  let lastTurnEndSeq = 0;
  let lastSummary = ''; // final assistant text of the last completed turn
  let msgText = '';
  try {
    const buf = fs.readFileSync(file);
    const json = Buffer.from(decompress(new Uint8Array(buf))).toString('utf8');
    for (const line of json.split('\n')) {
      if (!line.includes('"type":')) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'request/header') {
          currentModel = ev.data?.header?.config?.model || currentModel;
          continue;
        }
        if (ev.type === 'user/message') {
          for (const k of Object.keys(userMsgByModel)) delete userMsgByModel[k];
          msgText = '';
          continue;
        }
        if (ev.type === 'turn/end') {
          lastTurnEndSeq = ev.seq || lastTurnEndSeq;
          lastSummary = msgText;
          continue;
        }
        if (ev.type === 'assistant/message') {
          const text = extractText(ev.data?.message?.content);
          if (text) msgText = text;
          continue;
        }
        const u = ev.data?.chunk?.usage;
        if (!u) continue;
        const model = currentModel || 'unknown';
        const norm = {
          input: u.inputTokens || 0,
          cacheRead: u.cacheReadTokens || 0,
          output: u.outputTokens || 0,
          reasoning: u.reasoningTokens || 0,
        };
        const bm = (byModel[model] = byModel[model] || emptyUsage());
        addUsage(bm, norm);
        const um = (userMsgByModel[model] = userMsgByModel[model] || emptyUsage());
        addUsage(um, norm);
      } catch { /* skip malformed lines */ }
    }
  } catch { /* unreadable file: skip */ }
  return { byModel, userMsgByModel, lastTurnEndSeq, lastSummary };
}

// Incremental scan: files whose mtime+size are unchanged reuse cached totals.
// Parsing happens in a worker thread so the first (uncached) scan never
// blocks the main process; falls back to inline parsing if the worker fails.
let balanceWorker = null;
function getBalanceWorker() {
  if (!balanceWorker) {
    const { Worker } = require('node:worker_threads');
    balanceWorker = new Worker(path.join(__dirname, 'balance-worker.js'));
    balanceWorker.on('error', (e) => { console.error('[balance] worker error, falling back to inline parse:', e.message); try { balanceWorker.terminate(); } catch { /* ignore */ } balanceWorker = null; });
    balanceWorker.on('exit', () => { balanceWorker = null; });
  }
  return balanceWorker;
}

function parseFilesInWorker(files) {
  return new Promise((resolve) => {
    if (!files.length) return resolve([]);
    const w = getBalanceWorker();
    if (!w) return resolve(files.map((f) => ({ file: f, data: parseUsageFile(f) })));
    let settled = false;
    const finish = (fn) => (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(v);
    };
    const onMsg = finish((results) => {
      w.removeListener('message', onMsg);
      w.removeListener('error', onErr);
      resolve(results);
    });
    const onErr = finish(() => {
      w.removeListener('message', onMsg);
      balanceWorker = null;
      try { w.terminate(); } catch { /* ignore */ }
      resolve(files.map((f) => ({ file: f, data: parseUsageFile(f) })));
    });
    // Worker hang guard: if the worker does not answer within 30s, fall back
    // to the inline parse so refreshBalance never gets stuck (which would
    // permanently disable the re-entrancy guard and the balance menu).
    const timer = setTimeout(onErr, 30000);
    w.once('message', onMsg);
    w.once('error', onErr);
    w.postMessage(files);
  });
}

// computeUsage is called from both the periodic refresh and calibrateBalance;
// serialize concurrent calls so their worker batches never cross (shared
// worker + shared cache), reusing the in-flight scan.
let usageInflight = null;
async function computeUsage(cache) {
  if (usageInflight) return usageInflight;
  usageInflight = computeUsageInner(cache).finally(() => { usageInflight = null; });
  return usageInflight;
}

async function computeUsageInner(cache) {
  const files = findSessionFiles();
  const changed = [];
  for (const f of files) {
    let st;
    try { st = fs.statSync(f); } catch { continue; }
    const c = cache.get(f);
    if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) continue;
    changed.push({ file: f, mtimeMs: st.mtimeMs, size: st.size });
  }
  if (changed.length) {
    const results = await parseFilesInWorker(changed.map((c) => c.file));
    for (const r of results) {
      const meta = changed.find((c) => c.file === r.file);
      if (meta) cache.set(r.file, { mtimeMs: meta.mtimeMs, size: meta.size, data: r.data });
    }
  }

  const totals = emptyUsage();
  const byModel = {};
  let latest = null; // newest file (by mtime) with its per-model usage + last turn

  for (const f of files) {
    const c = cache.get(f);
    if (!c) continue;
    const d = c.data;
    for (const [model, u] of Object.entries(d.byModel)) {
      addUsage(totals, u);
      addUsage((byModel[model] = byModel[model] || emptyUsage()), u);
    }
    if (!latest || c.mtimeMs > latest.mtimeMs) {
      latest = { file: f, mtimeMs: c.mtimeMs, data: d };
    }
  }

  // Drop cache entries for deleted files.
  const alive = new Set(files);
  for (const k of cache.keys()) if (!alive.has(k)) cache.delete(k);

  const sessionByModel = latest ? latest.data.byModel : {};
  const userMsgByModel = latest ? latest.data.userMsgByModel : {};
  const lastTurnEndSeq = latest ? latest.data.lastTurnEndSeq : 0;
  const lastSummary = latest ? latest.data.lastSummary : '';

  // Per-session breakdown (each session file's own usage), newest first.
  const sessions = files
    .map((f) => {
      const c = cache.get(f);
      return {
        file: f,
        id: path.basename(path.dirname(f)),
        mtimeMs: c ? c.mtimeMs : 0,
        byModel: c ? c.data.byModel : {},
        userMsgByModel: c ? c.data.userMsgByModel : {},
        lastTurnEndSeq: c ? c.data.lastTurnEndSeq : 0,
        lastSummary: c ? c.data.lastSummary : '',
      };
    })
    .filter((s) => s.mtimeMs > 0)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return { totals, byModel, sessionByModel, userMsgByModel, lastTurnEndSeq, lastSummary, sessions };
}

// Cost in CNY for a per-model usage map.
function costOfByModel(byModel, pricing, now = Date.now()) {
  let cost = 0;
  for (const [model, u] of Object.entries(byModel)) {
    const p = priceFor(model, pricing, now);
    cost += (
      (u.input || 0) * p.input +
      (u.cacheRead || 0) * p.cacheHit +
      (u.output || 0) * p.output
    ) / 1e6;
  }
  return cost;
}

// Cost in CNY for the server-side token usage shape returned by dsh's
// session.list RPC: { uncachedInputTokens, cacheReadTokens, outputTokens }.
// The server response carries no model, so the caller passes it (derived from
// the local session parse); default to v4-flash (the current default model).
function costOfTokens(tokens, pricing, model, now = Date.now()) {
  const p = priceFor(model || 'deepseek-v4-flash', pricing, now);
  return (
    (tokens.uncachedInputTokens || 0) * p.input +
    (tokens.cacheReadTokens || 0) * p.cacheHit +
    (tokens.outputTokens || 0) * p.output
  ) / 1e6;
}

// Dominant model of a per-model usage map (largest input+cacheRead+output).
function dominantModel(byModel) {
  let best = null;
  let bestTokens = -1;
  for (const [model, u] of Object.entries(byModel)) {
    const n = (u.input || 0) + (u.cacheRead || 0) + (u.output || 0);
    if (n > bestTokens) { best = model; bestTokens = n; }
  }
  return best;
}

function cacheHitRate(usage) {
  const total = usage.input + usage.cacheRead;
  return total > 0 ? usage.cacheRead / total : 0;
}

function loadState(stateFile) {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return null; }
}

function saveState(stateFile, state) {
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  } catch { /* non-fatal */ }
}

module.exports = {
  setDshHome,
  getDshHome,
  DEFAULT_PRICING,
  getApiKey,
  fetchOfficialBalance,
  fetchSessions,
  computeUsage,
  findSessionFile,
  parseSessionFileById,
  costOfByModel,
  costOfTokens,
  dominantModel,
  cacheHitRate,
  loadState,
  saveState,
};
