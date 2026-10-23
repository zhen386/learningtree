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
