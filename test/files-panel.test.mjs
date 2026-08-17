'use strict';
// Contract test for the right sidebar (src/files-panel.html).
//
// The user asked to model the panel on the Reasonix/Codex screenshots:
// light theme, tabs 概览/文件/改动, an Overview page with real session
// stats (cost, turn cost, tokens, hit-rate bar, balance), and the file
// search folded into the Files tab as a "筛选文件…" filter.
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

// --- tabs: 概览 / 文件 / 改动 (no standalone 搜索 tab) ---
assert.match(html, /id="tab-overview"/, 'overview tab must exist');
assert.match(html, /id="tab-files"/, 'files tab must exist');
assert.match(html, /id="tab-git"/, 'git tab must exist');
assert.doesNotMatch(html, /id="tab-search"/, 'standalone search tab must be removed');
assert.doesNotMatch(html, /id="page-search"/, 'standalone search page must be removed');

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

// --- files tab: filter input merged search ---
assert.match(html, /id="file-q"/, 'files tab must have a filter/search input');
assert.match(html, /筛选文件…/, 'filter input must have the Codex-style "筛选文件…" placeholder (zh)');
assert.match(html, /window\.desktop\.wsSearch/, 'filter must call the workspace content search');

// --- files tab still has tree interaction + preview ---
assert.match(html, /window\.desktop\.wsList/, 'file tree still loads via wsList');
assert.match(html, /window\.desktop\.insertComposer/, 'click-to-reference still works');
assert.match(html, /window\.desktop\.wsPeek/, 'double-click preview still works');

// --- changes tab still wired ---
assert.match(html, /window\.desktop\.wsGit/, 'git tab still reads status/diff');

console.log('files-panel structural contract OK');