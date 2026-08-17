'use strict';

// DeepSeek Harness Desktop — Electron shell around the dsh Web UI.
//
// Responsibilities:
//   1. Start (or reuse) the dsh web server on a local port.
//   2. Show the dsh Web UI in a BrowserWindow.
//   3. Manage a tray icon: show/hide window, open in browser, quit (kills dsh).
//   4. Persist a small config in the userData directory.

const { app, BrowserWindow, WebContentsView, Tray, Menu, Notification, dialog, shell, nativeImage, ipcMain, globalShortcut, screen } = require('electron');
const { autoUpdater } = require('electron-updater');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');

// Portable build: keep ALL app data (config, balance state, logs, caches)
// next to the app under data/app/ so a portable instance and a normal install
// (or two portable copies) never share settings — e.g. closing behaviour is
// configured per instance, not globally. Set early (before loadConfig).
function isolatePortableUserData() {
  try {
    if (!app.isPackaged) return false;
    const root = process.resourcesPath ? path.join(process.resourcesPath, 'bundled') : '';
    if (!root || !fs.existsSync(path.join(root, 'node', 'bin', 'node'))) return false;
    app.setPath('userData', path.join(path.dirname(process.execPath), 'data', 'app'));
    return true;
  } catch { return false; }
}
const path = require('node:path');
const { deepLinkFromArgv, clampWindowState, migrateProfiles, applyProfile, togglePin } = require('./desktop-utils');
const wsTree = require('./ws-tree');

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
    balMenu: '余额', balOfficial: '官方余额', balEstimate: '估算余额',
    balRefresh: '刷新余额', balCalibrate: '校准（以当前官方余额为基准）',
    balUncalibrated: '（未校准）', balNoKey: '未找到 API key（~/.dsh/.credentials.yaml）',
    balSession: '当前会话消耗（预估）', balTurn: '本次对话消耗（预估）', balDetail: '余额详情…',
    balSessionsTitle: '各会话消耗（预估）', balSessionId: '会话', balSessionTime: '时间', balSessionCost: '消耗', balNoSessions: '（暂无会话记录）',
    balNote: '估算余额：对话进行中按「官方余额 − 当前轮消耗」实时递减；一轮结束后冻结，待官方账单确认（约 3 分钟，稳定 60 秒后）自动对齐官方值。「校准」将当前官方余额立即设为对话基准。消耗按模型价格估算（峰谷定价 8-17 起生效）；价格可在 config.json 的 pricing 中调整。',
    pluginFailMsg: 'dsh 插件 {id} 加载失败导致启动失败。是否在下次启动时禁用该插件？\n（禁用后该插件功能不可用；恢复方法：删除 ~/.dsh/profiles/web/cordis.patch.yml 中对应条目）',
    pluginDisableRestart: '禁用并重启', pluginSkip: '暂不处理',
    pluginDisabledTitle: '插件已禁用', pluginDisabledBody: '插件 {id} 已禁用，正在重启服务…',
    bundledMissingTitle: '便携运行时缺失', bundledMissingBody: '未找到内置运行时（bundled），已自动回退到 npx 模式启动 dsh。',
    turnDoneTitle: 'DeepSeek Harness', turnDoneBody: '本轮对话已完成',
    quickInputTitle: '快捷输入 — DeepSeek Harness',
    quickNoSession: '当前没有活跃会话（在 Web UI 中打开一个会话后再试）',
    quickRpcUnavailable: '此 dsh 版本不支持发送接口，已聚焦主窗口',
    quickSendFail: '发送失败：{err}',
    pluginMenu: '伴生插件', pluginInstall: '安装伴生插件（推荐）', pluginInstalled: '伴生插件已安装',
    pluginInstalling: '正在安装伴生插件…', pluginInstallDone: '伴生插件已安装，正在重启服务…',
    pluginInstallFail: '伴生插件安装失败：{err}',
    profilesMenu: '配置', profileAddFail: '添加配置失败：{err}',
    trayPins: '置顶的会话', noPins: '（暂无，右键会话可置顶）',
    filesPanel: '文件面板（Ctrl+Shift+E）', composerMiss: '未找到输入框——请先打开一个会话',
    approvalTitle: 'DSH 等待审批',
    profileSwitched: '已切换到配置「{name}」，正在重启服务…',
    pluginStatusOn: '已连接', pluginStatusOff: '未安装（功能受限）',
    loadingTitle: '正在启动 DeepSeek Harness…',
    loadingHint: '首次运行会通过 npx 下载 dsh 包，可能需要几分钟，请稍候。',
    fatalTitle: 'DeepSeek Harness 启动失败',
    fatalHint: '可尝试托盘菜单中的「重启服务」，或改用浏览器访问。',
    bootTimeout: '在 {port} 端口等待 dsh 服务超时（120 秒）。请检查网络后从托盘菜单「重启服务」。',
    spawnFail: '无法启动 dsh 进程：{err}',
    exitUnexpected: 'dsh 服务意外退出（code={code} signal={signal}）。日志见 {log}',
    buildConfirmTitle: '从源码构建并安装',
    buildConfirmMsg: '将在本机打包 deb 并安装（需要系统管理员授权）。',
    buildConfirmDetail: '源码目录：{dir}\n构建约需 1-2 分钟，完成后会弹出系统授权框。',
    buildStart: '开始构建', cancel: '取消',
    buildStartTitle: 'DeepSeek Harness', buildStartBody: '开始从源码构建 deb…',
    buildFailTitle: '构建失败',
    buildFailExit: 'npm run dist 退出码 {code}，详情见 dsh.log',
    buildFailNoDeb: '未在 dist/ 中找到 deb 产物',
    buildDoneTitle: '构建完成', buildDoneBody: '请求管理员授权安装…',
    installFailTitle: '安装失败',
    installFailPkexec: '无法启动 pkexec：{err}\n可手动执行：sudo dpkg -i "{deb}"',
    installDoneMsg: '新版本已安装，应用即将重启。', installFailExit: 'dpkg 返回码 {code}。\n可手动执行：sudo dpkg -i "{deb}"',
    updateDownloadedMsg: '新版本已下载完成，是否立即重启安装？',
    restartNow: '立即重启',
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
    balMenu: 'Balance', balOfficial: 'Official balance', balEstimate: 'Estimated balance',
    balRefresh: 'Refresh balance',
    balCalibrate: 'Calibrate (use official balance as baseline)',
    balUncalibrated: '(not calibrated)', balNoKey: 'API key not found (~/.dsh/.credentials.yaml)',
    balSession: 'Current session (est.)', balTurn: 'Last turn (est.)', balDetail: 'Balance details…',
    balSessionsTitle: 'Per-session cost (est.)', balSessionId: 'Session', balSessionTime: 'Time', balSessionCost: 'Cost', balNoSessions: '(no session records)',
    balNote: 'Estimated balance: while a conversation is in progress it counts down as (official balance − current-turn cost); after a turn ends it freezes, then re-aligns with the official value once the bill settles (~3 minutes, 60 s stable). "Calibrate" immediately re-bases the estimate on the current official balance. Costs are per-model (peak/off-peak from 2026-08-17); prices are adjustable via pricing in config.json.',
    pluginFailMsg: 'dsh plugin {id} failed to load, which made dsh exit on startup. Disable this plugin on the next start?\n(The plugin will be unavailable; to re-enable, remove the matching entry from ~/.dsh/profiles/web/cordis.patch.yml)',
    pluginDisableRestart: 'Disable & restart', pluginSkip: 'Not now',
    pluginDisabledTitle: 'Plugin disabled', pluginDisabledBody: 'Plugin {id} disabled — restarting the service…',
    bundledMissingTitle: 'Portable runtime missing', bundledMissingBody: 'No bundled runtime found — fell back to npx mode to start dsh.',
    turnDoneTitle: 'DeepSeek Harness', turnDoneBody: 'The last turn has finished',
    quickInputTitle: 'Quick Input — DeepSeek Harness',
    quickNoSession: 'No active session (open one in the Web UI first)',
    quickRpcUnavailable: 'This dsh build has no send API — focused the main window instead',
    quickSendFail: 'Send failed: {err}',
    pluginMenu: 'Companion plugin', pluginInstall: 'Install companion plugin (recommended)', pluginInstalled: 'Companion plugin installed',
    pluginInstalling: 'Installing companion plugin…', pluginInstallDone: 'Companion plugin installed — restarting service…',
    pluginInstallFail: 'Companion plugin installation failed: {err}',
    profilesMenu: 'Profiles', profileAddFail: 'Failed to add profile: {err}',
    trayPins: 'Pinned sessions', noPins: '(none yet — right-click a session to pin)',
    filesPanel: 'Files panel (Ctrl+Shift+E)', composerMiss: 'Composer not found — open a session first',
    approvalTitle: 'DSH is waiting for approval',
    profileSwitched: 'Switched to profile "{name}" — restarting service…',
    pluginStatusOn: 'Connected', pluginStatusOff: 'Not installed (limited features)',
    loadingTitle: 'Starting DeepSeek Harness…',
    loadingHint: 'The first run downloads the dsh package via npx; this can take a few minutes.',
    fatalTitle: 'DeepSeek Harness failed to start',
    fatalHint: 'Try "Restart Service" from the tray menu, or open it in a browser instead.',
    bootTimeout: 'Timed out waiting for dsh on port {port} (120 s). Check the network and use "Restart Service" from the tray menu.',
    spawnFail: 'Could not start the dsh process: {err}',
    exitUnexpected: 'dsh exited unexpectedly (code={code} signal={signal}). See the log at {log}',
    buildConfirmTitle: 'Build & Install',
    buildConfirmMsg: 'This builds a deb locally and installs it (admin authorization required).',
    buildConfirmDetail: 'Source dir: {dir}\nThe build takes ~1-2 minutes, then a system authorization prompt appears.',
    buildStart: 'Start build', cancel: 'Cancel',
    buildStartTitle: 'DeepSeek Harness', buildStartBody: 'Building deb from source…',
    buildFailTitle: 'Build failed',
    buildFailExit: 'npm run dist exited with code {code}; see dsh.log',
    buildFailNoDeb: 'No deb artifact found in dist/',
    buildDoneTitle: 'Build finished', buildDoneBody: 'Requesting admin authorization to install…',
    installFailTitle: 'Install failed',
    installFailPkexec: 'Could not start pkexec: {err}\nRun manually: sudo dpkg -i "{deb}"',
    installDoneMsg: 'The new version is installed — the app will restart now.', installFailExit: 'dpkg exited with code {code}.\nRun manually: sudo dpkg -i "{deb}"',
    updateDownloadedMsg: 'A new version has been downloaded. Restart and install now?',
    restartNow: 'Restart Now',
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
  dshCommand: '',
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
  // Notify when a conversation turn finishes and the app is not focused.
  notifyOnTurnEnd: true,
  // Manual "current session" override (full session id) picked in the balance
  // details page; empty = follow the server's last-active session.
  balanceSessionId: '',
  // True when balanceSessionId was set by an explicit user action (balance
  // page / deep link) — sniffed ids must NOT outrank the companion plugin.
  balanceSessionIdManual: false,
  // dsh data home; empty = ~/.dsh. Portable mode points this next to the app
  // (config.dshCommand 'bundled' ships its own node/dsh/pnpm).
  dshHome: '',
  // Global quick input (mini composer on a system-wide hotkey).
  quickInputEnabled: true,
  quickInputShortcut: 'Control+Shift+D',
  // Window bounds across restarts; null = defaults.
  windowState: null,
  // Multi-profile: [{ name, dshHome, port }] + activeProfile (migrated on load).
  profiles: null,
  activeProfile: '',
  // Pinned sessions (desktop-owned state): [{ id, title }], newest first.
  pinnedSessions: [],
  // Right-dock files panel (workspace browser) restored on boot.
  filesPanelOpen: false,
};

