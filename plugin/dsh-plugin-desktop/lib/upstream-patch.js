'use strict';
// 上游前端补丁器（方案甲）：把「左侧栏无法折叠」等 UI 缺陷直接打进
// @deepseek-ai/dsh-client-ui-layout 的前端 bundle，使**装插件即自动修复**。
//
// 关键设计（避免把用户环境改坏）：
//  * 幂等：已打过（含 MARKER）就跳过；
//  * 可回滚：首次打补丁前把原文件备份为 <file>.dsh-orig（只备份一次）；
//  * 失配安全：锚点字符串找不到（上游升级改了代码）→ 不改文件、只记日志；
//  * 尽力而为：任何异常都不抛出，绝不阻断 dsh 启动。
const fs = require('node:fs');
const path = require('node:path');

const MARKER = '/* dsh-plugin-desktop:patched:';

// 每条补丁：{ id, file, find, replace, note }
// 目前为占位空表——待用户给出「点击折叠按钮时实际现象」后再填入精确锚点，
// 基础设施先就位（定位/备份/幂等/失配日志）。
const PATCHES = [
  {
    id: 'sidebar-drag-collapse',
    note: '左侧栏只能拖动调整宽度，而 setSidebar 把宽度 clamp 到最小 264px，'
        + '拖到底也无法折叠（能置 0 的 toggleSidebar 没有任何按钮调用）。'
        + '这里让"拖到阈值以下"直接折叠为 0 → 渲染成 56px 图标栏。',
    find: 'd.layoutInfo.sidebar = clampWidth(px, 264, 420);',
    // 状态相关阈值：
    //  * 已折叠（sidebar === 0，渲染为 56px 图标栏）时，只要往右拖过 64px 就展开
    //    —— 否则拖动基准是 56，需要拖 100+px 才越过阈值，表现为"拖不出来"；
    //  * 已展开时，往左拖到 160px 以下即折叠。
    replace: 'd.layoutInfo.sidebar = d.layoutInfo.sidebar === 0'
      + ' ? (px > 64 ? clampWidth(px, 264, 420) : 0)'
      + ' : (px < 160 ? 0 : clampWidth(px, 264, 420));',
  },
  {
    id: 'sidebar-handle-when-collapsed',
    note: '折叠后拖动把手被条件渲染屏蔽（!sidebarCollapsed && jsx(DragHandle…)），'
        + '折叠态因此没有任何展开入口（既无按钮也无把手）。去掉该守卫，让把手在'
        + '折叠态也渲染在 56px 图标栏右缘，配合上一条的状态阈值即可拖出。',
    find: '!sidebarCollapsed && (0, react_jsx_runtime.jsx)(DragHandle, {',
    replace: '(0, react_jsx_runtime.jsx)(DragHandle, {',
  },
];

function locateLayoutBundle() {
  // The layout package is a nested dependency of the GLOBAL dsh install, so it is
  // not resolvable from this plugin. Probe the usual global roots explicitly.
  const candidates = [];
  const push = (p) => { if (p && !candidates.includes(p)) candidates.push(p); };
  try {
    const { execSync } = require('node:child_process');
    const root = execSync('npm root -g', { timeout: 4000, encoding: 'utf8' }).trim();
    if (root) push(root);
  } catch { /* npm not on PATH */ }
  push(process.env.DSH_GLOBAL_ROOT);
  push('/home/' + (process.env.USER || '') + '/.npm-global/lib/node_modules');
  push('/usr/local/lib/node_modules');
  push('/usr/lib/node_modules');
  // Walk up from this file and from the dsh process argv looking for node_modules.
  let dir = __dirname;
  for (let i = 0; i < 6 && dir && dir !== '/'; i++) {
    push(path.join(dir, 'node_modules'));
    dir = path.dirname(dir);
  }
  const rel = [
    '@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js',
    '@deepseek-ai/dsh-client-ui-layout/lib/client.js',
  ];
  for (const root of candidates) {
    for (const r of rel) {
      const f = path.join(root, r);
      try { if (fs.existsSync(f)) return f; } catch { /* next */ }
    }
  }
  return null;
}

function applyOne(file, patch, log) {
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch { return 'unreadable'; }
  if (src.includes(`${MARKER}${patch.id} */`)) return 'already';
  if (!src.includes(patch.find)) return 'anchor-missing';
  const backup = `${file}.dsh-orig`;
  try { if (!fs.existsSync(backup)) fs.writeFileSync(backup, src); } catch { /* best effort */ }
  const out = src.replace(patch.find, `${patch.replace} ${MARKER}${patch.id} */`);
  try { fs.writeFileSync(file, out); } catch { return 'write-failed'; }
  log(`[dsh-plugin-desktop] upstream patch applied: ${patch.id} → ${path.basename(file)}`);
  return 'applied';
}

module.exports = function applyUpstreamPatches(ctx) {
  const log = (m) => { try { ctx && ctx.logger ? ctx.logger.info(m) : console.log(m); } catch { /* ignore */ } };
  try {
    if (!PATCHES.length) { log('[dsh-plugin-desktop] upstream patch table empty (nothing to do)'); return { applied: 0 }; }
    const file = locateLayoutBundle();
    if (!file) { log('[dsh-plugin-desktop] layout bundle not found — upstream patches skipped'); return { applied: 0, missing: true }; }
    let applied = 0; const results = {};
    for (const p of PATCHES) {
      const r = applyOne(file, p, log);
      results[p.id] = r;
      if (r === 'applied') applied++;
      if (r === 'anchor-missing') log(`[dsh-plugin-desktop] patch ${p.id} anchor missing (upstream changed) — skipped`);
    }
    return { applied, results, file };
  } catch (e) {
    log(`[dsh-plugin-desktop] upstream patch failed: ${e && e.message}`);
    return { applied: 0, error: String(e && e.message) };
  }
};
