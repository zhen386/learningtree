// 学习树桌面版主进程：窗口、菜单、数据文件读写与备份、打开本机文件
'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain, shell, protocol, net, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { pathToFileURL } = require('url');

const APP_ROOT = path.join(__dirname, '..');
const SCHEME = 'app';
const ORIGIN = SCHEME + '://tree';
const BACKUP_DIR_NAME = '备份';
const BACKUP_KEEP = 30;
// 不允许从资源链接直接运行的类型（可执行文件、脚本、快捷方式等）
const BLOCKED_EXT = new Set([
  '.exe', '.com', '.bat', '.cmd', '.msi', '.msp', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse',
  '.wsf', '.wsh', '.hta', '.scr', '.pif', '.cpl', '.lnk', '.url', '.reg', '.jar', '.appref-ms', '.msc',
]);
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');
const THEMES = { system: '跟随系统', light: '浅色', dark: '深色' };
// 与 css/base.css 中的 --bg 一致，避免窗口打开或缩放时闪出另一种底色
const bgColor = () => (nativeTheme.shouldUseDarkColors ? '#15171c' : '#f6f7fb');

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// ---------------- 设置 ----------------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const defaultDataFile = () => path.join(app.getPath('documents'), '学习树', 'learning-tree.json');

// 测试用：LEARNING_TREE_HOME 指定一个独立目录存放设置与数据，不影响真实数据
if (process.env.LEARNING_TREE_HOME) {
  const home = path.resolve(process.env.LEARNING_TREE_HOME);
  app.setPath('userData', path.join(home, 'userData'));
  app.setPath('documents', path.join(home, 'Documents'));
}
let settings = {};

function loadSettings() {
  try { settings = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) || {}; } catch (e) { settings = {}; }
  if (typeof settings.dataFile !== 'string' || !path.isAbsolute(settings.dataFile)) settings.dataFile = defaultDataFile();
  if (!Object.hasOwn(THEMES, settings.theme)) settings.theme = 'system';
}

// 原生主题同时决定页面的 prefers-color-scheme、菜单栏和对话框的颜色
function setTheme(mode) {
  if (!Object.hasOwn(THEMES, mode)) throw new Error('invalid theme');
  settings.theme = mode;
  nativeTheme.themeSource = mode;
  saveSettings();
  const menu = Menu.getApplicationMenu();
  const item = menu && menu.getMenuItemById('theme-' + mode);
  if (item) item.checked = true;
}
function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch (e) { /* 设置写入失败不影响使用 */ }
}

// ---------------- 数据文件 ----------------
let lastJson = null;      // 最近一次读到或写入的内容
let lastMtime = 0;        // 对应的修改时间，用于发现外部改动（如网盘同步）
const today = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD

async function readData() {
  const file = settings.dataFile;
  try {
    const json = await fsp.readFile(file, 'utf8');
    JSON.parse(json); // 校验
    lastJson = json;
    lastMtime = (await fsp.stat(file)).mtimeMs;
    return { json, path: file, existed: true };
  } catch (e) {
    if (e.code === 'ENOENT') return { json: null, path: file, existed: false };
    // 文件损坏：先挪到备份目录，避免被覆盖
    const bad = await moveToBackup(file, 'damaged');
    dialog.showErrorBox('数据文件无法读取', `${file}\n\n${e.message}\n\n原文件已移到：${bad || '（移动失败）'}\n将从空白数据开始。`);
    return { json: null, path: file, existed: false };
  }
}

async function moveToBackup(file, tag) {
  try {
    const dir = path.join(path.dirname(file), BACKUP_DIR_NAME);
    await fsp.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(dir, `${path.basename(file, '.json')}.${tag}-${stamp}.json`);
    await fsp.rename(file, dest);
    return dest;
  } catch (e) { return null; }
}

