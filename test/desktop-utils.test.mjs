'use strict';
// Unit tests for src/desktop-utils.js — run: node test/desktop-utils.test.mjs
import assert from 'node:assert';
import { parseDeepLink, deepLinkFromArgv, clampWindowState, migrateProfiles, applyProfile, togglePin, prunePins, PINS_MAX } from '../src/desktop-utils.js';

// deep links
assert.deepStrictEqual(parseDeepLink('dsh://open'), { action: 'open' });
assert.deepStrictEqual(parseDeepLink('dsh://session/session-abc123'), { action: 'session', id: 'session-abc123' });
assert.deepStrictEqual(parseDeepLink('dsh://session/session-a%20b'), { action: 'session', id: 'session-a b' });
assert.deepStrictEqual(parseDeepLink('dsh://session/'), { action: 'open' });
assert.strictEqual(parseDeepLink('https://example.com'), null);
assert.strictEqual(parseDeepLink('dsh://weird/host'), null);
assert.strictEqual(parseDeepLink('garbage'), null);
assert.strictEqual(parseDeepLink(null), null);
assert.deepStrictEqual(deepLinkFromArgv(['/usr/bin/app', 'dsh://open']), { action: 'open' });
assert.deepStrictEqual(deepLinkFromArgv(['/usr/bin/app', '--flag']), null);
assert.strictEqual(deepLinkFromArgv(null), null);

// window state clamping
const wa = [{ x: 0, y: 0, width: 1920, height: 1080 }];
const defaults = { x: 100, y: 100, width: 1280, height: 820, maximized: false };
assert.deepStrictEqual(clampWindowState({ x: 200, y: 200, width: 800, height: 600 }, wa, defaults), { x: 200, y: 200, width: 800, height: 600, maximized: false });
// fully off-screen (monitor unplugged) → defaults
assert.deepStrictEqual(clampWindowState({ x: -5000, y: -5000, width: 800, height: 600 }, wa, defaults), defaults);
// partially visible title area (220px on-screen) → kept
assert.deepStrictEqual(clampWindowState({ x: 1700, y: 100, width: 800, height: 600 }, wa, defaults), { x: 1700, y: 100, width: 800, height: 600, maximized: false });
// only a 20px sliver visible → defaults
assert.deepStrictEqual(clampWindowState({ x: 1900, y: 100, width: 800, height: 600 }, wa, defaults), defaults);
// absurd sizes clamped
const r1 = clampWindowState({ x: 10, y: 10, width: 99999, height: 1 }, wa, defaults);
assert.ok(r1.width <= 7680 && r1.height >= 240);
// garbage → defaults
assert.deepStrictEqual(clampWindowState(null, wa, defaults), defaults);
assert.deepStrictEqual(clampWindowState({ foo: 1 }, wa, defaults), defaults);

// profile migration
const c1 = migrateProfiles({ dshHome: '/home/u/.dsh', port: 3080 });
assert.deepStrictEqual(c1.profiles, [{ name: '默认', dshHome: '/home/u/.dsh', port: 3080 }]);
assert.strictEqual(c1.activeProfile, '默认');
// re-run is stable
const c1b = migrateProfiles(JSON.parse(JSON.stringify(c1)));
assert.strictEqual(c1b.profiles.length, 1);
// drops invalid entries, fixes dangling activeProfile
const c2 = migrateProfiles({ profiles: [{ name: 'a', port: 70000 }, null, { name: 'a', dshHome: '/x' }, { name: 'b', dshHome: '/y', port: 3081 }], activeProfile: 'gone' });
assert.deepStrictEqual(c2.profiles, [{ name: 'a', dshHome: '', port: null }, { name: 'b', dshHome: '/y', port: 3081 }]);
assert.strictEqual(c2.activeProfile, 'a');
// applyProfile
const c3 = applyProfile({ dshHome: '', port: 3080, activeProfile: '默认' }, { name: 'work', dshHome: '/data/dsh-work', port: 3081 });
assert.deepStrictEqual([c3.activeProfile, c3.dshHome, c3.port], ['work', '/data/dsh-work', 3081]);
const c4 = applyProfile({ dshHome: '/a', port: 3080, activeProfile: 'x' }, { name: 'n', dshHome: '', port: null });
assert.deepStrictEqual([c4.dshHome, c4.port], ['', 3080]);

// pins
let pins = [];
pins = togglePin(pins, { id: 'session-a', title: 'A' });
pins = togglePin(pins, { id: 'session-b', title: 'B' });
assert.deepStrictEqual(pins, [{ id: 'session-b', title: 'B' }, { id: 'session-a', title: 'A' }], 'newest pin first');
pins = togglePin(pins, { id: 'session-a', title: 'A2' }); // unpin a
assert.deepStrictEqual(pins, [{ id: 'session-b', title: 'B' }]);
pins = togglePin(pins, { id: 'session-b', title: 'ignored' });
assert.deepStrictEqual(pins, [], 'toggle back off');
// cap
let many = [];
for (let i = 0; i < PINS_MAX + 5; i++) many = togglePin(many, { id: `s${i}`, title: `t${i}` });
assert.strictEqual(many.length, PINS_MAX);
assert.strictEqual(many[0].id, `s${PINS_MAX + 4}`, 'newest survives the cap');
// prune
assert.deepStrictEqual(prunePins([{ id: 'a' }, { id: 'b' }], ['b', 'c']), [{ id: 'b' }]);
assert.deepStrictEqual(prunePins(null, ['a']), []);
assert.deepStrictEqual(togglePin(null, { id: 'x' }), [{ id: 'x', title: '' }]);

console.log('desktop-utils tests OK');
