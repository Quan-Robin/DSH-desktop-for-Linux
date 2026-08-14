'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  getState: () => ipcRenderer.invoke('settings:get-state'),
  checkUpdate: () => ipcRenderer.invoke('settings:check-update'),
  updateDsh: () => ipcRenderer.invoke('settings:update-dsh'),
  closeSettings: () => ipcRenderer.invoke('settings:close'),
  setLanguage: (lang) => ipcRenderer.invoke('settings:set-language', lang),
  onLanguageChanged: (cb) => ipcRenderer.on('language-changed', (_e, lang) => cb(lang)),
});
