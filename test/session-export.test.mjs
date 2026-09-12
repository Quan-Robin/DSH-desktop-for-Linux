'use strict';
// Tests for src/session-export.js. Run: node test/session-export.test.mjs
import assert from 'node:assert';
import { eventsToMarkdown } from '../src/session-export.js';

const events = [
  { type: 'request/header', data: { header: { config: { model: 'deepseek-v4-flash' } } } },
  { type: 'user/message', seq: 1, data: { content: '帮我看看这个 bug' } },
  { type: 'assistant/chunk', seq: 2, data: { chunk: { usage: { inputTokens: 10 } } } },
  { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'text', text: '看过了，问题在第 3 行。' }] } } },
  { type: 'tool/whatever', seq: 4, data: { noise: true } },
  { type: 'user/message', seq: 5 },
  { type: 'assistant/message', seq: 6, data: { message: { content: [{ type: 'text', text: '已修复。' }] } } },
  { type: 'turn/end', seq: 7 },
];

const md = eventsToMarkdown(events, { sessionId: 'session-abc', title: '修复 bug', workspace: '/home/u/proj', exportedAt: 1750000000000 });

assert.ok(md.startsWith('# 修复 bug\n'), 'title heading first');
assert.ok(md.includes('- Session: `session-abc`'), 'session id in header');
assert.ok(md.includes('- Workspace: `/home/u/proj`'), 'workspace in header');
assert.ok(md.includes('## 🧑 Turn 1\n\n帮我看看这个 bug'), 'user text under turn heading');
assert.ok(md.includes('**🤖**\n\n看过了，问题在第 3 行。'), 'assistant reply in same turn');
assert.ok(md.includes('## 🧑 Turn 2\n'), 'empty user message still opens a turn');
assert.ok(md.includes('已修复。'), 'second turn reply');
assert.ok(!md.includes('tool/whatever') && !md.includes('noise'), 'non-message events skipped');
assert.ok(!md.includes('assistant/chunk'), 'usage chunks skipped');
// no message events at all → still a valid doc
const empty = eventsToMarkdown([], { sessionId: 's1' });
assert.ok(empty.startsWith('# s1'));
// data.content string shape
const md2 = eventsToMarkdown([{ type: 'user/message', data: { content: 'plain string' } }], { sessionId: 's2' });
assert.ok(md2.includes('plain string'));

console.log('session-export tests OK');
