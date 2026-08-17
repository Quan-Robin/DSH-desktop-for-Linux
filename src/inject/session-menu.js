// Desktop-native session context menu + pinned sessions for DSH-desktop.
//
// Adapted from @baihejiangnan/dsh-session-context-menu v0.2.13 (MIT,
// github.com/baihejiangnan/dsh-session-context-menu) — the menu logic,
// locators and clipboard helpers are close to the original; the desktop
// version adds:
//   * a PINNED section above the session list (desktop-owned state, rendered
//     as an independent partition — dsh's sort modes and DOM order untouched,
//     exactly the property the original author required of a pin feature)
//   * 置顶/取消置顶 menu items
//   * interop: when the original plugin is installed, our own menu stands
//     down and the pin item registers through the plugin's public extension
//     registry instead (no double menus)
//
// Loaded via webContents.executeJavaScript from the desktop shell; runs in
// the page world and talks to the shell through the DOM mailbox bridge set up
// by webview-preload.js (CustomEvent.detail does not cross isolated worlds).
(function () {
  'use strict';
  if (window.__dshDesktopMenu) return;
  window.__dshDesktopMenu = true;

  var OFFICIAL_STYLE = 'style[data-plugin-css="@baihejiangnan/dsh-session-context-menu"]';
  var KEY = Symbol.for('dsh.session-context-menu.extensions');

  var CSS =
    '.dshcm-menu{position:fixed;z-index:2147483647;width:max-content;min-width:148px;max-width:260px;padding:4px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#161616);border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:7px;box-shadow:0 5px 16px #00000029;font:13px/18px system-ui,sans-serif}' +
    '.dshcm-item{box-sizing:border-box;width:100%;height:30px;padding:0 8px;text-align:left;white-space:nowrap;color:inherit;background:transparent;border:0;border-radius:5px;cursor:pointer;display:flex;gap:16px;align-items:center;justify-content:space-between}' +
    '.dshcm-item:hover,.dshcm-item:focus-visible{background:var(--dsw-alias-interactive-bg-hover,#0000000f);outline:none}' +
    '.dshcm-shortcut{color:var(--dsw-alias-label-tertiary,#777);font-size:11px}' +
    '.dshcm-separator{height:1px;margin:4px -4px;background:var(--dsw-alias-border-l2,#ddd)}' +
    '.dshcm-toast{position:fixed;z-index:2147483647;left:50%;bottom:28px;transform:translateX(-50%);padding:7px 12px;border-radius:7px;background:#222;color:#fff;font:13px/18px system-ui,sans-serif;box-shadow:0 6px 20px #0003}' +
    '.dshdp-section{margin:2px 6px 6px;border:1px solid var(--dsw-alias-border-l2,#e2e2e2);border-radius:8px;padding:4px;background:var(--dshdp-section-bg,transparent)}' +
    '.dshdp-head{display:flex;align-items:center;gap:6px;padding:2px 6px 4px;font-size:11px;color:var(--dsh-dp-head,#8a8a8a);user-select:none}' +
    '.dshdp-item{display:flex;align-items:center;gap:6px;height:28px;padding:0 8px;border-radius:5px;cursor:pointer;color:var(--dsh-dp-item,#333);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}' +
    '.dshdp-item:hover{background:var(--dsw-alias-interactive-bg-hover,#0000000f)}' +
    '.dshdp-title{overflow:hidden;text-overflow:ellipsis;flex:1}' +
    '.dshdp-gone{opacity:.45}' +
    '.dshdp-empty{padding:2px 8px 4px;font-size:11px;color:var(--dsh-dp-empty,#9a9a9a);user-select:none}';

  // ---------- shell bridge (DOM mailbox, see webview-preload.js) ----------

  var pins = [];
  var sessionsService = null;
  var workspacesService = null;

  function toMain(kind, payload) {
    var box = document.getElementById('__dsh_desktop_bridge__');
    if (!box) {
      // The preload normally creates the mailbox before page scripts run;
      // create it ourselves as a fallback (DOM is shared across worlds).
      box = document.createElement('div');
      box.id = '__dsh_desktop_bridge__';
      box.style.display = 'none';
      (document.documentElement || document.body).appendChild(box);
    }
    box.dataset.kind = kind;
    box.dataset.payload = JSON.stringify(payload === undefined ? null : payload);
    window.dispatchEvent(new Event('dsh-desktop-to-main'));
  }

  window.addEventListener('dsh-desktop-to-page', function () {
    var box = document.getElementById('__dsh_desktop_bridge__');
    if (!box || !box.dataset.kind) return;
    var payload = null;
    try { payload = JSON.parse(box.dataset.payload || 'null'); } catch (e) { return; }
    if (box.dataset.kind === 'pins') {
      pins = Array.isArray(payload) ? payload : [];
      renderPins();
    } else if (box.dataset.kind === 'jump' && payload) {
      openSession(payload && payload.id ? payload.id : payload, payload && payload.title);
    }
  });

  // ---------- pinned state helpers ----------

  function isPinned(id) {
    return pins.some(function (p) { return p && p.id === id; });
  }

  function togglePin(session) {
    if (!session || !session.id) return;
    toMain('pins:toggle', { id: session.id, title: session.displayTitle || session.title || '' });
    toast(isPinned(session.id) ? '已取消置顶' : '已置顶（列表上方查看）');
  }

  function sessionTitle(id) {
    try {
      var state = sessionsService && sessionsService.list.getSnapshot();
      var item = state && state.byId && state.byId[id];
      if (item) return item.displayTitle || item.title || '';
    } catch (e) { /* snapshot unavailable */ }
    var pin = pins.find(function (p) { return p && p.id === id; });
    return pin ? pin.title : id;
  }

  function sessionAlive(id) {
    try {
      var state = sessionsService && sessionsService.list.getSnapshot();
      return !!(state && state.byId && state.byId[id]);
    } catch (e) { return false; }
  }

  function openSession(id, title) {
    var row = findSessionRow(title || sessionTitle(id));
    if (row) { row.click(); return; }
    if (sessionsService) {
      try { sessionsService.open(id); return; } catch (e) { /* fall through */ }
    }
    toast('无法打开会话：' + (title || id));
  }

  function findSessionRow(title) {
    if (!title) return null;
    var rows = document.querySelectorAll('[role="treeitem"]');
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var text = (row.textContent || '').trim();
      if (text.indexOf(title) >= 0) return row;
    }
    return null;
  }

  // ---------- pinned section (independent partition above the list) ----------

  var pinSection = null;
  var pinListEl = null;
  var pinObserver = null;
  var pinTimer = null;
  var lastPinSignature = '';

  function listContainer() {
    var row = document.querySelector('[role="treeitem"]');
    return row ? row.parentElement : null;
  }

  function buildPinSection() {
    var section = document.createElement('div');
    section.className = 'dshdp-section';
    section.dataset.desktopInject = 'pinned-sessions';
    var head = document.createElement('div');
    head.className = 'dshdp-head';
    head.textContent = '📌 置顶';
    section.appendChild(head);
    var list = document.createElement('div');
    list.className = 'dshdp-list';
    section.appendChild(list);
    return { section: section, list: list };
  }

  function renderPins() {
    var container = listContainer();
    if (!container) return;
    if (!container.parentNode || typeof container.parentNode.insertBefore !== 'function') return;
    if (!pinSection || !pinSection.isConnected) {
      var built = buildPinSection();
      pinSection = built.section;
      pinListEl = built.list;
      container.parentNode.insertBefore(pinSection, container);
    } else if (pinSection.nextElementSibling !== container) {
      // React re-rendered the neighborhood — reclaim our position.
      container.parentNode.insertBefore(pinSection, container);
    }
    var signature = JSON.stringify(pins);
    var titles = pins.map(function (p) { return p && sessionTitle(p.id); });
    if (signature === lastPinSignature && pinListEl.childElementCount === pins.length) {
      // cheap title-only refresh (renames)
      var items = pinListEl.children;
      for (var i = 0; i < items.length && i < titles.length; i++) {
        var span = items[i].querySelector('.dshdp-title');
        if (span && span.textContent !== titles[i]) span.textContent = titles[i];
      }
      return;
    }
    lastPinSignature = signature;
    pinListEl.textContent = '';
    if (!pins.length) {
      var empty = document.createElement('div');
      empty.className = 'dshdp-empty';
      empty.textContent = '右键会话 → 置顶会话';
      pinListEl.appendChild(empty);
      return;
    }
    pins.forEach(function (p) {
      if (!p || !p.id) return;
      var item = document.createElement('div');
      item.className = 'dshdp-item' + (sessionAlive(p.id) ? '' : ' dshdp-gone');
      item.setAttribute('role', 'button');
      item.tabIndex = 0;
      var pin = document.createElement('span');
      pin.textContent = '📌';
      item.appendChild(pin);
      var span = document.createElement('span');
      span.className = 'dshdp-title';
      span.textContent = sessionTitle(p.id);
      item.appendChild(span);
      item.addEventListener('click', function () { openSession(p.id, p.title); });
      item.addEventListener('keydown', function (e) { if (e.key === 'Enter') openSession(p.id); });
      item.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        e.stopPropagation();
        showPinMenu(e, p);
      });
      pinListEl.appendChild(item);
    });
  }

  function watchPins() {
    if (pinObserver) pinObserver.disconnect();
    pinObserver = new MutationObserver(function () {
      // Re-attach if the framework dropped or moved our section; re-render
      // when the list itself changed (new/removed rows → live titles).
      if (!pinSection || !pinSection.isConnected || pinSection.nextElementSibling !== listContainer()) {
        lastPinSignature = '';
        renderPins();
      }
    });
    pinObserver.observe(document.body, { childList: true, subtree: true });
    if (pinTimer) clearInterval(pinTimer);
    pinTimer = setInterval(function () {
      if (document.hidden) return;
      if (pins.length) renderPins();
    }, 3000);
  }

  // ---------- context menu plumbing (adapted from the MIT plugin) ----------

  var menu = null;
  function close() { if (menu) { menu.remove(); menu = null; } }

  // DOM-only right-click menu used when sessions/workspaces services are
  // unavailable (directStart path: __ModuleLoader__ registers the factory but
  // does not run it, so ctx services stay null). Provides the actions that do
  // not need the service APIs: text select/copy and reload.
  function buildDomOnlyMenu(event) {
    var editable = editableFrom(event.target);
    var selection = selectedText(editable).trim();
    if (!editable && !selection) return; // nothing actionable without services
    event.preventDefault();
    event.stopPropagation();
    close();
    var root = document.createElement('div');
    root.className = 'dshcm-menu';
    root.setAttribute('role', 'menu');
    root.style.visibility = 'hidden';
    document.body.appendChild(root);
    menu = root;
    if (editable) {
      add(root, '撤销', function () { editable.focus(); if (!document.execCommand('undo')) throw new Error('请使用 Ctrl+Z 撤销'); }, 'Ctrl+Z');
      add(root, '重做', function () { editable.focus(); if (!document.execCommand('redo')) throw new Error('请使用 Ctrl+Y 重做'); }, 'Ctrl+Y');
      split(root);
      add(root, '剪切', function () { if (selection) copy(selection, '已剪切'); replaceSelection(editable, ''); }, 'Ctrl+X');
      add(root, '复制', function () { return copy(selection, '已复制'); }, 'Ctrl+C');
      add(root, '粘贴', function () { return readClipboard().then(function (text) { replaceSelection(editable, text); }); }, 'Ctrl+V');
      split(root);
      add(root, '全选', function () {
        editable.focus();
        if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) editable.select();
        else selectSurface(editable);
      }, 'Ctrl+A');
    } else if (selection) {
      add(root, '复制所选文本', function () { return copy(selection, '已复制'); }, 'Ctrl+C');
    }
    split(root);
    add(root, '刷新', function () { globalThis.location.reload(); }, 'Ctrl+R');
    positionMenu(root, event);
  }

  function add(root, label, run, shortcut) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'dshcm-item';
    button.setAttribute('role', 'menuitem');
    button.tabIndex = -1;
    var text = document.createElement('span');
    text.textContent = label;
    button.appendChild(text);
    if (shortcut) {
      var hint = document.createElement('span');
      hint.className = 'dshcm-shortcut';
      hint.textContent = shortcut;
      button.appendChild(hint);
    }
    button.onclick = function () {
      close();
      try {
        var r = run();
        if (r && typeof r.catch === 'function') r.catch(function (error) { toast(error && error.message || String(error)); });
      } catch (error) { toast(error && error.message || String(error)); }
    };
    root.appendChild(button);
  }

  function split(root) {
    if (!root.childElementCount || root.lastElementChild.classList.contains('dshcm-separator')) return;
    var node = document.createElement('div');
    node.className = 'dshcm-separator';
    node.setAttribute('role', 'separator');
    root.appendChild(node);
  }

  function positionMenu(root, event) {
    var rect = root.getBoundingClientRect();
    root.style.left = Math.max(6, Math.min(event.clientX, innerWidth - rect.width - 6)) + 'px';
    root.style.top = Math.max(6, Math.min(event.clientY, innerHeight - rect.height - 6)) + 'px';
    root.style.visibility = 'visible';
  }

  function position(root, event) {
    var rect = root.getBoundingClientRect();
    root.style.left = Math.max(6, Math.min(event.clientX, innerWidth - rect.width - 6)) + 'px';
    root.style.top = Math.max(6, Math.min(event.clientY, innerHeight - rect.height - 6)) + 'px';
    root.style.visibility = 'visible';
    root.querySelector('button') && root.querySelector('button').focus();
  }

  function showPinMenu(event, pin) {
    close();
    var root = document.createElement('div');
    root.className = 'dshcm-menu';
    root.setAttribute('role', 'menu');
    root.style.visibility = 'hidden';
    document.body.appendChild(root);
    menu = root;
    add(root, '打开会话', function () { openSession(pin.id); });
    add(root, '取消置顶', function () { toMain('pins:toggle', { id: pin.id, title: sessionTitle(pin.id) }); });
    position(root, event);
  }

  function isAction(button) {
    var label = (button.getAttribute('aria-label') || '').toLocaleLowerCase();
    return (label.indexOf('会话') >= 0 && label.indexOf('操作') >= 0) || (label.indexOf('session') >= 0 && label.indexOf('action') >= 0);
  }

  function isWorkspaceAction(button) {
    var label = (button.getAttribute('aria-label') || '').toLocaleLowerCase();
    return (label.indexOf('工作区') >= 0 && label.indexOf('操作') >= 0) || (label.indexOf('workspace') >= 0 && label.indexOf('action') >= 0);
  }

  function rowFrom(target) {
    var row = target instanceof Element ? target.closest('[role="treeitem"]') : null;
    if (!row) return null;
    if (row.hasAttribute('aria-selected')) return row;
    var buttons = row.querySelectorAll('button[aria-label]');
    for (var i = 0; i < buttons.length; i++) if (isAction(buttons[i])) return row;
    return null;
  }

  function treeItemWorkspace(row, items) {
    if (!row) return null;
    var matches = items.filter(function (workspace) {
      var values = [row.getAttribute('aria-label'), row.getAttribute('title')];
      for (var i = 0; i < values.length; i++) {
        if (values[i] && values[i].trim() === workspace.title) return true;
      }
      var nodes = row.querySelectorAll('span,button,div');
      for (var j = 0; j < nodes.length; j++) {
        var node = nodes[j];
        if (node.closest('[role="treeitem"]') === row && node.children.length === 0 &&
            node.textContent && node.textContent.trim() === workspace.title) return true;
      }
      return false;
    });
    return matches.length === 1 ? matches[0] : null;
  }

  function workspaceFrom(target, workspaces) {
    var targetRow = target instanceof Element ? target.closest('[role="treeitem"]') : null;
    if (!targetRow) return null;
    var items = workspaces.list.getSnapshot().items;
    for (var row = targetRow; row; row = row.parentElement ? row.parentElement.closest('[role="treeitem"]') : null) {
      var workspace = treeItemWorkspace(row, items);
      if (workspace) return { workspace: workspace, row: row, targetRow: targetRow };
    }
    var rows = document.querySelectorAll('[role="treeitem"]');
    var level = Number(targetRow.getAttribute('aria-level'));
    var rowsArr = Array.prototype.slice.call(rows);
    var start = rowsArr.indexOf(targetRow) - 1;
    for (var index = start; index >= 0; index -= 1) {
      var candidate = rowsArr[index];
      var candidateLevel = Number(candidate.getAttribute('aria-level'));
      if (Number.isFinite(level) && Number.isFinite(candidateLevel) && candidateLevel >= level) continue;
      if (rowFrom(candidate)) continue;
      var ws = treeItemWorkspace(candidate, items);
      if (ws) return { workspace: ws, row: candidate, targetRow: targetRow };
      if (Number.isFinite(level) && Number.isFinite(candidateLevel) && candidateLevel < level) break;
    }
    return null;
  }

  function officialAction(row) {
    var buttons = row.querySelectorAll('button[aria-label]');
    for (var i = 0; i < buttons.length; i++) if (isAction(buttons[i])) return buttons[i];
    var spans = row.querySelectorAll('span');
    var title = '';
    for (var j = 0; j < spans.length; j++) {
      if (spans[j].children.length === 0 && spans[j].textContent && spans[j].textContent.trim()) { title = spans[j].textContent.trim(); break; }
    }
    var all = document.querySelectorAll('button[aria-label]');
    for (var k = 0; k < all.length; k++) {
      var button = all[k];
      if (!isAction(button)) continue;
      if (!title || (button.getAttribute('aria-label') || '').indexOf(title) >= 0) return button;
    }
    return null;
  }

  function officialSelect(row, labels, failureMessage) {
    var action = officialAction(row);
    if (!action) {
      row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: row.getBoundingClientRect().left + 8, clientY: row.getBoundingClientRect().top + 8 }));
      return new Promise(function (resolve) {
        requestAnimationFrame(function () { requestAnimationFrame(function () { resolve(); }); });
      }).then(function () {
        var found = officialAction(row);
        if (!found) throw new Error('当前会话尚未提供该官方操作');
        found.click();
        setTimeout(function () { pickMenuItem(labels, failureMessage); }, 0);
      });
    }
    action.click();
    setTimeout(function () { pickMenuItem(labels, failureMessage); }, 0);
    return Promise.resolve();
  }

  function pickMenuItem(labels, failureMessage) {
    var items = document.querySelectorAll('[role="menuitem"]');
    for (var i = 0; i < items.length; i++) {
      var text = items[i].textContent || '';
      for (var j = 0; j < labels.length; j++) {
        if (labels[j].test(text.trim())) { items[i].click(); return; }
      }
    }
    toast(failureMessage);
  }

  function officialWorkspaceSelect(row, labels, failureMessage) {
    var buttons = row.querySelectorAll('button[aria-label]');
    var action = null;
    for (var i = 0; i < buttons.length; i++) if (isWorkspaceAction(buttons[i])) { action = buttons[i]; break; }
    if (!action) throw new Error('找不到官方工作区操作');
    action.click();
    setTimeout(function () { pickMenuItem(labels, failureMessage); }, 0);
  }

  function titleFrom(row) {
    var buttons = row.querySelectorAll('button[aria-label]');
    var label = '';
    for (var i = 0; i < buttons.length; i++) {
      if (isAction(buttons[i])) { label = buttons[i].getAttribute('aria-label') || ''; break; }
    }
    var m = label.match(/[“"](.+?)[”"]/);
    return (m && m[1]) || (row.firstElementChild && row.firstElementChild.textContent || '').trim() || '';
  }

  function resolveSession(sessions, row, workspace) {
    var state = sessions.list.getSnapshot();
    if (row.getAttribute('aria-selected') === 'true' && state.current) {
      return state.byId[state.current] || null;
    }
    var title = titleFrom(row);
    if (!title) return null;
    var ids = (workspace && workspace.sessionIds) || state.ids || [];
    var matches = ids.map(function (id) { return state.byId[id]; }).filter(function (item) {
      return item && (
        item.title === title ||
        item.displayTitle === title ||
        (item.blank && /^(新会话|new session)$/i.test(title))
      );
    });
    return matches.length === 1 ? matches[0] : null;
  }

  function toast(message) {
    var old = document.querySelector('.dshcm-toast');
    if (old) old.remove();
    var node = document.createElement('div');
    node.className = 'dshcm-toast';
    node.textContent = message;
    document.body.appendChild(node);
    setTimeout(function () { node.remove(); }, 1800);
  }

  function legacyCopy(text) {
    var field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(field);
    field.select();
    var copied = document.execCommand('copy');
    field.remove();
    if (!copied) throw new Error('剪贴板不可用');
  }

  function writeClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () { legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function readClipboard() {
    if (navigator.clipboard && navigator.clipboard.readText) {
      return navigator.clipboard.readText().catch(function () {
        throw new Error('无法读取剪贴板，请使用 Ctrl+V');
      });
    }
    return Promise.reject(new Error('无法读取剪贴板，请使用 Ctrl+V'));
  }

  function copy(text, message) {
    return writeClipboard(text).then(function () { toast(message); });
  }

  function workspaceForSession(workspaces, session) {
    if (!session) return null;
    var items = workspaces.list.getSnapshot().items;
    for (var i = 0; i < items.length; i++) {
      if (items[i].sessionIds.indexOf(session.id) >= 0) return items[i];
    }
    return null;
  }

  function renameSession(sessions, row, session) {
    if (officialAction(row)) {
      return officialSelect(row, [/^重命名$/i, /^rename$/i], '无法打开官方重命名窗口');
    }
    if (!session) throw new Error('无法确定当前会话');
    var title = globalThis.prompt('重命名会话', session.displayTitle || session.title || '');
    if (title === null || title.trim() === (session.title || session.displayTitle)) return Promise.resolve();
    if (!title.trim()) throw new Error('会话名称不能为空');
    var binding = sessions.binding(session.id);
    if (!binding) throw new Error('无法取得官方会话服务');
    return binding.session.rename(title.trim()).then(function (result) {
      if (!result.ok) throw new Error((result.error && result.error.message) || '重命名失败');
      toast('会话已重命名');
    });
  }

  function archiveSession(workspaces, row, session) {
    if (officialAction(row)) {
      return officialSelect(row, [/^归档会话$/i, /^archive( session)?$/i], '无法调用官方归档会话');
    }
    if (!session) throw new Error('无法确定当前会话');
    return workspaces.archiveSession(session.id).then(function () { toast('会话已归档'); });
  }

  function forkSession(sessions, row, session) {
    if (officialAction(row)) {
      return officialSelect(row, [/^分叉会话$/i, /^fork( session)?$/i], '无法调用官方分叉会话');
    }
    if (!session) throw new Error('无法确定当前会话');
    return sessions.fork({ sessionId: session.id, increaseTitle: true }).then(function (childId) {
      sessions.open(childId);
    });
  }

  function archiveWorkspaceSessions(workspaces, workspace) {
    var archived = new Set(workspaces.list.getSnapshot().archivedSessionIds);
    var sessionIds = workspace.sessionIds.filter(function (id) { return !archived.has(id); });
    if (!sessionIds.length) { toast('该工作区没有可归档的会话'); return Promise.resolve(); }
    if (!globalThis.confirm('归档“' + workspace.title + '”中的 ' + sessionIds.length + ' 个会话？')) return Promise.resolve();
    var chain = Promise.resolve();
    sessionIds.forEach(function (id) { chain = chain.then(function () { return workspaces.archiveSession(id); }); });
    return chain.then(function () { toast('已归档 ' + sessionIds.length + ' 个会话'); });
  }

  function removeWorkspace(workspaces, workspace) {
    if (!globalThis.confirm('从 Harness 中移除工作区“' + workspace.title + '”？\n\n目录、文件和会话日志不会被删除。')) return Promise.resolve();
    return workspaces.delete(workspace.workspaceId).then(function () { toast('已移除工作区'); });
  }

  function editableFrom(target) {
    return target instanceof Element
      ? target.closest('input:not([type="button"]):not([type="submit"]),textarea,[contenteditable="true"]')
      : null;
  }

  function selectedText(editable) {
    if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
      return editable.value.slice(editable.selectionStart || 0, editable.selectionEnd || 0);
    }
    var selection = globalThis.getSelection();
    if (!selection) return '';
    if (editable && (!editable.contains(selection.anchorNode) || !editable.contains(selection.focusNode))) return '';
    return selection.toString();
  }

  function replaceSelection(editable, value) {
    editable.focus();
    if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
      var start = editable.selectionStart == null ? editable.value.length : editable.selectionStart;
      var end = editable.selectionEnd == null ? start : editable.selectionEnd;
      editable.setRangeText(value, start, end, 'end');
      editable.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      return;
    }
    var selection = globalThis.getSelection();
    if (!selection || !selection.rangeCount || !editable.contains(selection.anchorNode)) throw new Error('无法确定编辑位置');
    var range = selection.getRangeAt(0);
    range.deleteContents();
    var text = document.createTextNode(value);
    range.insertNode(text);
    range.setStartAfter(text);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    editable.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  }

  function selectSurface(surface) {
    if (!surface) return;
    var selection = globalThis.getSelection();
    if (!selection) return;
    var range = document.createRange();
    range.selectNodeContents(surface);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function selectionSurface(target) {
    var conversation = target instanceof Element ? target.closest('[data-slot="conversation.session"]') : null;
    if (conversation) return conversation;
    var dialog = target instanceof Element ? target.closest('[role="dialog"]') : null;
    if (dialog) return dialog;
    var hero = target instanceof Element ? target.closest('[data-phase="hero"]') : null;
    return hero && hero.querySelector(':scope > [data-conversation-scroll]') ? hero : null;
  }

  function selectedUrl(value) {
    var text = (value || '').trim();
    if (!/^https?:\/\/\S+$/i.test(text)) return null;
    try { return new URL(text).href; } catch (e) { return null; }
  }

  // ---------- interop with the original plugin (when it is installed) ----------

  var interopEntry = null;
  function officialPluginPresent() {
    return !!(document.querySelector(OFFICIAL_STYLE) || globalThis[KEY]);
  }

  function ensureInterop() {
    var registry = globalThis[KEY];
    if (!registry || interopEntry) return;
    try {
      interopEntry = {
        id: 'dsh-desktop.pin',
        order: 80,
        label: '置顶会话',
        visible: function (ctx) { return !!(ctx && ctx.session); },
        run: function (ctx) { togglePin(ctx && ctx.session); },
      };
      registry.register(interopEntry);
    } catch (e) { interopEntry = null; }
  }

  // The plugin dispatches this on every menu open — refresh the dynamic label.
  window.addEventListener('dsh:session-context-menu', function (e) {
    if (!interopEntry) return;
    var session = e.detail && e.detail.session;
    interopEntry.label = session && isPinned(session.id) ? '取消置顶' : '置顶会话';
  });

  // ---------- main contextmenu handler ----------

  function onContextMenu(event) {
    if (event.defaultPrevented) return;
    // Our pinned section always owns its own items.
    var pinItem = event.target instanceof Element ? event.target.closest('.dshdp-section') : null;
    if (pinItem) return; // item-level handlers already intercepted
    // If the original plugin is installed, it owns the menu — only make sure
    // our pin extension is registered inside it.
    if (officialPluginPresent()) {
      ensureInterop();
      return;
    }
    var sessions = sessionsService;
    var workspaces = workspacesService;
    var servicesAbsent = !sessions || !workspaces;
    if (servicesAbsent) {
      // directStart path: __ModuleLoader__ only registers the factory, it does
      // not run it here, so sessions/workspaces may be null. Build a DOM-only
      // menu (no service calls) so right-click still works.
      return buildDomOnlyMenu(event);
    }
    var row = rowFrom(event.target);
    var domSessionWorkspace = row && workspaceFrom(event.target, workspaces);
    var session = row && resolveSession(sessions, row, domSessionWorkspace && domSessionWorkspace.workspace);
    var resolvedWorkspace = (domSessionWorkspace && domSessionWorkspace.workspace) || workspaceForSession(workspaces, session);
    var workspaceTarget = !row && workspaceFrom(event.target, workspaces);
    var editable = editableFrom(event.target);
    var selection = selectedText(editable).trim();
    var link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    var surface = selectionSurface(event.target);
    if (!row && !workspaceTarget && !editable && !selection && !link && !surface) return;
    event.preventDefault();
    event.stopPropagation();
    close();
    var root = document.createElement('div');
    root.className = 'dshcm-menu';
    root.setAttribute('role', 'menu');
    root.style.visibility = 'hidden';
    document.body.appendChild(root);
    menu = root;

    if (row) {
      add(root, '重命名会话', function () { return renameSession(sessions, row, session); });
      add(root, '归档会话', function () { return archiveSession(workspaces, row, session); });
      var cwd = (session && session.cwd) || (resolvedWorkspace && resolvedWorkspace.path);
      if (cwd) {
        split(root);
        add(root, '在资源管理器中打开', function () { return workspaces.openPath(cwd); });
        add(root, '复制工作目录', function () { return copy(cwd, '已复制工作目录'); });
      }
      if (session) add(root, '复制会话 ID', function () { return copy(session.id, '已复制会话 ID'); });

      if (session) {
        split(root);
        add(root, isPinned(session.id) ? '取消置顶' : '置顶会话', function () { togglePin(session); });
      }

      split(root);
      add(root, '创建会话分支', function () { return forkSession(sessions, row, session); });

      split(root);
      add(root, '刷新', function () { globalThis.location.reload(); }, 'Ctrl+R');
    } else if (workspaceTarget) {
      var workspace = workspaceTarget.workspace;
      add(root, '新建会话', function () { return workspaces.startSession(workspace.workspaceId); });
      add(root, '在资源管理器中打开', function () { return workspaces.openPath(workspace.path); });
      split(root);
      add(root, '重命名工作区', function () { return officialWorkspaceSelect(workspaceTarget.row, [/^重命名$/i, /^rename$/i], '无法打开官方工作区重命名窗口'); });
      add(root, '复制工作区路径', function () { return copy(workspace.path, '已复制工作区路径'); });
      split(root);
      add(root, '归档工作区会话', function () { return archiveWorkspaceSessions(workspaces, workspace); });
      add(root, '移除工作区', function () { return removeWorkspace(workspaces, workspace); });
      split(root);
      add(root, '刷新', function () { globalThis.location.reload(); }, 'Ctrl+R');
    } else if (editable) {
      add(root, '撤销', function () { editable.focus(); if (!document.execCommand('undo')) throw new Error('请使用 Ctrl+Z 撤销'); }, 'Ctrl+Z');
      add(root, '重做', function () { editable.focus(); if (!document.execCommand('redo')) throw new Error('请使用 Ctrl+Y 重做'); }, 'Ctrl+Y');
      split(root);
      add(root, '剪切', function () { if (selection) copy(selection, '已剪切'); replaceSelection(editable, ''); }, 'Ctrl+X');
      add(root, '复制', function () { return copy(selection, '已复制'); }, 'Ctrl+C');
      add(root, '粘贴', function () { return readClipboard().then(function (text) { replaceSelection(editable, text); }); }, 'Ctrl+V');
      split(root);
      add(root, '全选', function () {
        editable.focus();
        if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) editable.select();
        else selectSurface(editable);
      }, 'Ctrl+A');
      split(root);
      add(root, '刷新', function () { globalThis.location.reload(); }, 'Ctrl+R');
    } else {
      if (selection) add(root, '复制所选文本', function () { return copy(selection, '已复制'); }, 'Ctrl+C');
      var url = (link && link.href) || selectedUrl(selection);
      if (url) {
        if (selection) split(root);
        add(root, '使用默认浏览器打开', function () { return workspaces.openPath(url); });
        add(root, '复制链接', function () { return copy(url, '已复制链接'); });
      }
      if (surface) {
        if (selection || url) split(root);
        add(root, '全选当前内容', function () { selectSurface(surface); }, 'Ctrl+A');
      }
      split(root);
      add(root, '刷新', function () { globalThis.location.reload(); }, 'Ctrl+R');
    }
    position(root, event);
  }

  function outside(event) { if (menu && !menu.contains(event.target)) close(); }
  function keyboard(event) {
    if (!menu) return;
    if (event.key === 'Escape') { close(); return; }
    var items = menu.querySelectorAll('[role="menuitem"]');
    var arr = Array.prototype.slice.call(items);
    var current = arr.indexOf(document.activeElement);
    var next = null;
    if (event.key === 'ArrowDown') next = arr[(current + 1 + arr.length) % arr.length];
    else if (event.key === 'ArrowUp') next = arr[(current - 1 + arr.length) % arr.length];
    else if (event.key === 'Home') next = arr[0];
    else if (event.key === 'End') next = arr[arr.length - 1];
    if (next) { event.preventDefault(); next.focus(); }
  }

  // ---------- module factory (same contract as the original plugin) ----------

  function factory() {
    var module = { exports: {} };
    var style = null;
    var disposed = false;

    function apply(ctx) {
      sessionsService = ctx.get('sessions');
      workspacesService = ctx.get('workspaces');
      style = document.createElement('style');
      style.dataset.desktopInject = 'session-menu';
      style.textContent = CSS;
      document.head.appendChild(style);
      document.addEventListener('contextmenu', onContextMenu, true);
      document.addEventListener('pointerdown', outside, true);
      document.addEventListener('keydown', keyboard, true);
      renderPins();
      watchPins();
      toMain('pins:hello', null);
      return function () {
        if (disposed) return;
        disposed = true;
        close();
        if (style) style.remove();
        if (pinObserver) pinObserver.disconnect();
        if (pinTimer) clearInterval(pinTimer);
        if (pinSection) pinSection.remove();
        document.removeEventListener('contextmenu', onContextMenu, true);
        document.removeEventListener('pointerdown', outside, true);
        document.removeEventListener('keydown', keyboard, true);
      };
    }

    module.exports.apply = apply;
    module.exports.inject = ['sessions', 'workspaces'];
    return module.exports;
  }

  // ---------- bootstrap: the dsh web UI's own client module loader ----------

  function directStart() {
    if (window.__dshDesktopMenuApplied) return;
    window.__dshDesktopMenuApplied = true;
    var style = document.createElement('style');
    style.dataset.desktopInject = 'session-menu';
    style.textContent = CSS;
    document.head.appendChild(style);
    document.addEventListener('contextmenu', onContextMenu, true);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', keyboard, true);
    renderPins();
    watchPins();
    toMain('pins:hello', null);
  }

  function boot(attempt) {
    if (window.__ModuleLoader__) {
      try {
        window.__ModuleLoader__.load({ id: 'dsh-desktop-session-menu', factory: factory });
        return;
      } catch (e) {
        console.warn('[dsh-desktop] session menu load failed:', e);
        return;
      }
    }
    if (attempt < 8) setTimeout(function () { boot(attempt + 1); }, 1200);
    else console.warn('[dsh-desktop] __ModuleLoader__ not found — session menu/pins disabled');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', directStart);
  else directStart();
  boot(0);
})();
