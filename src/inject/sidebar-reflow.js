// 临时 hack：修复 DSH 左侧栏「折叠后布局不重排（只有改变窗口大小才生效）」。
//
// 上游根因（已从 @deepseek-ai/dsh 的 layout 客户端确认）：
//   布局列宽由 `sidebarCollapsed` 决定，而它只看 `layoutInfo.sidebar === 0`；
//   折叠动作只改了 UI 的 collapsed 状态，没有把 layoutInfo.sidebar 置 0，
//   于是 grid 列宽不变 —— 表现为"点了没反应，改窗口大小才收起来"。
//
// 本 hack 在壳层做两件事（都不改 DSH 代码）：
//   1) 用 ResizeObserver 监听侧栏容器宽度变化；一旦发现它已经变窄（说明折叠动作生效了）
//      但布局列宽还是旧值，就调用 DSH 自己的布局 store 把 sidebar 置 0；
//   2) 若拿不到 store，则退化为"对布局列直接置宽 0"，并留日志便于排查。
(() => {
  if (window.__dshSidebarReflowHack) return;
  window.__dshSidebarReflowHack = true;
  const LOG = (...a) => console.log('[sidebar-reflow]', ...a);

  // DSH 的 store 一般挂在 window 上的 __DSH_* / __dsh* 命名空间；逐个探测。
  function findLayoutStore() {
    const roots = ['__DSH__', '__dsh__', '__DSH_STORE__', '__dsh', '__DSH'];
    for (const key of roots) {
      const ns = window[key];
      if (!ns) continue;
      const cands = [ns.layout, ns.layoutStore, ns.stores && ns.stores.layout];
      for (const c of cands) {
        if (c && typeof c.set === 'function') return c;
      }
      if (typeof ns.set === 'function') return ns;
    }
    return null;
  }

  function isCollapsed(el) {
    if (!el) return false;
    const cls = el.className || '';
    if (typeof cls === 'string' && /collapsed/i.test(cls)) return true;
    const w = el.getBoundingClientRect().width;
    const stored = Number(localStorage.getItem('dsh.sidebar.width') || '0');
    return stored === 0 || (w > 0 && w < 120);
  }

  function forceGridColumn(el, widthPx) {
    // el = 布局列（含侧栏的那一列）。找到 grid 父级，把该列置宽。
    const grid = el.parentElement;
    if (!grid) return false;
    const style = getComputedStyle(grid);
    if (!style.gridTemplateColumns || style.gridTemplateColumns === 'none') return false;
    const cols = style.gridTemplateColumns.split(' ').filter(Boolean);
    if (cols.length < 2) return false;
    const idx = Array.from(grid.children).indexOf(el);
    if (idx < 0 || idx >= cols.length) return false;
    const next = cols.slice();
    next[idx] = `${widthPx}px`;
    grid.style.gridTemplateColumns = next.join(' ');
    LOG('forced grid column', idx, '->', widthPx + 'px', next.join(' '));
    return true;
  }

  function sidebarEl() {
    return document.querySelector('[class*="collapsed"]')
        || document.querySelector('aside')
        || document.querySelector('nav');
  }

  let last = null;
  function apply() {
    const el = sidebarEl();
    if (!el) return;
    const collapsed = isCollapsed(el);
    if (collapsed === last) return;
    last = collapsed;
    LOG('collapse state ->', collapsed);
    const store = findLayoutStore();
    if (store) {
      try { store.set({ sidebar: collapsed ? 0 : 280 }); LOG('store updated'); return; }
      catch (e) { LOG('store update failed:', e.message); }
    }
    // 退化路径：直接改布局列
    const col = el.closest('[style*="grid"]') || el.parentElement;
    if (col) forceGridColumn(col, collapsed ? 0 : 280);
  }

  const ro = new ResizeObserver(() => apply());
  const start = () => {
    const el = sidebarEl();
    if (el) ro.observe(el);
    apply();
    // 折叠按钮点击后也补一次（ResizeObserver 不触发宽度变化时兜底）
    document.addEventListener('click', () => setTimeout(apply, 60), true);
  };
  if (document.readyState === 'complete' || document.readyState === 'interactive') start();
  else document.addEventListener('DOMContentLoaded', start);
  LOG('installed');
})();