let config = null;
let win = null;
let tray = null;
let sniTray = null;
let sniCreating = false; // guard: createSniTray registers asynchronously
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
    const merged = { ...DEFAULTS, ...loaded };
    migrateProfiles(merged); // ensures profiles/activeProfile exist & valid
    return merged;
  } catch {
    return migrateProfiles({ ...DEFAULTS });
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

// Cap dsh.log so a long-lived instance cannot grow it without bound.
const LOG_MAX_BYTES = 5 * 1024 * 1024;
function logDshLine(buf) {
  try {
    const file = path.join(app.getPath('userData'), 'dsh.log');
    // Cheap rotation: past the cap, drop the front half instead of appending.
    try {
      const st = fs.statSync(file);
      if (st.size > LOG_MAX_BYTES) {
        const keep = Buffer.alloc(Math.floor(LOG_MAX_BYTES / 2));
        const fd = fs.openSync(file, 'r');
        fs.readSync(fd, keep, 0, keep.length, st.size - keep.length);
        fs.closeSync(fd);
        fs.writeFileSync(file, keep);
      }
    } catch { /* no file yet */ }
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${buf.toString()}`);
  } catch { /* log is best-effort */ }
}

// dsh plugin-failure recovery: when dsh exits because a plugin failed to
// load (e.g. an upstream regex bug), offer to disable that plugin for the
// next start by appending `- disable: <id>` to the web profile patch.
const PLUGIN_FAIL_RE = /failed to (?:import|apply) loader entry\s+([A-Za-z0-9_.-]+)\s*\(([^)]+)\)/g;

// Portable ("bundled") runtime: node + dsh + pnpm shipped under resources/
// (or ./bundled in development).
function bundledRuntimePresent() {
  try {
    const b = bundledPaths();
    return fs.existsSync(path.join(b.base, 'node', 'bin', 'node')) &&
      fs.existsSync(path.join(b.base, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  } catch { return false; }
}

function bundledPaths() {
  const candidates = [process.resourcesPath, path.join(__dirname, '..')].filter(Boolean);
  for (const root of candidates) {
    const base = path.join(root, 'bundled');
    if (fs.existsSync(path.join(base, 'node', 'bin', 'node'))) {
      return {
        base,
        node: path.join(base, 'node', 'bin', 'node'),
        dsh: path.join(base, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
        pnpm: path.join(base, 'pnpm', 'pnpm'),
      };
    }
  }
  const root = candidates[0] || path.join(__dirname, '..');
  const base = path.join(root, 'bundled');
  return {
    base,
    node: path.join(base, 'node', 'bin', 'node'),
    dsh: path.join(base, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    pnpm: path.join(base, 'pnpm', 'pnpm'),
  };
}

// Known upstream bug in dsh-plugin-vetting (0.4.0): the FLAG_PATTERN regex
// has an unescaped `/proc` slash which is a SyntaxError under Node. The
// bundled dsh bootstraps this plugin into its own profile on first start;
// patch it proactively so portable mode works out of the box.
function ensureVettingPatched() {
  const file = path.join(balanceApi.getDshHome(), 'profiles', 'web', 'node_modules', 'dsh-plugin-vetting', 'lib', 'index.js');
  try {
    let s = fs.readFileSync(file, 'utf8');
    const broken = 'http:\\/\\/\\d{1,3}\\.|/proc\\/\\d+\\/environ';
    const fixed = 'http:\\/\\/\\d{1,3}\\.|\\/proc\\/\\d+\\/environ';
    if (s.includes(broken)) {
      s = s.replace(broken, fixed);
      fs.writeFileSync(file, s);
    }
  } catch { /* file not there yet (profile not bootstrapped) — first start handles it */ }
}

function detectFailedPlugin(logText) {
  // Error chains nest ("failed to apply loader entry include (...): failed
  // to import loader entry plugin-vet (...)") — the innermost (last) match is
  // the plugin that actually failed to load.
  const matches = [...(logText || '').matchAll(PLUGIN_FAIL_RE)];
  const m = matches[matches.length - 1];
  // Disable by package name when the loader reports one (entry ids are
  // per-install hashes like "9fba86a4" — writing those into cordis.patch.yml
  // disables nothing because the hash changes every bootstrap).
  if (m && m[2]) return { id: m[2], pkg: m[2] };
  return m ? { id: m[1], pkg: m[2] || m[1] } : null;
}

function readDshLogTail() {
  try {
    const file = path.join(app.getPath('userData'), 'dsh.log');
    const st = fs.statSync(file);
    const size = Math.min(st.size, 16384);
    const buf = Buffer.alloc(size);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, size, st.size - size);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch { return ''; }
}

// Append `- disable: <id>` to the dsh web profile patch (cordis.patch.yml).
// Returns true on success or when already disabled.
function disableDshPlugin(pluginId, patchFile) {
  const file = patchFile || path.join(balanceApi.getDshHome(), 'profiles', 'web', 'cordis.patch.yml');
  try {
    // Bundle plugins (listed in the profile's dsh.profile.bundles) load
    // BEFORE the patch layer — a `disabled: true` patch entry never reaches
    // them, so remove the bundle entry instead.
    const pkgFile = path.join(balanceApi.getDshHome(), 'profiles', 'web', 'package.json');
    if (fs.existsSync(pkgFile)) {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      const bundles = pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles;
      if (Array.isArray(bundles) && bundles.includes(pluginId)) {
        pkg.dsh.profile.bundles = bundles.filter((b) => b !== pluginId);
        if (pkg.dependencies && pkg.dependencies[pluginId]) delete pkg.dependencies[pluginId];
        fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
        console.log(`[dsh] removed bundle entry for ${pluginId} from profile package.json`);
        return true;
      }
    }
    // Non-bundle (patch-layer) plugin: write the disabled entry as before.
    // PatchOptions requires an id for non-insert patches ("id is required
    // for non-insert patches"), and disabled is a boolean.
    const entry = `- id: ${pluginId}\n  disabled: true`;
    let text = fs.readFileSync(file, 'utf8');
    // Already disabled (id + disabled:true pair) — nothing to do. A bare
    // `id: <pluginId>` without the flag means an unrelated entry: keep going.
    const escaped = pluginId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const alreadyDisabled = new RegExp(
      `id:\\s*${escaped}\\s*\\n(?:\\s*\\w+:\\s*[^\\n]*\\n)*?\\s*disabled:\\s*true`
    ).test(text);
    if (alreadyDisabled) return true;
    if (/^\[\]\s*$/m.test(text)) {
      // Replace a bare `[]` (possibly after comment lines) with the entry;
      // never leave `[]` followed by block entries — that is invalid YAML
      // and dsh refuses to start.
      text = text.replace(/^\[\]\s*$/m, entry);
    } else {
      const entryRe = new RegExp(`(- id:\\s*${escaped}\\s*\\n)(?!\\s*disabled:)`);
      if (entryRe.test(text)) {
        // Entry exists without the flag — set disabled on it (a second entry
        // with the same id would be a duplicate the loader may reject).
        text = text.replace(entryRe, `$1  disabled: true\n`);
      } else {
        text = text.replace(/\s*$/, '\n') + entry + '\n';
      }
    }
    fs.writeFileSync(file, text);
    return true;
  } catch (e) {
    console.error('[dsh] failed to disable plugin:', e.message);
    return false;
  }
}

// Plugin-failure self-heal state (shared by the exit-code path in startDsh
// and the page-probe path in createWindow): guard against stacked prompts and
// against re-offering the same plugin after the user disabled it.
let pluginPromptOpen = false;
let recentlyDisabledPlugin = null;

function startDsh() {
  const isBundled = config.dshCommand === 'bundled';
  let args;
  let bin;
  let env = { ...process.env, DSH_HOME: balanceApi.getDshHome() };
  if (isBundled) {
    // Portable mode: run the bundled dsh with the bundled node; put the
    // bundled node/pnpm bins on PATH so dsh's profile bootstrap can spawn
    // npm/pnpm itself.
    const b = bundledPaths();
    bin = b.node;
    args = [b.dsh, 'web', '--port', String(config.port)];
    const binDirs = [path.dirname(b.node), path.dirname(b.pnpm), process.env.PATH].filter(Boolean);
    env.PATH = binDirs.join(path.delimiter);
    ensureVettingPatched();
  } else {
    args = config.dshCommand === 'npx'
      ? ['-y', DSH_PACKAGE, 'web', '--port', String(config.port)]
      : ['web', '--port', String(config.port)];
    bin = config.dshCommand === 'npx' ? 'npx' : config.dshCommand === 'global' ? 'dsh' : config.dshCommand;
    // GUI launches get a bare PATH (~/.npm-global/bin etc. missing) — probe
    // the common user install locations before spawning, same as the version
    // checks do; otherwise spawn fails with ENOENT.
    const probed = probeBin(bin) || probeBin(bin + '.cmd') || probeBin(bin.replace(/\.cmd$/, ''));
    if (probed) bin = probed;
    if (process.platform === 'win32' && !bin.endsWith('.exe') && !path.isAbsolute(bin) && !bin.includes('/') && !bin.includes('\\')) {
      bin += '.cmd';
    }
  }

  const proc = spawn(bin, args, {
    cwd: os.homedir(),
    // dsh requires an explicit DSH_HOME (newer builds fail with
    // MISSING_DSH_HOME otherwise); keep it consistent with the local scan.
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group so stopDsh can kill the whole tree (npx -> sh -> node dsh).
    detached: process.platform !== 'win32',
  });
  proc.stdout.on('data', logDshLine);
  proc.stderr.on('data', logDshLine);
  proc.on('error', (err) => {
    // spawn failed (binary not found, etc.)
    dshProc = null;
    if (!quitting) showFatal(t('spawnFail', { err: err.message }));
  });
  proc.on('exit', (code, signal) => {
    const unexpected = dshProc === proc;
    dshProc = null;
    if (unexpected && !quitting) {
      // Plugin-failure recovery: offer to disable the failing plugin.
      if (!pluginPromptOpen && code !== 0) {
        const plugin = detectFailedPlugin(readDshLogTail());
        if (plugin && plugin.id !== recentlyDisabledPlugin) {
          // Portable mode: auto-patch the known dsh-plugin-vetting upstream
          // regex bug instead of prompting (the plugin file exists after the
          // first bootstrap run).
          if (config.dshCommand === 'bundled' && plugin.id === 'plugin-vet') {
            ensureVettingPatched();
            setTimeout(boot, 1500);
            return;
          }
          pluginPromptOpen = true;
          try {
            const opts = {
                type: 'warning',
                buttons: [t('pluginDisableRestart'), t('pluginSkip')],
                defaultId: 0,
                cancelId: 1,
                noLink: true,
                message: t('pluginFailMsg', { id: plugin.id }),
              };
              const w = win && !win.isDestroyed() ? win : undefined;
              const disable = (w ? dialog.showMessageBoxSync(w, opts) : dialog.showMessageBoxSync(opts)) === 0;
              if (disable && disableDshPlugin(plugin.id)) {
              recentlyDisabledPlugin = plugin.id;
              notify(t('pluginDisabledTitle'), t('pluginDisabledBody', { id: plugin.id }));
              setTimeout(boot, 1500);
              return; // restarting with the plugin disabled — no fatal page
            }
          } finally {
            pluginPromptOpen = false;
          }
        }
      }
      showFatal(t('exitUnexpected', { code, signal, log: path.join(app.getPath('userData'), 'dsh.log') }));
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
    execFile('ss', ['-tlnpH'], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve(null);
      // Listen lines look like:
      //   LISTEN 0 511 127.0.0.1:3080 0.0.0.0:* users:(("node",pid=1234,fd=20))
      // Match the local-address column exactly (":3080" but not ":13080").
      const re = new RegExp(`\\S+[:.]${port}\\s`, 'i');
      for (const line of stdout.split('\n')) {
        if (!re.test(line)) continue;
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

async function restartDsh() {
  const port = config.port;
  // stopDsh() also waits for an externally-started dsh to be stopped — that
  // must finish before boot() spawns a new process, or stopExternalDsh may
  // kill the fresh dsh it mistakes for an external one.
  await stopDsh();
  // Wait for the old server to actually release the port (poll instead of a
  // fixed 1.5s sleep — slow machines needed longer, fast ones less).
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && await isServerUp(port)) {
    await sleep(250);
  }
  boot();
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
    <div>${t('loadingTitle')}</div>
    <div class="hint">${t('loadingHint')}</div>
  </body></html>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function fatalPage(message) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:#0d1117;color:#f85149;font-family:system-ui,sans-serif;padding:40px;text-align:center}
    code{color:#c9d1d9;font-size:13px;word-break:break-all}
  </style></head><body>
    <div style="font-size:20px">${t('fatalTitle')}</div>
    <code>${String(message).replace(/</g, '&lt;')}</code>
    <div style="color:#8b949e;font-size:13px">${t('fatalHint')}</div>
  </body></html>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

// ---------- window ----------

function createWindow() {
  const workAreas = screen.getAllDisplays().map((d) => d.workArea);
  const ws = clampWindowState(config.windowState, workAreas, { x: undefined, y: undefined, width: 1280, height: 820 });
  win = new BrowserWindow({
    width: ws.width,
    height: ws.height,
    ...(ws.x !== undefined && ws.y !== undefined ? { x: ws.x, y: ws.y } : {}),
    minWidth: 720,
    minHeight: 480,
    title: 'DeepSeek Harness',
    icon: nativeImage.createFromPath(ICON_PATH),
    // First startup: the view is blank until the (loading) page paints; an
    // unpainted BrowserWindow on some compositors renders transparent with
    // ghosting until a resize forces a repaint. Paint the window bg from the
    // start (matches the loading/fatal pages).
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(__dirname, 'webview-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (ws.maximized) win.maximize();

  // The main content lives in its own WebContentsView so a docked sidebar
  // (files panel) can be laid out beside it without overlapping.
  mainView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'webview-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.contentView.addChildView(mainView);
  // Same reason as the window backgroundColor: an unpainted view can composite
  // as transparent with trailing ghost images until a repaint.
  mainView.setBackgroundColor('#0d1117');

  // Inject the in-page session menu/pins whenever the dsh UI (re)loads. The
  // script self-guards against double injection and retries __ModuleLoader__
  // on its own; runs only for the app origin (the loading page is a data: URL).
  // Detect the dsh "Failed to load plugins" page and offer to disable the
  // failing plugin. dsh keeps serving HTTP (exit 0) even when a plugin fails
  // to load, so the exit-code self-heal never fires for these — the page is
  // the only reliable signal. Debounced to avoid re-probing every navigation.
  let failProbeTimer = null;
  const probePluginFailPage = () => {
    try {
      const u = new URL(mainView.webContents.getURL());
      if (u.origin !== new URL(appUrl()).origin) return;
      clearTimeout(failProbeTimer);
      failProbeTimer = setTimeout(() => {
        mainView.webContents.executeJavaScript(
          `(() => { const t = document.body && document.body.innerText || ''; return /failed to load plugins/i.test(t) ? t.slice(0, 2000) : ''; })()`,
          true,
        ).then((text) => {
          if (!text) return;
          const plugin = detectFailedPlugin(text);
          if (!plugin || plugin.id === recentlyDisabledPlugin) return;
          pluginPromptOpen = true;
          try {
            const opts = {
              type: 'warning',
              buttons: [t('pluginDisableRestart'), t('pluginSkip')],
              defaultId: 0,
              cancelId: 1,
              noLink: true,
              message: t('pluginFailMsg', { id: plugin.id }),
            };
            const w = win && !win.isDestroyed() ? win : undefined;
            const disable = (w ? dialog.showMessageBoxSync(w, opts) : dialog.showMessageBoxSync(opts)) === 0;
            if (disable && disableDshPlugin(plugin.id)) {
              recentlyDisabledPlugin = plugin.id;
              notify(t('pluginDisabledTitle'), t('pluginDisabledBody', { id: plugin.id }));
              setTimeout(boot, 1500);
            }
          } finally {
            pluginPromptOpen = false;
          }
        }).catch(() => { /* page still loading or navigated away */ });
      }, 2500);
    } catch { /* not a URL yet */ }
  };
  const injectIfAppOrigin = () => {
    try {
      const u = new URL(mainView.webContents.getURL());
      if (u.origin === new URL(appUrl()).origin) {
        injectSessionMenu();
        probePluginFailPage();
      }
    } catch { /* not a URL yet */ }
  };
  mainView.webContents.on('did-finish-load', injectIfAppOrigin);
  mainView.webContents.on('did-navigate', injectIfAppOrigin);

  // Persist bounds (debounced) so the window reopens where the user left it.
  let boundsTimer = null;
  const saveBounds = () => {
    if (!win || win.isDestroyed() || win.isMinimized() || win.isMaximized()) return;
    config.windowState = { ...win.getBounds(), maximized: false };
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(saveConfig, 500);
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);
  win.on('close', () => {
    if (win && !win.isDestroyed()) {
      config.windowState = { ...win.getBounds(), maximized: win.isMaximized() };
      saveConfig();
    }
  });

  // Keep navigation inside the local dsh server; open everything else in the system browser.
  const allowedHost = new URL(appUrl()).host;
  mainView.webContents.on('will-navigate', (event, url) => {
    try {
      const u = new URL(url);
      // File drops that the page does not handle navigate to file:// — route
      // them into the quick input as attachment paths instead of launching
      // the system file manager (the old shell.openExternal behavior).
      if (u.protocol === 'file:') {
        event.preventDefault();
        prefillQuickInput([u.pathname.replace(/^\/([A-Za-z]:)/, '$1')]);
        return;
      }
      if (u.protocol !== 'http:' || u.host !== allowedHost) {
        event.preventDefault();
        shell.openExternal(url);
      }
    } catch {
      event.preventDefault();
    }
  });
  mainView.webContents.setWindowOpenHandler(({ url }) => {
    // Only hand http(s) links to the system browser — a remote page must not
    // be able to open arbitrary schemes (file:, custom protocol handlers…).
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') shell.openExternal(url);
    } catch { /* invalid URL — ignore */ }
    return { action: 'deny' };
  });

  // Keep the settings overlay centered when the main window is resized.
  win.on('resize', () => {
    if (overlayView && !win.isDestroyed()) overlayView.setBounds(centeredOverlayBounds());
    layoutFilesPanel();
  });

  // A page reload drops injected CSS — re-apply the mask if the overlay is open.
  mainView.webContents.on('did-navigate', () => {
    if (overlayView) applyOverlayMask();
  });

  // Follow session switches made INSIDE this window: opening a conversation
  // makes the frontend POST /api/session.history with the session id. The
  // server exposes no "current session" state, but we can observe the
  // request and make it our current session (auto-follows browsing switches).
  try {
    const ses = mainView.webContents.session;
    // Follow session switches made INSIDE this window. Any /api/session.*
    // request carrying a session id counts as "the user opened that session"
    // (the frontend may use different RPCs depending on its cache state).
    ses.webRequest.onBeforeRequest({ urls: ['http://127.0.0.1:*/api/session.*'] }, (details, callback) => {
      try {
        const raw = details.uploadData && details.uploadData[0] && details.uploadData[0].bytes;
        if (raw) {
          const body = JSON.parse(Buffer.from(raw).toString('utf8'));
          const sid = body && body.payload && body.payload.sessionId;
          if (typeof sid === 'string' && sid.startsWith('session-')) {
            config.balanceSessionId = sid;
            config.balanceSessionIdManual = false;
            saveConfig();
            refreshBalance();
            // Keep the companion plugin's /api/state (and therefore the
            // DS-pet) in sync with what the user is actually viewing. The
            // plugin cannot infer UI-navigation sessions from server events
            // alone, so the desktop reports them here.
            if (pluginAvailable === true) {
              fetch(`http://127.0.0.1:${config.port}/api/set-session`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: sid }),
              }).catch(() => {});
            }
          }
        }
      } catch { /* non-fatal */ }
      callback({});
    });
  } catch { /* webRequest unavailable — manual picking still works */ }

  win.on('close', (event) => {
    if (quitting) return;    if (config.closeBehavior === 'tray') {
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
  win.on('closed', () => { win = null; mainView = null; maskCssKey = null; filesView = null; });

  if (config.filesPanelOpen === true) toggleFilesPanel(true);
  return win;
}

async function boot() {
  if (!win) createWindow();
  mainView.webContents.loadURL(loadingPage());

  // Portable mode: never reuse an external dsh server on the configured port
  // (that would show the host's own ~/.dsh sessions). Pick a free port
  // instead, so the bundled runtime serves its own data directory.
  if (config.dshCommand === 'bundled') {
    for (let i = 0; i < 10 && await isServerUp(config.port); i++) {
      console.log(`[boot] port ${config.port} busy, trying ${config.port + 1}`);
      config.port += 1;
    }
  }

  if (await isServerUp(config.port)) {
    // A dsh server is already running on this port — reuse it.
    console.log(`[boot] reusing existing dsh on ${config.port}`);
    mainView.webContents.loadURL(appUrl());
    return;
  }

  startDsh();
  const ready = await waitForServer(config.port, 120_000, (elapsed) => {
    if (win && !win.isDestroyed()) win.setTitle(`DeepSeek Harness — 启动中 ${elapsed}s`);
  });
  if (win && !win.isDestroyed()) win.setTitle('DeepSeek Harness');
  if (ready) {
    mainView.webContents.loadURL(appUrl());
  } else if (dshProc !== null) {
    // dshProc === null means spawn failed or dsh exited — already handled
    // by the 'error'/'exit' callbacks, which showed the fatal page.
    mainView.webContents.loadURL(fatalPage(t('bootTimeout', { port: config.port })));
  }
}

function showFatal(message) {
  dialog.showErrorBox('DeepSeek Harness', message);
  if (win && !win.isDestroyed()) mainView.webContents.loadURL(fatalPage(message));
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
    title: t('buildConfirmTitle'),
    message: t('buildConfirmMsg'),
    detail: t('buildConfirmDetail', { dir: config.sourceDir }),
    buttons: [t('buildStart'), t('cancel')],
    defaultId: 0,
    cancelId: 1,
  });
  if (choice !== 0) return;
  building = true;
  // Fresh build: remove stale artifacts first so dist/ only holds the new
  // version and the newest-deb pick can never grab an older one.
  fs.rmSync(path.join(config.sourceDir, 'dist'), { recursive: true, force: true });
  notify(t('buildStartTitle'), t('buildStartBody'));
  const proc = spawn('bash', ['-lc', 'npm run dist'], {
    cwd: config.sourceDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', logDshLine);
  proc.stderr.on('data', logDshLine);
  proc.on('error', (err) => {
    building = false;
    notify(t('buildFailTitle'), err.message);
  });
  proc.on('exit', (code) => {
    building = false;
    if (code !== 0) {
      notify(t('buildFailTitle'), t('buildFailExit', { code }));
      return;
    }
    const deb = newestDebIn(path.join(config.sourceDir, 'dist'));
    if (!deb) {
      notify(t('buildFailTitle'), t('buildFailNoDeb'));
      return;
    }
    notify(t('buildDoneTitle'), t('buildDoneBody'));
    const inst = spawn('pkexec', ['dpkg', '-i', deb], { stdio: ['ignore', 'pipe', 'pipe'] });
    inst.stdout.on('data', logDshLine);
    inst.stderr.on('data', logDshLine);
    inst.on('error', (err) => {
      dialog.showErrorBox(t('installFailTitle'), t('installFailPkexec', { err: err.message, deb }));
    });
    inst.on('exit', (c) => {
      if (c === 0) {
        askBox({ type: 'info', title: t('buildDoneTitle'), message: t('installDoneMsg'), buttons: [t('ok')] });
        app.relaunch();
        app.exit(0);
      } else {
        dialog.showErrorBox(t('installFailTitle'), t('installFailExit', { code: c, deb }));
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
      message: t('updateDownloadedMsg'),
      buttons: [t('restartNow'), t('later')],
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
  // Portable mode ships a fixed dsh version — there is no npm-side update to
  // apply (updating means re-downloading the portable build).
  if (config.dshCommand === 'bundled') return;
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
const balanceApi = require('./balance');

// ---------- companion plugin (dsh-plugin-desktop) ----------
// Preferred source for current-session state and realtime usage; when absent
// everything falls back to the legacy paths (webRequest sniff + local scan).

let pluginAvailable = null; // null = unknown, true/false after first probe

async function probePlugin(force) {
  if (pluginAvailable !== null && !force) return pluginAvailable;
  try {
    await balanceApi.fetchPluginState(config.port);
    pluginAvailable = true;
  } catch {
    pluginAvailable = false;
  }
  return pluginAvailable;
}

// Copy the bundled plugin into the profile's node_modules and register it in
// cordis.patch.yml (same recovery path disableDshPlugin uses). Zero npm deps,
// so a plain directory copy is a complete install.
function installDesktopPlugin() {
  // Packaged: plugin ships inside app.asar at <root>/plugin/dsh-plugin-desktop,
  // so __dirname (="resources/app.asar") itself is the app root — a ".." step
  // from here lands in resources/, where the plugin is NOT present. Dev runs
  // have __dirname = the repo root. Try __dirname first, then the old paths.
  const src = [__dirname, process.resourcesPath, path.join(__dirname, '..')]
    .filter(Boolean)
    .map((root) => path.join(root, 'plugin', 'dsh-plugin-desktop'))
    .find((p) => fs.existsSync(path.join(p, 'lib', 'index.js')));
  if (!src) {
    notify(t('pluginInstallFail', { err: 'plugin sources not found in the app bundle' }));
    return false;
  }
  const profileRoot = path.join(balanceApi.getDshHome(), 'profiles', 'web');
  const dest = path.join(profileRoot, 'node_modules', 'dsh-plugin-desktop');
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    // Copy the plugin out of the asar. Electron's fs is asar-aware for reads,
    // but cpSync of a directory tree out of an asar is unreliable — walk and
    // copy file by file with readFileSync/writeFileSync instead.
    const files = ['lib/index.js', 'package.json', 'README.md', 'test/run.mjs'];
    fs.mkdirSync(dest, { recursive: true });
    for (const rel of files) {
      const s = path.join(src, rel);
      const d = path.join(dest, rel);
      try {
        const buf = fs.readFileSync(s);
        fs.mkdirSync(path.dirname(d), { recursive: true });
        fs.writeFileSync(d, buf);
      } catch { /* missing optional file — skip */ }
    }
    // Register in the loader patch — append `- include: dsh-plugin-desktop`
    // unless an entry is already there.
    const patch = path.join(profileRoot, 'cordis.patch.yml');
    let text = '';
    try { text = fs.readFileSync(patch, 'utf8'); } catch { text = '[]\n'; }
    if (!/dsh-plugin-desktop/.test(text)) {
      if (/^\[\]\s*$/m.test(text)) text = text.replace(/^\[\]\s*$/m, '- insert:\n    - id: dsh-plugin-desktop\n      name: dsh-plugin-desktop\n      inject:\n        - webServer\n        - apiProxy');
      else text = text.replace(/\s*$/, '\n') + '- insert:\n    - id: dsh-plugin-desktop\n      name: dsh-plugin-desktop\n      inject:\n        - webServer\n        - apiProxy\n';
      fs.writeFileSync(patch, text);
    }
    return true;
  } catch (e) {
    notify(t('pluginInstallFail', { err: e.message }));
    return false;
  }
}

function installPluginAndRestart() {
  notify('DeepSeek Harness', t('pluginInstalling'));
  if (installDesktopPlugin()) {
    pluginAvailable = null; // re-probe after restart
    notify('DeepSeek Harness', t('pluginInstallDone'));
    restartDsh();
  }
}

// ---------- in-page session menu & pinned sessions ----------
// The context menu + pinned section run INSIDE the dsh web page (page world,
// via __ModuleLoader__, same contract as community plugins) but are injected
// by the shell — no dsh plugin install needed. Pin state lives in the
// desktop config and travels to the page through webview-preload.js.

let sessionMenuJs = null;
function injectSessionMenu() {
  if (!win || win.isDestroyed()) return;
  try {
    if (!sessionMenuJs) {
      // Both in-page modules: context menu/pins + shell bridge (composer
      // insert, workspace report, files-panel toggle button).
      sessionMenuJs = ['session-menu.js', 'shell-bridge.js']
        .map((f) => fs.readFileSync(path.join(__dirname, 'inject', f), 'utf8'))
        .join('\n;\n');
    }
    mainView.webContents.executeJavaScript(sessionMenuJs, true).catch((e) => {
      console.error('[inject] session menu failed:', e.message);
    });
  } catch (e) {
    console.error('[inject] cannot read session-menu.js:', e.message);
  }
}

function sendPinsToPage() {
  if (win && !win.isDestroyed()) mainView.webContents.send('pins-changed', config.pinnedSessions || []);
}

function registerPinIpc() {
  // The page announces itself (mailbox bridge is up) — answer with the pins.
  ipcMain.on('pins:hello', () => sendPinsToPage());
  ipcMain.on('pins:toggle', (_e, session) => {
    if (!session || typeof session.id !== 'string') return;
    config.pinnedSessions = togglePin(config.pinnedSessions, session);
    saveConfig();
    sendPinsToPage();
    applyMenus(); // tray pinned list follows
  });
  ipcMain.handle('pins:get', () => config.pinnedSessions || []);
}

// Jump to a pinned session from the tray: show the window, tell the page.
function jumpToSession(id) {
  if (!id) return;
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    const hit = (balanceState.sessions || []).find((x) => x.id === id);
    mainView.webContents.send('jump', { id, title: hit ? hit.title : '' });
  }
}

// ---------- right-dock files panel (workspace browser + stats) ----------
// Native replication of dsh-workspace-explorer (MIT): lazy tree, [file: path]
// references, open-in-file-manager, 60-line preview — plus a stats strip fed
// by the EXISTING balance pipeline (sessionCost/turnCost) and the official
// session.list tokenUsage.

let mainView = null;
let filesView = null;
let workspaceState = { list: [], currentPath: '', currentSessionId: null };
const FILES_PANEL_W = 260;

function layoutFilesPanel() {
  if (!win || win.isDestroyed()) return;
  const [w, h] = win.getContentSize();
  if (mainView) {
    mainView.setBounds({ x: 0, y: 0, width: filesView ? Math.max(200, w - FILES_PANEL_W) : w, height: h });
  }
  if (filesView) {
    const panelX = w - FILES_PANEL_W;
    const panelW = FILES_PANEL_W;
    filesView.setBounds({ x: Math.max(0, panelX), y: 0, width: panelW, height: h });
    // Set a background color so the panel is visually distinct
    if (filesView.webContents) {
      filesView.webContents.insertCSS('body { background: var(--dsw-alias-bg-layer-2, #f5f5f5); }');
    }
  }
}

function toggleFilesPanel(on) {
  const want = on === undefined ? !filesView : !!on;
  if (want && !filesView && win && !win.isDestroyed()) {
    filesView = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.contentView.addChildView(filesView);
    filesView.webContents.loadFile(path.join(__dirname, 'files-panel.html'));
  } else if (!want && filesView) {
    try {
      if (win && !win.isDestroyed()) win.contentView.removeChildView(filesView);
      filesView.webContents.close();
    } catch { /* already gone */ }
    filesView = null;
  }
  if ((config.filesPanelOpen === true) !== !!filesView) {
    config.filesPanelOpen = !!filesView;
    saveConfig();
  }
  layoutFilesPanel();
}

function sendToPage(kind, payload) {
  if (win && !win.isDestroyed()) {
    // Rides the same mailbox protocol as pins/jump (see webview-preload.js).
    if (kind === 'insert-composer') mainView.webContents.send('insert', payload);
  }
}

function registerFilesIpc() {
  ipcMain.on('ws:report', (_e, snap) => {
    if (snap && Array.isArray(snap.list)) workspaceState = snap;
  });
  ipcMain.on('panel:toggle', () => toggleFilesPanel());
  ipcMain.on('composer:miss', () => {
    notify('DeepSeek Harness', t('composerMiss'));
  });
  ipcMain.handle('files:toggle', (_e, on) => { toggleFilesPanel(on === undefined ? undefined : !!on); return !!filesView; });
  ipcMain.handle('ws:list', (_e, a) => wsTree.wsList(String(a && a.root || ''), String(a && a.rel || '')));
  ipcMain.handle('ws:peek', (_e, a) => wsTree.wsPeek(String(a && a.path || '')));
  ipcMain.handle('ws:state', () => workspaceState);
  ipcMain.handle('stats:get', () => ({
    tokens: balanceState.currentTokens || null,
    sessionCost: balanceState.sessionCost,
    turnCost: balanceState.turnCost,
    currentId: balanceState.currentId,
  }));
  ipcMain.handle('insert:composer', (_e, text) => {
    if (typeof text !== 'string' || !text) return false;
    if (win && !win.isDestroyed()) {
      sendToPage('insert-composer', { text });
      return true;
    }
    return false;
  });
  ipcMain.handle('open:external-path', (_e, p) => {
    if (typeof p !== 'string' || !p || !fs.existsSync(p)) return false;
    // Only directories that were reported by the page's workspaces service,
    // or anything beneath them, may be opened.
    const known = workspaceState.list.some((w) => p === w.path || p.startsWith(w.path + '/'))
      || p === workspaceState.currentPath || (workspaceState.currentPath && p.startsWith(workspaceState.currentPath + '/'));
    if (!known) return false;
    shell.openPath(p);
    return true;
  });
}

// ---------- approvals, unread activity, palette, ws search/git ----------

// Approvals: the companion plugin surfaces pendingApproval in /api/state;
// doRefresh watches it, pops a small native decision dialog + a system
// notification when it appears (and closes both when it clears).
let lastApprovalId = null;
let approvalWin = null;

function underKnownRoot(p) {
  if (typeof p !== 'string' || !p) return false;
  const roots = [...workspaceState.list.map((w) => w.path), workspaceState.currentPath].filter(Boolean);
  return roots.some((r) => p === r || p.startsWith(r + '/'));
}

function showApproval(ap) {
  try {
    const n = new Notification({ title: t('approvalTitle'), body: ap.summary || t('turnDoneBody') });
    n.on('click', () => { if (win && !win.isDestroyed()) { win.show(); win.focus(); } });
    n.show();
  } catch { /* best-effort */ }
  if (!approvalWin || approvalWin.isDestroyed()) {
    approvalWin = new BrowserWindow({
      width: 420, height: 190, show: false, frame: false, resizable: false,
      skipTaskbar: true, alwaysOnTop: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    });
    approvalWin.loadFile(path.join(__dirname, 'approve-popup.html'));
    approvalWin.webContents.on('did-finish-load', () => {
      if (approvalWin) approvalWin.webContents.send('approval:show', currentApproval);
    });
  }
  currentApproval = ap;
  if (approvalWin && !approvalWin.isDestroyed()) {
    const [w] = win && !win.isDestroyed() ? win.getContentSize() : [420, 300];
    approvalWin.setPosition(Math.round(w / 2 - 210), 80);
    approvalWin.webContents.send('approval:show', ap);
    approvalWin.showInactive();
  }
}

function hideApproval() {
  if (approvalWin && !approvalWin.isDestroyed() && approvalWin.isVisible()) approvalWin.hide();
}

// Unread activity: sessions whose lastTurnEndSeq grew while NOT active.
const prevTurnSeq = new Map();
const unreadSessions = new Set();
function markSessionRead(id) { if (id) unreadSessions.delete(id); }

// Palette (Ctrl+Shift+P switch / Ctrl+Shift+F transcript search).
let paletteWin = null;
function openPalette(mode) {
  if (!paletteWin || paletteWin.isDestroyed()) {
    paletteWin = new BrowserWindow({
      width: 600, height: 440, show: false, frame: false, resizable: false,
      skipTaskbar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    });
    paletteWin.loadFile(path.join(__dirname, 'palette.html'));
    paletteWin.on('blur', () => { if (paletteWin && paletteWin.isVisible()) paletteWin.hide(); });
  }
  paletteWin.webContents.send('palette:mode', mode);
  const [w, h] = win && !win.isDestroyed() ? win.getContentSize() : [600, 440];
  paletteWin.setPosition(Math.round(w / 2 - 300), Math.round(h / 2 - 220));
  paletteWin.show();
  paletteWin.focus();
  paletteWin.webContents.send('palette:mode', mode);
}

// Workspace text search (main-process fs walk; same noise filter as ws-tree).
function wsSearch(root, query) {
  if (!root || !query) return { ok: false, error: 'bad-args' };
  const needle = String(query).toLowerCase();
  const out = [];
  const seen = { files: 0 };
  const walk = (abs, rel, depth) => {
    if (out.length >= 200 || depth > 8 || seen.files > 1500) return;
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === '.DS_Store') continue;
      if (e.isDirectory()) { if (!wsTree.IGNORED.has(e.name)) walk(path.join(abs, e.name), rel ? rel + '/' + e.name : e.name, depth + 1); continue; }
      if (out.length >= 200 || seen.files > 1500) return;
      seen.files++;
      const p = path.join(abs, e.name);
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.size > 256 * 1024) continue;
      let text; try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
      if (text.indexOf('\u0000') >= 0) continue; // binary
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && out.length < 200; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          out.push({ rel: rel ? rel + '/' + e.name : e.name, path: p, line: i + 1, text: lines[i].trim().slice(0, 200) });
        }
      }
    }
  };
  walk(root, '', 0);
  return { ok: true, results: out, scanned: seen.files };
}

// Workspace git review (read-only).
function wsGit(root) {
  return new Promise((resolve) => {
    if (!root) return resolve({ ok: false, error: 'bad-args' });
    execFile('git', ['-C', root, 'status', '--porcelain=v1', '-b'], { timeout: 8000 }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: String(err.code || err.message) });
      const lines = String(stdout).split('\n');
      const branch = (lines[0] || '').replace(/^##\s+/, '').trim();
      const files = lines.slice(1).filter(Boolean).map((l) => ({
        status: l.slice(0, 2).trim(),
        path: l.slice(3).trim(),
      }));
      execFile('git', ['-C', root, 'diff', '--unified=1'], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (err2, diff) => {
        resolve({ ok: true, branch, files, diff: err2 ? '' : String(diff).slice(0, 200 * 1024) });
      });
    });
  });
}

