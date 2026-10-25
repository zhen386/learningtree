// 右侧详情面板：标题、状态、进度、笔记、资源
(function (LT) {
  'use strict';
  const S = LT.state;
  const h = LT.h;

  // 连续输入只记录一次撤销点：聚焦时打开，失焦后关闭
  let typingOpen = false;
  function typedEdit(id, fn) {
    if (!typingOpen) { LT.checkpoint(); typingOpen = true; }
    LT.updateNode(id, fn, { history: false, panel: false });
  }
  const endTyping = () => { typingOpen = false; };

  async function relink(n, i) {
    if (LT.desktop) {
      // 桌面版：重新选择后直接改为路径引用
      const [p] = await LT.pickLocalFiles();
      if (p) LT.updateNode(n.id, x => { x.resources[i] = { title: x.resources[i].title || p.title, url: p.url }; });
      return;
    }
    const r = await LT.relinkLocalFile();
    if (r) LT.updateNode(n.id, x => { x.resources[i].fileKey = r.fileKey; if (!x.resources[i].title) x.resources[i].title = r.title; });
  }

  function resourceItem(n, r, i) {
    const url = LT.safeUrl(r.url);
    const local = !r.fileKey && LT.isLocalLink(r.url);
    const label = r.title || r.url;
    let main, sub = null, extra = null;

    if (r.fileKey) {
      // 通过“选择本机文件”添加：点击时读取保存的文件句柄打开
      main = h('button', {
        class: 'link res-file', title: '打开本机文件（' + r.title + '）',
        onclick: () => LT.openLocalFile(r, () => relink(n, i)),
      }, '📄 ' + label);
      sub = h('div', { class: 'muted' }, '本机文件 · 仅在本浏览器中可直接打开');
      extra = h('button', { title: '重新选择文件', 'aria-label': '重新选择文件 ' + label, onclick: () => relink(n, i) }, '↻');
    } else if (local) {
      const path = LT.fileUrlToPath(url);
      if (LT.desktop) {
        // 桌面版：用系统默认程序打开，或在资源管理器中显示
        main = h('a', {
          href: url, title: '用默认程序打开：' + path,
          onclick: e => { e.preventDefault(); LT.openLocalPath(r.url); },
        }, '📁 ' + label);
        extra = [
          h('button', { title: '在资源管理器中显示', 'aria-label': '在资源管理器中显示 ' + label, onclick: () => LT.revealLocalPath(r.url) }, '📂'),
          h('button', { title: '复制路径', 'aria-label': '复制路径 ' + label, onclick: () => LT.copyPath(r.url) }, '⧉'),
        ];
      } else {
        // 网页通过 http 打开时浏览器会拦截 file: 链接，改为复制路径
        const blocked = LT.fileLinksBlocked();
        main = h('a', {
          href: url, target: '_blank', rel: 'noopener noreferrer', title: path,
          onclick: blocked ? e => { e.preventDefault(); LT.copyPath(r.url); } : null,
        }, '📁 ' + label);
        extra = h('button', { title: '复制路径', 'aria-label': '复制路径 ' + label, onclick: () => LT.copyPath(r.url) }, '⧉');
      }
      sub = h('div', { class: 'muted' }, path);
    } else if (url) {
      main = h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', title: r.url }, label);
    } else {
      main = h('span', { title: r.url }, label);
      if (r.title && r.url) sub = h('div', { class: 'muted' }, r.url);
    }
    if (r.title && url && !local && !r.fileKey) sub = null;

    return h('li', null,
      h('div', null, main, sub),
      extra,
      h('button', {
        title: '上移', 'aria-label': '上移资源 ' + label, disabled: i === 0,
        onclick: () => LT.updateNode(n.id, x => x.resources.splice(i - 1, 0, x.resources.splice(i, 1)[0])),
      }, '↑'),
      h('button', {
        class: 'danger', title: '删除', 'aria-label': '删除资源 ' + label,
        onclick: () => LT.updateNode(n.id, x => x.resources.splice(i, 1)),
      }, '×'));
  }

  LT.renderPanel = function () {
    const panel = document.getElementById('panel');
    const info = LT.index.get(S.selectedId);
    const n = info.node;
    const isLeaf = !n.children.length;
    typingOpen = false;

    const crumbs = h('nav', { class: 'crumbs', 'aria-label': '路径' });
    LT.ancestors(n.id).forEach(a => {
      crumbs.append(h('button', { class: 'link', onclick: () => LT.select(a.id, { reveal: true }) }, a.title), '›');
    });
    crumbs.append(h('span', { class: 'cur' }, n.title));

    const title = h('input', {
      id: 'f-title', value: n.title, 'aria-label': '标题',
      oninput: e => { if (e.target.value.trim()) typedEdit(n.id, x => { x.title = e.target.value; }); },
      onblur: e => { endTyping(); if (!e.target.value.trim()) e.target.value = n.title; },
    });

    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': '状态' },
      ['todo', 'doing', 'done'].map(s => h('button', {
        class: s, 'aria-pressed': String(info.status === s),
        title: isLeaf ? '' : '将下面所有叶子节点设为“' + LT.STATUS_LABEL[s] + '”',
        onclick: () => LT.setStatus(n.id, s),
      }, LT.STATUS_LABEL[s])));

    const st = info.stats;
    const progress = isLeaf ? null : h('div', { class: 'progress' },
      LT.bar(LT.pct(st)),
      h('div', { class: 'muted' },
        `进度 ${LT.pct(st)}% · 已完成 ${st.done} / 进行中 ${st.doing} / 共 ${st.total} 个知识点（状态由子节点汇总）`));

    const notes = h('textarea', {
      id: 'f-notes', placeholder: '学习笔记、要点、疑问……', 'aria-label': '笔记',
      oninput: e => typedEdit(n.id, x => { x.notes = e.target.value; }),
      onblur: endTyping,
    });
    notes.value = n.notes;

    const rt = h('input', { name: 'rt', placeholder: '资源名称（如书名、课程名）', 'aria-label': '资源名称' });
    const ru = h('input', { name: 'ru', placeholder: '链接或本机路径，如 D:\\资料\\笔记.pdf（可选）', 'aria-label': '资源链接或本机路径' });
    const form = h('form', {
      class: 'res-form',
      onsubmit: e => {
        e.preventDefault();
        const t = rt.value.trim(), u = ru.value.trim();
        if (!t && !u) { rt.focus(); return; }
        LT.updateNode(n.id, x => x.resources.push({ title: t, url: u }));
        document.querySelector('#panel input[name="rt"]').focus();
      },
    }, rt, ru, h('button', { class: 'primary', type: 'submit' }, '添加'));

    const pick = h('div', { class: 'res-pick' },
      h('button', {
        disabled: !LT.canPickFiles(),
        title: LT.desktop ? '选择文件后记录其路径，点击即用系统默认程序打开'
          : LT.canPickFiles() ? '选择后可在本浏览器中直接点击打开' : '当前浏览器不支持，请使用 Chrome 或 Edge',
        onclick: async () => {
          const files = await LT.pickLocalFiles();
          if (files.length) LT.updateNode(n.id, x => x.resources.push(...files));
        },
      }, '📄 选择本机文件…'),
      LT.desktop ? h('span', { class: 'muted' }, '也可把文件拖到这里')
        : !LT.canPickFiles() ? h('span', { class: 'muted' }, '需 Chrome / Edge，也可直接粘贴路径') : null);

    const isRoot = !info.parent;
    // 关联节点：列出其他位置（可跳转），以及关联 / 取消关联
    let linkCtrl = [];
    if (!isRoot) {
      const twins = LT.twins(n);
      const picking = S.linkFrom === n.id;
      const where = t => LT.ancestors(t.id).slice(1).map(a => a.title).concat(t.title).join(' › ');
      linkCtrl = [
        h('span', { class: 'field' }, twins.length ? `关联节点（共 ${twins.length + 1} 处，标题、状态、笔记和资源同步）` : '关联节点'),
        twins.length ? h('ul', { class: 'res-list' }, twins.map(t => h('li', null,
          h('button', {
            class: 'link link-path', title: '跳转到该位置',
            onclick: () => { LT.select(t.id, { reveal: true }); LT.centerOn(t.id); },
          }, where(t))))) : null,
        !isLeaf && twins.length ? h('div', { class: 'muted' }, '有子节点时，状态由各自的子节点汇总，不同步') : null,
        h('div', { class: 'res-pick' },
          h('button', {
            'aria-pressed': String(picking),
            title: '同一知识点出现在多个分支时，关联后只需学习一次，总进度也只计一次',
            onclick: () => (picking ? LT.endLinkPick() : LT.startLinkPick(n.id)),
          }, picking ? '取消选择' : '⇄ 关联节点…'),
          twins.length ? h('button', { class: 'danger', onclick: () => LT.unlinkNode(n.id) }, '取消关联') : null,
          picking ? h('span', { class: 'muted' }, '在导图上点击目标节点') : null),
      ];
    }
    let sideCtrl = null;
    if (info.depth === 1) {
      sideCtrl = [h('span', { class: 'field' }, '分支方向'),
        h('div', { class: 'seg', role: 'group', 'aria-label': '分支方向' },
          [['left', '← 左侧'], ['right', '右侧 →']].map(([s, label]) => h('button', {
            'aria-pressed': String(n.side === s), class: 'side',
            onclick: () => LT.setSide(n.id, s),
          }, label)))];
    }
    const actions = isRoot
      ? h('div', { class: 'actions' },
        h('button', { onclick: () => LT.addChild(n.id, null, 'left'), title: 'Shift+Tab' }, '+ 左侧子节点'),
        h('button', { onclick: () => LT.addChild(n.id, null, 'right'), title: 'Tab' }, '+ 右侧子节点'))
      : h('div', { class: 'actions' },
        h('button', { onclick: () => LT.addChild(n.id) }, '+ 子节点'),
        h('button', { onclick: () => LT.addSibling(n.id) }, '+ 同级'),
        h('button', { onclick: () => LT.shift(n.id, -1) }, '上移'),
        h('button', { onclick: () => LT.shift(n.id, 1) }, '下移'),
        h('button', { class: 'danger', onclick: () => LT.removeNode(n.id) },
          isLeaf ? '删除' : `删除（含 ${LT.countDesc(n)} 个子节点）`));

    // 桌面版：把文件从资源管理器拖进面板即可添加为资源
    if (LT.desktop) {
      panel.ondragover = e => {
        if (![...e.dataTransfer.types].includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'link';
        panel.classList.add('drop-files');
      };
      panel.ondragleave = e => { if (!panel.contains(e.relatedTarget)) panel.classList.remove('drop-files'); };
      panel.ondrop = e => {
        panel.classList.remove('drop-files');
        const files = LT.resourcesFromDrop(e.dataTransfer);
        if (!files.length) return;
        e.preventDefault();
        LT.updateNode(S.selectedId, x => x.resources.push(...files));
        LT.toast('已添加 ' + files.length + ' 个本机文件');
      };
    }

    panel.textContent = '';
    // append 会把 null 变成文字 "null"，先滤掉
    panel.append(...[
      crumbs,
      h('label', { class: 'field', for: 'f-title' }, '标题'), title,
      h('span', { class: 'field' }, '状态'), seg, progress,
      ...(sideCtrl || []),
      ...linkCtrl,
      h('label', { class: 'field', for: 'f-notes' }, '笔记'), notes,
      h('span', { class: 'field' }, `引用资源（${n.resources.length}）`),
      n.resources.length ? h('ul', { class: 'res-list' }, n.resources.map((r, i) => resourceItem(n, r, i)))
        : h('div', { class: 'muted' }, '还没有资源，可以添加书籍、文章、视频链接等。'),
      form,
      pick,
      actions,
      h('p', { class: 'muted tip' }, '提示：选中节点后按 Tab 加子节点、Enter 加同级、空格切换状态；拖拽节点可调整层级与顺序。'),
    ].filter(Boolean));
  };
})(window.LT);
