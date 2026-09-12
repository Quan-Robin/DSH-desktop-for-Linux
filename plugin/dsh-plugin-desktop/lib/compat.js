'use strict';
// Cross-version compatibility layer for dsh 0.1.0-rc.6/7/8, 0.1.1-rc.1/2 (npm)
// and 0.1.2-alpha.1 (GitHub). dsh's plugin-facing seams move between
// releases; everything here is capability-probed (never version-gated) so a
// new build that restores an old shape keeps working.
//
// ── known spawnTerminal shapes ───────────────────────────────────────────
// 0.1.0-rc.* :  spec { name, rows, cols, graceMs }
//   handle (node-pty style): onData(cb) / write(data) / onExit(cb) / resize(c, r)
// 0.1.2-alpha:  spec { argv, cwd, rows, cols, graceMs, signal }  (argv required —
//   the implementation throws `terminal argv must contain a program` otherwise)
//   handle (stream style): { pid, output: Readable, done: Promise,
//                            write(data): Promise, terminate(): Promise }
//   — no resize, no onData/onExit.
//
// Probe order: argv form FIRST. On 0.1.2-alpha it is the only valid form; on
// 0.1.0-rc.* builds that ignore `argv` and require `name` it throws (good),
// and on hypothetical builds that ignore unknown fields it spawns the same
// shell we asked for (harmless). Name form is the fallback.
//
// unify: spawnTerminalCompat() returns
//   { write(data), onData(cb), onExit(cb), resize(cols, rows), kill() }

const os = require('node:os');

// Error events surfaced on the scoped bus: `agent/*` names exist on
// 0.1.2-alpha.1 (scoped-events.generated.ts); the `turn/*` set is our
// 0.1.0-rc.* guess. Unknown names simply never fire on a given build.
const ERROR_EVENT_NAMES = [
  'agent/error', 'agent/request-error',
  'turn/error', 'session/error', 'provider/error', 'llm/error',
  'request/error', 'assistant/error', 'session/abort', 'turn/failed',
];

function isStreamStyleHandle(handle) {
  return !!handle && typeof handle.write === 'function'
    && typeof handle.terminate === 'function'
    && typeof handle.onData !== 'function'; // node-pty style has onData
}

// Wrap an alpha.1 stream-style handle into the unified shape.
function wrapStreamHandle(handle) {
  const listeners = { data: [], exit: [] };
  let exiting = false;
  const emit = (kind, v) => { for (const cb of listeners[kind]) { try { cb(v); } catch { /* listener error */ } } };
  (async () => {
    try {
      for await (const chunk of handle.output) {
        if (exiting) return;
        emit('data', typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      }
    } catch { /* stream error — fall through to exit */ }
    if (!exiting) {
      exiting = true;
      let code = null;
      try {
        const outcome = await handle.done;
        code = outcome && typeof outcome === 'object' ? (outcome.exitCode ?? outcome.code ?? null) : outcome;
      } catch { code = null; }
      emit('exit', { exitCode: code });
    }
  })();
  return {
    write: (data) => { handle.write(data).catch(() => {}); },
    onData: (cb) => listeners.data.push(cb),
    onExit: (cb) => listeners.exit.push(cb),
    resize: () => { /* alpha.1 has no terminal resize — ignored */ },
    kill: () => { handle.terminate().catch(() => {}); },
  };
}

// Wrap a node-pty style handle (0.1.0-rc.*) into the unified shape.
function wrapPtyHandle(handle) {
  return {
    write: (data) => { try { handle.write(data); } catch { /* dead */ } },
    onData: (cb) => { handle.onData(cb); },
    onExit: (cb) => { handle.onExit(() => cb({ exitCode: null })); },
    resize: (cols, rows) => { try { handle.resize(cols, rows); } catch { /* optional */ } },
    kill: () => { try { handle.kill(); } catch { /* dead */ } },
  };
}

// Spawn a terminal across dsh builds; resolves to the unified handle or null.
//   opts: { shell: 'bash'|'zsh', rows, cols, cwd (session workspace when known) }
async function spawnTerminalCompat(ctx, opts) {
  const o = opts || {};
  const rows = Math.max(2, Math.min(200, Number(o.rows) || 40));
  const cols = Math.max(20, Math.min(500, Number(o.cols) || 120));
  const shell = o.shell === 'zsh' ? 'zsh' : 'bash';
  const sub = ctx.subprocess;
  if (!sub || typeof sub.spawnTerminal !== 'function') return null;

  // 1) 0.1.2-alpha argv form (throws on 0.1.0-rc.* builds that require name).
  try {
    const handle = await sub.spawnTerminal({
      argv: [shell, '-l'],
      cwd: o.cwd || os.homedir(),
      rows, cols,
      graceMs: 5000,
    });
    if (handle) return isStreamStyleHandle(handle) ? wrapStreamHandle(handle) : wrapPtyHandle(handle);
  } catch { /* not an argv build — try the name form */ }

  // 2) 0.1.0-rc.* name form (node-pty style callbacks).
  try {
    const handle = await sub.spawnTerminal({ name: shell, rows, cols, graceMs: 5000 });
    if (handle && typeof handle.onData === 'function') return wrapPtyHandle(handle);
    if (handle) return isStreamStyleHandle(handle) ? wrapStreamHandle(handle) : wrapPtyHandle(handle);
  } catch { /* both forms failed */ }
  return null;
}

module.exports = {
  ERROR_EVENT_NAMES,
  spawnTerminalCompat,
  wrapPtyHandle,
  wrapStreamHandle,
  isStreamStyleHandle,
};