function registerExtrasIpc() {
  ipcMain.handle('approval:decide', async (_e, decision) => {
    if (decision === 'view') {
      if (win && !win.isDestroyed()) { win.show(); win.focus(); }
      return { ok: true };
    }
    hideApproval();
    try {
      const r = await balanceApi.sendPluginApprove(config.port, decision);
      return r;
    } catch (e) {
      return { ok: false, status: 0, error: e.message };
    }
  });

  ipcMain.handle('palette:sessions', () => balanceState.sessions.map((s) => ({
    id: s.id,
    title: s.title,
    cost: s.cost,
    unread: unreadSessions.has(s.id),
    mtimeMs: s.mtimeMs,
    current: s.id === balanceState.currentId,
  })));

  ipcMain.handle('session-search', (_e, q) => balanceApi.searchSessions(String(q || ''), 60));
  ipcMain.handle('palette:open', (_e, id) => {
    if (typeof id === 'string' && id) {
      markSessionRead(id);
      jumpToSession(id);
    }
    if (paletteWin && !paletteWin.isDestroyed() && paletteWin.isVisible()) paletteWin.hide();
    return true;
  });

  ipcMain.handle('ws:search', (_e, a) => wsSearch(String(a && a.root || ''), String(a && a.query || '')));
  ipcMain.handle('ws:git', (_e, a) => wsGit(String(a && a.root || '')));

  // Ctrl+click on a chat path → reveal in the OS file manager (page → main).
  ipcMain.on('reveal', (_e, payload) => {
    const p = payload && typeof payload.path === 'string' ? payload.path : '';
    if (!p) return;
    const candidates = path.isAbsolute(p)
      ? [p]
      : [...(workspaceState.currentPath ? [workspaceState.currentPath] : []), ...workspaceState.list.map((w) => w.path)]
          .map((r) => path.join(r, p));
    for (const c of candidates) {
      try {
        if (fs.existsSync(c) && underKnownRoot(c)) { shell.showItemInFolder(c); return; }
      } catch { /* keep looking */ }
    }
  });

  // Quick input history (per profile, cleared on switch).
  ipcMain.handle('quick:history', (_e, arg) => {
    const list = config.quickInputHistory || [];
    if (arg && arg.op === 'push' && typeof arg.text === 'string' && arg.text.trim()) {
      const text = arg.text.trim();
      if (list[0] !== text) {
        config.quickInputHistory = [text, ...list.filter((x) => x !== text)].slice(0, 50);
        saveConfig();
      }
      return config.quickInputHistory;
    }
    return list;
  });
}

