// In-page right-side file panel for dsh-plugin-desktop v0.3.
// Codex-style docked panel rendered inside the dsh Web UI. Data comes from
// the plugin's read-only endpoints (/api/tree, /api/peek, /api/gitstatus).
// Injected as part of the plugin's client bundle; no desktop helpers needed.
(() => {
  if (window.__dshDesktopFilesPanel) return;
  window.__dshDesktopFilesPanel = true;

  const CSS = `
  .dshfp{position:fixed;top:56px;right:0;bottom:0;width:300px;z-index:99990;display:flex;flex-direction:column;
    background:var(--dsw-alias-bg-layer-2,rgba(20,22,27,.96));border-left:1px solid var(--dsw-alias-border-l2,#333);
    font:12.5px/1.6 system-ui,sans-serif;color:var(--dsw-alias-label-primary,#eee);backdrop-filter:blur(6px)}
  .dshfp-head{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l2,#333);font-weight:600;font-size:12px}
  .dshfp-head .tabs{margin-left:auto;display:flex;gap:2px}
  .dshfp-head .tab{padding:2px 8px;border-radius:5px;cursor:pointer;opacity:.65}
  .dshfp-head .tab.active{opacity:1;background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.06))}
  .dshfp-body{flex:1;overflow:auto;padding:4px 0}
  .dshfp-item{display:flex;align-items:center;gap:6px;padding:2px 12px;cursor:pointer;white-space:nowrap}
  .dshfp-item:hover{background:rgba(255,255,255,.05)}
  .dshfp-item.dir{font-weight:600}
  .dshfp-item .ico{width:16px;text-align:center;opacity:.8;flex:none}
  .dshfp .dshfp-empty{padding:18px 12px;color:var(--dsw-alias-label-tertiary,#888);text-align:center}
  .dshfp pre{margin:0;padding:8px 12px;overflow:auto;font:11px/1.5 var(--mono,ui-monospace,monospace);opacity:.92;white-space:pre-wrap;word-break:break-word}
  .dshfp .dshfp-close{position:absolute;top:50%;left:-22px;width:22px;height:48px;border:1px solid var(--dsw-alias-border-l2,#333);border-right:0;border-radius:8px 0 0 8px;
    background:var(--dsw-alias-bg-layer-2,#181a1f);cursor:pointer;font-size:12px;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary,#aaa)}
  `;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // ── state ──
  let root = '';
  let tab = 'files'; // files | git
  let panel = null;
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  async function api(path) {
    try {
      const r = await fetch(path);
      return await r.json();
    } catch { return { ok: false, error: 'fetch-failed' }; }
  }

  async function resolveRoot() {
    // Prefer the visible session's workspace; fall back to ~/.dsh sessions dir marker.
    // The page's workspaces service exposes session cwd — try a few common shapes.
    try {
      const state = await api('/api/state');
      if (state && state.workspace && typeof state.workspace === 'string' && state.workspace) return state.workspace;
    } catch { /* ignore */ }
    return '';
  }

  async function loadFiles(rel) {
    if (!root) { root = await resolveRoot(); }
    const body = panel.querySelector('.dshfp-body');
    body.textContent = '';
    if (!root) {
      body.appendChild(el('div', 'dshfp-empty', '未获取到工作区路径'));
      return;
    }
    const res = await api('/api/tree?root=' + encodeURIComponent(root) + '&rel=' + encodeURIComponent(rel || ''));
    if (!res || !res.ok) {
      body.appendChild(el('div', 'dshfp-empty', (res && res.error) || '加载失败'));
      return;
    }
    if (res.entries.length === 0) {
      body.appendChild(el('div', 'dshfp-empty', '(空目录)'));
    }
    const mkItem = (e) => {
      const item = el('div', e.dir ? 'dshfp-item dir' : 'dshfp-item');
      item.appendChild(el('span', 'ico', e.dir ? '📁' : '📄'));
      item.appendChild(el('span', '', e.name));
      item.addEventListener('click', () => {
        if (e.dir) { loadFiles(e.rel); return; }
        peekFile(e.path);
      });
      body.appendChild(item);
    };
    res.entries.forEach(mkItem);
    if (res.truncated) body.appendChild(el('div', 'dshfp-empty', '（条目过多已截断）'));
    // breadcrumb back
    if (rel) {
      const up = rel.split('/').slice(0, -1).join('/');
      const upItem = el('div', 'dshfp-item dir');
      upItem.appendChild(el('span', 'ico', '⬆'));
      upItem.appendChild(el('span', '', '..'));
      upItem.addEventListener('click', () => loadFiles(up));
      body.prepend(upItem);
    }
  }

  async function peekFile(path) {
    const body = panel.querySelector('.dshfp-body');
    body.textContent = '';
    const res = await api('/api/peek?path=' + encodeURIComponent(path));
    if (!res || !res.ok) {
      body.appendChild(el('div', 'dshfp-empty', (res && (res.error || res.message)) || '无法预览'));
      return;
    }
    const pre = el('pre', '', res.text || '');
    body.appendChild(pre);
    const insert = el('div', 'dshfp-item');
    insert.style.justifyContent = 'center';
    insert.appendChild(el('span', '', '📎 插入引用'));
    insert.addEventListener('click', () => insertRef(res.path || path));
    body.appendChild(insert);
  }

  async function insertRef(path) {
    // Reference as [file: path] — try to insert into the composer textarea.
    const ta = document.querySelector('[data-composer-card] textarea, textarea[data-composer]');
    const marker = '[file: ' + path + ']';
    if (ta) {
      ta.focus();
      const sel = ta.selectionStart ?? ta.value.length;
      const v = ta.value;
      const at = v.slice(0, sel) + marker + v.slice(sel);
      ta.value = at;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      navigator.clipboard?.writeText(marker).catch(() => {});
      window.dispatchEvent(new CustomEvent('dshdp-toast', { detail: '已复制  引用' }));
    }
  }

  async function loadGit() {
    const body = panel.querySelector('.dshfp-body');
    body.textContent = '';
    if (!root) { root = await resolveRoot(); }
    if (!root) {
      body.appendChild(el('div', 'dshfp-empty', '未获取到工作区'));
      return;
    }
    const res = await api('/api/gitstatus?root=' + encodeURIComponent(root));
    if (!res || !res.branch) {
      body.appendChild(el('div', 'dshfp-empty', '非 git 工作区'));
      return;
    }
    const head = el('div', 'dshfp-item', '⎇ ' + (res.branch || ''));
    head.style.fontWeight = '600';
    body.appendChild(head);
    if (res.dirty && res.dirty.length) {
      res.dirty.slice(0, 100).forEach((l) => body.appendChild(el('div', 'dshfp-item', l)));
    } else {
      body.appendChild(el('div', 'dshfp-empty', '工作区干净'));
    }
  }

  function render() {
    const body = panel.querySelector('.dshfp-body');
    body.textContent = '';
    if (tab === 'files') loadFiles('');
    else loadGit();
  }

  function mount() {
    if (panel) return;
    const style = document.createElement('style');
    style.dataset.desktopInject = 'files-panel';
    style.textContent = CSS;
    document.head.appendChild(style);
    panel = document.createElement('div');
    panel.className = 'dshfp';
    panel.dataset.desktopInject = 'files-panel';
    const head = el('div', 'dshfp-head', '文件');
    const tabs = el('div', 'tabs');
    const mkTab = (name, label) => {
      const t = el('div', 'tab', label);
      t.addEventListener('click', () => { tab = name; [...tabs.children].forEach((x) => x.classList.toggle('active', x === t)); render(); });
      return t;
    };
    tabs.appendChild(mkTab('files', '文件'));
    tabs.appendChild(mkTab('git', '变更'));
    head.appendChild(tabs);
    const close = el('div', 'dshfp-close', '»');
    close.addEventListener('click', () => { panel.style.display = 'none'; });
    panel.appendChild(close);
    panel.appendChild(head);
    panel.appendChild(el('div', 'dshfp-body'));
    document.body.appendChild(panel);
    render();
  }

  // Toggle hotkey (Ctrl+Shift+E) + expose toggle.
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === 'E' || e.key === 'e')) {
      e.preventDefault(); e.stopPropagation();
      if (!panel) mount();
      else { panel.style.display = panel.style.display === 'none' ? 'flex' : 'none'; }
    }
  });
  window.__dshDesktopFilesPanelToggle = () => { if (!panel) mount(); else panel.style.display = panel.style.display === 'none' ? 'flex' : 'none'; };
})();