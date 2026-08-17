'use strict';
// Unit tests for the pure parts of src/ws-tree.js + wsList/wsPeek against a
// temp directory. Run: node test/ws-tree.test.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildWsEntries, validateRel, wsList, wsPeek, MAX_ENTRIES } from '../src/ws-tree.js';
const PEEK_TOO_BIG = 200 * 1024 + 1; // just over the cap

// validateRel
assert.strictEqual(validateRel(''), true);
assert.strictEqual(validateRel('a/b/c'), true);
assert.strictEqual(validateRel('a//b'), false);
assert.strictEqual(validateRel('a/./b'), false);
assert.strictEqual(validateRel('a/../b'), false);
assert.strictEqual(validateRel('../a'), false);

// buildWsEntries: filtering, sorting (dirs first, locale), rel chaining, cap
const fake = (name, dir) => ({ name, isDirectory: () => dir });
let r = buildWsEntries([fake('z.txt', false), fake('a', true), fake('node_modules', true), fake('.git', true), fake('.DS_Store', false), fake('m.py', false)], '');
assert.deepStrictEqual(r.entries.map((e) => e.name), ['a', 'm.py', 'z.txt'], 'noise filtered, dirs first');
assert.strictEqual(r.entries[0].rel, 'a');
r = buildWsEntries([fake('x', true)], 'src/lib');
assert.strictEqual(r.entries[0].rel, 'src/lib/x');
const many = Array.from({ length: MAX_ENTRIES + 10 }, (_, i) => fake(`f${String(i).padStart(3, '0')}`, false));
r = buildWsEntries(many, '');
assert.strictEqual(r.entries.length, MAX_ENTRIES);
assert.strictEqual(r.truncated, true);

// wsList/wsPeek against a real temp tree
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ws-'));
fs.mkdirSync(path.join(root, 'src'));
fs.mkdirSync(path.join(root, 'node_modules'));
fs.writeFileSync(path.join(root, 'src', 'main.js'), 'l1\nl2\nl3\n');
fs.writeFileSync(path.join(root, 'node_modules', 'junk.js'), 'x');
let res = wsList(root, '');
assert.strictEqual(res.ok, true);
assert.deepStrictEqual(res.entries.map((e) => e.name), ['src'], 'node_modules hidden');
assert.strictEqual(res.entries[0].path, root.replace(/\/+$/, '') + '/src');
res = wsList(root, 'src');
assert.strictEqual(res.ok, true);
assert.strictEqual(res.entries[0].name, 'main.js');
assert.strictEqual(res.entries[0].rel, 'src/main.js');
res = wsList(root, 'nope');
assert.strictEqual(res.ok, false);
assert.strictEqual(res.error, 'not-found');
res = wsList(root, '../etc');
assert.strictEqual(res.ok, false, 'traversal rejected');

res = wsPeek(path.join(root, 'src', 'main.js'));
assert.strictEqual(res.ok, true);
assert.strictEqual(res.content, 'l1\nl2\nl3\n', 'trailing newline preserved (same as the plugin)');
assert.strictEqual(res.binary, false);
assert.strictEqual(res.truncatedLines, false);
const big = path.join(root, 'big.bin');
fs.writeFileSync(big, Buffer.alloc(PEEK_TOO_BIG, 7));
res = wsPeek(big);
assert.strictEqual(res.tooLarge, true);
const bin = path.join(root, 'b.bin');
fs.writeFileSync(bin, Buffer.from([1, 2, 0, 3]));
res = wsPeek(bin);
assert.strictEqual(res.binary, true);

console.log('ws-tree tests OK');
