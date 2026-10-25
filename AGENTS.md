# 学习树

可标记进度、可引用资源的思维导图。同一套前端既是网页版（localStorage），也是 Electron 桌面版（JSON 数据文件）。

## 命令
- `npm start`：运行桌面版
- `npm test`：冒烟测试（`test/smoke.js`），结果看 `test/smoke.log`，末尾应为 `ALL PASS`（Windows 下读不到 Electron 的 stdout）。若环境中设置了 `ELECTRON_RUN_AS_NODE`，需先清除，否则 Electron 会以 Node 模式运行而报错
- `npm run dist`：打包 NSIS 安装包和便携版到 `dist/`
- 网页版：`python -m http.server 5173 --bind 127.0.0.1`

## 结构
- `desktop/main.js`：主进程（窗口、菜单、`app://tree` 协议与 CSP、数据读写与备份、打开本机文件）
- `desktop/preload.js`：通过 `window.desktop` 暴露受限接口
- `js/*.js`：前端，无框架、无构建，由 `index.html` 按顺序加载，模块挂在全局 `window.LT` 上
  - `store.js` 数据层，`render.js` 布局与绘制，`interact.js` 交互，`ops.js` 编辑操作，`panel.js` 详情面板，`io.js` 导入导出，`localfile.js` 本机文件

## 约定
- 修改树的操作一律通过 `LT.commit(fn)`，它负责记录撤销点、重建索引、保存和重绘
- 关联节点（`link` 相同）共享标题、笔记、资源和叶子状态，各存一份副本；修改这些字段要走 `LT.updateNode` / `LT.rename` / `LT.setStatus` 才会同步。进度统计中关联的叶子只计一次
- 前端用 `LT.desktop` 判断是否运行在桌面版，两种模式都要能用
- Electron 不支持 `prompt()`，需要输入时用页面内的 `<dialog>`
- 测试时设置 `LEARNING_TREE_HOME` 指向临时目录，避免改动真实数据（默认在 `文档\学习树\`）
- 新增 IPC 接口时用 `handle()` 注册，它会校验消息是否来自本应用页面
- 代码注释和界面文案用中文
