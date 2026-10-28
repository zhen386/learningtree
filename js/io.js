// 导入导出：JSON（完整数据）、Markdown 大纲（可读、可回导）
(function (LT) {
  'use strict';
  const S = LT.state;
  const MARK = { todo: ' ', doing: '~', done: 'x' };

  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = LT.h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const safeName = s => s.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'learning-tree';

  LT.exportJson = function () {
    const data = { app: 'learning-tree', version: 1, exportedAt: new Date().toISOString(), root: S.map.root };
    download(safeName(S.map.root.title) + '.json', JSON.stringify(data, null, 2), 'application/json');
  };

  // 导出全部学习树（用于备份，或从网页版迁移到桌面版）
  LT.exportAll = function () {
    const data = { app: 'learning-tree', version: 1, exportedAt: new Date().toISOString(), maps: S.db.maps };
    download('学习树-全部-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(data, null, 2), 'application/json');
  };

  // 笔记与资源以 "> " 行跟在节点下面
  function extras(out, n, pad) {
    n.notes.split('\n').filter(l => l.trim()).forEach(l => out.push(pad + '> ' + l));
    n.resources.forEach(r => {
      out.push(pad + '> 🔗 ' + (r.url ? `[${r.title || r.url}](${r.url})` : r.title));
    });
  }

  // 节点列表转为 Markdown 列表行，叶子输出 [ ]/[~]/[x]；可被 parseOutline 解析回来
  LT.toOutline = function (list) {
    const out = [];
    (function walk(nodes, depth) {
      nodes.forEach(n => {
        const pad = '  '.repeat(depth);
        const box = n.children.length ? '' : `[${MARK[n.status]}] `;
        out.push(`${pad}- ${box}${n.title}`);
        extras(out, n, pad + '  ');
        walk(n.children, depth + 1);
      });
    })(list, 0);
    return out;
  };

  LT.toMarkdown = function (root) {
    const out = ['# ' + root.title];
    extras(out, root, '');
    if (root.notes.trim() || root.resources.length) out.push('');
    return out.concat(LT.toOutline(root.children)).join('\n') + '\n';
  };

  LT.exportMarkdown = function () {
    download(safeName(S.map.root.title) + '.md', LT.toMarkdown(S.map.root), 'text/markdown');
  };

  // 解析缩进文本 / Markdown 列表 / # 标题，返回顶层节点数组
  LT.parseOutline = function (text) {
    const roots = [];
    const stack = []; // { level, node }
    let headingBase = -1;
    let last = null;
    text.replace(/\r/g, '').split('\n').forEach(raw => {
      if (!raw.trim()) return;
      const indent = raw.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;
      let line = raw.trim();

      if (line.startsWith('>')) {
        // 归属上一个节点的笔记或资源
        if (!last) return;
        const body = line.replace(/^>\s?/, '');
        const m = body.match(/^🔗\s*(?:\[([^\]]*)\]\(([^)]*)\)|(.+))$/);
        if (m) last.resources.push({ title: (m[1] || m[3] || '').trim(), url: (m[2] || '').trim() });
        else last.notes += (last.notes ? '\n' : '') + body;
        return;
      }

      let level;
      const hm = line.match(/^(#{1,6})\s+(.*)$/);
      if (hm) {
        level = (hm[1].length - 1) * 1000;
        headingBase = level;
        line = hm[2];
      } else {
        level = headingBase + 1 + indent;
        line = line.replace(/^([-*+]|\d+[.)])\s+/, '');
      }
      let status = 'todo';
      const cm = line.match(/^\[([ xX~\-])\]\s*/);
      if (cm) {
        status = /x/i.test(cm[1]) ? 'done' : cm[1] === ' ' ? 'todo' : 'doing';
        line = line.slice(cm[0].length);
      }
      if (!line.trim()) return;

      const node = LT.makeNode(line.trim(), { status });
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      if (stack.length) stack[stack.length - 1].node.children.push(node);
      else roots.push(node);
      stack.push({ level, node });
      last = node;
    });
    return roots;
  };

  function addMaps(roots) {
    if (!roots.length) { alert('没有在文件中找到可导入的内容。'); return; }
    let lastId;
    roots.forEach(r => {
      const m = { id: LT.uid(), root: LT.normalize(r) };
      S.db.maps.push(m);
      lastId = m.id;
    });
    LT.switchMap(lastId);
  }

  LT.importFile = async function (file) {
    const text = await file.text();
    const base = file.name.replace(/\.[^.]+$/, '');
    if (/\.json$/i.test(file.name)) {
      let data;
      try { data = JSON.parse(text); } catch (e) { alert('JSON 格式错误：' + e.message); return; }
      if (Array.isArray(data.maps)) addMaps(data.maps.map(m => m.root));
      else if (data.root) addMaps([data.root]);
      else if (data.title) addMaps([data]);
      else alert('无法识别的 JSON 结构。');
      return;
    }
    const nodes = LT.parseOutline(text);
    if (nodes.length === 1) addMaps(nodes);
    else addMaps(nodes.length ? [{ title: base, children: nodes }] : []);
  };
})(window.LT);
