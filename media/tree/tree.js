'use strict';
// The Solution Explorer as a page of an editor tab (see src/treePanel.js): the rows, menus and commands come from the extension.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (s) => document.querySelector(s);
  const el = (tag, props, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== false && v !== null) e.setAttribute(k, String(v));
    }
    for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
    return e;
  };
  const post = (m) => vscode.postMessage(m);

  const saved = vscode.getState() || {};
  const open = new Map(Object.entries(saved.open || {}));       // id -> expanded, as the user left it
  let roots = [], menus = {}, toolbar = { buttons: [], more: [] };
  let rows = [];                                                // the visible nodes, top to bottom
  let selected = new Set(saved.selected || []);
  let anchor = null;
  const keep = () => vscode.setState({ open: Object.fromEntries(open), selected: [...selected] });

  const isOpen = (n) => (open.has(n.id) ? open.get(n.id) : !!n.open);

  function flatten(list, depth, parent, out) {
    for (const n of list) {
      n.depth = depth; n.parent = parent;
      out.push(n);
      if (n.children && isOpen(n)) flatten(n.children, depth + 1, n, out);
    }
    return out;
  }

  function iconOf(i) {
    if (!i) return el('span', { class: 'ico' });
    if (i.codicon) return el('span', { class: `ico codicon codicon-${i.codicon}`, style: i.color ? `color: var(${i.color})` : undefined });
    return el('span', { class: 'ico' }, el('img', { class: 'light', src: i.light, alt: '' }), el('img', { class: 'dark', src: i.dark, alt: '' }));
  }

  function button(b, run) {
    return el('button', { class: 'btn', title: b.title, 'aria-label': b.title, onclick: (ev) => { ev.stopPropagation(); run(b); } },
      b.codicon ? el('span', { class: `codicon codicon-${b.codicon}` }) : el('span', { class: 'txt', text: b.title }));
  }

  function renderBar() {
    const bar = $('#bar');
    bar.textContent = '';
    for (const b of toolbar.buttons) bar.append(button(b, (x) => post({ type: 'run', command: x.command })));
    if (toolbar.more.length) bar.append(el('button', { class: 'btn', title: 'More Actions...', onclick: (ev) => { ev.stopPropagation(); const r = ev.currentTarget.getBoundingClientRect(); showMenu(r.left, r.bottom, toolbar.more, null); } }, el('span', { class: 'codicon codicon-ellipsis' })));
  }

  function render() {
    const tree = $('#tree');
    const focus = document.activeElement === tree;
    rows = flatten(roots, 0, null, []);
    tree.textContent = '';
    const empty = $('#empty');
    empty.hidden = !!roots.length;
    tree.hidden = !roots.length;
    if (!roots.length) {
      empty.textContent = '';
      empty.append(el('p', { text: 'No solution found in this folder.' }),
        ...[['fudebaSolutionist.newSolution', 'Create a New Solution...'], ['fudebaSolutionist.openSolution', 'Open Solution...'], ['fudebaSolutionist.newProject', 'New Project from Template...']]
          .map(([c, t]) => el('button', { class: 'wide', text: t, onclick: () => post({ type: 'run', command: c }) })));
    }
    for (const n of rows) tree.append(rowOf(n));
    if (focus) tree.focus({ preventScroll: true });
  }

  function rowOf(n) {
    const m = menus[n.cv] || { inline: [], menu: [] };
    const kids = !!n.children;
    const row = el('div', {
      class: `row${selected.has(n.id) ? ' sel' : ''}${n.missing ? ' missing' : ''}`, role: 'treeitem', 'data-id': n.id,
      'aria-level': n.depth + 1, 'aria-expanded': kids ? String(isOpen(n)) : undefined,
      title: n.tooltip || n.label, draggable: n.draggable ? 'true' : undefined,
      style: `padding-left: ${4 + n.depth * 12}px`,
    },
    el('span', { class: `twistie codicon ${kids ? (isOpen(n) ? 'codicon-chevron-down' : 'codicon-chevron-right') : ''}` }),
    iconOf(n.icon),
    el('span', { class: 'label', text: n.label }),
    n.description ? el('span', { class: 'desc', text: n.description }) : null,
    m.inline.length ? el('span', { class: 'inline' }, m.inline.map((b) => button(b, (x) => post({ type: 'run', command: x.command, id: n.id })))) : null);
    row.addEventListener('click', (ev) => click(ev, n));
    row.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      if (!selected.has(n.id)) { selected = new Set([n.id]); anchor = n.id; keep(); render(); }
      showMenu(ev.clientX, ev.clientY, m.menu, n.id);
    });
    if (n.draggable) row.addEventListener('dragstart', (ev) => {
      if (!selected.has(n.id)) { selected = new Set([n.id]); keep(); }
      const ids = rows.filter((r) => selected.has(r.id) && r.draggable).map((r) => r.id);
      ev.dataTransfer.setData('text/plain', ids.join('\n'));
      ev.dataTransfer.effectAllowed = 'move';
      drag = ids;
    });
    row.addEventListener('dragend', () => { drag = null; clearDrop(); });
    if (n.droppable) {
      row.addEventListener('dragover', (ev) => { if (!drag) return; ev.preventDefault(); ev.dataTransfer.dropEffect = 'move'; clearDrop(); row.classList.add('drop'); });
      row.addEventListener('dragleave', () => row.classList.remove('drop'));
      row.addEventListener('drop', (ev) => {
        ev.preventDefault();
        const sources = drag; drag = null; clearDrop();
        if (!sources || !sources.length || sources.includes(n.id)) return;
        open.set(n.id, true); keep();                      // the target opens to show what arrived
        post({ type: 'drop', target: n.id, sources });
        render();
      });
    }
    return row;
  }
  let drag = null;
  const clearDrop = () => { for (const e of document.querySelectorAll('.row.drop')) e.classList.remove('drop'); };

  function click(ev, n) {
    $('#tree').focus({ preventScroll: true });
    if (ev.shiftKey && anchor) {
      const a = rows.findIndex((r) => r.id === anchor), b = rows.findIndex((r) => r.id === n.id);
      selected = new Set(rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((r) => r.id));
    } else if (ev.ctrlKey || ev.metaKey) {
      if (selected.has(n.id)) selected.delete(n.id); else selected.add(n.id);
      anchor = n.id;
    } else {
      selected = new Set([n.id]); anchor = n.id;
      if (n.children) open.set(n.id, !isOpen(n));
      if (n.hasCommand) post({ type: 'click', id: n.id });
    }
    keep(); render();
  }

  // ---- menus --------------------------------------------------------------------------------

  const menuEl = $('#menu');
  function closeMenu() { menuEl.hidden = true; menuEl.textContent = ''; }
  function showMenu(x, y, items, id) {
    if (!items.length) return;
    menuEl.textContent = '';
    let last = null;
    for (const it of items) {
      const g = it.group.split('@')[0];
      if (last !== null && g !== last) menuEl.append(el('div', { class: 'sep' }));
      last = g;
      menuEl.append(el('div', { class: 'mi', text: it.title, onclick: () => { closeMenu(); post({ type: 'run', command: it.command, id }); } }));
    }
    menuEl.hidden = false;
    menuEl.style.left = Math.max(2, Math.min(x, window.innerWidth - menuEl.offsetWidth - 2)) + 'px';
    menuEl.style.top = Math.max(2, Math.min(y, window.innerHeight - menuEl.offsetHeight - 2)) + 'px';
  }
  window.addEventListener('mousedown', (ev) => { if (!menuEl.contains(ev.target)) closeMenu(); }, true);
  window.addEventListener('blur', closeMenu);
  window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeMenu(); });

  // ---- keyboard -----------------------------------------------------------------------------

  $('#tree').addEventListener('keydown', (ev) => {
    const at = rows.findIndex((r) => selected.has(r.id));
    const cur = rows[at < 0 ? 0 : at];
    if (!cur) return;
    const go = (i) => { const n = rows[Math.max(0, Math.min(rows.length - 1, i))]; selected = new Set([n.id]); anchor = n.id; keep(); render(); const e = document.querySelector(`.row[data-id="${CSS.escape(n.id)}"]`); if (e) e.scrollIntoView({ block: 'nearest' }); };
    if (ev.key === 'ArrowDown') go(at + 1);
    else if (ev.key === 'ArrowUp') go(at - 1);
    else if (ev.key === 'ArrowRight' && cur.children && !isOpen(cur)) { open.set(cur.id, true); keep(); render(); }
    else if (ev.key === 'ArrowRight' && cur.children) go(at + 1);
    else if (ev.key === 'ArrowLeft' && cur.children && isOpen(cur)) { open.set(cur.id, false); keep(); render(); }
    else if (ev.key === 'ArrowLeft' && cur.parent) go(rows.findIndex((r) => r.id === cur.parent.id));
    else if (ev.key === 'Home') go(0);
    else if (ev.key === 'End') go(rows.length - 1);
    else if (ev.key === 'Enter') { if (cur.hasCommand) post({ type: 'click', id: cur.id }); else if (cur.children) { open.set(cur.id, !isOpen(cur)); keep(); render(); } }
    else return;
    ev.preventDefault();
  });

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type !== 'tree') return;
    roots = m.roots || []; menus = m.menus || {}; toolbar = m.toolbar || toolbar;
    const live = new Set();
    (function walk(l) { for (const n of l) { live.add(n.id); if (n.children) walk(n.children); } })(roots);
    selected = new Set([...selected].filter((id) => live.has(id)));
    renderBar(); render();
  });
  post({ type: 'ready' });
})();
