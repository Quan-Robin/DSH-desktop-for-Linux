'use strict';
// Worker for parsing dsh session files (zstd decompress + line scan).
// CPU-heavy work runs off the main process so the UI never blocks on the
// first (uncached) balance scan. The parser itself lives in usage-parse.js
// (shared with balance.js's inline fallback).
//
// Message protocol:
//   [file, ...]                          → usage parse (legacy form)
//   { type: 'search', files, query }     → cross-session content search
const { parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const { decompress } = require('fzstd');
const { parseUsageFile, messageText } = require('./usage-parse');

function searchFile(file, needle, out, cap) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return; }
  let json;
  try { json = Buffer.from(decompress(new Uint8Array(buf))).toString('utf8'); } catch { return; }
  for (const line of json.split('\n')) {
    if (out.length >= cap) return;
    if (!line.includes('"type":')) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    const text = messageText(ev);
    if (!text) continue;
    const idx = text.toLowerCase().indexOf(needle);
    if (idx >= 0) {
      out.push({
        file,
        sessionId: path.basename(path.dirname(file)),
        seq: ev.seq || 0,
        snippet: text.slice(Math.max(0, idx - 40), idx + 120).replace(/\s+/g, ' ').trim(),
      });
    }
  }
}

parentPort.on('message', (msg) => {
  if (Array.isArray(msg)) {
    const results = msg.map((file) => ({ file, data: parseUsageFile(file) }));
    parentPort.postMessage(results);
    return;
  }
  if (msg && msg.type === 'search') {
    const needle = String(msg.query || '').toLowerCase();
    const out = [];
    if (needle) {
      for (const file of msg.files || []) {
        searchFile(file, needle, out, msg.cap || 60);
        if (out.length >= (msg.cap || 60)) break;
      }
    }
    parentPort.postMessage(out);
  }
});
