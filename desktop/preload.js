// 安全桥接：只向页面暴露少量受限接口，页面本身无法访问 Node
'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  load: () => ipcRenderer.invoke('data:load'),
  save: json => ipcRenderer.invoke('data:save', String(json)),
  // 页面关闭/刷新前同步写入，确保最后的修改不丢
  saveSync: json => ipcRenderer.sendSync('data:save-sync', String(json)),
  openPath: p => ipcRenderer.invoke('file:open', String(p)),
  revealPath: p => ipcRenderer.invoke('file:reveal', String(p)),
  pickFiles: () => ipcRenderer.invoke('file:pick'),
  info: () => ipcRenderer.invoke('app:info'),
  setTheme: mode => ipcRenderer.invoke('app:setTheme', String(mode)),
  // 拖入的文件取得本机路径
  getPathForFile: file => webUtils.getPathForFile(file),
  onMenu: cb => ipcRenderer.on('menu', (e, cmd) => cb(String(cmd))),
});