let currentApproval = null;


// ---------- balance & usage ----------

let balanceState = {
  official: null, currency: 'CNY', consumed: 0, hitRate: 0,
  estimated: null, calibrated: false, error: null,
  sessionCost: 0, turnCost: 0,
  currentId: null,
  currentTokens: null, // official session.list tokenUsage of the active session
  dshTurn: null, // 'working' | 'idle' | null (null = companion plugin absent)
  sessions: [],
};
let lastMenuKey = '';
const usageCache = new Map();

// Re-entrancy guard: the 10s timer and manual refreshes share one in-flight
// request; callers get the same promise instead of stacking fetches.
let balancePromise = null;
function refreshBalance() {
  if (balancePromise) return balancePromise;
  balancePromise = doRefresh().finally(() => { balancePromise = null; });
  return balancePromise;
}

let lastNotifiedTurnEndSeq = 0; // 0 = not yet initialized (first scan is the baseline)

// Conversation-aware estimate state (see doRefresh): while a conversation is
// in progress the estimated balance is (official at conversation start − turn
// cost); once it finishes the estimate freezes until the official balance has
// been stable for 60s (billing settled), then the official value is adopted.
let convBase = null;          // official balance when the active conversation started
let convPrevTurnCost = 0;     // last seen turnCost (growth detection)
let convOfficialStableAt = 0; // timestamp of the last official balance change
let convLastOfficial = null;  // last official balance value seen
let convDone = false;         // conversation finished — estimate frozen
let convFrozenEst = null;     // frozen estimate while waiting for official to settle

