// 鼠标 / 触摸 / 键盘交互：平移、缩放、点击、拖拽重组、行内编辑、快捷键
(function (LT) {
  'use strict';
  const S = LT.state;
  const view = LT.view;
  const DRAG_THRESHOLD = 5;
  let canvas;

  // ---- 行内重命名 ----
  LT.startInlineEdit = function (id) {
    const b = LT.boxes.get(id);
    if (!b) return;
    const t = b.el.querySelector('.title');
    const original = t.textContent;
    let finished = false;
    t.contentEditable = 'plaintext-only';
    if (t.contentEditable !== 'plaintext-only') t.contentEditable = 'true';
    t.focus();
    const range = document.createRange();
    range.selectNodeContents(t);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const finish = save => {
      if (finished) return;
      finished = true;
      t.removeAttribute('contenteditable');
      canvas.focus({ preventScroll: true });
      if (save) LT.rename(id, t.textContent.replace(/\s+/g, ' '));
      else { t.textContent = original; LT.renderAll(); }
    };
    t.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      else if (e.key === 'Tab' && !e.isComposing) {
        // 输入完直接 Tab 继续加子节点，像大纲编辑器一样
        e.preventDefault(); finish(true); LT.addChild(id);
      }
    });
    t.addEventListener('blur', () => finish(true), { once: true });
    t.addEventListener('pointerdown', e => e.stopPropagation());
  };

  // ---- 点选关联目标：面板中点“关联节点…”后，在导图上点击目标节点 ----
  LT.startLinkPick = function (id) {
    S.linkFrom = id;
    canvas.classList.add('picking');
    canvas.focus({ preventScroll: true });
    LT.toast('点击导图上要关联的节点，Esc 取消', 600000);
    LT.renderPanel();
  };
  LT.endLinkPick = function () {
    if (!S.linkFrom) return;
    S.linkFrom = null;
    canvas.classList.remove('picking');
    LT.hideToast();
    LT.renderPanel();
  };

  // ---- 指针：平移 / 选择 / 拖拽节点 ----
  let ptr = null;

  // ---- 拖拽落点 ----
  // 找离鼠标最近的节点 t（排除被拖拽的子树）：
  //   - t 是根：按鼠标在根的左/右决定侧，再按高度插到该侧对应的缝隙
  //   - 鼠标在 t 的中部，或越过 t 的外侧边缘：成为 t 的子节点，按高度插入
  //   - 否则：成为 t 的兄弟，按高度插到对应的缝隙
  const EMPTY_SLOT_W = 100;
  const OUTWARD = 16;

  // 在父节点 p 的某一侧，按鼠标高度 wy 求插入位置及指示线
  function slotIn(p, side, wy, dragId) {
    const root = S.map.root;
    const list = p === root ? p.children.filter(c => c.side === side) : p.children;
    const shown = new Set(LT.visibleKids(p));
    const vis = list.filter(c => shown.has(c) && c.id !== dragId);
    const pb = LT.boxes.get(p.id);
    const dir = side === 'left' ? -1 : 1;
    const boxes = vis.map(c => LT.boxes.get(c.id));
    const k = boxes.findIndex(b => wy < b.y + b.h / 2);
    let index, y;
    if (!vis.length) {
      index = p.children.length;
      y = pb.y + pb.h / 2;
    } else if (k === -1) {
      index = p.children.indexOf(vis[vis.length - 1]) + 1;
      const last = boxes[boxes.length - 1];
      y = last.y + last.h + LT.VGAP / 2;
    } else {
      index = p.children.indexOf(vis[k]);
      y = k > 0 ? (boxes[k - 1].y + boxes[k - 1].h + boxes[k].y) / 2 : boxes[k].y - LT.VGAP / 2;
    }
    return {
      parentId: p.id, index, side: p === root ? side : undefined, dir,
      x: dir > 0 ? pb.x + pb.w + LT.HGAP : pb.x - LT.HGAP, y,
      w: boxes.length ? Math.max(80, ...boxes.map(b => b.w)) : EMPTY_SLOT_W,
    };
  }

  function computeDrop(wx, wy, dragId) {
    let best = null, bestD = Infinity;
    LT.boxes.forEach((b, id) => {
      if (id === dragId || LT.isAncestor(dragId, id)) return;
      const dx = wx < b.x ? b.x - wx : wx > b.x + b.w ? wx - b.x - b.w : 0;
      const dy = wy < b.y ? b.y - wy : wy > b.y + b.h ? wy - b.y - b.h : 0;
      const d = Math.hypot(dx, dy);
      if (d < bestD) { bestD = d; best = id; }
    });
    if (!best) return null;
    const info = LT.index.get(best), t = info.node, b = LT.boxes.get(best);
    if (!info.parent) return slotIn(t, wx < b.x + b.w / 2 ? 'left' : 'right', wy, dragId);
    const left = info.side === 'left';
    // 只在节点外侧紧邻的一段区域（与节点同高、约一个连线间距内）才算“作为子节点”
    const past = left ? b.x - wx : wx - b.x - b.w;
    const outward = past > OUTWARD && past < LT.HGAP * 2.5 &&
      wy >= b.y - LT.VGAP && wy <= b.y + b.h + LT.VGAP;
    const inside = bestD === 0;
    const middle = inside && wy > b.y + b.h * 0.3 && wy < b.y + b.h * 0.7;
    if (outward || middle) return slotIn(t, info.side, wy, dragId);
    return slotIn(info.parent, info.side, wy, dragId);
  }

  function toWorld(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    return [(clientX - r.left - view.x) / view.k, (clientY - r.top - view.y) / view.k];
  }

  function showDrop(s) {
    const line = document.getElementById('dropLine');
    if (!s) { line.style.display = 'none'; return; }
    line.style.display = 'block';
    line.style.width = s.w + 'px';
    line.style.transform = `translate(${s.dir > 0 ? s.x : s.x - s.w}px, ${s.y}px)`;
    line.classList.toggle('to-left', s.dir < 0);
    const el = LT.boxes.get(s.parentId).el;
    if (ptr.dropParentEl !== el) {
      if (ptr.dropParentEl) ptr.dropParentEl.classList.remove('drop-child');
      el.classList.add('drop-child');
      ptr.dropParentEl = el;
    }
  }
  function clearDropMark() {
    document.getElementById('dropLine').style.display = 'none';
    if (ptr && ptr.dropParentEl) ptr.dropParentEl.classList.remove('drop-child');
  }

  function onPointerDown(e) {
    if (e.button !== 0 || e.target.closest('.zoom-ctrl') || e.target.isContentEditable) return;
    // 阻止浏览器默认的文字选择与原生拖拽，否则拖动画布时会选中文字、再拖就变成拖文字
    e.preventDefault();
    const sel = getSelection();
    if (sel.rangeCount && !sel.isCollapsed) sel.removeAllRanges();
    const nodeEl = e.target.closest('.node');
    ptr = {
      id: e.pointerId, sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y,
      nodeId: nodeEl ? nodeEl.dataset.id : null, nodeEl,
      onFold: !!e.target.closest('.fold'), onDot: !!e.target.closest('.dot'),
      foldSide: e.target.closest('.fold') ? e.target.closest('.fold').dataset.side : undefined,
      moved: false, dragging: false, drop: null,
    };
    canvas.setPointerCapture(e.pointerId);
    canvas.focus({ preventScroll: true });
  }

  function onPointerMove(e) {
    if (!ptr || e.pointerId !== ptr.id) return;
    const dx = e.clientX - ptr.sx, dy = e.clientY - ptr.sy;
    if (!ptr.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    ptr.moved = true;

    const canDrag = ptr.nodeId && !ptr.onFold && LT.index.get(ptr.nodeId).parent;
    if (!canDrag) {
      canvas.classList.add('panning');
      view.x = ptr.vx + dx;
      view.y = ptr.vy + dy;
      LT.applyView();
      return;
    }
    if (!ptr.dragging) {
      ptr.dragging = true;
      ptr.base = ptr.nodeEl.style.transform;
      ptr.nodeEl.classList.add('dragging');
    }
    ptr.nodeEl.style.transform = ptr.base + ` translate(${dx / view.k}px, ${dy / view.k}px)`;
    const [wx, wy] = toWorld(e.clientX, e.clientY);
    ptr.drop = computeDrop(wx, wy, ptr.nodeId);
    showDrop(ptr.drop);
  }

  function onPointerUp(e) {
    if (!ptr || e.pointerId !== ptr.id) return;
    const p = ptr;
    clearDropMark();
    ptr = null;
    canvas.classList.remove('panning');

    if (p.dragging) {
      p.nodeEl.classList.remove('dragging');
      p.nodeEl.style.transform = p.base;
      if (p.drop) LT.moveNode(p.nodeId, p.drop.parentId, p.drop.index, p.drop.side);
      return;
    }
    if (p.moved) return;
    if (S.linkFrom) {
      // 点选关联目标：点节点即关联，点空白处取消
      const from = S.linkFrom;
      LT.endLinkPick();
      if (p.nodeId && LT.index.has(from)) LT.linkNodes(from, p.nodeId);
      return;
    }
    if (!p.nodeId) return;
    if (p.onFold) LT.toggleCollapse(p.nodeId, null, p.foldSide);
    else if (p.onDot) { LT.select(p.nodeId); LT.cycleStatus(p.nodeId); }
    else LT.select(p.nodeId);
  }

  function onPointerCancel() {
    if (!ptr) return;
    clearDropMark();
    if (ptr.dragging) { ptr.nodeEl.classList.remove('dragging'); ptr.nodeEl.style.transform = ptr.base; }
    ptr = null;
    canvas.classList.remove('panning');
  }

  function onWheel(e) {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    LT.zoomAt(Math.exp(-d * 0.0015), e.clientX - r.left, e.clientY - r.top);
  }

  // ---- 键盘 ----
  function navigate(key) {
    const info = LT.index.get(S.selectedId);
    const n = info.node, p = info.parent;
    // 根的子节点只在同侧之间上下移动
    const sibs = !p ? [n] : info.depth === 1 ? p.children.filter(c => c.side === n.side) : p.children;
    const i = sibs.indexOf(n);
    let target = null;
    if (key === 'ArrowUp') target = sibs[i - 1];
    else if (key === 'ArrowDown') target = sibs[i + 1];
    else if (!p) {
      // 根节点：← / → 进入对应一侧的第一个分支，该侧折叠时先展开
      const side = key === 'ArrowLeft' ? 'left' : 'right';
      target = n.children.find(c => c.side === side);
      if (target && n[LT.sideKey(side)]) return LT.toggleCollapse(n.id, false, side);
    } else {
      // 左侧分支方向镜像：朝外 = 展开/进入子节点，朝内 = 折叠/回到父节点
      const outward = info.side === 'left' ? 'ArrowLeft' : 'ArrowRight';
      if (key === outward) {
        if (n.collapsed) return LT.toggleCollapse(n.id, false);
        target = n.children[0];
      } else {
        if (n.children.length && !n.collapsed) return LT.toggleCollapse(n.id, true);
        target = p;
      }
    }
    if (target) LT.select(target.id, { reveal: true });
  }

  function onCanvasKey(e) {
    if (e.target !== canvas || e.isComposing) return;
    const id = S.selectedId;
    const mod = e.ctrlKey || e.metaKey;
    let handled = true;
    // 根节点上：Tab 加到右侧，Shift+Tab 加到左侧
    if (e.key === 'Tab' && id === S.map.root.id) LT.addChild(id, null, e.shiftKey ? 'left' : 'right');
    else if (e.key === 'Tab' && !e.shiftKey) LT.addChild(id);
    else if (e.key === 'Enter') LT.addSibling(id);
    else if (mod && e.shiftKey && e.key.toLowerCase() === 'v') LT.pasteFromClipboard(true);
    else if (e.key === 'F2') LT.startInlineEdit(id);
    else if (e.key === ' ') LT.cycleStatus(id);
    else if (e.key === 'Delete' || e.key === 'Backspace') LT.removeNode(id);
    else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) LT.shift(id, e.key === 'ArrowUp' ? -1 : 1);
    else if (e.key.startsWith('Arrow') && !mod) navigate(e.key);
    else if (e.key === '+' || e.key === '=') LT.zoomAt(1.2);
    else if (e.key === '-') LT.zoomAt(1 / 1.2);
    else handled = false;
    if (handled) e.preventDefault();
  }

  // 全局快捷键（输入框内不拦截撤销，保留浏览器原生文本撤销）
  function onGlobalKey(e) {
    if (e.key === 'Escape' && S.linkFrom) { e.preventDefault(); LT.endLinkPick(); return; }
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === 'f') { e.preventDefault(); document.getElementById('search').select(); return; }
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if (inField) return;
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); LT.undo(); }
    else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); LT.redo(); }
  }

  LT.initInteract = function () {
    canvas = document.getElementById('canvas');
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerCancel);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dragstart', e => e.preventDefault());
    canvas.addEventListener('keydown', onCanvasKey);
    canvas.addEventListener('dblclick', e => {
      const nodeEl = e.target.closest('.node');
      if (nodeEl && !e.target.closest('.fold, .dot')) LT.startInlineEdit(nodeEl.dataset.id);
    });
    document.addEventListener('keydown', onGlobalKey);
  };
})(window.LT);
