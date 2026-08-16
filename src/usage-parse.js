'use strict';
// Shared session-file parser — used by the worker thread (balance-worker.js)
// and by the inline fallback in balance.js. Keep it in one place: the two
// copies had already started to drift.

const fs = require('node:fs');
const { decompress } = require('fzstd');

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

// Parse one session file. Returns per-model usage, the max turn number, and the
// usage of that max turn. The model of each call is paired from the preceding
// request/header event (stream order). Usage is read from assistant/chunk
// usage events only (assistant/message also carries usage — a duplicate).
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

module.exports = { emptyUsage, addUsage, extractText, parseUsageFile };
