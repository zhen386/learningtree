// 桌面版冒烟测试：在独立目录中启动应用，检查加载、保存、备份、协议限制与本机文件接口
// 用法：npx electron test/smoke.js
'use strict';
const os = require('os'), path = require('path'), fs = require('fs');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-smoke-'));
process.env.LEARNING_TREE_HOME = home;
const { app, BrowserWindow, dialog } = require('electron');
// 尽早设置，避免 Electron 在默认的 %APPDATA%\Electron 下创建缓存
app.setPath('userData', path.join(home, 'userData'));
dialog.showMessageBox = async () => ({ response: 0 });   // 跳过欢迎对话框
require('../desktop/main.js');

// 结果写到 smoke.log（Windows 下 Electron 的 stdout 不一定能被管道读到）
const LOG = path.join(__dirname, 'smoke.log');
fs.writeFileSync(LOG, '');
const step = msg => fs.appendFileSync(LOG, msg + '\n');
const results = [];
const check = (name, ok, extra) => {
  const line = (ok ? 'PASS ' : 'FAIL ') + name + (extra && !ok ? '  ' + extra : '');
  results.push(line);
  step(line);
};
const wait = ms => new Promise(r => setTimeout(r, ms));
setTimeout(() => { step('TIMEOUT'); app.exit(2); }, 60000);
app.whenReady().then(() => step('ready'));

