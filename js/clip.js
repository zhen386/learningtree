// 复制 / 剪切 / 粘贴节点（含子节点），可跨学习树、跨网页版与桌面版
// 剪贴板同时写两种格式：自定义格式存完整 JSON；纯文本存 Markdown 大纲，粘贴到记事本也可读
// 粘贴时优先用完整 JSON，否则把纯文本当作大纲解析（因此也能粘贴其他软件里复制的大纲）
(function (LT) {
  'use strict';
  const S = LT.state;
  const MIME = 'application/x-learning-tree+json';
  // 最近一次复制的内容。读不到自定义格式时（如 Ctrl+Shift+V 只能读纯文本），
  // 若剪贴板文本与之相同，仍按完整数据粘贴
  let last = null;
  let forced = null;  // 由按钮触发：'copy' | 'cut'，此时焦点不在导图上

  const canvas = () => document.getElementById('canvas');
  const ours = () => !!forced || (document.activeElement === canvas() && !S.linkFrom);

  function describe(n) {
    const c = LT.countDesc(n);
    return '“' + n.title + '”' + (c ? `（含 ${c} 个子节点）` : '');
  }

  function onCopy(e, cut) {
    if (!ours()) return;
    cut = cut || forced === 'cut';
    const info = LT.index.get(S.selectedId);
    e.preventDefault();
    if (cut && !info.parent) { LT.toast('根节点不能剪切，可以复制后粘贴到其他树'); return; }
    const n = info.node;
    last = {
      json: JSON.stringify({ app: 'learning-tree', version: 1, nodes: [n] }),
      text: LT.toOutline([n]).join('\n') + '\n',
    };
    e.clipboardData.setData(MIME, last.json);
    e.clipboardData.setData('text/plain', last.text);
    if (cut) LT.removeNode(n.id);
    LT.toast((cut ? '已剪切' : '已复制') + describe(n) +
      '\n选中目标节点后：Ctrl+V 粘贴，Ctrl+Shift+V 粘贴并重置进度', 4000);
  }

  // 从 JSON 或大纲文本取出要粘贴的节点（原始对象）
  function parse(json, text) {
    if (!json && last && text === last.text) json = last.json;
    const src = json || (/^\s*[{[]/.test(text) ? text : '');
    if (src) {
      try {
        const d = JSON.parse(src);
        const list = Array.isArray(d) ? d : d.nodes || (d.root ? [d.root] : Array.isArray(d.maps) ? d.maps.map(m => m && m.root) : d.title ? [d] : null);
        if (Array.isArray(list)) return list.filter(x => x && typeof x === 'object');
      } catch (e) { /* 不是 JSON，按大纲处理 */ }
    }
    return LT.parseOutline(text || '');
  }

  // 生成全新的副本：重新分配 id；子树内部的关联保留（换新的关联键），与外部的关联在重建索引时自动解除
  function prepare(list, reset) {
    const keys = new Map();
    (function strip(nodes) {
      nodes.forEach(n => {
        if (!n || typeof n !== 'object') return;
        delete n.id;
        if (typeof n.link === 'string' && n.link) {
          if (!keys.has(n.link)) keys.set(n.link, 'k' + LT.uid());
          n.link = keys.get(n.link);
        }
        if (reset) n.status = 'todo';
        if (Array.isArray(n.children)) strip(n.children);
      });
    })(list);
    return list.map(n => LT.normalize(n));
  }

  LT.pasteData = function (json, text, reset) {
    const nodes = prepare(parse(json, text), reset);
    if (!nodes.length) { LT.toast('剪贴板中没有可粘贴的内容'); return false; }
    LT.insertNodes(S.selectedId, nodes);
    const count = nodes.reduce((s, n) => s + 1 + LT.countDesc(n), 0);
    LT.toast(`已粘贴 ${count} 个节点` + (reset ? '，进度已重置为未开始' : ''));
    return true;
  };

  // 按钮与 Ctrl+Shift+V：主动读取剪贴板（只能读到纯文本）；读不到时用最近一次复制的内容
  LT.pasteFromClipboard = async function (reset) {
    let text = null;
    try { text = await navigator.clipboard.readText(); } catch (e) { /* 无权限或不支持 */ }
    if (text == null) {
      if (!last) { LT.toast('无法读取剪贴板，请允许访问剪贴板，或在导图上按 Ctrl+V 粘贴'); return false; }
      text = last.text;
    }
    return LT.pasteData('', text, reset);
  };

  // 按钮触发复制/剪切：借助 execCommand('copy') 产生 copy 事件，走与快捷键相同的路径
  // （剪切也用 copy 命令，因为不可编辑内容上浏览器不一定触发 cut 事件）
  function exec(mode) {
    forced = mode;
    try { document.execCommand('copy'); } finally { forced = null; }
  }
  LT.copyNode = () => exec('copy');
  LT.cutNode = () => exec('cut');

  LT.initClipboard = function () {
    document.addEventListener('copy', e => onCopy(e, false));
    document.addEventListener('cut', e => onCopy(e, true));
    document.addEventListener('paste', e => {
      if (!ours()) return;
      e.preventDefault();
      LT.pasteData(e.clipboardData.getData(MIME), e.clipboardData.getData('text/plain'), false);
    });
  };
})(window.LT);
