// 对树的编辑操作，全部通过 LT.commit 完成以支持撤销
(function (LT) {
  'use strict';
  const S = LT.state;
  const info = id => LT.index.get(id);

  // 展开某父节点，使挂在 side 一侧的新子节点可见
  function expandFor(p, side) {
    if (p === S.map.root) p[LT.sideKey(side)] = false;
    else p.collapsed = false;
  }

  // side 仅在父节点是根时生效，默认右侧
  LT.addChild = function (parentId, title, side) {
    const p = info(parentId || S.selectedId).node;
    const n = LT.makeNode(title || '新节点');
    if (p === S.map.root) n.side = side || 'right';
    LT.commit(() => { expandFor(p, n.side); p.children.push(n); S.selectedId = n.id; });
    if (!title) LT.startInlineEdit(n.id);
    return n;
  };

  LT.addSibling = function (id) {
    const i = info(id || S.selectedId);
    if (!i.parent) return LT.addChild(i.node.id);
    const n = LT.makeNode('新节点');
    if (i.node.side) n.side = i.node.side;
    LT.commit(() => {
      i.parent.children.splice(i.parent.children.indexOf(i.node) + 1, 0, n);
      S.selectedId = n.id;
    });
    LT.startInlineEdit(n.id);
    return n;
  };

  LT.removeNode = function (id) {
    const i = info(id || S.selectedId);
    if (!i.parent) { alert('根节点不能删除。如需移除整棵树，请使用“删除树”。'); return; }
    const sibs = i.parent.children;
    const idx = sibs.indexOf(i.node);
    LT.commit(() => {
      sibs.splice(idx, 1);
      S.selectedId = (sibs[idx] || sibs[idx - 1] || i.parent).id;
    });
  };

  LT.rename = function (id, title) {
    title = (title || '').trim();
    const n = info(id).node;
    if (!title || title === n.title) return LT.renderAll();
    LT.commit(() => { n.title = title; });
  };

  // 叶子直接设置状态；父节点则把下面所有叶子设为该状态
  LT.setStatus = function (id, status) {
    const n = info(id).node;
    LT.commit(() => {
      (function walk(x) {
        if (x.children.length) x.children.forEach(walk);
        else x.status = status;
      })(n);
    });
  };

  const NEXT = { todo: 'doing', doing: 'done', done: 'todo' };
  LT.cycleStatus = function (id) {
    LT.setStatus(id, NEXT[info(id).status]);
  };

  // 把节点移动到 newParent 的第 index 个位置；移到根下时 side 指定左右
  LT.moveNode = function (id, newParentId, index, side) {
    const i = info(id);
    if (!i.parent || id === newParentId || LT.isAncestor(id, newParentId)) return;
    const np = info(newParentId).node;
    // 位置没有变化时不产生撤销记录
    if (np === i.parent) {
      const from = np.children.indexOf(i.node);
      const to = from < index ? index - 1 : index;
      if (to === from && (np !== S.map.root || !side || side === i.node.side)) return;
    }
    LT.commit(() => {
      const old = i.parent.children;
      const from = old.indexOf(i.node);
      old.splice(from, 1);
      if (old === np.children && from < index) index--;
      np.children.splice(Math.max(0, Math.min(index, np.children.length)), 0, i.node);
      if (np === S.map.root) i.node.side = side || i.node.side || 'right';
      else delete i.node.side;
      expandFor(np, i.node.side);
      S.selectedId = id;
    });
  };

  // 把根的直接子分支换到另一侧
  LT.setSide = function (id, side) {
    const n = info(id).node;
    if (info(id).depth !== 1 || n.side === side) return;
    LT.commit(() => { n.side = side; expandFor(S.map.root, side); });
  };

  // 同侧兄弟中上下移动（根的子节点左右两组各自排序）
  LT.shift = function (id, delta) {
    const i = info(id || S.selectedId);
    if (!i.parent) return;
    const sibs = i.parent.children;
    if (i.depth === 1) {
      const same = sibs.filter(c => c.side === i.node.side);
      const other = same[same.indexOf(i.node) + delta];
      if (!other) return;
      const a = sibs.indexOf(i.node), b = sibs.indexOf(other);
      LT.commit(() => { sibs[a] = other; sibs[b] = i.node; });
      return;
    }
    const to = sibs.indexOf(i.node) + delta;
    if (to < 0 || to >= sibs.length) return;
    LT.commit(() => {
      sibs.splice(sibs.indexOf(i.node), 1);
      sibs.splice(to, 0, i.node);
    });
  };

  // 折叠状态也会保存，但不进入撤销历史
  // 根节点需指定 side，分别折叠左右两侧
  LT.toggleCollapse = function (id, value, side) {
    const n = info(id).node;
    if (!n.children.length) return;
    const key = n === S.map.root ? LT.sideKey(side || 'right') : 'collapsed';
    const v = value == null ? !n[key] : value;
    if (v === !!n[key]) return;
    LT.anchorId = id;
    n[key] = v;
    LT.commit(null, { history: false, panel: false });
  };

  LT.setAllCollapsed = function (collapsed) {
    LT.index.forEach(({ node, depth }) => {
      if (node.children.length) node.collapsed = collapsed && depth >= 1;
    });
    S.map.root.collapsedLeft = S.map.root.collapsedRight = false;
    if (collapsed) S.selectedId = S.map.root.id;
    LT.commit(null, { history: false });
    LT.fit();
  };

  LT.updateNode = function (id, fn, opts) {
    const n = info(id).node;
    LT.commit(() => fn(n), opts);
  };

  LT.addOutline = function (parentId, text) {
    const nodes = LT.parseOutline(text);
    if (!nodes.length) return;
    const p = info(parentId).node;
    // 粘贴到根下时放在右侧，之后可手动调整
    const side = p === S.map.root ? 'right' : undefined;
    if (side) nodes.forEach(c => { c.side = side; });
    LT.commit(() => { expandFor(p, side); p.children.push(...nodes); S.selectedId = nodes[0].id; });
  };

  LT.newMap = function (title) {
    const m = { id: LT.uid(), root: LT.makeNode(title) };
    S.db.maps.push(m);
    LT.switchMap(m.id);
    return m;
  };

  LT.deleteMap = function () {
    if (S.db.maps.length <= 1) { alert('至少保留一棵树。'); return; }
    if (!confirm('确定删除学习树“' + S.map.root.title + '”？此操作无法撤销，建议先导出备份。')) return;
    S.db.maps = S.db.maps.filter(m => m !== S.map);
    LT.switchMap(S.db.maps[0].id);
  };
})(window.LT);
