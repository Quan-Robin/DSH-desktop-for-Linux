'use strict';
// Session transcript → Markdown exporter (pure, unit-tested).
// Consumes the parsed event objects from a session.jsonl.zstd transcript
// (same shapes usage-parse.js reads) and produces a portable Markdown doc.

// Build the Markdown document from transcript events. Events are the raw
// JSONL lines (parsed): user/message, assistant/message, tool events are
// skipped (they are noise in a readable transcript).
function eventsToMarkdown(events, meta) {
  const m = meta || {};
  const out = [];
  out.push(`# ${m.title || m.sessionId || 'DSH Session'}`);
  const head = [];
  if (m.sessionId) head.push(`- Session: \`${m.sessionId}\``);
  if (m.exportedAt) head.push(`- Exported: ${new Date(m.exportedAt).toISOString()}`);
  if (m.workspace) head.push(`- Workspace: \`${m.workspace}\``);
  if (head.length) out.push(head.join('\n'));

  let turn = 0;
  let inTurn = false;
  for (const ev of events || []) {
    if (!ev || typeof ev.type !== 'string') continue;
    if (ev.type === 'user/message') {
      turn += 1;
      inTurn = true;
      const text = textOf(ev);
      if (text) out.push(`\n## 🧑 Turn ${turn}\n\n${text}\n`);
      else out.push(`\n## 🧑 Turn ${turn}\n`);
      continue;
    }
    if (ev.type === 'assistant/message') {
      const text = textOf(ev);
      if (!text) continue;
      if (!inTurn) {
        turn += 1;
        out.push(`\n## 🤖 Turn ${turn}\n\n${text}\n`);
      } else {
        out.push(`\n**🤖**\n\n${text}\n`);
      }
      continue;
    }
  }
  return out.join('\n').replace(/\n{4,}/g, '\n\n\n') + '\n';
}

// Text content of a user/assistant message event (same extraction rules as
// usage-parse.messageText, kept local so this module has no deps).
function textOf(ev) {
  const content = ev.data?.message?.content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('')
      .trim();
  }
  const c = ev.data?.content;
  return typeof c === 'string' ? c.trim() : '';
}

module.exports = { eventsToMarkdown };
