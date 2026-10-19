'use strict';
// The editable model of a project's configuration files: what the dialog shows (built from the text files and the
// schema) and how an edited model is written back (only what changed, through textfile.js).
const fs = require('fs');
const path = require('path');
const tf = require('./textfile');
const { pagesFor, appliesTo } = require('./schema');

const clone = (x) => JSON.parse(JSON.stringify(x));
const norm = (v) => String(v == null ? '' : v);

/** raw (spacing intact) value text of an active line */
const rawOf = (doc, i) => { const l = doc.lines[i]; return l.valStart < 0 ? '' : l.raw.slice(l.valStart, l.valEnd); };

// ---- list item conversion ------------------------------------------------------------------------------------------

const CHILD = /^(\S+)\s+\^\/(.*?)\/\s+(?:\^\/(.*?)\/|(\S+))$/;
const KINDS = {
  list: {
    parse: (raw) => ({ value: raw }),
    format: (it) => it.value,
    blank: () => ({ value: '' }),
  },
  hook: {
    parse: (raw) => { const [ret = '', name = '', ...sig] = raw.split('|'); return { ret, name, sig: sig.join('|') }; },
    format: (it) => `${it.ret}|${it.name}|${it.sig}`,
    blank: () => ({ ret: 'void', name: '', sig: '(void)' }),
  },
  impl: {
    parse: (raw) => { const [hook = '', ...rest] = raw.split(/\s+/); return { hook, symbol: rest.join(' ') }; },
    format: (it) => `${it.hook}\t\t${it.symbol}`,
    blank: () => ({ hook: '', symbol: '' }),
  },
  child: {
    parse: (raw) => {
      const m = CHILD.exec(raw);
      if (!m) return { raw, name: '', file: '', ext: '' };
      return { name: m[1], file: m[2].replace(/\s+$/, ''), ext: m[3] !== undefined ? m[3].replace(/\s+$/, '') : m[4] };
    },
    format: (it) => (it.raw !== undefined && !it.name && !it.file ? it.raw
      : `${it.name} ^/${it.file.padEnd(8)}/ ${it.ext.length === 3 ? it.ext : `^/${it.ext.padEnd(3)}/`}`),
    blank: () => ({ name: '', file: '', ext: 'MDO' }),
  },
};

// ---- building the model ---------------------------------------------------------------------------------------------

const fieldList = (page, type) => (page.groups || []).filter((g) => appliesTo(g, type)).flatMap((g) => g.fields.map((f) => ({ f, g }))).filter(({ f }) => appliesTo(f, type));
const listDefs = (page, type) => (page.lists || []).filter((l) => appliesTo(l, type));

function fieldModel(doc, f, section, useRaw) {
  const idx = tf.settings(doc, f.key, section)[0];
  const present = idx !== undefined;
  let value = present ? (useRaw ? rawOf(doc, idx) : doc.lines[idx].value) : '';
  const m = { ...f, present };
  if (f.kind === 'flag') {
    if (!present) value = '_OFF';
    else if (value === '') value = '_ON';
    else if (/^_on$/i.test(value)) value = '_ON';
    else if (/^_off$/i.test(value)) value = '_OFF';
  }
  m.value = value;
  // optional settings can be commented out ("automatic"); mandatory ones are simply present
  m.set = f.optional ? present : true;
  if (f.optional && !present) {
    const d = tf.disabledLines(doc, f.key, section)[0];
    if (d !== undefined && doc.lines[d].value !== undefined) m.value = doc.lines[d].value || '';
  }
  return m;
}

function buildList(doc, def, section) {
  const kind = KINDS[def.kind] || KINDS.list;
  if (def.kind === 'usr') {
    const items = [];
    doc.lines.forEach((l, i) => { if (l.kind === 'setting' && (l.key === 'SYMBOL' || l.key === 'ADDRESS')) items.push({ kind: l.key, value: rawOf(doc, i) }); });
    return { ...def, items };
  }
  const items = tf.settings(doc, def.key, section).map((i) => kind.parse(rawOf(doc, i)));
  return { ...def, items };
}

