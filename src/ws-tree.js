'use strict';
// Workspace file-tree backend for the desktop files panel.
// Port of dsh-workspace-explorer's host.js (MIT) to plain Node fs — the shell
// has direct fs access, so no dsh `fs` service is needed. Pure parts
// (filter/sort/cap, rel validation) are exported for unit tests.

const fs = require('node:fs');
const path = require('node:path');

const IGNORED = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv',
  '.pytest_cache', '.ruff_cache', '.mypy_cache', 'dist', 'build', '.next', '.nuxt',
  'coverage', '.idea', 'target']);
const MAX_ENTRIES = 400;
const PEEK_MAX_BYTES = 200 * 1024;
const PEEK_MAX_LINES = 60;

// Build the API entry list from raw readdir results (pure — unit-tested).
function buildWsEntries(raw, baseRel) {
  const out = [];
  for (const e of raw) {
    if (e.name === '.DS_Store') continue;
    if (e.isDirectory() && IGNORED.has(e.name)) continue;
    out.push({
      name: e.name,
      type: e.isDirectory() ? 'directory' : 'file',
      rel: baseRel === '' ? e.name : baseRel + '/' + e.name,
    });
  }
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const truncated = out.length > MAX_ENTRIES;
  return { entries: truncated ? out.slice(0, MAX_ENTRIES) : out, truncated };
}

// '' is the root listing; non-empty rel must be clean segments (no '..').
function validateRel(rel) {
  if (rel === '') return true;
  const segs = String(rel).split('/');
  return segs.every((s) => s !== '' && s !== '.' && s !== '..');
}

function wsList(root, rel) {
  if (!root || !validateRel(rel)) return { ok: false, error: 'bad-args' };
  const abs = rel === '' ? root : root.replace(/\/+$/, '') + '/' + rel;
  let raw;
  try {
    raw = fs.readdirSync(abs, { withFileTypes: true });
  } catch (e) {
    return { ok: false, error: e.code === 'ENOENT' ? 'not-found' : e.message };
  }
  const { entries, truncated } = buildWsEntries(raw, rel);
  // Absolute path per entry (the marker uses it when the panel root is NOT
  // the session cwd, mirroring the plugin's markerFor()).
  for (const e of entries) e.path = rel === '' ? root.replace(/\/+$/, '') + '/' + e.name : abs + '/' + e.name;
  return { ok: true, path: abs, rel, entries, truncated };
}

function wsPeek(p) {
  if (!p) return { ok: false, error: 'bad-args' };
  let st;
  try { st = fs.statSync(p); } catch { return { ok: false, error: 'not-found' }; }
  const size = st.size || 0;
  if (size > PEEK_MAX_BYTES) return { ok: true, tooLarge: true, binary: false, size, content: '', lineCount: 0 };
  let buf;
  try { buf = fs.readFileSync(p); } catch (e) { return { ok: false, error: e.message }; }
  const text = buf.toString('utf8');
  const binary = text.indexOf('\u0000') >= 0;
  const lines = text.split('\n');
  return {
    ok: true, tooLarge: false, binary, size,
    content: lines.slice(0, PEEK_MAX_LINES).join('\n'),
    lineCount: lines.length,
    truncatedLines: lines.length > PEEK_MAX_LINES,
  };
}

module.exports = { wsList, wsPeek, buildWsEntries, validateRel, IGNORED, MAX_ENTRIES };
