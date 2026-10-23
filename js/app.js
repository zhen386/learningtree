// 入口：工具栏绑定与整体刷新
(function (LT) {
  'use strict';
  const S = LT.state;
  const $ = id => document.getElementById(id);

  function renderToolbar() {
    const sel = $('mapSelect');
    sel.textContent = '';
    S.db.maps.forEach(m => {
      const st = LT.index.size && m === S.map ? LT.index.get(m.root.id).stats : null;
      sel.append(LT.h('option', { value: m.id }, m.root.title + (st ? ` (${LT.pct(st)}%)` : '')));
    });
    sel.value = S.map.id;
    $('btnDelMap').disabled = S.db.maps.length <= 1;
    $('btnUndo').disabled = !S.undo.length;
    $('btnRedo').disabled = !S.redo.length;

    const pct = LT.pct(LT.index.get(S.map.root.id).stats);
    $('overallBar').style.width = pct + '%';
    $('overallPct').textContent = pct + '%';
    $('hitCount').textContent = S.query.trim() ? S.hits.size + ' 个结果' : '';
  }

  LT.renderAll = function (opts) {
    opts = opts || {};
    LT.renderTree();
    if (opts.panel !== false) LT.renderPanel();
    renderToolbar();
  };

  // 在搜索结果之间循环跳转
  let hitCursor = -1;
  function nextHit(dir) {
    const ids = [...LT.index.keys()].filter(id => S.hits.has(id));
    if (!ids.length) return;
    hitCursor = (hitCursor + dir + ids.length) % ids.length;
    LT.select(ids[hitCursor], { reveal: true });
    LT.centerOn(ids[hitCursor]);
  }

  function bindToolbar() {
    $('mapSelect').addEventListener('change', e => LT.switchMap(e.target.value));
    $('btnNewMap').addEventListener('click', () => {
      const t = prompt('新学习树的主题：', '');
      if (t && t.trim()) LT.newMap(t.trim());
    });
    $('btnDelMap').addEventListener('click', LT.deleteMap);
    $('btnAddChild').addEventListener('click', () => LT.addChild(S.selectedId));
    $('btnAddSibling').addEventListener('click', () => LT.addSibling(S.selectedId));
    $('btnUndo').addEventListener('click', LT.undo);
    $('btnRedo').addEventListener('click', LT.redo);
    $('btnExpand').addEventListener('click', () => LT.setAllCollapsed(false));
    $('btnCollapse').addEventListener('click', () => LT.setAllCollapsed(true));
    $('btnExport').addEventListener('click', LT.exportJson);
    $('btnExportMd').addEventListener('click', LT.exportMarkdown);
    $('btnImport').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', e => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) LT.importFile(f);
    });
    $('btnHelp').addEventListener('click', () => $('dlgHelp').showModal());

    $('btnOutline').addEventListener('click', () => {
      $('outlineText').value = '';
      $('dlgOutline').showModal();
    });
    $('dlgOutline').addEventListener('close', () => {
      if ($('dlgOutline').returnValue === 'ok') LT.addOutline(S.selectedId, $('outlineText').value);
    });

    const search = $('search');
    search.addEventListener('input', () => {
      S.query = search.value;
      hitCursor = -1;
      LT.reindex();
      LT.renderAll({ panel: false });
    });
    search.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); nextHit(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { search.value = ''; search.dispatchEvent(new Event('input')); $('canvas').focus(); }
    });

    $('btnZoomIn').addEventListener('click', () => LT.zoomAt(1.2));
    $('btnZoomOut').addEventListener('click', () => LT.zoomAt(1 / 1.2));
    $('btnFit').addEventListener('click', LT.fit);
    $('btnCenter').addEventListener('click', () => LT.centerOn(S.selectedId));
  }

  LT.initRender();
  LT.initInteract();
  bindToolbar();
  LT.load();
  LT.renderAll();
  LT.fit();
  // 字体加载完成后节点尺寸会变化，重新布局一次
  if (document.fonts) document.fonts.ready.then(() => { LT.renderTree(); LT.fit(); });
})(window.LT);
