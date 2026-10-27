// 主题：跟随系统 / 浅色 / 深色
// 网页版存在 localStorage；桌面版存在设置文件，并由主进程同步原生界面（菜单栏、窗口底色）
// 在 <head> 中加载，尽早设置 data-theme，避免先闪一下另一种颜色
window.LT = window.LT || {};
(function (LT) {
  'use strict';
  const KEY = 'learningTree.theme';
  const MODES = ['system', 'light', 'dark'];
  const NAME = { system: '跟随系统', light: '浅色', dark: '深色' };
  const ICON = { system: '◐', light: '☀', dark: '☾' };
  const desktop = window.desktop || null;
  let mode = 'system';

  function apply(m) {
    mode = MODES.includes(m) ? m : 'system';
    const root = document.documentElement;
    if (mode === 'system') delete root.dataset.theme;
    else root.dataset.theme = mode;
    const btn = document.getElementById('btnTheme');
    if (btn) {
      btn.textContent = ICON[mode] + ' ' + NAME[mode];
      btn.title = '主题：' + NAME[mode] + '（点击切换）';
    }
  }

  LT.THEME_MODES = MODES;
  LT.getTheme = () => mode;
  LT.setTheme = function (m) {
    apply(m);
    if (desktop) desktop.setTheme(mode);
    else try { localStorage.setItem(KEY, mode); } catch (e) { /* 无法保存时仅本次生效 */ }
  };
  LT.cycleTheme = () => LT.setTheme(MODES[(MODES.indexOf(mode) + 1) % MODES.length]);

  // 桌面版在窗口创建前已按设置切换原生主题，页面颜色本就正确，这里只需同步按钮
  if (desktop) desktop.info().then(i => apply(i.theme));
  else {
    let saved = null;
    try { saved = localStorage.getItem(KEY); } catch (e) { /* 忽略 */ }
    apply(saved);
  }
  document.addEventListener('DOMContentLoaded', () => apply(mode));
})(window.LT);