function knownKeys(page, type) {
  const keys = new Set();
  for (const { f } of fieldList(page, type)) keys.add(f.key);
  for (const l of listDefs(page, type)) { keys.add(l.key); if (l.kind === 'usr') { keys.add('SYMBOL'); keys.add('ADDRESS'); } }
  return keys;
}

function buildOther(doc, page, type, group) {
  const def = group ? group.other : page.other;
  if (!def) return undefined;
  const section = group ? group.section : '';
  const known = group ? new Set(group.fields.filter((f) => appliesTo(f, type)).map((f) => f.key)) : knownKeys(page, type);
  const r = [];
  const lines = doc.lines;
  let inSection = !section;
  lines.forEach((l, i) => {
    if (l.kind === 'section') { inSection = l.name === section.toUpperCase(); return; }
    if (l.kind !== 'setting' || !inSection || known.has(l.key)) return;
    r.push({ key: l.key, value: rawOf(doc, i) });
  });
  return { ...def, items: r, section };
}

/** @returns the model of one page (see schema for the shape of groups/lists) */
function buildPage(page, doc, type) {
  const m = { id: page.file, file: page.file, title: page.title, category: page.category, kind: page.kind, blurb: page.blurb, profile: page.profile };
  if (page.missing) m.missing = true;
  if (page.kind === 'settings' || page.kind === 'mdo' || page.kind === 'target' || page.kind === 'events') {
    m.groups = [];
    const groups = page.kind === 'events' ? [{ title: 'Commands', fields: page.fields }] : page.groups;
    for (const g of groups.filter((x) => appliesTo(x, type))) {
      const fields = g.fields.filter((f) => appliesTo(f, type)).map((f) => {
        const fm = fieldModel(doc, f, g.section || '', page.kind === 'events' || f.rawValue);
        if (f.lockedOn && f.lockedOn.includes(type)) fm.locked = true;
        return fm;
      });
      const gm = { title: g.title, section: g.section, fields };
      const other = page.kind === 'target' ? buildOther(doc, page, type, g) : undefined;
      if (other) gm.other = other;
      m.groups.push(gm);
    }
    m.lists = listDefs(page, type).map((d) => buildList(doc, d, ''));
    if (page.kind === 'settings' && page.other) m.other = buildOther(doc, page, type, null);
    if (page.example) m.example = page.example;
  } else {
    m.entry = page.entry;
    m.itemTitle = page.itemTitle;
    m.help = page.help;
    m.lockFirst = !!page.lockFirst;
    m.extensions = page.extensions;
    m.items = tf.entries(doc).map((e) => ({ text: e.text, enabled: e.enabled }));
  }
  return m;
}

// ---- writing it back ---------------------------------------------------------------------------------------------

function applyField(doc, f, section, oldF) {
  if (f.kind === 'readonly' || f.locked) return false;
  const nv = norm(f.value).trim();
  const same = f.set === oldF.set && nv === norm(oldF.value);
  if (same) return false;
  if (f.optional && !f.set) return tf.disable(doc, f.key, section);
  return tf.set(doc, f.key, nv, section);
}

function applyList(doc, nl, ol, section) {
  if (JSON.stringify(nl.items) === JSON.stringify(ol.items)) return false;
  if (nl.kind === 'usr') return tf.setKeyedList(doc, (k) => k === 'SYMBOL' || k === 'ADDRESS', nl.items.map((it) => ({ key: it.kind, value: norm(it.value).trim() })), section);
  const kind = KINDS[nl.kind] || KINDS.list;
  return tf.setList(doc, nl.key, nl.items.map((it) => kind.format(it)).filter((s) => s.trim() !== ''), section);
}

function applyOther(doc, no, oo, known, section) {
  if (!no || JSON.stringify(no.items) === JSON.stringify(oo.items)) return false;
  return tf.setKeyedList(doc, (k) => !known.has(k), no.items.filter((i) => norm(i.key).trim()).map((i) => ({ key: norm(i.key).trim(), value: norm(i.value).trim() })), section);
}

