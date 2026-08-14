'use strict';

// DeepSeek Harness Desktop — Electron shell around the dsh Web UI.
//
// Responsibilities:
//   1. Start (or reuse) the dsh web server on a local port.
//   2. Show the dsh Web UI in a BrowserWindow.
//   3. Manage a tray icon: show/hide window, open in browser, quit (kills dsh).
//   4. Persist a small config in the userData directory.

const { app, BrowserWindow, WebContentsView, Tray, Menu, Notification, dialog, shell, nativeImage, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_PORT = 3080;
const DSH_PACKAGE = '@deepseek-ai/dsh';

// UI strings. 'zh' is the default; switching re-applies menus and the
// settings window (config.language).
const I18N = {
  zh: {
    file: '文件', settings: '设置…', checkUpdate: '检查更新', buildInstall: '从源码构建并安装',
    exit: '退出', edit: '编辑', view: '视图', window: '窗口', help: '帮助',
    trayShow: '显示 / 隐藏', trayBrowser: '在浏览器中打开', trayRestart: '重启服务',
    updateNow: '立即更新', later: '稍后', ok: '确定',
    updateAvailableMsg: '发现新版本 {latest}（当前 {installed}），是否立即更新？',
    upToDate: '当前已是最新版本（{installed}）',
    updateNotify: '发现新版本 {latest}，可在「设置 → 检查更新」中更新',
    updateStart: '正在通过 npm 更新 dsh…',
    updateDone: 'dsh 已更新到 {latest}，重启服务后生效。是否立即重启？',
    updateFail: 'dsh 更新失败：\n{err}',
    restartService: '重启服务',
    settingsTitle: 'DeepSeek Harness 设置',
    curVersion: '当前版本', latestVersion: 'npm 最新', updateStatus: '更新状态',
    checkNow: '检查更新', installNow: '立即更新', language: '语言', languageZh: '中文', languageEn: 'English',
    infoPort: '端口', infoSource: '源码目录',
    noSourceDir: '（未设置）',
    closeBehaviorLabel: '关闭窗口时',
    closeUnset: '首次询问（默认）',
    closeTrayOpt: '保留后台（托盘）',
    closeQuitOpt: '完全退出',
    closeAskOpt: '每次询问',
    closeFirstMsg: '关闭窗口后希望如何处理？',
    closeFirstDetail: '「保留后台」：隐藏到托盘，dsh 服务继续运行；「完全退出」：同时停止 dsh 服务。可在设置中更改。',
    closeAskMsg: '关闭窗口后如何处理？',
    closeAskDetail: '「保留后台」继续在托盘运行（dsh 服务不中断）；「完全退出」会同时停止 dsh 服务。',
    closeCancel: '取消',
  },
  en: {
    file: 'File', settings: 'Settings…', checkUpdate: 'Check for Updates', buildInstall: 'Build & Install',
    exit: 'Exit', edit: 'Edit', view: 'View', window: 'Window', help: 'Help',
    trayShow: 'Show / Hide', trayBrowser: 'Open in Browser', trayRestart: 'Restart Service',
    updateNow: 'Update Now', later: 'Later', ok: 'OK',
    updateAvailableMsg: 'New version {latest} available (current {installed}). Update now?',
    upToDate: 'Already up to date ({installed})',
    updateNotify: 'New version {latest} available — update it in Settings → Check for Updates',
    updateStart: 'Updating dsh via npm…',
    updateDone: 'dsh updated to {latest}. Restart the service to apply. Restart now?',
    updateFail: 'dsh update failed:\n{err}',
    restartService: 'Restart Service',
    settingsTitle: 'DeepSeek Harness Settings',
    curVersion: 'Current version', latestVersion: 'Latest on npm', updateStatus: 'Update status',
    checkNow: 'Check for Updates', installNow: 'Update Now', language: 'Language', languageZh: '中文', languageEn: 'English',
    infoPort: 'Port', infoSource: 'Source dir',
    noSourceDir: '(not set)',
    closeBehaviorLabel: 'On window close',
    closeUnset: 'Ask on first close (default)',
    closeTrayOpt: 'Keep in tray',
    closeQuitOpt: 'Fully quit',
    closeAskOpt: 'Ask every time',
    closeFirstMsg: 'What should happen when the window is closed?',
    closeFirstDetail: '"Keep in tray": hide to the tray, dsh keeps running; "Fully quit": stops the dsh service too. You can change this later in Settings.',
    closeAskMsg: 'What should happen when the window is closed?',
    closeAskDetail: '"Keep in tray" keeps running in the tray (dsh stays up); "Fully quit" stops the dsh service as well.',
    closeCancel: 'Cancel',
  },
};

function t(key, vars) {
  let s = (I18N[config.language] || I18N.zh)[key] || I18N.zh[key] || key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
  return s;
}

// App icons (converted from the user-provided artwork, see assets/).
const ICON_PATH = path.join(__dirname, '..', 'assets', 'icon.png');
const TRAY_ICON_PATH = path.join(__dirname, '..', 'assets', 'icon-tray.png');

const DEFAULTS = {
  port: DEFAULT_PORT,
  // How to start dsh: 'npx' (official route, auto-downloads) | 'global' (dsh on PATH) | absolute path to a binary.
  dshCommand: 'npx',
  // What closing the window does: '' (unset — ask once on first close) | 'tray' | 'quit' | 'ask'.
  closeBehavior: '',
  // Legacy alias of closeBehavior (pre-0.1.12), migrated on load.
  onClose: undefined,
  // Auto-update feed for AppImage (electron-updater). Empty = disabled.
  updateUrl: '',
  // Local source directory for "build & install deb" (self-packaging). Empty = feature hidden.
  sourceDir: '',
  // On full quit, also stop an externally-started `dsh web` listening on our port.
  stopExternalDsh: true,
  // UI language: 'zh' | 'en'.
  language: 'zh',
};

let config = null;
let win = null;
let tray = null;
let sniTray = null;
let dshProc = null;
let quitting = false;
let cleaningUp = false;

// ---------- config ----------

function loadConfig() {
  const file = path.join(app.getPath('userData'), 'config.json');
  try {
    const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Legacy: pre-0.1.12 used onClose; migrate it into closeBehavior.
    if (loaded.onClose && !loaded.closeBehavior) loaded.closeBehavior = loaded.onClose;
    delete loaded.onClose;
    return { ...DEFAULTS, ...loaded };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveConfig() {
  const file = path.join(app.getPath('userData'), 'config.json');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error('[config] save failed:', err.message);
  }
}

function appUrl() {
  return `http://127.0.0.1:${config.port}`;
}

// ---------- dsh server management ----------

async function isServerUp(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    return res.ok;
  } catch {
    return false;
  }
}

function waitForServer(port, timeoutMs, onTick) {
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = async () => {
      if (await isServerUp(port)) return resolve(true);
      onTick && onTick(Math.round((Date.now() - start) / 1000));
      if (Date.now() - start >= timeoutMs) return resolve(false);
      setTimeout(tick, 500);
    };
    tick();
  });
}

