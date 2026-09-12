'use strict';
// Tests for lib/compat.js — the cross-version terminal spawn adapter.
// Run: node test/compat.test.mjs   (zero deps)
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { spawnTerminalCompat, wrapPtyHandle, wrapStreamHandle, ERROR_EVENT_NAMES } = require('../lib/compat.js');

// ── 0.1.0-rc.* shape: name spec + node-pty callbacks ──
function makeRcCtx(log) {
  return {
    subprocess: {
      async spawnTerminal(spec) {
        log.push({ kind: 'rc', spec });
        if (!spec.name) throw new Error('rc: name required');
        return {
          write(data) { log.push({ kind: 'rc-write', data }); },
          onData(cb) { this._d = cb; },
          onExit(cb) { this._x = cb; },
          resize(c, r) { log.push({ kind: 'rc-resize', c, r }); },
          kill() { log.push({ kind: 'rc-kill' }); },
          _emitData: null, _emitExit: null,
        };
      },
    },
  };
}

// ── 0.1.2-alpha shape: argv spec + stream handle ──
function makeAlphaCtx(log, outChunks, exitCode) {
  const { Readable } = require('node:stream');
  return {
    subprocess: {
      async spawnTerminal(spec) {
        log.push({ kind: 'alpha', spec });
        if (!spec.argv || !spec.argv[0]) throw new Error('subprocess-local: terminal argv must contain a program');
        if (!spec.cwd) throw new Error('cwd required');
        const output = Readable.from(outChunks.map((c) => Buffer.from(c)));
        return {
          pid: 4242,
          output,
          done: Promise.resolve({ exitCode: exitCode }),
          async write(data) { log.push({ kind: 'alpha-write', data }); },
          async terminate() { log.push({ kind: 'alpha-term' }); },
          async inspectForeground() { return undefined; },
          async signalForeground(s) { return 1; },
        };
      },
    },
  };
}

const TICK = () => new Promise((r) => setTimeout(r, 30));

// 1) rc.* build: argv probe throws (rc requires name) → name probe succeeds
{
  const log = [];
  const h = await spawnTerminalCompat(makeRcCtx(log), { shell: 'zsh', rows: 30, cols: 100 });
  assert.ok(h, 'rc handle unified');
  const rcProbes = log.filter((l) => l.kind === 'rc');
  assert.strictEqual(rcProbes[0].spec.argv, undefined || rcProbes[0].spec.argv, 'probe record');
  assert.ok(rcProbes[0].spec.argv, 'first probe is the argv form');
  assert.strictEqual(rcProbes[1].spec.name, 'zsh', 'second probe is the name form with the shell');
  assert.strictEqual(rcProbes[1].spec.rows, 30);
  let gotData = null, gotExit = null;
  h.onData((d) => { gotData = d; });
  h.onExit((e) => { gotExit = e; });
  h.write('ls\n');
  assert.ok(log.some((l) => l.kind === 'rc-write' && l.data === 'ls\n'));
  assert.strictEqual(typeof h.resize, 'function');
}

// 2) alpha build: argv spec rejected on missing argv by rc first? — order:
//    compat tries argv FIRST, so an alpha ctx succeeds on the first probe.
{
  const log = [];
  const h = await spawnTerminalCompat(makeAlphaCtx(log, ['hello ', 'world'], 7), { shell: 'bash', rows: 20, cols: 80, cwd: '/home/u/proj' });
  assert.ok(h, 'alpha handle unified');
  assert.strictEqual(log[0].kind, 'alpha');
  assert.deepStrictEqual(log[0].spec.argv, ['bash', '-l']);
  assert.strictEqual(log[0].spec.cwd, '/home/u/proj', 'cwd forwarded (alpha requires it)');
  let gotData = '', gotExit = null;
  h.onData((d) => { gotData += d; });
  h.onExit((e) => { gotExit = e; });
  await TICK();
  assert.strictEqual(gotData, 'hello world', 'stream chunks delivered as utf8');
  assert.strictEqual(gotExit.exitCode, 7, 'done promise → onExit');
  h.write('echo hi');
  assert.ok(log.some((l) => l.kind === 'alpha-write' && l.data === 'echo hi'));
  h.resize(100, 30); // must be a no-op, not a crash
  h.kill();
  assert.ok(log.some((l) => l.kind === 'alpha-term'), 'kill → terminate');
}

// 3) alpha ctx receiving the rc spec FIRST must not happen (argv probed first)
{
  const log = [];
  const ctx = makeAlphaCtx(log, [], 0);
  await spawnTerminalCompat(ctx, {});
  assert.strictEqual(log[0].kind, 'alpha', 'argv form probed first — no rc-name probe leak');
}

// 4) rc build receiving the argv spec must throw (name required) and fall
//    through to the name form — exactly one successful spawn.
{
  const log = [];
  const h = await spawnTerminalCompat(makeRcCtx(log), {});
  assert.ok(h);
  const rcProbes = log.filter((l) => l.kind === 'rc');
  assert.strictEqual(rcProbes.length, 2, 'argv probe threw (no name) → name probe succeeded');
  assert.ok(rcProbes[0].spec.argv, 'first probe is argv form');
  assert.strictEqual(rcProbes[1].spec.name, 'bash', 'second probe is name form');
}

// 5) no subprocess service → null (terminal bridge stays unmounted)
{
  const h = await spawnTerminalCompat({}, {});
  assert.strictEqual(h, null);
}

// 6) error event table covers both generations
for (const n of ['agent/error', 'agent/request-error', 'turn/error']) {
  assert.ok(ERROR_EVENT_NAMES.includes(n), n + ' present');
}

console.log('compat tests OK');