/** Writes the edited page model (`now`) over the document, given the model it was built as (`was`). @returns true when anything changed */
function applyPage(page, doc, now, was, type) {
  let changed = false;
  if (now.groups) {
    now.groups.forEach((g, gi) => {
      const og = was.groups[gi];
      g.fields.forEach((f, fi) => { if (applyField(doc, f, g.section || '', og.fields[fi])) changed = true; });
      if (g.other) {
        const defGroup = page.groups.find((x) => x.title === g.title);
        const known = new Set(defGroup.fields.filter((x) => appliesTo(x, type)).map((x) => x.key));
        if (applyOther(doc, g.other, og.other, known, g.section || '')) changed = true;
      }
    });
    now.lists.forEach((l, li) => { if (applyList(doc, l, was.lists[li], '')) changed = true; });
    if (now.other && applyOther(doc, now.other, was.other, knownKeys(page, type), '')) changed = true;
  } else if (JSON.stringify(now.items) !== JSON.stringify(was.items)) {
    changed = tf.setEntries(doc, now.items.map((i) => ({ text: norm(i.text).trim(), enabled: !!i.enabled })).filter((i) => i.text));
  }
  return changed;
}

// ---- a whole project ---------------------------------------------------------------------------------------------

/**
 * @param {string} projectDir
 * @param {'ROM'|'COM'|'BIN'|'MDO'} type
 * @param {(file:string)=>string|null} [defaults] text of a configuration file the project lacks (from its template); without
 *   it only the files that exist are loaded, with it the pages of the missing ones are loaded too (marked `missing`)
 * @returns {{type:string, dir:string, pages:{page:object, file:string, doc:object, model:object, missing:boolean, text?:string}[]}}
 */
function loadProjectConfig(projectDir, type, defaults) {
  const cfg = path.join(projectDir, 'Config');
  const files = fs.existsSync(cfg) ? fs.readdirSync(cfg).filter((f) => /.txt$/i.test(f)) : [];
  const pages = [];
  for (const page of pagesFor(type, files, typeof defaults === 'function')) {
    if (page.missing) {
      const text = defaults(page.file);
      if (text == null) continue;
      const doc = tf.load(text);
      pages.push({ page, file: path.join(cfg, page.file), doc, text, missing: true, model: buildPage(page, doc, type) });
    } else {
      const file = path.join(cfg, files.find((f) => f.toLowerCase() === page.file.toLowerCase()));
      const doc = tf.load(fs.readFileSync(file, 'utf8'));
      pages.push({ page, file, doc, missing: false, model: buildPage(page, doc, type) });
    }
  }
  return { type, dir: projectDir, pages };
}

/** Converts backslashes to "/" in the commands of the build events page(s). @returns {string[]} the keys that were fixed */
function normalizeEvents(pages) {
  const { fixSlashes } = require('./validate');
  const fixed = [];
  for (const p of pages) {
    if (p.kind !== 'events') continue;
    for (const g of p.groups) {
      for (const f of g.fields) {
        const nv = fixSlashes(f.value);
        if (nv !== f.value) { f.value = nv; fixed.push(f.key); }
      }
    }
  }
  return fixed;
}

/**
 * Writes the edited models (same order and shape as `cfg.pages[i].model`) to disk; only files that changed are rewritten.
 * A missing file is created when its page was edited or its id is in `opt.create`, from the template text.
 * @returns {string[]} the files written; `.created` lists the ones that are new
 */
function saveProjectConfig(cfg, edited, opt = {}) {
  const create = new Set(opt.create || []);
  const written = [];
  written.created = [];
  cfg.pages.forEach((p, i) => {
    if (p.missing) {
      const doc = tf.load(p.text);
      const changed = applyPage(p.page, doc, edited[i], p.model, cfg.type);
      if (!changed && !create.has(p.model.id)) return;
      fs.mkdirSync(path.dirname(p.file), { recursive: true });
      fs.writeFileSync(p.file, tf.save(doc), 'utf8');
      written.push(p.file);
      written.created.push(p.file);
      return;
    }
    const doc = tf.load(fs.readFileSync(p.file, 'utf8')); // re-read: the file may have been edited in the meantime
    if (!applyPage(p.page, doc, edited[i], p.model, cfg.type)) return;
    fs.writeFileSync(p.file, tf.save(doc), 'utf8');
    written.push(p.file);
  });
  return written;
}

module.exports = { normalizeEvents, loadProjectConfig, saveProjectConfig, buildPage, applyPage, KINDS, clone, fieldList, rawOf };