function logDshLine(buf) {
  try {
    const file = path.join(app.getPath('userData'), 'dsh.log');
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${buf.toString()}`);
  } catch { /* log is best-effort */ }
}

function startDsh() {
  const args = config.dshCommand === 'npx'
    ? ['-y', DSH_PACKAGE, 'web', '--port', String(config.port)]
    : ['web', '--port', String(config.port)];

  let bin = config.dshCommand === 'npx' ? 'npx' : config.dshCommand === 'global' ? 'dsh' : config.dshCommand;
  if (process.platform === 'win32' && !bin.endsWith('.exe') && !path.isAbsolute(bin) && !bin.includes('/') && !bin.includes('\\')) {
    bin += '.cmd';
  }

  const proc = spawn(bin, args, {
    cwd: os.homedir(),
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group so stopDsh can kill the whole tree (npx -> sh -> node dsh).
    detached: process.platform !== 'win32',
  });
  proc.stdout.on('data', logDshLine);
  proc.stderr.on('data', logDshLine);
  proc.on('error', (err) => {
    // spawn failed (binary not found, etc.)
    dshProc = null;
    if (!quitting) showFatal(`无法启动 dsh 进程：${err.message}`);
  });
  proc.on('exit', (code, signal) => {
    const unexpected = dshProc === proc;
    dshProc = null;
    if (unexpected && !quitting) {
      showFatal(`dsh 服务意外退出（code=${code} signal=${signal}）。日志见 ${path.join(app.getPath('userData'), 'dsh.log')}`);
    }
  });
  dshProc = proc;
  return proc;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stopDsh() {
  const proc = dshProc;
  dshProc = null; // mark as intentional, so 'exit' won't warn
  if (proc) {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F']);
    } else {
      try {
        process.kill(-proc.pid, 'SIGTERM'); // whole process group
      } catch {
        proc.kill();
      }
    }
  }
  // Also stop an externally-started dsh on our port (e.g. launched from a
  // terminal). Wait briefly so our own spawned group has fully exited first.
  return new Promise((resolve) => setTimeout(() => stopExternalDsh().then(resolve), 800));
}

function findPidOnPort(port) {
  return new Promise((resolve) => {
    execFile('ss', ['-tlnp'], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve(null);
      for (const line of stdout.split('\n')) {
        if (!line.includes(`:${port}`)) continue;
        const m = line.match(/pid=(\d+)/);
        if (m) return resolve(Number(m[1]));
      }
      resolve(null);
    });
  });
}

function isDshProcess(pid) {
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
    return /\bdsh\b/.test(cmd) && /\bweb\b/.test(cmd);
  } catch {
    return false;
  }
}

async function stopExternalDsh() {
  if (!config.stopExternalDsh) return;
  try {
    const pid = await findPidOnPort(config.port);
    if (!pid) return;
    if (!isDshProcess(pid)) {
      console.log(`[dsh] port ${config.port} is held by a non-dsh process, leaving it running`);
      return;
    }
    console.log(`[dsh] stopping external dsh (pid ${pid})`);
    process.kill(pid, 'SIGTERM');
    await sleep(1200);
    if (!(await isServerUp(config.port))) {
      console.log('[dsh] external dsh stopped, port released');
    }
  } catch (err) {
    console.error('[dsh] failed to stop external dsh:', err.message);
  }
}

function restartDsh() {
  stopDsh();
  // Give the old server a moment to release the port before probing again.
  setTimeout(boot, 1500);
}

// ---------- pages ----------

function loadingPage() {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;background:#0d1117;color:#c9d1d9;font-family:system-ui,sans-serif}
    .dot{width:28px;height:28px;border-radius:50%;background:#1e90ff;animation:pulse 1.2s ease-in-out infinite}
    @keyframes pulse{0%,100%{transform:scale(.85);opacity:.6}50%{transform:scale(1.15);opacity:1}}
    .hint{color:#8b949e;font-size:13px;max-width:420px;text-align:center}
  </style></head><body>
    <div class="dot"></div>
    <div>正在启动 DeepSeek Harness…</div>
    <div class="hint">首次运行会通过 npx 下载 dsh 包，可能需要几分钟，请稍候。</div>
  </body></html>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function fatalPage(message) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:#0d1117;color:#f85149;font-family:system-ui,sans-serif;padding:40px;text-align:center}
    code{color:#c9d1d9;font-size:13px;word-break:break-all}
  </style></head><body>
    <div style="font-size:20px">DeepSeek Harness 启动失败</div>
    <code>${message.replace(/</g, '&lt;')}</code>
    <div style="color:#8b949e;font-size:13px">可尝试托盘菜单中的「重启服务」，或改用浏览器访问。</div>
  </body></html>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

// ---------- window ----------

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    title: 'DeepSeek Harness',
    icon: nativeImage.createFromPath(ICON_PATH),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Keep navigation inside the local dsh server; open everything else in the system browser.
  const allowedHost = new URL(appUrl()).host;
  win.webContents.on('will-navigate', (event, url) => {
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' || u.host !== allowedHost) {
        event.preventDefault();
        shell.openExternal(url);
      }
    } catch {
      event.preventDefault();
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Keep the settings overlay centered when the main window is resized.
  win.on('resize', () => {
    if (settingsView && !win.isDestroyed()) settingsView.setBounds(centeredSettingsBounds());
  });

  // A page reload drops injected CSS — re-apply the mask if the overlay is open.
  win.webContents.on('did-navigate', () => {
    if (settingsView) applySettingsMask();
  });

  win.on('close', (event) => {
    if (quitting) return;
    if (config.closeBehavior === 'tray') {
      event.preventDefault();
      win.hide();
      return;
    }
    if (config.closeBehavior === 'quit') {
      quitting = true;
      app.quit();
      return;
    }
    event.preventDefault();
    if (config.closeBehavior === 'ask') {
      // Ask every time: keep-in-tray vs full quit.
      const choice = dialog.showMessageBoxSync(win, {
        type: 'question',
        title: 'DeepSeek Harness',
        message: t('closeAskMsg'),
        detail: t('closeAskDetail'),
        buttons: [t('closeTrayOpt'), t('closeQuitOpt'), t('closeCancel')],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      });
      if (choice === 0) win.hide();
      else if (choice === 1) { quitting = true; app.quit(); }
      return;
    }
    // closeBehavior === '' — first close: pick the default behavior once.
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      title: 'DeepSeek Harness',
      message: t('closeFirstMsg'),
      detail: t('closeFirstDetail'),
      buttons: [t('closeTrayOpt'), t('closeQuitOpt'), t('closeAskOpt')],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (choice === 0) { config.closeBehavior = 'tray'; saveConfig(); win.hide(); }
    else if (choice === 1) { config.closeBehavior = 'quit'; saveConfig(); quitting = true; app.quit(); }
    else { config.closeBehavior = 'ask'; saveConfig(); win.hide(); } // this time: tray default
  });
  win.on('closed', () => { win = null; maskCssKey = null; });

  return win;
}

async function boot() {
  if (!win) createWindow();
  win.loadURL(loadingPage());

  if (await isServerUp(config.port)) {
    // A dsh server is already running on this port — reuse it.
    win.loadURL(appUrl());
    return;
  }

  startDsh();
  const ready = await waitForServer(config.port, 120_000, (elapsed) => {
    if (win && !win.isDestroyed()) win.setTitle(`DeepSeek Harness — 启动中 ${elapsed}s`);
  });
  if (win && !win.isDestroyed()) win.setTitle('DeepSeek Harness');
  if (ready) {
    win.loadURL(appUrl());
  } else if (dshProc !== null) {
    // dshProc === null means spawn failed or dsh exited — already handled
    // by the 'error'/'exit' callbacks, which showed the fatal page.
    win.loadURL(fatalPage(`在 ${config.port} 端口等待 dsh 服务超时（120 秒）。请检查网络后从托盘菜单「重启服务」。`));
  }
}

function showFatal(message) {
  dialog.showErrorBox('DeepSeek Harness', message);
  if (win && !win.isDestroyed()) win.loadURL(fatalPage(message));
}

// ---------- build & install (deb, self-packaging on this machine) ----------
// Runs `npm run dist` in the configured source directory, then installs the
// freshly built deb via pkexec (system polkit prompt — the sudo password goes
// to polkit, never to this app), then relaunches.

let building = false;

function askBox(options) {
  return win && !win.isDestroyed()
    ? dialog.showMessageBoxSync(win, options)
    : dialog.showMessageBoxSync(options);
}

function notify(title, body) {
  try {
    if (Notification.isSupported()) new Notification({ title, body }).show();
  } catch { /* best-effort */ }
}

function newestDebIn(dir) {
  let best = null;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.deb')) continue;
      const p = path.join(dir, f);
      if (!best || fs.statSync(p).mtimeMs > best.mtime) best = { p, mtime: fs.statSync(p).mtimeMs };
    }
  } catch { /* dir missing */ }
  return best ? best.p : null;
}

function buildAndInstall() {
  if (!config.sourceDir || building) return;
  const choice = askBox({
    type: 'question',
    title: '从源码构建并安装',
    message: '将在本机打包 deb 并安装（需要系统管理员授权）。',
    detail: `源码目录：${config.sourceDir}\n构建约需 1-2 分钟，完成后会弹出系统授权框。`,
    buttons: ['开始构建', '取消'],
    defaultId: 0,
    cancelId: 1,
  });
  if (choice !== 0) return;
  building = true;
  // Fresh build: remove stale artifacts first so dist/ only holds the new
  // version and the newest-deb pick can never grab an older one.
  fs.rmSync(path.join(config.sourceDir, 'dist'), { recursive: true, force: true });
  notify('DeepSeek Harness', '开始从源码构建 deb…');
  const proc = spawn('bash', ['-lc', 'npm run dist'], {
    cwd: config.sourceDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', logDshLine);
  proc.stderr.on('data', logDshLine);
  proc.on('error', (err) => {
    building = false;
    notify('构建失败', err.message);
  });
  proc.on('exit', (code) => {
    building = false;
    if (code !== 0) {
      notify('构建失败', `npm run dist 退出码 ${code}，详情见 dsh.log`);
      return;
    }
    const deb = newestDebIn(path.join(config.sourceDir, 'dist'));
    if (!deb) {
      notify('构建失败', '未在 dist/ 中找到 deb 产物');
      return;
    }
    notify('构建完成', '请求管理员授权安装…');
    const inst = spawn('pkexec', ['dpkg', '-i', deb], { stdio: ['ignore', 'pipe', 'pipe'] });
    inst.stdout.on('data', logDshLine);
    inst.stderr.on('data', logDshLine);
    inst.on('error', (err) => {
      dialog.showErrorBox('安装失败', `无法启动 pkexec：${err.message}\n可手动执行：sudo dpkg -i "${deb}"`);
    });
    inst.on('exit', (c) => {
      if (c === 0) {
        askBox({ type: 'info', title: '安装完成', message: '新版本已安装，应用即将重启。', buttons: ['确定'] });
        app.relaunch();
        app.exit(0);
      } else {
        dialog.showErrorBox('安装失败', `dpkg 返回码 ${c}。\n可手动执行：sudo dpkg -i "${deb}"`);
      }
    });
  });
}

// ---------- auto update (AppImage only) ----------
// AppImage self-replacement via electron-updater; deb installs follow the
// system package manager and use the self-packaging flow above instead.

function setupAutoUpdater() {
  if (!app.isPackaged || !config.updateUrl) return;
  if (!process.env.APPIMAGE) return; // deb installs: self-packaging flow (tray menu), no auto check
  autoUpdater.setFeedURL({ provider: 'generic', url: config.updateUrl });
  autoUpdater.logger = console;
  autoUpdater.on('update-downloaded', () => {
    const choice = askBox({
      type: 'info',
      title: 'DeepSeek Harness',
      message: '新版本已下载完成，是否立即重启安装？',
      buttons: ['立即重启', '稍后'],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.checkForUpdates().catch(() => { /* silent: no network or feed unavailable */ });
}

// ---------- dsh npm update (check + install) ----------

let lastChecked = { installed: null, latest: null, update: false, checkedAt: 0 };

// GUI-launched apps get a bare PATH (no ~/.npm-global/bin etc.); probe the
// common user install locations so dsh/npm resolve without shell config.
function probeBin(name) {
  const dirs = [
    path.join(os.homedir(), '.npm-global', 'bin'),
    path.join(os.homedir(), '.local', 'bin'),
    '/usr/bin',
  ];
  for (const dir of dirs) {
    const p = path.join(dir, name);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* keep looking */ }
  }
  return null;
}

function getInstalledDshVersion() {
  return new Promise((resolve) => {
    const dsh = probeBin('dsh');
    const args = dsh ? [dsh, '--version'] : ['bash', '-lc', 'dsh --version'];
    execFile(args[0], args.slice(1), { timeout: 10000 }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim().split('\n')[0]);
    });
  });
}

function getNpmLatestVersion() {
  return new Promise((resolve) => {
    const npm = probeBin('npm');
    const args = npm ? [npm, 'view', DSH_PACKAGE, 'version'] : ['bash', '-lc', `npm view ${DSH_PACKAGE} version`];
    execFile(args[0], args.slice(1), { timeout: 20000 }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim().split('\n')[0]);
    });
  });
}

function getNpmGlobalPrefix() {
  return new Promise((resolve) => {
    const npm = probeBin('npm');
    const args = npm ? [npm, 'prefix', '-g'] : ['bash', '-lc', 'npm prefix -g'];
    execFile(args[0], args.slice(1), { timeout: 10000 }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim());
    });
  });
}

// Compare versions like "0.1.0-rc.6" / "1.2.3": numeric segments, prerelease
// suffix (rc.N) folded in as an extra segment. Returns >0 if a > b.
function compareVersions(a, b) {
  const nums = (v) => String(v).replace('-rc.', '.').split('.').map((s) => parseInt(s, 10) || 0);
  const na = nums(a); const nb = nums(b);
  const len = Math.max(na.length, nb.length);
  for (let i = 0; i < len; i++) {
    const d = (na[i] || 0) - (nb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function checkDshUpdate(manual) {
  const [installed, latest] = await Promise.all([getInstalledDshVersion(), getNpmLatestVersion()]);
  lastChecked = { installed, latest, update: !!installed && !!latest && compareVersions(latest, installed) > 0, checkedAt: Date.now() };
  if (manual) {
    if (!installed || !latest) {
      const reasons = [];
      if (!installed) reasons.push(`dsh --version failed (probed: ${probeBin('dsh') || 'not in ~/.npm-global/bin, ~/.local/bin, PATH'})`);
      if (!latest) reasons.push('npm view failed (network or registry issue)');
      dialog.showErrorBox(t('settingsTitle'), t('updateFail', { err: reasons.join('\n') }));
    } else if (lastChecked.update) {
      const choice = askBox({
        type: 'question', title: t('settingsTitle'),
        message: t('updateAvailableMsg', { latest, installed }),
        buttons: [t('updateNow'), t('later')], defaultId: 0, cancelId: 1,
      });
      if (choice === 0) await updateDsh();
    } else {
      askBox({ type: 'info', title: t('settingsTitle'), message: t('upToDate', { installed }), buttons: [t('ok')] });
    }
  } else if (lastChecked.update) {
    notify('DeepSeek Harness', t('updateNotify', { latest }));
  }
  return lastChecked;
}

function updateDsh() {
  return new Promise((resolve) => {
    getNpmGlobalPrefix().then((prefix) => {
      const userPrefix = prefix && (prefix.startsWith(os.homedir()) || prefix.includes('.npm-global'));
      if (!userPrefix) {
        dialog.showErrorBox(t('settingsTitle'), t('updateFail', { err: `global prefix is system-owned (${prefix || 'unknown'}); run manually: sudo npm install -g ${DSH_PACKAGE}` }));
        resolve({ ok: false });
        return;
      }
      notify('DeepSeek Harness', t('updateStart'));
      const npm = probeBin('npm');
      const args = npm ? [npm, 'install', '-g', DSH_PACKAGE] : ['bash', '-lc', `npm install -g ${DSH_PACKAGE}`];
      execFile(args[0], args.slice(1), { timeout: 180000 }, (err, stdout, stderr) => {
        if (err) {
          const tail = (stderr || stdout || err.message).split('\n').slice(-6).join('\n');
          dialog.showErrorBox(t('settingsTitle'), t('updateFail', { err: tail }));
          resolve({ ok: false });
          return;
        }
        const choice = askBox({
          type: 'question', title: t('settingsTitle'),
          message: t('updateDone', { latest: lastChecked.latest }),
          buttons: [t('restartService'), t('later')], defaultId: 0, cancelId: 1,
        });
        if (choice === 0) restartDsh();
        resolve({ ok: true });
      });
    });
  });
}

// ---------- menus ----------

const { createSniTray } = require('./sni');

function trayMenuTemplate() {
  return [
    { label: t('trayShow'), click: () => toggleWindow() },
    { label: t('trayBrowser'), click: () => shell.openExternal(appUrl()) },
    { label: t('trayRestart'), click: () => restartDsh() },
    { label: t('settings'), click: () => openSettings() },
    ...(config.sourceDir
      ? [{ label: t('buildInstall'), click: () => buildAndInstall() }]
      : []),
    { type: 'separator' },
    { label: t('exit'), click: () => { quitting = true; app.quit(); } },
  ];
}

function appMenuTemplate() {
  return [
    {
      label: t('file'),
      submenu: [
        { label: t('settings'), click: () => openSettings() },
        { label: t('checkUpdate'), click: () => checkDshUpdate(true) },
        ...(config.sourceDir
          ? [{ label: t('buildInstall'), click: () => buildAndInstall() }]
          : []),
        { type: 'separator' },
        { label: t('exit'), click: () => { quitting = true; app.quit(); } },
      ],
    },
    { role: 'editMenu', label: t('edit') },
    { role: 'viewMenu', label: t('view') },
    { role: 'windowMenu', label: t('window') },
    { label: t('help'), enabled: false, submenu: [] }, // Help not implemented yet — disabled
  ];
}

// Rebuild application menu and tray after a language switch.
function applyMenus() {
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate()));
  if (process.platform === 'linux' && process.env.WAYLAND_DISPLAY) {
    if (sniTray && sniTray.destroy) {
      try { sniTray.destroy(); } catch { /* ignore */ }
      sniTray = null;
    }
    createTray();
  } else if (tray) {
    tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate()));
  }
}

function createTray() {
  if (process.platform === 'linux' && process.env.WAYLAND_DISPLAY) {
    // Wayland: Electron's Tray SNI is broken (fake IconName, unreadable
    // IconPixmap) — use our own StatusNotifierItem instead.
    createSniTray({
      iconPath: TRAY_ICON_PATH,
      title: 'DeepSeek Harness',
      menuItems: [
        { label: t('trayShow'), action: () => toggleWindow() },
        { label: t('trayBrowser'), action: () => shell.openExternal(appUrl()) },
        { label: t('trayRestart'), action: () => restartDsh() },
        { label: t('settings'), action: () => openSettings() },
        ...(config.sourceDir
          ? [{ label: t('buildInstall'), action: () => buildAndInstall() }]
          : []),
        { separator: true },
        { label: t('exit'), action: () => { quitting = true; app.quit(); } },
      ],
      onActivate: () => toggleWindow(),
    }).then((handle) => {
      sniTray = handle;
    }).catch((err) => {
      console.error('[tray] SNI failed, falling back to Electron Tray:', err.message);
      tray = new Tray(nativeImage.createFromPath(TRAY_ICON_PATH));
      tray.setToolTip('DeepSeek Harness');
      tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate()));
      tray.on('click', toggleWindow);
    });
    return;
  }
  tray = new Tray(nativeImage.createFromPath(TRAY_ICON_PATH));
  tray.setToolTip('DeepSeek Harness');
  tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate()));
  tray.on('click', toggleWindow);
}

function toggleWindow() {
  if (!win) { boot(); return; }
  if (win.isVisible() && win.isFocused()) win.hide();
  else { win.show(); win.focus(); }
}

// ---------- settings window ----------

let settingsView = null;
let maskCssKey = null;

// Dim + desaturate the main page and block its clicks while the settings
// overlay is open, so the modal layering is obvious.
const SETTINGS_MASK_CSS = `
  #dsh-settings-mask {
    position: fixed; inset: 0; z-index: 2147483647;
    background: rgba(0, 0, 0, 0.45);
  }
  html { filter: grayscale(0.7) brightness(0.65) !important; }
`;

function applySettingsMask() {
  if (maskCssKey || !win || win.isDestroyed()) return;
  win.webContents.insertCSS(SETTINGS_MASK_CSS).then((key) => { maskCssKey = key; }).catch(() => {});
}

function removeSettingsMask() {
  if (!maskCssKey || !win || win.isDestroyed()) return;
  const key = maskCssKey;
  maskCssKey = null;
  win.webContents.removeInsertedCSS(key).catch(() => {});
}

function centeredSettingsBounds() {
  const size = { width: 460, height: 400 };
  const cb = win ? win.getContentBounds() : { width: 1280, height: 820 };
  return {
    x: Math.round((cb.width - size.width) / 2),
    y: Math.round((cb.height - size.height) / 2),
    width: size.width,
    height: size.height,
  };
}

function openSettings() {
  if (!win) { boot(); return; }
  if (settingsView) { settingsView.setBounds(centeredSettingsBounds()); settingsView.webContents.focus(); return; }
  // In-window overlay: Wayland forbids positioning standalone windows (the
  // compositor parks them at screen edges), so we embed the settings panel
  // as a child view with bounds relative to the main window — always centered.
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  settingsView = view;
  win.contentView.addChildView(view);
  view.setBounds(centeredSettingsBounds());
  view.webContents.loadFile(path.join(__dirname, 'settings.html'));
  view.webContents.on('destroyed', () => { if (settingsView === view) settingsView = null; });
  applySettingsMask();
}

function closeSettings() {
  removeSettingsMask();
  if (!settingsView || !win || win.isDestroyed()) return;
  const view = settingsView;
  settingsView = null;
  win.contentView.removeChildView(view);
  view.webContents.close();
}

function registerSettingsIpc() {
  ipcMain.handle('settings:get-state', () => ({
    language: config.language,
    port: config.port,
    sourceDir: config.sourceDir,
    closeBehavior: config.closeBehavior || '',
    checkedAt: lastChecked.checkedAt,
    installed: lastChecked.installed,
    latest: lastChecked.latest,
    update: lastChecked.update,
  }));
  ipcMain.handle('settings:check-update', () => checkDshUpdate(true));
  ipcMain.handle('settings:update-dsh', () => updateDsh());
  ipcMain.handle('settings:close', () => closeSettings());
  ipcMain.handle('settings:set-close-behavior', (_e, behavior) => {
    if (!['tray', 'quit', 'ask', ''].includes(behavior)) return;
    config.closeBehavior = behavior;
    saveConfig();
  });
  ipcMain.handle('settings:set-language', (_e, lang) => {
    if (lang !== 'zh' && lang !== 'en') return;
    config.language = lang;
    saveConfig();
    applyMenus();
    if (settingsView && !settingsView.webContents.isDestroyed()) {
      settingsView.webContents.send('language-changed', lang);
    }
  });
}

// ---------- app lifecycle ----------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { win.show(); win.focus(); }
  });

  app.whenReady().then(() => {
    config = loadConfig();
    registerSettingsIpc();
    Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate()));
    createTray();
    setupAutoUpdater();
    boot();
    // Startup auto-check for a newer dsh on npm (non-intrusive notification).
    setTimeout(() => checkDshUpdate(false), 4000);

    app.on('activate', () => {
      if (win) { win.show(); win.focus(); } else boot();
    });
  });

  app.on('before-quit', (event) => {
    if (cleaningUp) return;
    event.preventDefault();
    cleaningUp = true;
    quitting = true;
    // Async cleanup (including external dsh) must finish before we exit.
    stopDsh().then(() => app.exit(0));
  });

  // Clean shutdown when killed externally (e.g. SIGTERM from a service manager).
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      quitting = true;
      stopDsh().then(() => app.exit(0));
    });
  }

  app.on('window-all-closed', () => {
    // With closeToTray the window hides instead of closing; a real close means quit.
    if (process.platform !== 'darwin') app.quit();
  });
}