function checkTurnEnd(turnInfo) {
  // Conversation-finished notification: a new turn/end event means the last
  // turn completed. Only notify when the app is not focused; clicking the
  // notification brings the window back to the foreground.
  const seq = turnInfo && turnInfo.lastTurnEndSeq ? turnInfo.lastTurnEndSeq : 0;
  if (seq <= lastNotifiedTurnEndSeq) return;
  if (lastNotifiedTurnEndSeq === 0) {
    lastNotifiedTurnEndSeq = seq; // baseline on first scan — no notification
    return;
  }
  lastNotifiedTurnEndSeq = seq;
  // A real turn/end event means the conversation finished: freeze the
  // estimate here — doRefresh adopts the official balance once it has been
  // stable for 60s. (A subagent thinking shows as a quiet turn but no end
  // event, so the running estimate stays untouched.)
  convDone = true;
  convFrozenEst = convBase != null ? convBase - balanceState.turnCost : balanceState.official;
  if (config.notifyOnTurnEnd !== false && (!win || !win.isFocused())) {
    const body = turnInfo.lastSummary ? turnInfo.lastSummary.slice(0, 80) : t('turnDoneBody');
    const n = new Notification({ title: t('turnDoneTitle'), body });
    n.on('click', () => { if (win) { win.show(); win.focus(); } });
    n.show();
  }
}

