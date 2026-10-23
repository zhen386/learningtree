// 本机文件引用：
//   1) 粘贴的本机路径（D:\...、\\server\share\...、"带引号的路径"）自动转成 file:/// 链接，并可一键复制路径
//   2) 用“选择本机文件”选中的文件，把文件句柄存进 IndexedDB，之后点击直接打开（Chrome / Edge）
(function (LT) {
  'use strict';

  // ---- 路径 <-> file: 链接 ----
  const stripQuotes = s => s.trim().replace(/^["']|["']$/g, '').trim();
  const encodePath = p => p.split('/').map(seg => encodeURIComponent(seg).replace(/%3A/gi, ':')).join('/');

  // 本机路径转 file: 链接；不是本机路径返回 null
  LT.pathToFileUrl = function (u) {
    u = stripQuotes(u || '');
    let m;
    if ((m = u.match(/^([a-zA-Z]):[\\/](.*)$/))) {
      return 'file:///' + m[1].toUpperCase() + ':/' + encodePath(m[2].replace(/\\/g, '/'));
    }
    if ((m = u.match(/^\\\\([^\\/]+)[\\/](.+)$/))) {
      return 'file://' + m[1] + '/' + encodePath(m[2].replace(/\\/g, '/'));
    }
    return null;
  };

  const isFileUrl = u => /^file:\/\//i.test((u || '').trim());
  LT.isLocalLink = u => isFileUrl(u) || !!LT.pathToFileUrl(u);

  // file: 链接转回便于粘贴到资源管理器的 Windows 路径
  LT.fileUrlToPath = function (u) {
    u = stripQuotes(u || '');
    if (!isFileUrl(u)) return u;
    let rest = u.replace(/^file:\/\//i, '');
    let path;
    try { rest = decodeURIComponent(rest); } catch (e) { /* 保留原样 */ }
    if (/^\/[a-zA-Z]:/.test(rest)) path = rest.slice(1);           // file:///D:/x
    else if (/^[a-zA-Z]:/.test(rest)) path = rest;                  // file://D:/x
    else if (rest.startsWith('/')) return rest;                     // file:///home/x（非 Windows）
    else path = '//' + rest;                                        // file://server/share
    return path.replace(/\//g, '\\');
  };

  // ---- 提示条 ----
  let toastTimer = null;
  LT.toast = function (msg, ms) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms || 3200);
  };

  LT.copyText = async function (text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      // 非安全上下文等情况下的退路
      const ta = LT.h('textarea', { style: 'position:fixed;opacity:0' });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    }
  };

  LT.copyPath = async function (u) {
    const path = LT.fileUrlToPath(LT.pathToFileUrl(u) || u);
    const ok = await LT.copyText(path);
    LT.toast(ok ? '已复制路径：' + path + '\n可粘贴到资源管理器地址栏打开' : '复制失败，请手动复制：' + path, 4500);
  };

  // 网页从 http(s) 打开时，浏览器禁止跳转到 file: 链接（点击无反应），这时改为复制路径
  LT.fileLinksBlocked = () => location.protocol !== 'file:';

  // ---- 文件句柄存储（IndexedDB） ----
  const DB_NAME = 'learningTree.files', STORE = 'handles';
  let dbp = null;
  function db() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbp;
  }
  function tx(mode, fn) {
    return db().then(d => new Promise((resolve, reject) => {
      const t = d.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req && req.result);
      t.onerror = () => reject(t.error);
    }));
  }
  const putHandle = (key, handle) => tx('readwrite', s => s.put(handle, key));
  const getHandle = key => tx('readonly', s => s.get(key));

  LT.canPickFiles = () => typeof window.showOpenFilePicker === 'function';

  // 弹出系统文件选择框，返回 [{ title, url: '', fileKey }]
  LT.pickLocalFiles = async function () {
    let handles;
    try {
      handles = await window.showOpenFilePicker({ multiple: true });
    } catch (e) {
      if (e.name !== 'AbortError') LT.toast('无法打开文件选择框：' + e.message);
      return [];
    }
    const out = [];
    for (const h of handles) {
      const key = 'f' + LT.uid();
      await putHandle(key, h);
      out.push({ title: h.name, url: '', fileKey: key });
    }
    return out;
  };

  // 浏览器能直接显示的类型在新标签页打开，其余类型以下载方式打开
  const VIEWABLE = /^(application\/pdf|image\/(png|jpe?g|gif|webp|bmp|avif)|text\/plain|video\/|audio\/)/;
  // HTML / SVG / XML 可能含脚本，按纯文本显示，避免在本应用的源下执行
  const AS_TEXT = /^(text\/|application\/(json|xml|javascript)|image\/svg)/;
  const TEXT_EXT = /\.(md|markdown|txt|csv|log|json|ya?ml|xml|html?|svg|js|ts|py|java|c|cpp|h|go|rs|sh|ini|toml)$/i;

  // 用户点击后调用：必须在点击的同步阶段先开好窗口，否则会被弹窗拦截
  LT.openLocalFile = async function (res, onRelink) {
    const win = window.open('', '_blank');
    const fail = msg => { if (win) win.close(); LT.toast(msg, 5000); };
    let handle;
    try { handle = await getHandle(res.fileKey); } catch (e) { /* 视为找不到 */ }
    if (!handle) {
      if (win) win.close();
      if (LT.canPickFiles() && confirm('“' + res.title + '”尚未在本浏览器中关联（可能是换了浏览器或清理了数据）。\n现在重新选择这个文件吗？')) onRelink();
      else if (!LT.canPickFiles()) LT.toast('当前浏览器不支持打开本机文件，请使用 Chrome 或 Edge。', 5000);
      return;
    }
    try {
      let perm = await handle.queryPermission({ mode: 'read' });
      if (perm !== 'granted') perm = await handle.requestPermission({ mode: 'read' });
      if (perm !== 'granted') return fail('没有获得读取“' + res.title + '”的权限。');
      const file = await handle.getFile();
      let type = file.type;
      if (!type && TEXT_EXT.test(file.name)) type = 'text/plain';
      if (AS_TEXT.test(type) || TEXT_EXT.test(file.name)) type = 'text/plain;charset=utf-8';
      const url = URL.createObjectURL(new Blob([file], { type: type || 'application/octet-stream' }));
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      if (win && VIEWABLE.test(type)) {
        win.location.href = url;
      } else {
        if (win) win.close();
        const a = LT.h('a', { href: url, download: file.name });
        document.body.append(a);
        a.click();
        a.remove();
        LT.toast('浏览器无法直接预览此类文件，已以下载方式打开：' + file.name);
      }
    } catch (e) {
      if (e.name === 'NotFoundError') {
        if (win) win.close();
        if (confirm('找不到文件“' + res.title + '”，它可能已被移动或删除。\n现在重新选择这个文件吗？')) onRelink();
      } else fail('打开失败：' + e.message);
    }
  };

  // 为已有的文件资源重新选择文件
  LT.relinkLocalFile = async function () {
    try {
      const [h] = await window.showOpenFilePicker({ multiple: false });
      const key = 'f' + LT.uid();
      await putHandle(key, h);
      return { title: h.name, fileKey: key };
    } catch (e) {
      return null;
    }
  };
})(window.LT);