app.on('browser-window-created', (e, win) => {
  step('window created');
  win.webContents.on('did-fail-load', (e, code, desc, url) => step('did-fail-load ' + code + ' ' + desc + ' ' + url));
  win.webContents.on('console-message', (e) => step('console: ' + (e.message || '')));
  win.webContents.once('did-finish-load', async () => {
    step('loaded ' + win.webContents.getURL());
    const ev = js => win.webContents.executeJavaScript(js);
    try {
      await wait(800);
      check('page has desktop bridge', await ev('!!window.desktop && !!LT.desktop'));
      check('no node in page', await ev('typeof require === "undefined" && typeof process === "undefined"'));
      check('sample tree rendered', (await ev('document.querySelectorAll(".node").length')) > 10);

      const dataFile = path.join(home, 'Documents', '学习树', 'learning-tree.json');
      await ev('LT.addChild(LT.state.map.root.id, "冒烟测试节点", "left"); LT.saveNow()');
      await wait(600);
      const saved = fs.existsSync(dataFile) && fs.readFileSync(dataFile, 'utf8');
      check('data file written to Documents\学习树', !!saved && saved.includes('冒烟测试节点'));
      check('no temp files left', fs.readdirSync(path.dirname(dataFile)).every(f => !f.endsWith('.tmp')));

      await ev('LT.rename(LT.state.selectedId, "改名后"); LT.saveNow()');
      await wait(600);
      const bdir = path.join(path.dirname(dataFile), '备份');
      const backups = fs.existsSync(bdir) ? fs.readdirSync(bdir) : [];
      check('daily backup created', backups.some(f => /learning-tree-\d{4}-\d{2}-\d{2}\.json$/.test(f)), backups.join(','));

      // 重新加载后数据仍在
      win.webContents.reload();
      await new Promise(r => win.webContents.once('did-finish-load', r));
      await wait(800);
      check('data survives reload', await ev('[...LT.index.values()].some(i => i.node.title === "改名后" && i.side === "left")'));

      // 主题：页面、原生主题、菜单与设置文件同步，重新加载后保持
      const { nativeTheme, Menu } = require('electron');
      const bodyBg = () => ev('getComputedStyle(document.body).backgroundColor');
      const settingsTheme = () => JSON.parse(fs.readFileSync(path.join(home, 'userData', 'settings.json'), 'utf8')).theme;
      check('theme defaults to system', await ev('LT.getTheme()') === 'system' && nativeTheme.themeSource === 'system');
      await ev('LT.setTheme("dark"); 0');
      await wait(200);
      check('dark theme colors', await bodyBg() === 'rgb(21, 23, 28)' && await ev('document.documentElement.dataset.theme') === 'dark');
      check('theme button label', (await ev('document.getElementById("btnTheme").textContent')).includes('深色'));
      check('native theme follows', nativeTheme.themeSource === 'dark' && nativeTheme.shouldUseDarkColors);
      check('window background follows', win.getBackgroundColor().toLowerCase() === '#15171c', win.getBackgroundColor());
      check('theme menu checked', Menu.getApplicationMenu().getMenuItemById('theme-dark').checked);
      check('theme saved to settings', settingsTheme() === 'dark');
      win.webContents.reload();
      await new Promise(r => win.webContents.once('did-finish-load', r));
      await wait(500);
      check('theme survives reload', await ev('LT.getTheme()') === 'dark' && await bodyBg() === 'rgb(21, 23, 28)');
      await ev('LT.setTheme("light"); 0');
      await wait(200);
      check('light theme colors', await bodyBg() === 'rgb(246, 247, 251)' && !nativeTheme.shouldUseDarkColors &&
        win.getBackgroundColor().toLowerCase() === '#f6f7fb');
      await ev('LT.cycleTheme(); 0');
      check('cycle light -> dark', await ev('LT.getTheme()') === 'dark');
      await ev('LT.cycleTheme(); 0');
      await wait(200);
      check('cycle dark -> system', await ev('LT.getTheme()') === 'system' && settingsTheme() === 'system' &&
        await ev('!("theme" in document.documentElement.dataset)'));
      check('invalid theme rejected', await ev('desktop.setTheme("toString").then(() => false, () => true)') && settingsTheme() === 'system');

      // 新建树（Electron 不支持 prompt()，必须用页面内对话框）
      const mapsBefore = await ev('LT.state.db.maps.length');
      await ev('document.getElementById("btnNewMap").click()');
      check('new-tree dialog opens', await ev('document.getElementById("dlgNewMap").open'));
      await ev(`document.getElementById("newMapTitle").value = "冒烟新树";
        document.querySelector('#dlgNewMap button[value="ok"]').click(); 0`);
      await wait(300);
      check('new tree created', await ev(`LT.state.db.maps.length === ${mapsBefore} + 1 && LT.state.map.root.title === "冒烟新树"`));
      await ev('document.getElementById("btnNewMap").click(); document.querySelector(\'#dlgNewMap button[value="cancel"]\').click(); 0');
      await wait(200);
      check('cancel creates nothing', await ev(`LT.state.db.maps.length === ${mapsBefore} + 1`));
      // 回到原来的树继续后面的测试
      await ev('LT.switchMap(LT.state.db.maps[0].id)');

      // 节点关联：共享标题 / 状态 / 笔记 / 资源，进度统计去重
      await ev(`window._a = LT.addChild(LT.state.map.root.id, "关联A", "left");
        window._b = LT.addChild(LT.state.map.root.id, "关联B", "right");
        LT.updateNode(_b.id, x => { x.notes = "B 的笔记"; x.resources.push({ title: "B 的资源", url: "" }); }); 0`);
      const node = id => `LT.index.get(${id}.id).node`;
      const total0 = await ev('LT.index.get(LT.state.map.root.id).stats.total');
      await ev('LT.select(_a.id); LT.startLinkPick(_a.id); 0');
      check('link pick mode', await ev('document.getElementById("canvas").classList.contains("picking")'));
      await ev('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); 0');
      check('esc cancels link pick', await ev('!document.getElementById("canvas").classList.contains("picking") && !LT.state.linkFrom'));
      await ev('LT.linkNodes(_a.id, _b.id); 0');
      check('linked nodes merged', await ev(`(() => { const a = ${node('_a')}, b = ${node('_b')};
        return !!a.link && a.link === b.link && b.title === "关联A" && a.notes === "B 的笔记" && a.resources.length === 1; })()`));
      check('linked leaf counted once', await ev('LT.index.get(LT.state.map.root.id).stats.total') === total0 - 1);
      await ev('LT.setStatus(_a.id, "done"); LT.rename(_b.id, "关联节点"); LT.updateNode(_a.id, x => { x.notes = "新笔记"; }); 0');
      check('status, title, notes shared', await ev(`${node('_b')}.status === "done" && ${node('_a')}.title === "关联节点" && ${node('_b')}.notes === "新笔记"`));
      check('twin highlighted with link line', await ev(`(LT.select(_a.id),
        document.getElementById("n-" + _b.id).classList.contains("twin") && document.querySelectorAll("#edges .link-edge").length === 1)`));
      check('panel lists twin', await ev('document.querySelectorAll("#panel .link-path").length === 1'));
      check('panel has no "null" text', await ev('![...document.getElementById("panel").childNodes].some(c => c.nodeType === 3 && c.textContent.includes("null"))'));
      check('ancestor link rejected', await ev(`(() => { const c = LT.addChild(_a.id, "子"); return LT.linkNodes(_a.id, c.id) === false && !!${node('_a')}.link; })()`));
      await ev('LT.undo(); LT.undo(); LT.undo(); LT.undo(); LT.undo(); 0');
      check('undo removes link', await ev(`!${node('_a')}.link && !${node('_b')}.link`));
      await ev('LT.redo(); LT.unlinkNode(_a.id); 0');
      check('unlink clears both', await ev(`!${node('_a')}.link && !${node('_b')}.link`));

      // 协议只开放前端文件
      check('desktop code not served', await ev('fetch("app://tree/desktop/main.js").then(r => r.status)') === 404);
      check('node_modules not served', await ev('fetch("app://tree/package.json").then(r => r.status)') === 404);
      check('CSP header set', /default-src 'self'/.test(await ev('fetch("app://tree/index.html").then(r => r.headers.get("content-security-policy"))')));

      // 本机文件接口
      const doc = path.join(home, '测试 文档.txt');
      fs.writeFileSync(doc, 'hello');
      const exe = path.join(home, 'evil.bat');
      fs.writeFileSync(exe, '@echo off');
      const shell = require('electron').shell;
      const opened = [], revealed = [];
      shell.openPath = async p => { opened.push(p); return ''; };
      shell.showItemInFolder = p => revealed.push(p);
      const r1 = await ev(`desktop.openPath(${JSON.stringify(doc)})`);
      check('open local file', r1.ok && opened[0] === doc, JSON.stringify(r1));
      const r2 = await ev(`desktop.openPath(${JSON.stringify('file:///' + doc.replace(/\\/g, '/').replace(/ /g, '%20'))})`);
      check('open file: url', r2.ok && opened[1] === doc, JSON.stringify(r2));
      const r3 = await ev(`desktop.openPath(${JSON.stringify(exe)})`);
      check('executable blocked', r3.error === 'blocked' && opened.length === 2 && revealed.includes(exe));
      const r4 = await ev(`desktop.openPath(${JSON.stringify('D:\\不存在\\x.pdf')})`);
      check('missing file reported', r4.error === 'notfound');
      const r5 = await ev(`desktop.openPath("relative.txt")`);
      check('relative path rejected', r5.error === 'invalid');
      const r6 = await ev(`desktop.revealPath(${JSON.stringify(doc)})`);
      check('reveal in explorer', r6.ok && revealed.includes(doc));

      // 页面里路径资源走桌面接口
      await ev(`LT.updateNode(LT.state.selectedId, x => x.resources.push({ title: "测试文档", url: ${JSON.stringify(doc)} }))`);
      await ev('document.querySelector("#panel .res-list a").click()');
      await wait(300);
      check('panel link opens via system', opened.length === 3 && opened[2] === doc);
      check('panel has reveal button', await ev('!!document.querySelector("#panel .res-list button[title=\'在资源管理器中显示\']")'));

      // 外部链接不在应用内打开
      const extOpened = [];
      shell.openExternal = async u => { extOpened.push(u); };
      await ev('window.open("https://example.com", "_blank")');
      await wait(300);
      check('external link -> system browser', extOpened[0] === 'https://example.com/' || extOpened[0] === 'https://example.com');
      check('app still on app://', win.webContents.getURL().startsWith('app://tree/'));

      // 关闭/刷新前同步保存：修改后立刻刷新（防抖保存尚未触发），走 beforeunload 路径
      await ev('LT.rename(LT.state.selectedId, "关闭前修改"); 0');
      check('change not yet written', !fs.readFileSync(dataFile, 'utf8').includes('关闭前修改'));
      win.webContents.reload();
      await new Promise(r => win.webContents.once('did-finish-load', r));
      check('unsaved change flushed before unload', fs.readFileSync(dataFile, 'utf8').includes('关闭前修改'));
    } catch (err) {
      check('exception', false, err.stack);
    }
    step(results.every(r => r.startsWith('PASS')) ? 'ALL PASS' : 'SOME FAILED');
    app.on('quit', () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
    app.exit(results.every(r => r.startsWith('PASS')) ? 0 : 1);
  });
});
