'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  getState: () => ipcRenderer.invoke('settings:get-state'),
  checkUpdate: () => ipcRenderer.invoke('settings:check-update'),
  updateDsh: () => ipcRenderer.invoke('settings:update-dsh'),
  closeSettings: () => ipcRenderer.invoke('settings:close'),
  getBalance: () => ipcRenderer.invoke('settings:get-balance'),
  refreshBalance: () => ipcRenderer.invoke('settings:refresh-balance'),
  calibrateBalance: () => ipcRenderer.invoke('settings:calibrate-balance'),
  setCloseBehavior: (b) => ipcRenderer.invoke('settings:set-close-behavior', b),
  setNotify: (on) => ipcRenderer.invoke('settings:set-notify', on),
  setQuickInput: (on) => ipcRenderer.invoke('settings:set-quick-input', on),
  setCurrentSession: (id) => ipcRenderer.invoke('settings:set-current-session', id),
  setLanguage: (lang) => ipcRenderer.invoke('settings:set-language', lang),
  onLanguageChanged: (cb) => ipcRenderer.on('language-changed', (_e, lang) => cb(lang)),
  // quick input
  quickSend: (text) => ipcRenderer.invoke('quick:send', text),
  quickHide: () => ipcRenderer.invoke('quick:hide'),
  onQuickState: (cb) => ipcRenderer.on('quick:state', (_e, info) => cb(info)),
  onQuickPrefill: (cb) => ipcRenderer.on('quick:prefill', (_e, paths) => cb(paths)),
  // companion plugin
  getPluginStatus: () => ipcRenderer.invoke('plugin:status'),
  installPlugin: () => ipcRenderer.invoke('plugin:install'),
  // multi-profile
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  addProfile: (p) => ipcRenderer.invoke('profiles:add', p),
  switchProfile: (name) => ipcRenderer.invoke('profiles:switch', name),
  removeProfile: (name) => ipcRenderer.invoke('profiles:remove', name),
  // files panel (right dock)
  wsList: (root, rel) => ipcRenderer.invoke('ws:list', { root, rel }),
  wsPeek: (path) => ipcRenderer.invoke('ws:peek', { path }),
  wsState: () => ipcRenderer.invoke('ws:state'),
  statsGet: () => ipcRenderer.invoke('stats:get'),
  insertComposer: (text) => ipcRenderer.invoke('insert:composer', text),
  openExternalPath: (path) => ipcRenderer.invoke('open:external-path', path),
  toggleFilesPanel: (on) => ipcRenderer.invoke('files:toggle', on),
  // approvals
  onApprovalShow: (cb) => ipcRenderer.on('approval:show', (_e, ap) => cb(ap)),
  approvalDecide: (decision) => ipcRenderer.invoke('approval:decide', decision),
  // palette (session switcher + transcript search)
  onPaletteMode: (cb) => ipcRenderer.on('palette:mode', (_e, mode) => cb(mode)),
  paletteSessions: () => ipcRenderer.invoke('palette:sessions'),
  sessionSearch: (q) => ipcRenderer.invoke('session-search', q),
  paletteOpen: (id) => ipcRenderer.invoke('palette:open', id),
  // files panel: search & review tabs
  wsSearch: (root, query) => ipcRenderer.invoke('ws:search', { root, query }),
  wsGit: (root) => ipcRenderer.invoke('ws:git', { root }),
  // quick input history
  quickHistory: (arg) => ipcRenderer.invoke('quick:history', arg),
});
