// Desktop shell bridge for the dsh Web UI — second injected module
// (alongside session-menu.js): composer insertion, workspace reporting and
// the floating files-panel toggle button.
//
//   insert-composer {text}   → append `[file: …]` at the composer caret
//   panel-toggle              → floating 📁 button click
//   ws:report (page → main)   → workspaces snapshot + current session cwd,
//                               polled every 2s, sent on change
(function () {
  'use strict';
  if (window.__dshShellBridge) return;
  window.__dshShellBridge = true;

  var sessionsService = null;
  var workspacesService = null;
  var lastReport = '';

  function toMain(kind, payload) {
    var box = document.getElementById('__dsh_desktop_bridge__');
    if (!box) {
      box = document.createElement('div');
      box.id = '__dsh_desktop_bridge__';
      box.style.display = 'none';
      (document.documentElement || document.body).appendChild(box);
    }
    box.dataset.kind = kind;
    box.dataset.payload = JSON.stringify(payload === undefined ? null : payload);
    window.dispatchEvent(new Event('dsh-desktop-to-main'));
  }

  // ---- composer insertion ([data-composer-card] textarea, per the plugin) ----

  function insertComposer(text) {
    var ta = document.querySelector('[data-composer-card] textarea');
    if (!ta) return false;
    ta.focus();
    var start = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
    var end = ta.selectionEnd == null ? start : ta.selectionEnd;
    var atEnd = start >= ta.value.length;
    var sep = atEnd && ta.value && !ta.value.endsWith('\n') ? '\n' : '';
    ta.setRangeText(sep + text, start, end, 'end');
    // React-controlled textarea: the native input event carries the mutation.
    ta.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    return true;
  }

  window.addEventListener('dsh-desktop-to-page', function () {
    var box = document.getElementById('__dsh_desktop_bridge__');
    if (!box || box.dataset.kind !== 'insert-composer') return;
    var payload = null;
    try { payload = JSON.parse(box.dataset.payload || 'null'); } catch (e) { return; }
    if (payload && typeof payload.text === 'string') {
      if (!insertComposer(payload.text)) toMain('composer:miss', null);
    }
  });

  // ---- workspace reporting ----

  function snapshotWorkspaces() {
    try {
      if (!sessionsService || !workspacesService) return null;
      var ws = workspacesService && workspacesService.list.getSnapshot();
      var ss = sessionsService && sessionsService.list.getSnapshot();
      var items = (ws && ws.items) || [];
      var current = ss && ss.current && ss.byId ? ss.byId[ss.current] : null;
      var list = items.map(function (w) {
        return { id: w.workspaceId, title: w.title, path: w.path };
      });
      return {
        list: list,
        currentPath: current ? (current.cwd || '') : '',
        currentSessionId: current ? current.id : null,
      };
    } catch (e) { return null; }
  }

  function reportWorkspaces(force) {
    var snap = snapshotWorkspaces();
    if (!snap) return;
    var json = JSON.stringify(snap);
    if (!force && json === lastReport) return;
    lastReport = json;
    toMain('ws:report', snap);
  }

  // ---- floating toggle button ----

  var toggleBtn = null;
  function ensureToggleButton() {
    if (toggleBtn && toggleBtn.isConnected) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.title = 'Files (Ctrl+Shift+E)';
    btn.setAttribute('aria-label', 'files panel');
    btn.textContent = '📁';
    btn.style.cssText = [
      'position:fixed', 'right:10px', 'top:50%', 'transform:translateY(-50%)',
      'z-index:2147483646', 'width:30px', 'height:44px', 'padding:0',
      'border:1px solid var(--dsw-alias-border-l2,#ddd)', 'border-radius:8px',
      'background:var(--dsw-alias-bg-layer-2,#fff)', 'color:var(--dsw-alias-label-primary,#333)',
      'font-size:15px', 'cursor:pointer', 'opacity:.55', 'line-height:1',
    ].join(';');
    btn.addEventListener('mouseenter', function () { btn.style.opacity = '1'; });
    btn.addEventListener('mouseleave', function () { btn.style.opacity = '.55'; });
    btn.addEventListener('click', function () { toMain('panel:toggle', null); });
    (document.body || document.documentElement).appendChild(btn);
    toggleBtn = btn;
  }

  // ---- Ctrl+click a file path in chat → reveal in the OS file manager ----
  // (port of dsh-pathlink's idea; pure listener — nothing visible is added to
  // the page). Only fires inside conversation/dialog surfaces.
  var PATH_RE = /(^|[\s"'(`[=,(])(\/[A-Za-z0-9._\-/ @]+\/[A-Za-z0-9._\-/]+|\.?\/?[A-Za-z0-9_.\-]+(?:\/[A-Za-z0-9_.\-]+)+\.[A-Za-z0-9]{1,8})/;

  function pathCandidateFrom(target) {
    var el = target instanceof Element ? target : null;
    for (var node = el; node && node !== document.body; node = node.parentElement) {
      if (node.children && node.children.length > 3) break; // too coarse a container
      var text = (node.textContent || '').trim();
      if (text && text.length <= 500) {
        var m = text.match(PATH_RE);
        if (m) return m[2];
      }
    }
    return null;
  }

  document.addEventListener('click', function (e) {
    if (!(e.ctrlKey || e.metaKey) || e.defaultPrevented) return;
    var surface = e.target instanceof Element
      && (e.target.closest('[data-slot="conversation.session"]') || e.target.closest('[role="dialog"]'));
    if (!surface) return;
    var p = pathCandidateFrom(e.target);
    if (p) toMain('reveal', { path: p });
  }, true);

  // ---- module (same __ModuleLoader__ contract as session-menu.js) ----

  function factory() {
    var module = { exports: {} };
    module.exports.inject = ['sessions', 'workspaces'];
    module.exports.apply = function (ctx) {
      sessionsService = ctx.get('sessions');
      workspacesService = ctx.get('workspaces');
      ensureToggleButton();
      reportWorkspaces(true);
      var timer = setInterval(function () {
        if (document.hidden) return;
        ensureToggleButton();
        reportWorkspaces(false);
      }, 2000);
      return function () {
        clearInterval(timer);
        if (toggleBtn) toggleBtn.remove();
      };
    };
    return module.exports;
  }

  function directStart() {
    if (window.__dshShellBridgeApplied) return;
    window.__dshShellBridgeApplied = true;
    ensureToggleButton();
    reportWorkspaces(true);
    var timer = setInterval(function () {
      if (document.hidden) return;
      ensureToggleButton();
      reportWorkspaces(false);
    }, 2000);
    window.addEventListener('beforeunload', function () { clearInterval(timer); });
  }

  function boot(attempt) {
    if (window.__ModuleLoader__) {
      try { window.__ModuleLoader__.load({ id: 'dsh-desktop-shell-bridge', factory: factory }); return; }
      catch (e) { console.warn('[dsh-desktop] shell bridge load failed:', e); return; }
    }
    if (attempt < 8) setTimeout(function () { boot(attempt + 1); }, 1200);
    else console.warn('[dsh-desktop] __ModuleLoader__ not found — shell bridge disabled');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', directStart);
  else directStart();
  boot(0);
})();