async function doRefresh() {
  const t0 = Date.now();
  const pricing = config.pricing || {};
  // Kick off the three independent data sources in parallel so a slow one
  // does not serialize the refresh. The official balance resolves first
  // (~5s cap) and is shown immediately; the local usage scan (worker thread,
  // can take 10s+ on large session files) lands afterwards — the window is
  // never left blank while the scan runs.
  const serverP = balanceApi.fetchSessions(config.port).catch(() => null);
  const usageP = balanceApi.computeUsage(usageCache);
  // Companion plugin (when installed): current-session state + realtime
  // per-model usage. Probed lazily; on any failure we mark it absent for the
  // session and the legacy paths below stay authoritative.
  const pluginP = (async () => {
    if (pluginAvailable === false) return null;
    try {
      const [state, usage] = await Promise.all([
        balanceApi.fetchPluginState(config.port),
        balanceApi.fetchPluginUsage(config.port),
      ]);
      pluginAvailable = true;
      return { state, usage };
    } catch {
      pluginAvailable = false;
      return null;
    }
  })();
  const officialP = (async () => {
    const key = balanceApi.getApiKey();
    if (!key) return { error: t('balNoKey') };
    try {
      const bal = await balanceApi.fetchOfficialBalance(key);
      return { bal };
    } catch (e) { return { error: e.message }; }
  })();
  // Official balance first — show it as soon as it resolves.
  const officialRes = await officialP;
  if (officialRes.error) {
    balanceState.official = null;
    balanceState.error = officialRes.error;
  } else {
    balanceState.official = officialRes.bal.total;
    balanceState.currency = officialRes.bal.currency;
    balanceState.error = null;
  }
  const earlyKey = JSON.stringify([balanceState.official, balanceState.estimated, balanceState.calibrated, balanceState.sessionCost.toFixed(4), balanceState.turnCost.toFixed(4)]);
  if (earlyKey !== lastMenuKey) {
    lastMenuKey = earlyKey;
    applyMenus();
  }
  // Server session list (2.5s cap).
  const serverRaw = await serverP;
  // Key-consistency guard: the dsh web instance must belong to the same
  // DSH_HOME as our local scan (the local DSH_HOME key). If the server reports
  // sessions that do not exist locally, it is another instance (e.g. the
  // ~/.dsh-cc home with a different API key) — fall back to the local scan
  // so we never mix another key's consumption into this key's balance.
  let server = serverRaw && serverRaw.length ? serverRaw : null;
  if (server && server.length) {
    const allLocal = server.every((s) => balanceApi.findSessionFile(s.id));
    if (!allLocal) server = null;
  }
  // Cost numbers always come from the local scan (the usage-event口径 the
  // user validated); the server is used only to pick the ACTIVE session
  // (follows what the user is working on / switched to in the web UI).
  const plugin = await pluginP;
  const usage = await usageP;
  balanceState.consumed = balanceApi.costOfByModel(usage.byModel, pricing);
  balanceState.turnCost = balanceApi.costOfByModel(usage.userMsgByModel, pricing);
  const titleById = new Map((server || []).filter((s) => s.title).map((s) => [s.id, s.title]));
  const cwdById = new Map((server || []).filter((s) => s.cwd).map((s) => [s.id, s.cwd]));
  balanceState.sessions = usage.sessions.map((s) => ({
    id: s.id,
    title: titleById.get(s.id) || null,
    mtimeMs: s.mtimeMs,
    cost: balanceApi.costOfByModel(s.byModel, pricing),
    cwd: cwdById.get(s.id) || null,
  }));
  let activeId = null;
  if (config.balanceSessionIdManual && config.balanceSessionId && (!server || server.some((s) => s.id === config.balanceSessionId))) {
    // Manual override (balance page / deep link): the user explicitly picked
    // this session. Sniffed ids set balanceSessionId WITHOUT the manual flag,
    // so they never outrank the companion plugin below.
    activeId = config.balanceSessionId;
  } else if (plugin && plugin.state.currentSessionId) {
    // Companion plugin: authoritative "user is working here right now".
    activeId = plugin.state.currentSessionId;
  } else if (server && server.length) {
    const cur = server.find((s) => s.running && !s.blank)
      || server.filter((s) => !s.blank).sort((a, b) => b.updatedAt - a.updatedAt)[0]
      || null;
    activeId = cur ? cur.id : null;
  }
  if (!activeId) activeId = (usage.sessions[0] || {}).id || null; // local fallback (newest)
  balanceState.currentId = activeId;
  // Main-side workspace fallback: when the page bridge has not reported a
  // workspace snapshot, still give the files panel the active session's cwd.
  const activeCwd = cwdById.get(activeId);
  if (activeCwd) {
    workspaceState.currentPath = activeCwd;
    workspaceState.currentSessionId = activeId;
    if (!workspaceState.list.some((w) => w.path === activeCwd)) {
      workspaceState.list.push({ id: activeCwd, title: path.basename(activeCwd) || activeCwd, path: activeCwd });
    }
  }
  // Official per-session token usage (session.list RPC) for the ACTIVE
  // session — surfaced in the files-panel stats strip.
  const serverItem = server ? server.find((s) => s.id === activeId) : null;
  if (serverItem) balanceState.currentTokens = serverItem.tokens;
  let sess = usage.sessions.find((s) => s.id === activeId);
  // The plugin's turn-completion signals (seq/summary) are in-memory and
  // fresher than the file scan; its token counters, however, only cover
  // events since the dsh process started and OVERLAP the file scan (same
  // events, different vantage point) — replacing would under- or double-
  // count. So: only the completion signals come from the plugin; all token
  // accounting stays on the local scan (complete history, ≤1 refresh stale).
  if (sess && plugin) {
    const ps = plugin.usage.sessions.find((s) => s.id === activeId);
    if (ps && (ps.lastTurnEndSeq || ps.lastSummary)) {
      sess = { ...sess, lastTurnEndSeq: ps.lastTurnEndSeq || sess.lastTurnEndSeq, lastSummary: ps.lastSummary || sess.lastSummary };
    }
  }
  balanceState.sessionCost = sess ? balanceApi.costOfByModel(sess.byModel, pricing) : 0;
  // "Last turn" follows the CURRENT session (not the newest file): usage since
  // its last user/message — taken from the worker's cached parse, so no
  // synchronous zstd/parse ever runs on the main process.
  balanceState.turnCost = sess ? balanceApi.costOfByModel(sess.userMsgByModel, pricing) : 0;
  checkTurnEnd(sess);
  balanceState.hitRate = 0; // server path has no per-session hit rate; kept for compatibility
  if (plugin) balanceState.dshTurn = plugin.state.turn; // 'working' | 'idle' (plugin only)
  // Approval watch: surface new pending approvals, dismiss the popup when
  // the user answered in the web UI (plugin clears it on the next event).
  const ap = plugin ? plugin.state.pendingApproval : null;
  if (ap && ap.id !== lastApprovalId) {
    lastApprovalId = ap.id;
    showApproval(ap);
  } else if (!ap && lastApprovalId) {
    lastApprovalId = null;
    hideApproval();
  }
  // Unread activity: a session finished a turn while NOT being viewed.
  for (const s of usage.sessions) {
    const prev = prevTurnSeq.get(s.id);
    if (prev != null && s.lastTurnEndSeq > prev && s.id !== activeId) unreadSessions.add(s.id);
    prevTurnSeq.set(s.id, s.lastTurnEndSeq);
  }
  markSessionRead(activeId);
  // ---- Conversation-aware estimated balance ----
  const now = Date.now();
  const official = balanceState.official;
  const turn = balanceState.turnCost;
  const turnGrew = turn > convPrevTurnCost + 1e-9;
  convPrevTurnCost = turn;
  if (official == null) {
    balanceState.estimated = null;
  } else {
    if (official !== convLastOfficial) { convLastOfficial = official; convOfficialStableAt = now; }
    if (turnGrew) {
      // Conversation in progress: estimate = official at its start − turn cost.
      if (convDone && convFrozenEst != null) {
        // Back-to-back turns: the previous turn's billing usually has NOT
        // settled yet (~3 min lag), so `official` is still the pre-turn
        // value. Re-base on the frozen post-turn estimate instead of letting
        // the stale official carry the previous turn's cost forever; take
        // the min so a settled (lower) official or third-party spend wins.
        convBase = Math.min(convFrozenEst, official);
      } else if (convBase == null) {
        convBase = official;
      }
      convDone = false;
      balanceState.estimated = convBase - turn;
    } else if (convDone) {
      // A real turn/end event was seen (conversation finished): keep the
      // frozen estimate until the official balance settles (60s without a
      // change), then adopt it as the new base.
      balanceState.estimated = convFrozenEst;
      if (now - convOfficialStableAt >= 60_000) {
        convBase = official;
        convDone = false;
        balanceState.estimated = official;
      }
    } else if (convBase != null) {
      // Conversation still in progress, no new tokens this tick (e.g. a
      // subagent working silently): keep the running estimate.
      balanceState.estimated = convBase - turn;
    } else {
      // Idle: follow the official balance.
      convBase = official;
      balanceState.estimated = official;
    }
  }
  balanceState.calibrated = convBase != null;
  // Rebuild menus only when the displayed numbers actually change; the 10s
  // refresh then costs nothing when nothing moved (cached usage scan).
  const menuKey = JSON.stringify([balanceState.official, balanceState.estimated, balanceState.calibrated, balanceState.sessionCost.toFixed(4), balanceState.turnCost.toFixed(4)]);
  if (menuKey !== lastMenuKey) {
    lastMenuKey = menuKey;
    applyMenus();
  }
  if (Date.now() - t0 > 500) console.log(`[balance] slow refresh: ${Date.now() - t0}ms`);
  return balanceState;
}

async function calibrateBalance() {
  let balance = balanceState.official;
  if (balance == null) {
    const key = balanceApi.getApiKey();
    if (key) {
      try { balance = (await balanceApi.fetchOfficialBalance(key)).total; } catch { /* keep null */ }
    }
  }
  if (balance != null) {
    // Manual calibration: adopt the current official balance as the base for
    // the in-progress conversation's estimate.
    convBase = balance;
    convDone = false;
    convPrevTurnCost = -1; // force "turn grew" on next refresh so the estimate recomputes
    balanceState.calibrated = true;
  }
  return refreshBalance();
}

function balanceMenuItems() {
  const fmt = (v) => (v == null ? '—' : `¥${Number(v).toFixed(2)}`);
  const sessionsSub = (balanceState.sessions || []).slice(0, 10).map((s) => {
    const isCur = s.id === balanceState.currentId;
    const title = s.title ? s.title.slice(0, 24) : (s.id || '').slice(0, 8);
    return {
      label: `${isCur ? '✓ ' : ''}${title} — ${fmt(s.cost)}`,
      type: 'checkbox',
      checked: isCur,
      click: () => {
        config.balanceSessionId = s.id;
        config.balanceSessionIdManual = true;
        saveConfig();
        refreshBalance();
      },
    };
  });
  return [
    { label: `${t('balOfficial')}: ${fmt(balanceState.official)}`, enabled: false },
    { label: `${t('balEstimate')}: ${fmt(balanceState.estimated)}${balanceState.calibrated ? '' : ` ${t('balUncalibrated')}`}`, enabled: false },
    { label: `${t('balSession')}: ${fmt(balanceState.sessionCost)} | ${t('balTurn')}: ${fmt(balanceState.turnCost)}`, enabled: false },
    { type: 'separator' },
    { label: t('balSessionsTitle'), submenu: sessionsSub.length ? sessionsSub : [{ label: t('balNoSessions'), enabled: false }] },
    { label: t('balDetail'), click: () => openBalance() },
    { label: t('balRefresh'), click: () => refreshBalance() },
    { label: t('balCalibrate'), click: () => calibrateBalance() },
  ];
}

