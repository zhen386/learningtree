// 数据层：节点模型、索引与统计、本地存储、撤销/重做
window.LT = window.LT || {};
(function (LT) {
  'use strict';

  const KEY = 'learningTree.v1';
  const MAX_HISTORY = 100;
  const STATUSES = ['todo', 'doing', 'done'];

  const S = LT.state = {
    db: null,          // { current, maps: [{ id, root }] }
    map: null,         // 当前学习树
    selectedId: null,
    query: '',
    hits: new Set(),
    undo: [],
    redo: [],
  };
  // id -> { node, parent, depth, stats: { total, done, doing }, status }
  LT.index = new Map();

  LT.uid = () => Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 8);

  LT.makeNode = function (title, extra) {
    return Object.assign({
      id: LT.uid(), title: title || '新节点', status: 'todo',
      notes: '', resources: [], children: [], collapsed: false,
    }, extra || {});
  };

  // 把任意来源（本地存储、导入文件、大纲解析）的对象整理成合法节点
  LT.normalize = function normalize(raw, seen) {
    seen = seen || new Set();
    raw = raw || {};
    const n = LT.makeNode(raw.title != null && String(raw.title).trim() ? String(raw.title) : '未命名');
    if (typeof raw.id === 'string' && raw.id && !seen.has(raw.id)) n.id = raw.id;
    seen.add(n.id);
    if (STATUSES.includes(raw.status)) n.status = raw.status;
    if (typeof raw.notes === 'string') n.notes = raw.notes;
    if (Array.isArray(raw.resources)) {
      n.resources = raw.resources
        .filter(r => r && (r.title || r.url))
        .map(r => {
          const o = { title: String(r.title || ''), url: String(r.url || '') };
          // fileKey 指向 IndexedDB 中保存的本机文件句柄
          if (typeof r.fileKey === 'string' && r.fileKey) o.fileKey = r.fileKey;
          return o;
        });
    }
    n.collapsed = !!raw.collapsed;
    if (raw.side === 'left' || raw.side === 'right') n.side = raw.side;
    if (raw.collapsedLeft) n.collapsedLeft = true;
    if (raw.collapsedRight) n.collapsedRight = true;
    if (Array.isArray(raw.children)) n.children = raw.children.map(c => normalize(c, seen));
    return n;
  };

  // 父节点的状态与进度由其下所有叶子节点汇总
  // ---- 左右布局：只有根节点的直接子节点记录 side（由用户手动指定），后代继承 ----
  // 根节点左右两侧分别折叠：collapsedLeft / collapsedRight
  LT.sideKey = side => (side === 'left' ? 'collapsedLeft' : 'collapsedRight');
  function ensureSides(root) {
    root.children.forEach(c => { if (c.side !== 'left' && c.side !== 'right') c.side = 'right'; });
    if (root.collapsed) {
      // 旧版本根节点整体折叠 → 转为两侧都折叠
      root.collapsedLeft = root.collapsedRight = true;
      root.collapsed = false;
    }
  }

  LT.reindex = function () {
    LT.index.clear();
    ensureSides(S.map.root);
    (function walk(node, parent, depth, side) {
      if (depth === 1) side = node.side;
      const info = { node, parent, depth, side };
      LT.index.set(node.id, info);
      if (!node.children.length) {
        info.stats = { total: 1, done: +(node.status === 'done'), doing: +(node.status === 'doing') };
        info.status = node.status;
      } else {
        const st = { total: 0, done: 0, doing: 0 };
        node.children.forEach(c => {
          const s = walk(c, node, depth + 1, side);
          st.total += s.total; st.done += s.done; st.doing += s.doing;
        });
        info.stats = st;
        info.status = st.done === st.total ? 'done' : (st.done + st.doing) ? 'doing' : 'todo';
      }
      return info.stats;
    })(S.map.root, null, 0, null);
    if (!LT.index.has(S.selectedId)) S.selectedId = S.map.root.id;
    computeHits();
  };

  function matches(n, q) {
    return n.title.toLowerCase().includes(q) ||
      n.notes.toLowerCase().includes(q) ||
      n.resources.some(r => (r.title + ' ' + r.url).toLowerCase().includes(q));
  }
  function computeHits() {
    S.hits = new Set();
    const q = S.query.trim().toLowerCase();
    if (!q) return;
    LT.index.forEach((info, id) => { if (matches(info.node, q)) S.hits.add(id); });
  }

  // 从根到父节点的祖先列表（不含自身）
  LT.ancestors = function (id) {
    const out = [];
    let info = LT.index.get(id);
    while (info && info.parent) { out.unshift(info.parent); info = LT.index.get(info.parent.id); }
    return out;
  };
  // a 是否为 b 的祖先
  LT.isAncestor = function (a, b) {
    return LT.ancestors(b).some(n => n.id === a);
  };
  LT.countDesc = function countDesc(n) {
    return n.children.reduce((sum, c) => sum + 1 + countDesc(c), 0);
  };

  // ---- 持久化 ----
  // 桌面版（Electron）通过 window.desktop 读写数据文件；网页版使用 localStorage
  LT.desktop = window.desktop || null;

  async function readRaw() {
    if (LT.desktop) {
      const r = await LT.desktop.load();
      return r && r.json;
    }
    return localStorage.getItem(KEY);
  }

  LT.load = async function () {
    let db = null;
    try { db = JSON.parse(await readRaw()); } catch (e) { /* 数据损坏或不存在时回退到示例 */ }
    if (!db || !Array.isArray(db.maps) || !db.maps.length) {
      db = { current: null, maps: [{ id: LT.uid(), root: LT.normalize(LT.sample()) }] };
    } else {
      db.maps = db.maps.map(m => ({ id: m.id || LT.uid(), root: LT.normalize(m.root) }));
    }
    if (!db.maps.some(m => m.id === db.current)) db.current = db.maps[0].id;
    S.db = db;
    S.map = db.maps.find(m => m.id === db.current);
    S.selectedId = S.map.root.id;
    LT.reindex();
  };

  let saveTimer = null, flashTimer = null, saveErrorShown = false;
  let writing = Promise.resolve();  // 桌面版按顺序写入，避免旧内容覆盖新内容
  let dirty = false;                // 有尚未写入磁盘的修改

  LT.save = function () {
    dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(LT.saveNow, LT.desktop ? 400 : 250);
  };

  function flashSaved() {
    saveErrorShown = false;
    const el = document.getElementById('saved');
    if (!el) return;
    el.textContent = '已保存';
    el.classList.add('show');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => el.classList.remove('show'), 900);
  }
  function saveFailed(e) {
    const el = document.getElementById('saved');
    if (el) { el.textContent = '⚠ 保存失败'; el.classList.add('show'); }
    if (saveErrorShown) return;
    saveErrorShown = true;
    alert('保存失败：' + (e && e.message || e) + '\n请先导出备份数据，并检查数据文件所在位置是否可写。');
  }

  LT.saveNow = function () {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!S.db) return Promise.resolve();
    const json = JSON.stringify(S.db);
    dirty = false;
    if (LT.desktop) {
      writing = writing.then(() => LT.desktop.save(json)).then(flashSaved, e => { dirty = true; saveFailed(e); });
      return writing;
    }
    try {
      localStorage.setItem(KEY, json);
      flashSaved();
    } catch (e) {
      dirty = true;
      saveFailed(e);
    }
    return Promise.resolve();
  };

  // 关闭/刷新前把最后的修改同步写入
  window.addEventListener('beforeunload', () => {
    if (!dirty || !S.db) return;
    clearTimeout(saveTimer);
    const json = JSON.stringify(S.db);
    if (LT.desktop) LT.desktop.saveSync(json);
    else try { localStorage.setItem(KEY, json); } catch (e) { /* 无法处理 */ }
  });

  LT.switchMap = function (id) {
    const m = S.db.maps.find(x => x.id === id);
    if (!m) return;
    S.db.current = id;
    S.map = m;
    S.selectedId = m.root.id;
    S.undo.length = 0;
    S.redo.length = 0;
    LT.boxes.clear();
    LT.reindex();
    LT.save();
    LT.renderAll();
    LT.fit();
  };

  // ---- 撤销 / 重做 ----
  const snap = () => JSON.stringify({ root: S.map.root, sel: S.selectedId });
  function restore(s) {
    const o = JSON.parse(s);
    S.map.root = o.root;
    S.selectedId = o.sel;
  }
  LT.checkpoint = function () {
    S.undo.push(snap());
    if (S.undo.length > MAX_HISTORY) S.undo.shift();
    S.redo.length = 0;
  };
  // 所有修改都经过这里：记录历史 → 修改 → 重建索引 → 保存 → 重绘
  LT.commit = function (fn, opts) {
    opts = opts || {};
    if (opts.history !== false) LT.checkpoint();
    if (fn) fn();
    LT.reindex();
    LT.save();
    LT.renderAll(opts);
  };
  LT.undo = function () {
    if (!S.undo.length) return;
    S.redo.push(snap());
    restore(S.undo.pop());
    LT.reindex(); LT.save(); LT.renderAll();
  };
  LT.redo = function () {
    if (!S.redo.length) return;
    S.undo.push(snap());
    restore(S.redo.pop());
    LT.reindex(); LT.save(); LT.renderAll();
  };

  // ---- 小工具 ----
  LT.h = function (tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'value') el.value = v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    kids.flat().forEach(c => {
      if (c == null || c === false) return;
      el.append(c instanceof Node ? c : String(c));
    });
    return el;
  };
  LT.bar = pct => LT.h('div', { class: 'bar' }, LT.h('span', { style: 'width:' + pct + '%' }));
  LT.pct = st => st.total ? Math.round(st.done / st.total * 100) : 0;
  LT.STATUS_LABEL = { todo: '未开始', doing: '进行中', done: '已完成' };

  // 只允许 http(s)/file 链接，避免 javascript: 等协议；本机路径转 file: 链接；其他文本（如书名）按纯文本显示
  LT.safeUrl = function (u) {
    u = (u || '').trim();
    if (/^(https?|file):\/\//i.test(u)) return u;
    const local = LT.pathToFileUrl && LT.pathToFileUrl(u);
    if (local) return local;
    if (/^(www\.)?[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(u)) return 'https://' + u;
    return null;
  };
})(window.LT);
