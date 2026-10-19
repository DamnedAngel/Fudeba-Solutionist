'use strict';
// The project settings dialog (runs inside the webview). The extension sends the models of the pages (see
// src/core/msxconfig/model.js); this edits them in place and sends them back to be checked and saved.
(function () {
  const vscode = acquireVsCodeApi();
  const CATEGORIES = ['General', 'Build configuration', 'Sources', 'Linking'];

  let state = null;       // { type, project, pages }
  let saved = '';         // JSON of the pages as they are on disk
  let issues = [];        // from the extension
  let sel = null;         // id (file name) of the selected page
  let timer = null;
  let token = 0;
  const browsing = new Map();

  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, props, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== false && v !== null) e.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k) e.append(k);
    return e;
  };
  const page = () => state.pages.find((p) => p.id === sel);
  const dirty = () => JSON.stringify(state.pages) !== saved;

  // ---- messages ---------------------------------------------------------------------------------------------------
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'init') {
      state = m.state; saved = JSON.stringify(state.pages); issues = m.issues || [];
      if (!state.pages.some((p) => p.id === sel)) sel = state.pages.length ? state.pages[0].id : null;
      renderAll();
    } else if (m.type === 'issues') {
      issues = m.issues; refreshIssues();
    } else if (m.type === 'picked') {
      const cb = browsing.get(m.token); browsing.delete(m.token);
      if (cb) cb(m.value);
    } else if (m.type === 'saveFailed') {
      issues = m.issues; refreshIssues(); setBusy(false);
    }
  });

  function changed() {
    $('#apply').disabled = !dirty();
    $('#ok').disabled = false;
    vscode.postMessage({ type: 'dirty', dirty: dirty() });
    clearTimeout(timer);
    timer = setTimeout(() => vscode.postMessage({ type: 'validate', pages: state.pages }), 150);
  }
  function setBusy(b) { for (const id of ['ok', 'apply', 'cancel']) $('#' + id).disabled = b; if (!b) $('#apply').disabled = !dirty(); }

  // ---- explanation pane -------------------------------------------------------------------------------------------
  function describe(title, key, help, extra) {
    const d = $('#desc');
    d.textContent = '';
    d.append(el('div', {}, el('span', { class: 't', text: title }), key ? el('span', { class: 'k', text: key }) : null));
    d.append(el('div', { text: help }));
    if (extra) d.append(el('div', { class: 'opt', text: extra }));
  }
  function describePage(p) { describe(p.title, p.file, p.blurb || p.help || ''); }

  // ---- index -------------------------------------------------------------------------------------------------------
  function renderIndex() {
    const idx = $('#index');
    idx.textContent = '';
    const cats = [...CATEGORIES, ...state.pages.map((p) => p.category).filter((c) => !CATEGORIES.includes(c))];
    for (const c of [...new Set(cats)]) {
      const pages = state.pages.filter((p) => p.category === c);
      if (!pages.length) continue;
      idx.append(el('div', { class: 'cat', text: c }));
      for (const p of pages) {
        const leaf = el('div', { class: `leaf${p.id === sel ? ' sel' : ''}${p.missing ? ' missing' : ''}`, 'data-id': p.id, onclick: () => { sel = p.id; renderAll(); } },
          el('span', { class: 'name' }, p.title, el('div', { class: 'file', text: p.file + (p.missing ? '  (not created yet)' : '') })),
          el('span', { class: 'badges', 'data-badges': p.id }));
        leaf.title = p.file;
        idx.append(leaf);
      }
    }
  }

  // ---- controls ---------------------------------------------------------------------------------------------------
  const FLAG = [{ value: '_ON', label: 'On  (_ON)' }, { value: '_OFF', label: 'Off  (_OFF)' }];

  function browse(startValue, cb) {
    const t = ++token;
    browsing.set(t, cb);
    vscode.postMessage({ type: 'browse', token: t, value: startValue });
  }

  function onField(f, row) {
    const show = () => {
      for (const r of document.querySelectorAll('.row.focus')) r.classList.remove('focus');
      row.classList.add('focus');
      const opt = f.options && f.options.find((o) => o.value === f.value);
      describe(f.title, f.key, f.help + (f.locked ? ' (Fixed for this project type.)' : ''), opt ? `${opt.label}: ${opt.help}` : undefined);
    };
    row.addEventListener('focusin', show);
    row.addEventListener('mouseenter', show);
  }

  function fieldControl(f) {
    const wrap = el('div', { class: `ctl${f.kind === 'flag' || f.kind === 'addr' || f.kind === 'int' ? ' narrow' : ''}` });
    let input;
    const set = (v) => { f.value = v; changed(); const row = wrap.closest('.row'); if (row) row.dispatchEvent(new Event('mouseenter')); };
    const disabledNow = () => f.kind === 'readonly' || f.locked || (f.optional && !f.set);

    if (f.optional) {
      const cb = el('input', { type: 'checkbox', title: 'Set this value; unchecked leaves it automatic (the line is commented out in the file)', ...(f.set ? { checked: true } : {}) });
      cb.addEventListener('change', () => { f.set = cb.checked; if (input) input.disabled = disabledNow(); auto.hidden = f.set; changed(); });
      wrap.append(cb);
    }
    const auto = el('span', { class: 'auto', text: 'automatic', hidden: !(f.optional && !f.set) });

    if (f.kind === 'flag') {
      input = el('select');
      const opts = FLAG.some((o) => o.value === f.value) ? FLAG : [...FLAG, { value: f.value, label: f.value }];
      for (const o of opts) input.append(el('option', { value: o.value, text: o.label, ...(o.value === f.value ? { selected: true } : {}) }));
      input.addEventListener('change', () => set(input.value));
    } else if (f.kind === 'enum' && !f.custom) {
      input = el('select');
      const opts = f.options.some((o) => o.value === f.value) || f.value === '' ? f.options : [...f.options, { value: f.value, label: f.value }];
      for (const o of opts) input.append(el('option', { value: o.value, text: o.label, ...(o.value === f.value ? { selected: true } : {}) }));
      input.addEventListener('change', () => set(input.value));
    } else {
      const listId = f.custom ? `dl-${f.key}` : undefined;
      input = el('input', { type: 'text', value: f.value, spellcheck: 'false', ...(listId ? { list: listId } : {}), ...(f.kind === 'addr' ? { placeholder: '0x0000' } : {}) });
      input.addEventListener('input', () => set(input.value));
      if (f.custom) {
        wrap.append(el('datalist', { id: listId }, f.options.map((o) => el('option', { value: o.value, label: o.label }))));
      }
    }
    input.disabled = disabledNow();
    input.dataset.key = f.key;
    wrap.append(input, auto);
    if (f.kind === 'path' || f.path) {
      wrap.append(el('button', { class: 'icon', title: 'Browse for a folder...', text: '...', onclick: () => browse(input.value, (v) => { input.value = v; set(v); }) }));
    }
    return wrap;
  }

  function fieldRow(f) {
    const row = el('div', { class: `row${f.locked ? ' locked' : ''}`, 'data-key': f.key });
    row.append(el('div', { class: 'label', text: f.title }), fieldControl(f));
    row.append(el('div', { class: 'iss-host', 'data-iss': f.key }));
    onField(f, row);
    return row;
  }

  // ---- lists ----------------------------------------------------------------------------------------------------------
  const COLS = {
    list: [{ k: 'value', ph: '' }],
    hook: [{ k: 'ret', ph: 'return type', w: '130px', h: 'Return type' }, { k: 'name', ph: 'hook name', h: 'Hook name' }, { k: 'sig', ph: '(parameters)', w: '200px', h: 'Parameters' }],
    impl: [{ k: 'hook', ph: 'hook name', h: 'Hook name' }, { k: 'symbol', ph: '_function', h: 'Assembler symbol of the function' }],
    child: [{ k: 'name', ph: 'module name', h: 'Module name' }, { k: 'file', ph: 'file (up to 8)', w: '130px', h: 'File name' }, { k: 'ext', ph: 'ext', w: '70px', h: 'Ext.' }],
    usr: [{ k: 'kind', select: ['SYMBOL', 'ADDRESS'], w: '120px', h: 'Kind' }, { k: 'value', ph: '_routine or address', h: 'Routine or address' }],
  };
  const BLANK = { list: () => ({ value: '' }), hook: () => ({ ret: 'void', name: '', sig: '(void)' }), impl: () => ({ hook: '', symbol: '' }), child: () => ({ name: '', file: '', ext: 'MDO' }), usr: () => ({ kind: 'SYMBOL', value: '' }) };

  function move(items, i, d) { const j = i + d; if (j < 0 || j >= items.length) return; [items[i], items[j]] = [items[j], items[i]]; }

  function listSection(l) {
    const sec = el('section', {});
    sec.append(el('h2', { text: l.title }));
    const cols = COLS[l.kind] || COLS.list;
    const body = el('tbody');
    const head = cols.some((c) => c.h) ? el('thead', {}, el('tr', {}, el('td', { class: 'n' }), cols.map((c) => el('td', { class: 'h', text: c.h || '' })), el('td', {}))) : null;
    const draw = () => {
      body.textContent = '';
      l.items.forEach((it, i) => {
        const tr = el('tr', { 'data-key': l.key, 'data-item': String(i) });
        tr.append(el('td', { class: 'n', text: l.kind === 'usr' ? `USR${i}` : '' }));
        for (const c of cols) {
          let inp;
          if (c.select) {
            inp = el('select', {}, c.select.map((o) => el('option', { value: o, text: o, ...(it[c.k] === o ? { selected: true } : {}) })));
            inp.addEventListener('change', () => { it[c.k] = inp.value; changed(); });
          } else {
            inp = el('input', { type: 'text', value: it[c.k] === undefined ? '' : it[c.k], placeholder: c.ph || (l.itemTitle || ''), spellcheck: 'false' });
            inp.addEventListener('input', () => { it[c.k] = inp.value; changed(); });
          }
          const td = el('td', c.w ? { style: `width:${c.w}` } : {}, inp);
          tr.append(td);
        }
        const act = el('td', { class: 'act' },
          l.path ? el('button', { class: 'icon', title: 'Browse...', text: '...', onclick: () => browse(it.value, (v) => { it.value = v; draw(); changed(); }) }) : null,
          el('button', { class: 'icon', title: 'Move up', text: '↑', ...(i === 0 ? { disabled: true } : {}), onclick: () => { move(l.items, i, -1); draw(); changed(); } }),
          el('button', { class: 'icon', title: 'Move down', text: '↓', ...(i === l.items.length - 1 ? { disabled: true } : {}), onclick: () => { move(l.items, i, 1); draw(); changed(); } }),
          el('button', { class: 'icon', title: 'Remove', text: '✕', onclick: () => { l.items.splice(i, 1); draw(); changed(); } }));
        tr.append(act);
        body.append(tr);
        tr.addEventListener('focusin', () => describe(l.title, l.key, l.help));
        tr.addEventListener('mouseenter', () => describe(l.title, l.key, l.help));
      });
      if (!l.items.length) body.append(el('tr', {}, el('td', { class: 'empty', colspan: String(cols.length + 2), text: 'None.' })));
      refreshIssues();
    };
    const add = el('button', { text: `Add ${l.kind === 'usr' ? 'routine' : 'entry'}`, onclick: () => { l.items.push((BLANK[l.kind] || BLANK.list)()); draw(); changed(); } });
    sec.append(el('div', { class: 'sub', text: l.help }), el('table', { class: 'list' }, head, body), el('div', { style: 'margin-top:4px' }, add));
    sec.addEventListener('mouseenter', () => describe(l.title, l.key, l.help));
    draw();
    return sec;
  }

  function otherSection(o) {
    const sec = el('section', {});
    sec.append(el('h2', { text: o.title }), el('div', { class: 'sub', text: o.help }));
    const body = el('tbody');
    const draw = () => {
      body.textContent = '';
      o.items.forEach((it, i) => {
        const k = el('input', { type: 'text', value: it.key, placeholder: 'NAME', spellcheck: 'false' });
        k.addEventListener('input', () => { it.key = k.value; changed(); });
        const v = el('input', { type: 'text', value: it.value, placeholder: 'value (empty = defined)', spellcheck: 'false' });
        v.addEventListener('input', () => { it.value = v.value; changed(); });
        body.append(el('tr', {}, el('td', { class: 'n' }), el('td', { style: 'width:240px' }, k), el('td', {}, v),
          el('td', { class: 'act' }, el('button', { class: 'icon', title: 'Remove', text: '✕', onclick: () => { o.items.splice(i, 1); draw(); changed(); } }))));
      });
      if (!o.items.length) body.append(el('tr', {}, el('td', { class: 'empty', colspan: '4', text: 'None.' })));
    };
    sec.append(el('table', { class: 'list' }, body), el('div', { style: 'margin-top:4px' }, el('button', { text: 'Add definition', onclick: () => { o.items.push({ key: '', value: '' }); draw(); changed(); } })));
    sec.addEventListener('mouseenter', () => describe(o.title, '', o.help));
    draw();
    return sec;
  }

  function entriesSection(p) {
    const sec = el('section', {});
    sec.append(el('h2', { text: p.itemTitle ? `${p.itemTitle}s` : 'Entries' }), el('div', { class: 'sub', text: `${p.help} Tick an entry to switch it on; an unticked entry stays in the file as a comment.` }));
    const body = el('tbody');
    const draw = () => {
      body.textContent = '';
      p.items.forEach((it, i) => {
        const locked = p.lockFirst && i === 0;
        const cb = el('input', { type: 'checkbox', title: locked ? 'The startup code cannot be switched off' : 'On', ...(it.enabled ? { checked: true } : {}), ...(locked ? { disabled: true } : {}) });
        cb.addEventListener('change', () => { it.enabled = cb.checked; tr.className = it.enabled ? '' : 'off'; changed(); });
        const inp = el('input', { type: 'text', value: it.text, spellcheck: 'false', placeholder: p.itemTitle || '' });
        inp.addEventListener('input', () => { it.text = inp.value; changed(); });
        const tr = el('tr', { class: it.enabled ? '' : 'off', 'data-item': String(i) },
          el('td', { class: 'ck' }, cb), el('td', {}, inp),
          el('td', { class: 'act' },
            (p.entry === 'directory') ? el('button', { class: 'icon', title: 'Browse...', text: '...', onclick: () => browse(it.text, (v) => { it.text = v; draw(); changed(); }) }) : null,
            el('button', { class: 'icon', title: 'Move up', text: '↑', ...(i === 0 || (p.lockFirst && i === 1) ? { disabled: true } : {}), onclick: () => { move(p.items, i, -1); draw(); changed(); } }),
            el('button', { class: 'icon', title: 'Move down', text: '↓', ...(i === p.items.length - 1 || locked ? { disabled: true } : {}), onclick: () => { move(p.items, i, 1); draw(); changed(); } }),
            el('button', { class: 'icon', title: 'Remove', text: '✕', ...(locked ? { disabled: true } : {}), onclick: () => { p.items.splice(i, 1); draw(); changed(); } })));
        tr.dataset.row = '1';
        tr.addEventListener('focusin', () => describePage(p));
        body.append(tr);
      });
      if (!p.items.length) body.append(el('tr', {}, el('td', { class: 'empty', colspan: '3', text: 'None.' })));
      refreshIssues();
    };
    sec.append(el('table', { class: 'list' }, body), el('div', { style: 'margin-top:4px' }, el('button', { text: 'Add', onclick: () => { p.items.push({ text: '', enabled: true }); draw(); changed(); } })));
    draw();
    return sec;
  }

  /** a file the template defines and this project lacks: shown with the template's values, created on request or on edit */
  function missingNotice(p) {
    return el('div', { class: 'notice' },
      el('div', {}, el('b', { text: 'This file does not exist in the project yet. ' }), `The page shows the values of the project template. The file is created in the Config folder (and added to the project's Config filter) when you change something here and press Apply or OK, or right now:`),
      el('div', { style: 'margin-top:6px' }, el('button', { class: 'primary', text: 'Create the file now', onclick: () => { setBusy(true); vscode.postMessage({ type: 'save', pages: state.pages, close: false, create: [p.id] }); } })));
  }

  // ---- the page -----------------------------------------------------------------------------------------------------
  function renderPage() {
    const root = $('#page');
    root.textContent = '';
    const p = page();
    if (!p) { root.append(el('div', { class: 'empty', text: 'This project has no configuration files.' })); return; }
    root.append(el('h1', { text: p.title }), el('div', { class: 'filename', text: `Config\\${p.file}` }), el('div', { class: 'blurb', text: p.blurb || '' }), p.missing ? missingNotice(p) : null, el('div', { id: 'issues', hidden: true }));
    for (const g of p.groups || []) {
      if (!g.fields.length && !(g.other)) continue;
      const sec = el('section', {}, el('h2', { text: g.title }));
      for (const f of g.fields) sec.append(fieldRow(f));
      if (g.other) sec.append(otherSection(g.other));
      root.append(sec);
    }
    for (const l of p.lists || []) root.append(listSection(l));
    if (p.other) root.append(otherSection(p.other));
    if (p.items) root.append(entriesSection(p));
    describePage(p);
    refreshIssues();
  }

  // ---- issues ----------------------------------------------------------------------------------------------------------
  function refreshIssues() {
    if (!state) return;
    // index badges
    for (const b of document.querySelectorAll('[data-badges]')) {
      b.textContent = '';
      const mine = issues.filter((i) => i.file === b.dataset.badges);
      const e = mine.filter((i) => i.severity === 'error').length;
      const w = mine.length - e;
      if (e) b.append(el('span', { class: 'badge error', text: String(e), title: `${e} error${e > 1 ? 's' : ''}` }));
      if (w) b.append(el('span', { class: 'badge warning', text: String(w), title: `${w} warning${w > 1 ? 's' : ''}` }));
    }
    const p = page();
    // page box and inline messages
    for (const x of document.querySelectorAll('.iss')) x.remove();
    for (const x of document.querySelectorAll('.bad, .warn')) x.classList.remove('bad', 'warn');
    for (const x of document.querySelectorAll('tr.rowissue, tr.rowerror')) x.classList.remove('rowissue', 'rowerror');
    const box = $('#issues');
    const mine = p ? issues.filter((i) => i.file === p.file) : [];
    if (box) {
      box.textContent = '';
      box.hidden = !mine.length;
      for (const i of mine) {
        box.append(el('div', { class: `msg ${i.severity}` }, el('b', { text: i.severity === 'error' ? 'Error  ' : 'Warning  ' }), i.key ? el('span', { class: 'k', text: `${i.key}: ` }) : null, document.createTextNode(i.message), fixButton(i)));
      }
    }
    for (const i of mine) {
      if (i.key && i.item === undefined) {
        const host = document.querySelector(`[data-iss="${i.key}"]`);
        if (host) {
          host.parentElement.append(el('div', { class: `iss ${i.severity}`, text: i.message }));
          const inp = host.parentElement.querySelector('input[type=text], select');
          if (inp) inp.classList.add(i.severity === 'error' ? 'bad' : 'warn');
        }
      }
      if (i.item !== undefined) {
        const sel2 = i.key ? `tr[data-key="${i.key}"][data-item="${i.item}"]` : `tr[data-item="${i.item}"]`;
        const tr = document.querySelector(sel2);
        if (tr) { tr.classList.add(i.severity === 'error' ? 'rowerror' : 'rowissue'); tr.title = i.message; }
      }
    }
    const errors = issues.filter((i) => i.severity === 'error').length;
    const warnings = issues.length - errors;
    $('#summary').textContent = errors || warnings ? `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'} in the project settings` : 'No problems found';
    $('#summary').className = errors ? 'msg error' : warnings ? 'msg warning' : '';
    $('#ok').disabled = errors > 0;
    $('#apply').disabled = !dirty() || errors > 0;
  }

  /** the quick fix of an issue, where there is one: backslashes of a build event command become "/" */
  function fixButton(i) {
    if (i.fix !== 'slashes') return null;
    return el('button', { class: 'fix', text: 'Fix', onclick: () => {
      const p = state.pages.find((x) => x.file === i.file);
      const f = p && p.groups.flatMap((g) => g.fields).find((x) => x.key === i.key);
      if (!f) return;
      f.value = f.value.replace(/\\(?=[A-Za-z0-9_.[\]~-]|$)/g, '/');
      renderPage(); changed();
    } });
  }

  function renderAll() { renderIndex(); renderPage(); refreshIssues(); }

  // ---- buttons ----------------------------------------------------------------------------------------------------------
  $('#ok').addEventListener('click', () => { setBusy(true); vscode.postMessage({ type: 'save', pages: state.pages, close: true }); });
  $('#apply').addEventListener('click', () => { setBusy(true); vscode.postMessage({ type: 'save', pages: state.pages, close: false }); });
  $('#cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel', dirty: dirty() }));

  vscode.postMessage({ type: 'ready' });
})();
