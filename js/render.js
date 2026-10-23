// 画布渲染：节点 DOM、自动布局、连线、平移缩放
(function (LT) {
  'use strict';

  const HGAP = 56;   // 父子节点水平间距
  const VGAP = 12;   // 兄弟子树垂直间距
  const view = LT.view = { x: 40, y: 40, k: 1 };
  LT.boxes = new Map();  // 当前可见节点 id -> { el, x, y, w, h, sh }
  LT.anchorId = null;    // 重绘时保持屏幕位置不动的节点
  let canvas, world, nodesEl, edgesEl, zoomLabel;

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const isRoot = n => n === LT.state.map.root;
  // 根节点按左右两侧分别判断折叠
  const visibleKids = n => isRoot(n)
    ? n.children.filter(c => !n[LT.sideKey(c.side)])
    : (n.collapsed ? [] : n.children);
  const countList = list => list.reduce((s, c) => s + 1 + LT.countDesc(c), 0);
  LT.visibleKids = visibleKids;
  LT.HGAP = HGAP;
  LT.VGAP = VGAP;

  LT.initRender = function () {
    canvas = document.getElementById('canvas');
    world = document.getElementById('world');
    nodesEl = document.getElementById('nodes');
    edgesEl = document.getElementById('edges');
    zoomLabel = document.getElementById('zoomLabel');
  };

  function hasHitIn(list) {
    return list.some(c => LT.state.hits.has(c.id) || hasHitIn(c.children));
  }

  function foldButton(list, collapsed, side) {
    const cls = ['fold'];
    if (side) cls.push('fold-' + side);
    if (collapsed && hasHitIn(list)) cls.push('has-hit');
    const where = side === 'left' ? '左侧' : side === 'right' ? '右侧' : '';
    return LT.h('button', {
      class: cls.join(' '), tabindex: '-1', 'data-side': side || null,
      title: collapsed ? `展开${where}（${countList(list)} 个子节点）` : `折叠${where}`,
    }, collapsed ? String(countList(list)) : '−');
  }

  function nodeEl(n, info) {
    const S = LT.state;
    const h = LT.h;
    const selected = n.id === S.selectedId;
    const cls = ['node', 's-' + info.status];
    if (info.depth === 0) cls.push('root');
    if (info.side === 'left') cls.push('left');
    if (selected) cls.push('selected');
    if (S.hits.has(n.id)) cls.push('hit');

    const el = h('div', {
      class: cls.join(' '), id: 'n-' + n.id, 'data-id': n.id, role: 'treeitem',
      'aria-level': info.depth + 1, 'aria-selected': String(selected),
      'aria-expanded': n.children.length ? String(visibleKids(n).length > 0) : null,
      'aria-label': n.title + '，' + LT.STATUS_LABEL[info.status],
    });
    el.append(h('div', { class: 'head' },
      h('span', { class: 'dot', title: LT.STATUS_LABEL[info.status] + '（点击切换）' }),
      h('span', { class: 'title' }, n.title)));

    const meta = [];
    if (n.children.length) {
      meta.push(LT.bar(LT.pct(info.stats)), h('span', null, info.stats.done + '/' + info.stats.total));
    }
    if (n.resources.length) meta.push(h('span', { title: n.resources.length + ' 个资源' }, '🔗' + n.resources.length));
    if (n.notes.trim()) meta.push(h('span', { title: '有笔记' }, '📝'));
    if (meta.length) el.append(h('div', { class: 'meta' }, meta));

    if (isRoot(n)) {
      // 根节点左右各一个折叠按钮，分别控制两侧
      ['left', 'right'].forEach(side => {
        const list = n.children.filter(c => c.side === side);
        if (list.length) el.append(foldButton(list, !!n[LT.sideKey(side)], side));
      });
    } else if (n.children.length) {
      el.append(foldButton(n.children, n.collapsed, null));
    }
    return el;
  }

  // 一组兄弟子树的总高度
  function measureList(list) {
    return list.reduce((sum, c, i) => sum + measure(c) + (i ? VGAP : 0), 0);
  }
  // 计算子树高度
  function measure(n) {
    const b = LT.boxes.get(n.id);
    b.kidsH = measureList(visibleKids(n));
    return (b.sh = Math.max(b.h, b.kidsH));
  }
  // 依次向下排列一组兄弟子树；dir=1 向右生长（x 为左边缘），dir=-1 向左生长（x 为右边缘）
  function placeList(list, x, top, dir) {
    let y = top;
    list.forEach(c => {
      place(c, x, y, dir);
      y += LT.boxes.get(c.id).sh + VGAP;
    });
  }
  // 父节点垂直居中于子树
  function place(n, x, top, dir) {
    const b = LT.boxes.get(n.id);
    b.x = dir > 0 ? x : x - b.w;
    b.y = top + (b.sh - b.h) / 2;
    const nx = dir > 0 ? b.x + b.w + HGAP : b.x - HGAP;
    placeList(visibleKids(n), nx, top + (b.sh - b.kidsH) / 2, dir);
  }
  // 根节点：子节点分成左右两组，各自向外生长，根在两组中间垂直居中
  function layoutRoot(root) {
    const b = LT.boxes.get(root.id);
    const kids = visibleKids(root);
    const right = kids.filter(c => c.side !== 'left');
    const left = kids.filter(c => c.side === 'left');
    const rh = measureList(right), lh = measureList(left);
    b.sh = Math.max(b.h, rh, lh);
    b.x = 0;
    b.y = (b.sh - b.h) / 2;
    placeList(right, b.w + HGAP, (b.sh - rh) / 2, 1);
    placeList(left, -HGAP, (b.sh - lh) / 2, -1);
  }

  function drawEdges(root) {
    const NS = 'http://www.w3.org/2000/svg';
    const frag = document.createDocumentFragment();
    (function walk(n) {
      const p = LT.boxes.get(n.id);
      visibleKids(n).forEach(c => {
        const b = LT.boxes.get(c.id);
        const left = LT.index.get(c.id).side === 'left';
        // 折叠按钮在外侧，连线从按钮外开始
        const x1 = left ? p.x - 10 : p.x + p.w + 10;
        const y1 = p.y + p.h / 2;
        const x2 = left ? b.x + b.w : b.x, y2 = b.y + b.h / 2, mx = (x1 + x2) / 2;
        const path = document.createElementNS(NS, 'path');
        path.setAttribute('d', `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`);
        path.setAttribute('class', 'edge ' + LT.index.get(c.id).status);
        frag.append(path);
        walk(c);
      });
    })(root);
    edgesEl.textContent = '';
    edgesEl.append(frag);
  }

  LT.renderTree = function () {
    const S = LT.state;
    const root = S.map.root;

    // 记住锚点节点的旧位置，重绘后保持它在屏幕上不动
    const anchorOld = LT.boxes.get(LT.anchorId);
    const anchor = anchorOld ? { id: LT.anchorId, x: anchorOld.x, y: anchorOld.y } : null;

    nodesEl.textContent = '';
    const order = [];
    (function walk(n) {
      const el = nodeEl(n, LT.index.get(n.id));
      nodesEl.append(el);
      order.push([n, el]);
      visibleKids(n).forEach(walk);
    })(root);

    LT.boxes = new Map();
    order.forEach(([n, el]) => LT.boxes.set(n.id, { el, w: el.offsetWidth, h: el.offsetHeight, x: 0, y: 0, sh: 0 }));
    layoutRoot(root);
    order.forEach(([n, el]) => {
      const b = LT.boxes.get(n.id);
      el.style.transform = `translate(${b.x}px, ${b.y}px)`;
    });
    drawEdges(root);

    const nb = anchor && LT.boxes.get(anchor.id);
    if (nb) {
      view.x += (anchor.x - nb.x) * view.k;
      view.y += (anchor.y - nb.y) * view.k;
      LT.applyView();
    }
    canvas.setAttribute('aria-activedescendant', 'n-' + S.selectedId);
    LT.anchorId = S.selectedId;
    LT.ensureVisible(S.selectedId);
  };

  // 只切换选中样式，不重新布局
  LT.select = function (id, opts) {
    const S = LT.state;
    if (!LT.index.has(id)) return;
    const prev = LT.boxes.get(S.selectedId);
    if (prev) { prev.el.classList.remove('selected'); prev.el.setAttribute('aria-selected', 'false'); }
    S.selectedId = id;
    LT.anchorId = id;
    const b = LT.boxes.get(id);
    if (b) {
      b.el.classList.add('selected');
      b.el.setAttribute('aria-selected', 'true');
      canvas.setAttribute('aria-activedescendant', 'n-' + id);
    }
    LT.renderPanel();
    if (opts && opts.reveal) LT.reveal(id);
  };

  // 展开被折叠的祖先并滚动到可见
  LT.reveal = function (id) {
    let changed = false;
    LT.ancestors(id).forEach(a => { if (a.collapsed) { a.collapsed = false; changed = true; } });
    const info = LT.index.get(id), root = LT.state.map.root;
    if (info && info.side && root[LT.sideKey(info.side)]) { root[LT.sideKey(info.side)] = false; changed = true; }
    if (changed) { LT.save(); LT.renderTree(); }
    LT.ensureVisible(id);
  };

  // ---- 视图 ----
  LT.applyView = function () {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
    zoomLabel.textContent = Math.round(view.k * 100) + '%';
  };

  LT.zoomAt = function (factor, cx, cy) {
    if (cx == null) { cx = canvas.clientWidth / 2; cy = canvas.clientHeight / 2; }
    const k = clamp(view.k * factor, 0.2, 2.5);
    const f = k / view.k;
    view.x = cx - (cx - view.x) * f;
    view.y = cy - (cy - view.y) * f;
    view.k = k;
    LT.applyView();
  };

  LT.fit = function () {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    LT.boxes.forEach(b => {
      minX = Math.min(minX, b.x - 12); minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w + 12); maxY = Math.max(maxY, b.y + b.h);
    });
    if (!isFinite(minX)) return;
    const cw = canvas.clientWidth, ch = canvas.clientHeight, pad = 48;
    const bw = maxX - minX, bh = maxY - minY;
    view.k = clamp(Math.min((cw - pad * 2) / bw, (ch - pad * 2) / bh), 0.2, 1);
    view.x = (cw - bw * view.k) / 2 - minX * view.k;
    view.y = (ch - bh * view.k) / 2 - minY * view.k;
    LT.applyView();
  };

  LT.centerOn = function (id) {
    const b = LT.boxes.get(id);
    if (!b) return;
    view.x = canvas.clientWidth / 2 - (b.x + b.w / 2) * view.k;
    view.y = canvas.clientHeight / 2 - (b.y + b.h / 2) * view.k;
    LT.applyView();
  };

  LT.ensureVisible = function (id) {
    const b = LT.boxes.get(id);
    if (!b) return;
    const k = view.k, m = 40, mb = 60;
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    const l = view.x + (b.x - 12) * k, t = view.y + b.y * k;
    const r = l + (b.w + 24) * k, btm = t + b.h * k;
    let dx = 0, dy = 0;
    if (r > cw - m) dx = cw - m - r;
    if (l + dx < m) dx = m - l;
    if (btm > ch - mb) dy = ch - mb - btm;
    if (t + dy < m) dy = m - t;
    if (dx || dy) { view.x += dx; view.y += dy; LT.applyView(); }
  };
})(window.LT);