// 每天第一次覆盖前，把旧文件复制一份到备份目录，只保留最近 BACKUP_KEEP 份
async function dailyBackup(file) {
  const dir = path.join(path.dirname(file), BACKUP_DIR_NAME);
  const base = path.basename(file, '.json');
  const dest = path.join(dir, `${base}-${today()}.json`);
  try {
    await fsp.access(file);
  } catch (e) { return; }
  try {
    await fsp.access(dest);
    return; // 今天已备份
  } catch (e) { /* 继续 */ }
  await fsp.mkdir(dir, { recursive: true });
  await fsp.copyFile(file, dest);
  const re = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-\\d{4}-\\d{2}-\\d{2}\\.json$');
  const old = (await fsp.readdir(dir)).filter(f => re.test(f)).sort().reverse().slice(BACKUP_KEEP);
  await Promise.all(old.map(f => fsp.unlink(path.join(dir, f)).catch(() => {})));
}

// 原子写入：先写临时文件再替换，避免写到一半损坏
async function writeData(json, file) {
  file = file || settings.dataFile;
  JSON.parse(json);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  if (file === settings.dataFile) {
    try {
      const st = await fsp.stat(file);
      if (lastMtime && Math.abs(st.mtimeMs - lastMtime) > 1) {
        // 文件被其他程序改过（例如另一台电脑通过网盘同步），保留一份再覆盖
        const dir = path.join(path.dirname(file), BACKUP_DIR_NAME);
        await fsp.mkdir(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        await fsp.copyFile(file, path.join(dir, `${path.basename(file, '.json')}.external-${stamp}.json`));
      }
    } catch (e) { /* 文件不存在 */ }
    await dailyBackup(file);
  }
  const tmp = file + '.' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + '.tmp';
  await fsp.writeFile(tmp, json, 'utf8');
  await fsp.rename(tmp, file);
  if (file === settings.dataFile) {
    lastJson = json;
    lastMtime = (await fsp.stat(file)).mtimeMs;
  }
}

function writeDataSync(json) {
  const file = settings.dataFile;
  JSON.parse(json);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + '.tmp';
  fs.writeFileSync(tmp, json, 'utf8');
  fs.renameSync(tmp, file);
  lastJson = json;
  lastMtime = fs.statSync(file).mtimeMs;
}

// ---------------- 本机文件 ----------------
// 接受 Windows 路径或 file: 链接，返回规范化的绝对路径；不合法返回 null
function toLocalPath(input) {
  if (typeof input !== 'string') return null;
  let p = input.trim().replace(/^["']|["']$/g, '');
  if (/^file:\/\//i.test(p)) {
    try {
      const u = new URL(p);
      p = decodeURIComponent(u.pathname);
      if (u.host) p = '\\\\' + u.host + p.replace(/\//g, '\\');
      else p = p.replace(/^\/([a-zA-Z]:)/, '$1');
    } catch (e) { return null; }
  }
  p = path.normalize(p);
  return path.isAbsolute(p) ? p : null;
}

async function openLocal(input) {
  const p = toLocalPath(input);
  if (!p) return { error: 'invalid', message: '不是有效的本机路径' };
  try { await fsp.stat(p); } catch (e) { return { error: 'notfound', message: '找不到文件：' + p, path: p }; }
  if (BLOCKED_EXT.has(path.extname(p).toLowerCase())) {
    shell.showItemInFolder(p);
    return { error: 'blocked', message: '出于安全考虑不直接运行此类文件，已在资源管理器中显示：' + p, path: p };
  }
  const err = await shell.openPath(p);
  return err ? { error: 'failed', message: err, path: p } : { ok: true, path: p };
}

async function revealLocal(input) {
  const p = toLocalPath(input);
  if (!p) return { error: 'invalid', message: '不是有效的本机路径' };
  try { await fsp.stat(p); } catch (e) {
    // 文件不在了就打开它原本所在的文件夹
    const dir = path.dirname(p);
    try { await fsp.stat(dir); await shell.openPath(dir); return { ok: true, path: dir }; } catch (e2) {
      return { error: 'notfound', message: '找不到文件：' + p };
    }
  }
  shell.showItemInFolder(p);
  return { ok: true, path: p };
}

// ---------------- 窗口 ----------------
let win = null;

function createWindow() {
  const b = settings.bounds || {};
  win = new BrowserWindow({
    width: b.width || 1280, height: b.height || 820, x: b.x, y: b.y,
    minWidth: 720, minHeight: 480, show: false,
    title: '学习树', backgroundColor: bgColor(),
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false,
    },
  });
  if (settings.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());

  // 外部网页用系统浏览器打开，本机文件用系统程序打开，其余一律拒绝
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    else if (/^file:\/\//i.test(url)) openLocal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(ORIGIN + '/')) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  win.webContents.session.setPermissionRequestHandler((wc, perm, cb) => cb(perm === 'clipboard-sanitized-write'));

  win.on('close', () => {
    settings.maximized = win.isMaximized();
    if (!settings.maximized && !win.isMinimized()) settings.bounds = win.getBounds();
    saveSettings();
  });
  win.on('closed', () => { win = null; });
  win.loadURL(ORIGIN + '/index.html');
}

const send = cmd => () => win && win.webContents.send('menu', cmd);

function buildMenu() {
  const template = [
    {
      label: '文件(&F)',
      submenu: [
        { label: '新建学习树…', accelerator: 'CmdOrCtrl+N', click: send('newMap') },
        { label: '导入…', accelerator: 'CmdOrCtrl+O', click: send('import') },
        { type: 'separator' },
        { label: '导出当前树为 JSON…', click: send('exportJson') },
        { label: '导出全部（备份）…', accelerator: 'CmdOrCtrl+Shift+S', click: send('exportAll') },
        { label: '导出当前树为 Markdown…', click: send('exportMd') },
        { type: 'separator' },
        { label: '打开数据文件夹', click: () => shell.showItemInFolder(settings.dataFile) },
        { label: '更改数据文件位置…', click: changeDataLocation },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '编辑(&E)',
      submenu: [
        // 撤销/重做交给页面自己的快捷键处理（输入框内是文字撤销，导图上是结构撤销）
        { label: '撤销', accelerator: 'CmdOrCtrl+Z', registerAccelerator: false, click: send('undo') },
        { label: '重做', accelerator: 'CmdOrCtrl+Y', registerAccelerator: false, click: send('redo') },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
        { type: 'separator' },
        { label: '搜索', accelerator: 'CmdOrCtrl+F', registerAccelerator: false, click: send('find') },
      ],
    },
    {
      label: '视图(&V)',
      submenu: [
        { label: '适应窗口', accelerator: 'CmdOrCtrl+0', click: send('fit') },
        { label: '全部展开', click: send('expandAll') },
        { label: '全部折叠', click: send('collapseAll') },
        { type: 'separator' },
        {
          label: '主题',
          // 交给页面切换，页面再通过 app:setTheme 回到主进程保存，两边只有一条路径
          submenu: Object.entries(THEMES).map(([mode, label]) => ({
            id: 'theme-' + mode, label, type: 'radio', checked: settings.theme === mode, click: send('theme:' + mode),
          })),
        },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
      ],
    },
    {
      label: '帮助(&H)',
      submenu: [
        { label: '快捷键与说明', accelerator: 'F1', click: send('help') },
        {
          label: '关于学习树',
          click: () => dialog.showMessageBox(win, {
            type: 'info', title: '关于学习树',
            message: '学习树 ' + app.getVersion(),
            detail: '数据文件：' + settings.dataFile + '\n备份目录：' +
              path.join(path.dirname(settings.dataFile), BACKUP_DIR_NAME),
          }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function changeDataLocation() {
  const r = await dialog.showSaveDialog(win, {
    title: '选择数据文件位置（可放在网盘同步目录中）',
    defaultPath: settings.dataFile,
    filters: [{ name: '学习树数据', extensions: ['json'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  });
  if (r.canceled || !r.filePath) return;
  const target = path.normalize(r.filePath);
  if (target === settings.dataFile) return;

  let exists = false;
  try { await fsp.access(target); exists = true; } catch (e) { /* 新文件 */ }
  let useExisting = false;
  if (exists) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'question', title: '该位置已有数据文件',
      message: '所选位置已经存在数据文件，要怎么处理？',
      buttons: ['使用该文件中的数据', '用当前数据覆盖它', '取消'], cancelId: 2, defaultId: 0, noLink: true,
    });
    if (response === 2) return;
    useExisting = response === 0;
  }
  try {
    if (useExisting) JSON.parse(await fsp.readFile(target, 'utf8'));
    else {
      if (exists) await dailyBackup(target);
      await writeData(lastJson || '{"maps":[]}', target);
    }
  } catch (e) {
    dialog.showErrorBox('无法使用该位置', e.message);
    return;
  }
  const old = settings.dataFile;
  settings.dataFile = target;
  lastMtime = 0;
  saveSettings();
  win.webContents.reload();
  dialog.showMessageBox(win, {
    type: 'info', title: '数据文件位置已更改',
    message: '现在使用：' + target, detail: '原文件仍保留在：' + old,
  });
}

// ---------------- IPC ----------------
function trusted(e) {
  return e.senderFrame && e.senderFrame.url.startsWith(ORIGIN + '/');
}
function handle(channel, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!trusted(e)) throw new Error('untrusted sender');
    return fn(...args);
  });
}

function registerIpc() {
  handle('data:load', readData);
  handle('data:save', json => writeData(String(json)).then(() => ({ ok: true, path: settings.dataFile })));
  ipcMain.on('data:save-sync', (e, json) => {
    if (!trusted(e)) { e.returnValue = false; return; }
    try { writeDataSync(String(json)); e.returnValue = true; } catch (err) { e.returnValue = false; }
  });
  handle('file:open', openLocal);
  handle('file:reveal', revealLocal);
  handle('file:pick', async () => {
    const r = await dialog.showOpenDialog(win, { title: '选择要引用的本机文件', properties: ['openFile', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  });
  handle('app:info', () => ({ dataFile: settings.dataFile, version: app.getVersion(), theme: settings.theme }));
  handle('app:setTheme', mode => setTheme(String(mode)));
}

// ---------------- 启动 ----------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    loadSettings();
    nativeTheme.themeSource = settings.theme;
    nativeTheme.on('updated', () => { if (win) win.setBackgroundColor(bgColor()); });
    const root = path.resolve(APP_ROOT);
    protocol.handle(SCHEME, async req => {
      const { pathname } = new URL(req.url);
      const file = path.resolve(root, '.' + decodeURIComponent(pathname));
      // 只提供应用目录内的前端文件，桌面版代码与依赖不对页面开放
      const rel = path.relative(root, file);
      if (rel.startsWith('..') || path.isAbsolute(rel) || !/^(index\.html$|css[\\/]|js[\\/])/.test(rel)) {
        return new Response('Not found', { status: 404 });
      }
      const res = await net.fetch(pathToFileURL(file).toString());
      const headers = new Headers(res.headers);
      headers.set('Content-Security-Policy', CSP);
      headers.set('X-Content-Type-Options', 'nosniff');
      return new Response(res.body, { status: res.status, headers });
    });
    registerIpc();
    buildMenu();
    const first = !fs.existsSync(settings.dataFile);
    createWindow();
    if (first) {
      win.webContents.once('did-finish-load', () => {
        dialog.showMessageBox(win, {
          type: 'info', title: '欢迎使用学习树',
          message: '数据将自动保存到：\n' + settings.dataFile,
          detail: '每天自动备份一份到同目录的“备份”文件夹（保留 30 份）。\n\n' +
            '如果你在网页版中已有数据：在网页版点击“导出全部”，然后在这里使用“文件 › 导入”。\n' +
            '如需多台电脑同步，可通过“文件 › 更改数据文件位置”把数据放到网盘目录。',
        });
      });
    }
  });

  app.on('window-all-closed', () => app.quit());
}