// Tray variant: the tray shows only the official balance (the full balance
// menu lives in the application menubar).
function trayBalanceItems() {
  const fmt = (v) => (v == null ? '—' : `¥${Number(v).toFixed(2)}`);
  return [
    { label: `${t('balOfficial')}: ${fmt(balanceState.official)}`, enabled: false },
  ];
}

function trayMenuTemplate() {
  return [
    ...trayBalanceItems(),
    { type: 'separator' },
    { label: t('trayShow'), click: () => toggleWindow() },
    { label: t('trayBrowser'), click: () => shell.openExternal(appUrl()) },
    { label: t('trayRestart'), click: () => restartDsh() },
    { label: t('filesPanel'), click: () => toggleFilesPanel() },
    { label: t('settings'), click: () => openSettings() },
    {
      label: t('trayPins'),
      submenu: (config.pinnedSessions || []).length
        ? (config.pinnedSessions || []).map((p) => ({
          label: (p.title || p.id).slice(0, 28),
          click: () => jumpToSession(p.id),
        }))
        : [{ label: t('noPins'), enabled: false }],
    },
    { label: t('profilesMenu'), submenu: (config.profiles || []).map((p) => ({
      label: p.name,
      type: 'checkbox',
      checked: p.name === config.activeProfile,
      click: () => switchProfile(p.name),
    })) },
    ...(pluginAvailable !== true
      ? [{ label: t('pluginInstall'), click: () => installPluginAndRestart() }]
      : []),
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
    { label: t('balMenu'), submenu: balanceMenuItems() }, // rightmost position
  ];
}

// Rebuild application menu and tray after a language switch / balance change.
function applyMenus() {
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate()));
  if (process.platform === 'linux' && process.env.WAYLAND_DISPLAY) {
    if (sniTray && sniTray.setMenu) {
      // Hot-update the SNI menu in place — re-creating the service on every
      // balance refresh made GNOME stack a new tray icon each time.
      try {
        sniTray.setMenu(trayMenuItems());
        return;
      } catch {
        // Hot-update failed — tear the old service down before recreating.
        try { if (sniTray && sniTray.destroy) sniTray.destroy(); } catch { /* ignore */ }
        sniTray = null;
      }
    }
    createTray();
  } else if (tray) {
    tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate()));
  }
}

// Convert Electron-style template items to the SNI dbusmenu shape.
function sniMenuItems(items) {
  return items.map((it) => {
    if (it.type === 'separator') return { separator: true };
    return {
      label: it.label,
      action: it.click || (() => {}),
      enabled: it.enabled !== false,
      ...(it.submenu ? { children: sniMenuItems(it.submenu) } : {}),
    };
  });
}

// Shared tray menu (SNI and Electron-Tray fallback).
function trayMenuItems() {
  return [
    ...sniMenuItems(trayBalanceItems()),
    { separator: true },
    { label: t('trayShow'), action: () => toggleWindow() },
    { label: t('trayBrowser'), action: () => shell.openExternal(appUrl()) },
    { label: t('trayRestart'), action: () => restartDsh() },
    { label: t('filesPanel'), action: () => toggleFilesPanel() },
    { label: t('settings'), action: () => openSettings() },
    {
      label: t('trayPins'),
      children: (config.pinnedSessions || []).length
        ? (config.pinnedSessions || []).map((p) => ({
          label: (p.title || p.id).slice(0, 28),
          action: () => jumpToSession(p.id),
        }))
        : [{ label: t('noPins') }],
    },
    { label: t('profilesMenu'), children: (config.profiles || []).map((p) => ({
      label: (p.name === config.activeProfile ? '✓ ' : '') + p.name,
      action: () => switchProfile(p.name),
    })) },
    ...(pluginAvailable !== true
      ? [{ label: t('pluginInstall'), action: () => installPluginAndRestart() }]
      : []),
    ...(config.sourceDir
      ? [{ label: t('buildInstall'), action: () => buildAndInstall() }]
      : []),
    { separator: true },
    { label: t('exit'), action: () => { quitting = true; app.quit(); } },
  ];
}

function createTray() {
  if (process.platform === 'linux' && process.env.WAYLAND_DISPLAY) {
    // Wayland: Electron's Tray SNI is broken (fake IconName, unreadable
    // IconPixmap) — use our own StatusNotifierItem instead.
    // createSniTray registers asynchronously (a few seconds of watcher
    // probing); guard against duplicate registration when applyMenus runs
    // before the first creation settles.
    if (sniCreating) return;
    sniCreating = true;
    createSniTray({
      iconPath: TRAY_ICON_PATH,
      title: 'DeepSeek Harness',
      menuItems: trayMenuItems(),
      onActivate: () => toggleWindow(),
    }).then((handle) => {
      sniTray = handle;
      // Drop any native Tray left over from an earlier SNI failure so the
      // system tray never shows two icons/menus.
      if (tray) { try { tray.destroy(); } catch { /* ignore */ } tray = null; }
    }).catch((err) => {
      console.error('[tray] SNI failed, falling back to Electron Tray:', err.message);
      if (tray) { try { tray.destroy(); } catch { /* ignore */ } tray = null; }
      tray = new Tray(nativeImage.createFromPath(TRAY_ICON_PATH));
      tray.setToolTip('DeepSeek Harness');
      tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate()));
      tray.on('click', toggleWindow);
    }).finally(() => {
      sniCreating = false;
    });
    return;
  }
  if (tray) { try { tray.destroy(); } catch { /* ignore */ } tray = null; }
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

// ---------- in-window overlays (settings / balance) ----------

let overlayView = null;
let overlayPage = '';
let maskCssKey = null;

// Dim + desaturate the main page and block its clicks while an overlay is
// open, so the modal layering is obvious.
const OVERLAY_MASK_CSS = `
  #dsh-overlay-mask {
    position: fixed; inset: 0; z-index: 2147483647;
    background: rgba(0, 0, 0, 0.45);
  }
  html { filter: grayscale(0.7) brightness(0.65) !important; }
`;

function applyOverlayMask() {
  if (maskCssKey || !win || win.isDestroyed()) return;
  mainView.webContents.insertCSS(OVERLAY_MASK_CSS).then((key) => { maskCssKey = key; }).catch(() => {});
}

function removeOverlayMask() {
  if (!maskCssKey || !win || win.isDestroyed()) return;
  const key = maskCssKey;
  maskCssKey = null;
  mainView.webContents.removeInsertedCSS(key).catch(() => {});
}

function centeredOverlayBounds() {
  const size = { width: 460, height: 400 };
  const cb = win ? win.getContentBounds() : { width: 1280, height: 820 };
  return {
    x: Math.round((cb.width - size.width) / 2),
    y: Math.round((cb.height - size.height) / 2),
    width: size.width,
    height: size.height,
  };
}

function openOverlay(page) {
  if (!win) { boot(); return; }
  if (overlayView) {
    if (overlayPage === page) {
      overlayView.setBounds(centeredOverlayBounds());
      overlayView.webContents.focus();
      return;
    }
    closeOverlay();
  }
  // In-window overlay: Wayland forbids positioning standalone windows (the
  // compositor parks them at screen edges), so we embed the page as a child
  // view with bounds relative to the main window — always centered.
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  overlayView = view;
  overlayPage = page;
  win.contentView.addChildView(view);
  view.setBounds(centeredOverlayBounds());
  view.webContents.loadFile(path.join(__dirname, page));
  view.webContents.on('destroyed', () => {
    if (overlayView === view) { overlayView = null; overlayPage = ''; }
  });
  applyOverlayMask();
}

function closeOverlay() {
  removeOverlayMask();
  if (!overlayView || !win || win.isDestroyed()) return;
  const view = overlayView;
  overlayView = null;
  overlayPage = '';
  win.contentView.removeChildView(view);
  view.webContents.close();
}

function openSettings() { openOverlay('settings.html'); }
function openBalance() { openOverlay('balance.html'); }

// ---------- global quick input ----------

// Mini composer on a system-wide hotkey (default Ctrl+Shift+D): type a prompt
// anywhere, Enter sends it to the current dsh session via the companion
// plugin. A separate always-on-top window (not an overlay) so it works while
// the main window is hidden.

let quickWin = null;
let quickPendingPrefill = null;

function quickSessionLabel() {
  const id = balanceState.currentId;
  if (!id) return t('quickNoSession');
  const turn = pluginAvailable ? (balanceState.dshTurn === 'working' ? ' · working' : '') : '';
  return `${id.slice(0, 16)}…${turn}`;
}

