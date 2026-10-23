// 首次打开时的示例学习树
window.LT = window.LT || {};
LT.sample = function () {
  const n = (title, status, children, extra) =>
    Object.assign({ title, status: status || 'todo', children: children || [] }, extra);
  const mdn = path => 'https://developer.mozilla.org/zh-CN/docs/' + path;

  return n('前端开发', '', [
    n('HTML', '', [
      n('语义化标签', 'done'),
      n('表单与校验', 'done'),
      n('无障碍 (a11y)', 'doing', [], {
        resources: [{ title: 'MDN 无障碍指南', url: mdn('Web/Accessibility') }],
      }),
    ]),
    n('CSS', '', [
      n('盒模型', 'done'),
      n('Flexbox', 'done', [], {
        resources: [{ title: 'Flexbox 完全指南', url: 'https://css-tricks.com/snippets/css/a-guide-to-flexbox/' }],
      }),
      n('Grid 布局', 'doing'),
      n('响应式设计'),
      n('动画与过渡'),
    ]),
    n('JavaScript', '', [
      n('基础', '', [
        n('变量与作用域', 'done'),
        n('闭包', 'doing', [], { notes: '函数 + 其词法环境。\n常见用途：私有变量、柯里化、防抖节流。' }),
        n('原型与继承'),
      ]),
      n('异步编程', '', [n('事件循环'), n('Promise'), n('async / await')]),
      n('DOM 与事件'),
    ], {
      resources: [
        { title: 'MDN JavaScript 指南', url: mdn('Web/JavaScript/Guide') },
        { title: '《JavaScript 高级程序设计》第 4 版', url: '' },
      ],
    }),
    n('框架', '', [n('React'), n('Vue')]),
    n('工程化', '', [n('包管理 npm / pnpm'), n('构建工具 Vite'), n('自动化测试')]),
  ], { notes: '这是一棵示例学习树，可以直接修改，也可以点“新建树”从自己的主题开始。' });
};
