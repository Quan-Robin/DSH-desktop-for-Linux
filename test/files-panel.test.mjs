'use strict';
// Contract test for the right sidebar (src/files-panel.html).
//
// The user asked to model the panel on the Reasonix/Codex screenshots:
// light theme, tabs 概览/文件/改动, an Overview page with real session
// stats (cost, turn cost, tokens, hit-rate bar, balance), and the file
// Tabs are 概览 / 改动 / 终端 — the 文件 tab was removed at the user's request.
//
// This test parses the HTML and asserts the structural contract so a
// regression to the old dark 文件/搜索/变更 layout fails loudly.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'src', 'files-panel.html'), 'utf8');

// --- light theme (screenshots are light; not dark) ---
assert.match(html, /color-scheme:\s*light/, 'panel must declare light color-scheme');
assert.match(html, /--bg:\s*#f7f7f8/, 'panel must use the Reasonix/Codex light background');
assert.doesNotMatch(html, /--bg:\s*#17171c/, 'dark background from the previous theme must be gone');

// --- tabs: 概览 / 改动 / 终端（用户决定删掉「文件」栏）---
assert.match(html, /id="tab-overview"/, 'overview tab must exist');
assert.match(html, /id="tab-git"/, 'git tab must exist');
assert.match(html, /id="tab-term"/, 'terminal tab must exist');
assert.doesNotMatch(html, /id="tab-files"/, 'files tab must be gone (removed by user request)');
assert.doesNotMatch(html, /id="page-files"/, 'files page must be gone');
assert.doesNotMatch(html, /id="file-q"/, 'files filter input must be gone');
assert.doesNotMatch(html, /id="tree"/, 'file tree container must be gone');
assert.doesNotMatch(html, /id="tab-search"/, 'standalone search tab must be removed');
assert.doesNotMatch(html, /id="page-search"/, 'standalone search page must be removed');

// tab list in setTab must match the DOM (a stale name throws at click time)
const tabList = html.match(/for \(const t of \[([^\]]*)\]\)/);
assert.ok(tabList, 'setTab must iterate a tab list');
for (const t of ['overview', 'git', 'term']) {
  assert.ok(tabList[1].includes(`'${t}'`), `setTab list must include ${t}`);
}
assert.ok(!tabList[1].includes("'files'"), 'setTab list must not reference the removed files tab');

// default active tab is 概览
assert.match(html, /class="tab active" id="tab-overview"/, 'overview tab is the default active tab');

// --- overview page with real data elements ---
for (const id of [
  'ov-cost', 'ov-turn',       // session / turn cost
  'ov-hit', 'ov-hitbar',      // hit-rate bar
  'ov-in', 'ov-cache', 'ov-out', // current tokens
  'ov-official', 'ov-estimated', // balance
]) {
  assert.ok(html.includes(`id="${id}"`), `overview element #${id} must exist`);
}
assert.ok(html.includes('window.desktop.statsGet()'), 'overview must read stats via IPC');
assert.ok(html.includes('window.desktop.getBalance()'), 'overview balance must read via IPC');

// --- preview must survive the files-tab removal ---
assert.match(html, /window\.desktop\.insertComposer/, 'click-to-reference still works');
assert.match(html, /window\.desktop\.wsPeek/, 'preview still works');

// --- changes tab still wired ---
assert.match(html, /window\.desktop\.wsGit/, 'git tab still reads status/diff');

// --- terminal tab still wired ---
assert.match(html, /api\/shell/, 'terminal tab still connects to the shell bridge');

console.log('files-panel structural contract OK');