function createQuickInput() {
  const quick = new BrowserWindow({
    width: 560,
    height: 200,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // no activate: don't steal focus from the current app when spawned for prefill
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  quick.loadFile(path.join(__dirname, 'quickinput.html'));
  quick.on('blur', () => { if (quick.isVisible()) quick.hide(); });
  quick.webContents.on('did-finish-load', () => {
    quick.webContents.send('quick:state', quickSessionLabel());
    if (quickPendingPrefill) {
      quick.webContents.send('quick:prefill', quickPendingPrefill);
      quickPendingPrefill = null;
    }
  });
  return quick;
}

function toggleQuickInput() {
  if (!quickWin || quickWin.isDestroyed()) quickWin = createQuickInput();
  const quick = quickWin;
  if (quick.isVisible()) { quick.hide(); return; }
  // top-center of the display the main window (or cursor) is on
  const display = win && !win.isDestroyed()
    ? screen.getDisplayMatching(win.getBounds())
    : screen.getCursorScreenMonitor();
  const wa = display.workArea;
  quick.setPosition(Math.round(wa.x + (wa.width - 560) / 2), Math.round(wa.y + Math.max(12, wa.height * 0.18)));
  quick.show();
  quick.focus();
  quick.webContents.send('quick:state', quickSessionLabel());
}

// File drops land here (via the will-navigate file: interception).
function prefillQuickInput(paths) {
  if (!Array.isArray(paths) || !paths.length) return;
  if (!quickWin || quickWin.isDestroyed()) quickWin = createQuickInput();
  const quick = quickWin;
  const showQuietly = () => {
    // showInactive: visible for the user but keeps keyboard focus where it
    // was (they are mid-drag, not mid-typing).
    if (!quick.isVisible()) {
      const wa = screen.getCursorScreenMonitor().workArea;
      quick.setPosition(Math.round(wa.x + (wa.width - 560) / 2), Math.round(wa.y + Math.max(12, wa.height * 0.18)));
      quick.showInactive();
    }
  };
  if (quick.webContents.isLoading()) {
    quickPendingPrefill = paths;
    showQuietly();
  } else {
    showQuietly();
    quick.webContents.send('quick:prefill', paths);
  }
}

async function quickSend(text) {
  await probePlugin();
  if (pluginAvailable !== true) return { ok: false, error: t('pluginStatusOff') };
  // The plugin's live currentSessionId wins (sub-second); balanceState is the
  // 10s-refresh fallback.
  let sid = null;
  try { sid = (await balanceApi.fetchPluginState(config.port)).currentSessionId; } catch { /* plugin just went away */ }
  if (!sid) sid = balanceState.currentId;
  if (!sid) return { ok: false, error: t('quickNoSession') };
  try {
    const r = await balanceApi.sendPluginPrompt(config.port, sid, text);
    if (r.ok) {
      config.quickInputHistory = [text.trim(), ...(config.quickInputHistory || []).filter((x) => x !== text.trim())].slice(0, 50);
      saveConfig();
      return { ok: true };
    }
    if (r.status === 501) {
      // No send RPC in this dsh build — surface the main window instead.
      if (win && !win.isDestroyed()) { win.show(); win.focus(); }
      return { ok: false, error: t('quickRpcUnavailable') };
    }
    return { ok: false, error: r.status === 409 ? t('quickNoSession') : `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, error: t('quickSendFail', { err: e.message }) };
  }
}

function registerQuickInputShortcut() {
  globalShortcut.unregisterAll();
  if (config.quickInputEnabled !== false) {
    try {
      globalShortcut.register(config.quickInputShortcut || 'Control+Shift+D', toggleQuickInput);
    } catch (e) {
      console.error('[quick-input] shortcut registration failed:', e.message);
    }
  }
  try {
    globalShortcut.register('Control+Shift+E', () => toggleFilesPanel());
  } catch (e) {
    console.error('[files-panel] shortcut registration failed:', e.message);
  }
  try {
    globalShortcut.register('Control+Shift+P', () => openPalette('sessions'));
    globalShortcut.register('Control+Shift+F', () => openPalette('search'));
  } catch (e) {
    console.error('[palette] shortcut registration failed:', e.message);
  }
}

// ---------- multi-profile ----------

function resolveDshHome(dshHome) {
  if (dshHome) return dshHome;
  // Same default as startup: portable keeps data next to the app.
  if (config.dshCommand === 'bundled' && app.isPackaged) {
    return path.join(path.dirname(process.execPath), 'data');
  }
  return path.join(os.homedir(), '.dsh');
}

function switchProfile(name) {
  const p = (config.profiles || []).find((x) => x.name === name);
  if (!p || p.name === config.activeProfile) return false;
  applyProfile(config, p);
  saveConfig();
  balanceApi.setDshHome(resolveDshHome(p.dshHome));
  // Reset all conversation/usage state — different home, different history.
  usageCache.clear();
  lastNotifiedTurnEndSeq = 0;
  convBase = null; convPrevTurnCost = 0; convDone = false; convFrozenEst = null; convLastOfficial = null;
  pluginAvailable = null;
  config.pinnedSessions = []; // pins reference the other home's sessions
  config.quickInputHistory = []; // history is per profile
  unreadSessions.clear();
  prevTurnSeq.clear();
  hideApproval();
  saveConfig();
  sendPinsToPage();
  notify('DeepSeek Harness', t('profileSwitched', { name: p.name }));
  restartDsh();
  applyMenus();
  return true;
}

function registerSettingsIpc() {
  ipcMain.handle('settings:get-state', () => {
    // In bundled (portable) mode the meaningful dsh version is the bundled one.
    let installed = lastChecked.installed;
    if (config.dshCommand === 'bundled') {
      try {
        const p = require(path.join(bundledPaths().base, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
        installed = p.version;
      } catch { /* bundled runtime missing */ }
    }
    return {
    appVersion: app.getVersion(),
    language: config.language,
    port: config.port,
    sourceDir: config.sourceDir,
    closeBehavior: config.closeBehavior || '',
    notifyOnTurnEnd: config.notifyOnTurnEnd !== false,
    checkedAt: lastChecked.checkedAt,
    installed,
    latest: lastChecked.latest,

    update: lastChecked.update,
    balance: balanceState,
    pluginAvailable: pluginAvailable === true,
    quickInputEnabled: config.quickInputEnabled !== false,
    quickInputShortcut: config.quickInputShortcut || 'Control+Shift+D',
    profiles: config.profiles || [],
    activeProfile: config.activeProfile || '',
  };
  });
  ipcMain.handle('settings:check-update', () => checkDshUpdate(true));
  ipcMain.handle('settings:update-dsh', () => updateDsh());
  ipcMain.handle('settings:close', () => closeOverlay());
  ipcMain.handle('settings:set-close-behavior', (_e, behavior) => {
    if (!['tray', 'quit', 'ask', ''].includes(behavior)) return;
    config.closeBehavior = behavior;
    saveConfig();
  });
  ipcMain.handle('settings:set-notify', (_e, on) => {
    config.notifyOnTurnEnd = !!on;
    saveConfig();
  });
  ipcMain.handle('settings:set-current-session', (_e, id) => {
    config.balanceSessionId = typeof id === 'string' ? id : '';
    config.balanceSessionIdManual = !!config.balanceSessionId;
    saveConfig();
    refreshBalance();
  });
  ipcMain.handle('settings:set-language', (_e, lang) => {
    if (lang !== 'zh' && lang !== 'en') return;
    config.language = lang;
    saveConfig();
    applyMenus();
    if (overlayView && !overlayView.webContents.isDestroyed()) {
      overlayView.webContents.send('language-changed', lang);
    }
  });
  ipcMain.handle('settings:get-balance', () => balanceState);
  ipcMain.handle('settings:refresh-balance', () => refreshBalance());
  ipcMain.handle('settings:calibrate-balance', () => calibrateBalance());

  // quick input
  ipcMain.handle('quick:send', (_e, text) => (typeof text === 'string' ? quickSend(text) : { ok: false, error: 'no text' }));
  ipcMain.handle('quick:hide', () => { if (quickWin && !quickWin.isDestroyed() && quickWin.isVisible()) quickWin.hide(); });

  // companion plugin
  ipcMain.handle('plugin:status', () => pluginAvailable);
  ipcMain.handle('plugin:install', () => { installPluginAndRestart(); return true; });

  // multi-profile
  ipcMain.handle('profiles:list', () => ({ profiles: config.profiles || [], active: config.activeProfile }));
  ipcMain.handle('profiles:add', (_e, p) => {
    const name = p && typeof p.name === 'string' ? p.name.trim() : '';
    if (!name) return { ok: false, error: 'name required' };
    if ((config.profiles || []).some((x) => x.name === name)) return { ok: false, error: 'name exists' };
    const port = Number.isInteger(p.port) && p.port > 0 && p.port < 65536 ? p.port : null;
    config.profiles = [...(config.profiles || []), { name, dshHome: typeof p.dshHome === 'string' ? p.dshHome.trim() : '', port }];
    saveConfig();
    applyMenus();
    return { ok: true };
  });
  ipcMain.handle('profiles:switch', (_e, name) => ({ ok: switchProfile(name) }));
  ipcMain.handle('profiles:remove', (_e, name) => {
    const list = config.profiles || [];
    if (list.length <= 1) return { ok: false, error: 'cannot remove the last profile' };
    if (name === config.activeProfile) return { ok: false, error: 'switch away first' };
    config.profiles = list.filter((p) => p.name !== name);
    saveConfig();
    applyMenus();
    return { ok: true };
  });

  // quick input toggle (shortcut itself is edited via config.json for now)
  ipcMain.handle('settings:set-quick-input', (_e, on) => {
    config.quickInputEnabled = !!on;
    saveConfig();
    registerQuickInputShortcut();
  });
}

// ---------- app lifecycle ----------

// Isolate portable userData before the single-instance lock is taken (the
// lock lives in userData — two portable copies must not collide on it).
isolatePortableUserData();

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    // dsh:// deep link launch (Linux/Windows pass the URL in argv; macOS uses
    // the open-url event below).
    const link = deepLinkFromArgv(argv);
    if (link && link.action === 'session') {
      config.balanceSessionId = link.id;
      config.balanceSessionIdManual = true;
      saveConfig();
      refreshBalance().catch(() => {});
    }
    if (win) { win.show(); win.focus(); }
  });

  // macOS deep links arrive here.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    const link = deepLinkFromArgv([url]);
    if (link && link.action === 'session') {
      config.balanceSessionId = link.id;
      config.balanceSessionIdManual = true;
      saveConfig();
      refreshBalance().catch(() => {});
    }
    if (win) { win.show(); win.focus(); }
    else if (app.isReady()) boot();
  });

  app.whenReady().then(() => {
    console.log('[userData]', app.getPath('userData'));
    config = loadConfig();
    // Portable build ships bundled/: default to bundled mode so it works out
    // of the box (own runtime + own data directory, never the host's ~/.dsh
    // sessions). This overrides a leftover explicit "npx" from a normal
    // install's config; other explicit choices (global / custom path) stay.
    const hasBundled = bundledRuntimePresent();
    if (!config.dshCommand || (config.dshCommand === 'npx' && hasBundled)) {
      config.dshCommand = hasBundled ? 'bundled' : 'npx';
    } else if (config.dshCommand === 'bundled' && !hasBundled) {
      // Explicit "bundled" but this build has no portable runtime (e.g. a
      // normal deb install with a config left over from testing the portable
      // zip). Fall back to npx so the app keeps working.
      config.dshCommand = 'npx';
      setTimeout(() => notify(t('bundledMissingTitle'), t('bundledMissingBody')), 4000);
    }
    if (config.dshHome) {
      balanceApi.setDshHome(config.dshHome);
    } else if (config.dshCommand === 'bundled' && app.isPackaged) {
      // Portable mode: keep all dsh data next to the app by default
      // (DeepSeek-Harness-x64/data/) so ~/.dsh is never touched.
      balanceApi.setDshHome(path.join(path.dirname(process.execPath), 'data'));
    }
    registerSettingsIpc();
    registerPinIpc();
    registerFilesIpc();
    registerExtrasIpc();
    Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate()));
    createTray();
    setupAutoUpdater();
    boot();
    // dsh:// deep links (deb/AppImage desktop entries declare the scheme;
    // dev runs register best-effort with the desktop environment).
    try { app.setAsDefaultProtocolClient('dsh'); } catch { /* best-effort */ }
    // Global quick input hotkey.
    registerQuickInputShortcut();
    // Startup auto-check for a newer dsh on npm (non-intrusive notification).
    setTimeout(() => checkDshUpdate(false), 4000);
    // Balance & usage summary (official balance + local token estimate).
    setTimeout(() => refreshBalance().catch((e) => console.error('[balance] init failed:', e.message)), 8000);
    // Probe the companion plugin once the server is likely up; the tray menu
    // shows "install" only when it is really absent.
    setTimeout(() => probePlugin().then(() => applyMenus()).catch(() => {}), 6000);
    // Periodic refresh: session files grow while chatting; the estimate rolls
    // forward and settles once the official billing confirms (~3 min).
    // Menus are only rebuilt when displayed values change (see refreshBalance).
    setInterval(() => refreshBalance().catch(() => {}), 10000);

    app.on('activate', () => {
      if (win) { win.show(); win.focus(); } else boot();
    });
  });

  app.on('before-quit', (event) => {
    if (cleaningUp) return;
    event.preventDefault();
    cleaningUp = true;
    quitting = true;
    globalShortcut.unregisterAll();
    if (win && !win.isDestroyed() && !win.isMaximized()) {
      try { config.windowState = { ...win.getBounds(), maximized: false }; saveConfig(); } catch { /* best-effort */ }
    }
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
