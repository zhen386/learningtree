// 对树的编辑操作，全部通过 LT.commit 完成以支持撤销
(function (LT) {
  'use strict';
  const S = LT.state;
  const info = id => LT.index.get(id);
  const cloneResources = list => list.map(r => Object.assign({}, r));

  // 把节点的共享内容复制到它的关联节点；状态只在叶子之间同步（父节点状态由各自子节点汇总）
  function syncTwins(n) {
    LT.twins(n).forEach(t => {
      t.title = n.title;
      t.notes = n.notes;
      t.resources = cloneResources(n.resources);
      if (!n.children.length && !t.children.length) t.status = n.status;
    });
  }

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
    LT.commit(() => { n.title = title; syncTwins(n); });
  };

  // 叶子直接设置状态；父节点则把下面所有叶子设为该状态
  LT.setStatus = function (id, status) {
    const n = info(id).node;
    LT.commit(() => {
      (function walk(x) {
        if (x.children.length) x.children.forEach(walk);
        else {
          x.status = status;
          LT.twins(x).forEach(t => { if (!t.children.length) t.status = status; });
        }
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
    LT.commit(() => { fn(n); syncTwins(n); }, opts);
  };

  // 把 targetId 关联到 id（两边已有的关联组合并为一组）：
  // 标题沿用 id 的，笔记与资源合并，叶子状态取进度最靠前的
  const RANK = { todo: 0, doing: 1, done: 2 };
  LT.linkNodes = function (id, targetId) {
    const a = info(id).node, b = info(targetId).node;
    if (a === b || (a.link && a.link === b.link)) return false;
    const group = [a, ...LT.twins(a), b, ...LT.twins(b)];
    if (group.some(x => group.some(y => LT.isAncestor(x.id, y.id)))) {
      LT.toast('不能关联自己的上级或下级节点');
      return false;
    }
    const key = a.link || b.link || 'k' + LT.uid();
    const notes = [...new Set(group.map(x => x.notes.trim()).filter(Boolean))].join('\n\n');
    const seen = new Set();
    const resources = group.flatMap(x => x.resources).filter(r => {
      const k = JSON.stringify([r.title, r.url, r.fileKey]);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const leaves = group.filter(x => !x.children.length);
    const status = leaves.reduce((s, x) => (RANK[x.status] > RANK[s] ? x.status : s), 'todo');
    LT.commit(() => {
      group.forEach(x => {
        x.link = key;
        x.title = a.title;
        x.notes = notes;
        x.resources = cloneResources(resources);
        if (!x.children.length) x.status = status;
      });
    });
    LT.toast('已关联，共 ' + group.length + ' 处共享标题、状态、笔记和资源');
    return true;
  };

  // 取消关联后保留当前内容的一份副本
  LT.unlinkNode = function (id) {
    const n = info(id).node;
    if (!n.link) return;
    LT.commit(() => { delete n.link; });
  };

  // 把一组新节点追加为 parentId 的子节点，并选中第一个
  LT.insertNodes = function (parentId, nodes) {
    if (!nodes.length) return;
    const p = info(parentId).node;
    const isRoot = p === S.map.root;
    // 放到根下时沿用原来的左右侧，没有则放右侧；其他位置不记录 side
    nodes.forEach(c => { if (isRoot) c.side = c.side === 'left' ? 'left' : 'right'; else delete c.side; });
    LT.commit(() => {
      nodes.forEach(c => expandFor(p, c.side));
      p.children.push(...nodes);
      S.selectedId = nodes[0].id;
    });
  };

  LT.addOutline = (parentId, text) => LT.insertNodes(parentId, LT.parseOutline(text));

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
