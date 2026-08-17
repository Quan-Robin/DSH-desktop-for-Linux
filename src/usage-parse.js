'use strict';
// Shared session-file parser — used by the worker thread (balance-worker.js)
// and by the inline fallback in balance.js. Keep it in one place: the two
// copies had already started to drift.

const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { decompress } = require('fzstd');

// Decompress a .zstd session file. Prefer the system `zstd` CLI (C, ~20x
// faster than fzstd's JS decoder — the first balance scan showed a ~15s
// worker stall that froze the UI and looked like a hang); fall back to fzstd
// when zstd is not on PATH.
function decompressZstd(file) {
  return new Promise((resolve) => {
    execFile('zstd', ['-dc', '-q', file], { maxBuffer: 512 * 1024 * 1024, timeout: 30000 }, (err, stdout) => {
      if (!err) return resolve(Buffer.from(stdout));
      try {
        const buf = fs.readFileSync(file);
        resolve(Buffer.from(decompress(new Uint8Array(buf))));
      } catch {
        resolve(null);
      }
    });
  });
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

function extractText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('')
    .trim();
}

// Text content of user/assistant message events — the searchable transcript.
function messageText(ev) {
  if (!ev || typeof ev.type !== 'string') return '';
  if (ev.type === 'user/message') {
    const t = extractText(ev.data?.message?.content) || extractText(ev.data?.content);
    if (t) return t;
    const c = ev.data?.content;
    return typeof c === 'string' ? c : '';
  }
  if (ev.type === 'assistant/message') return extractText(ev.data?.message?.content);
  return '';
}

// Parse one session file. Returns per-model usage, the max turn number, and the
// usage of that max turn. The model of each call is paired from the preceding
// request/header event (stream order). Usage is read from assistant/chunk
// usage events only (assistant/message also carries usage — a duplicate).
async function parseUsageFile(file) {
  const byModel = {};
  const userMsgByModel = {}; // usage since the last user/message — the "current turn" cost
  let currentModel = null;
  let lastTurnEndSeq = 0;
  let lastSummary = ''; // final assistant text of the last completed turn
  let msgText = '';
  try {
    const json = await decompressZstd(file);
    if (!json) return emptyResult();
    const text = json.toString('utf8');
    for (const line of text.split('\n')) {
      if (!line.includes('"type":')) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'request/header') {
          currentModel = ev.data?.header?.config?.model || currentModel;
          continue;
        }
        if (ev.type === 'user/message') {
          // New user message: the "current turn" cost restarts from zero.
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
          msgText = extractText(ev.data?.message?.content) || msgText;
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

function emptyResult() {
  return { byModel: {}, userMsgByModel: {}, lastTurnEndSeq: 0, lastSummary: '' };
}

module.exports = { emptyUsage, addUsage, extractText, messageText, parseUsageFile, decompressZstd };
