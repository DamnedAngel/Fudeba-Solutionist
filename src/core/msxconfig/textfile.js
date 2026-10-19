'use strict';
// Line-preserving reader/editor for the MSX templates' Config\*.txt files.
//
// The files are free-form text that people also edit by hand (comments, examples, alignment), so every edit touches
// only the lines it has to: the text of a changed value, a ';' that enables or disables a line, a new line. Everything
// else - comments, blank lines, spacing, end-of-line style, BOM - comes out byte for byte as it went in.
//
// Line kinds (the way make.py reads them: a token that starts with ';' starts a comment):
//   blank     nothing
//   section   ".BUILD", ".APPLICATION" ... (TargetConfig files)
//   comment   a ';' line
//   disabled  a commented-out setting or entry: ';' followed directly by a non-space ("  ;CODE_LOC   0x8100")
//   setting   KEY [VALUE ...] [; comment]
const BOM = '﻿';

/** whitespace-separated tokens of `raw` from index `from`, with their spans */
function tokens(raw, from = 0) {
  const re = /\S+/g;
  re.lastIndex = from;
  const out = [];
  for (let m = re.exec(raw); m; m = re.exec(raw)) out.push({ t: m[0], s: m.index, e: m.index + m[0].length });
  return out;
}

/** KEY VALUE... ; comment, starting at index `from` (after the ';' of a disabled line) */
function parseSetting(raw, from) {
  const toks = tokens(raw, from);
  if (!toks.length) return {};
  const val = [];
  let commentAt = -1;
  for (const k of toks.slice(1)) {
    if (k.t[0] === ';') { commentAt = k.s; break; }
    val.push(k);
  }
  const first = toks[0];
  // the key itself may carry a trailing ';' comment (a bare key followed by "; text" has it as its own token)
  return {
    key: first.t, keyStart: first.s, keyEnd: first.e,
    value: val.map((v) => v.t).join(' '),
    valStart: val.length ? val[0].s : -1, valEnd: val.length ? val[val.length - 1].e : -1,
    commentAt,
  };
}

function parseLine(raw) {
  if (/^\s*$/.test(raw)) return { raw, kind: 'blank' };
  const sec = /^\s*(\.[A-Za-z_]+)\s*(;.*)?$/.exec(raw);
  if (sec) return { raw, kind: 'section', name: sec[1].toUpperCase() };
  const dis = /^(\s*);([^\s;=-].*)$/.exec(raw);
  if (dis) return { raw, kind: 'disabled', semi: dis[1].length, ...parseSetting(raw, dis[1].length + 1) };
  if (/^\s*;/.test(raw)) return { raw, kind: 'comment' };
  return { raw, kind: 'setting', ...parseSetting(raw, 0) };
}

/** @returns {{bom:boolean, eol:string, lines:object[]}} each line has `raw` and its own `eol` ('' for the last line without one) */
function load(text) {
  const bom = text.startsWith(BOM);
  const body = bom ? text.slice(1) : text;
  const parts = body.split(/(\r?\n)/);
  const lines = [];
  for (let i = 0; i < parts.length; i += 2) {
    const raw = parts[i];
    const eol = parts[i + 1] || '';
    if (i + 1 >= parts.length && raw === '') break; // the empty piece after a final newline
    lines.push({ ...parseLine(raw), eol });
  }
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  return { bom, eol, lines };
}

function save(doc) {
  return (doc.bom ? BOM : '') + doc.lines.map((l) => l.raw + l.eol).join('');
}

const reparse = (doc, i, raw) => { doc.lines[i] = { ...parseLine(raw), eol: doc.lines[i].eol }; };

/** A new line goes in with the document's end-of-line; the previous last line gets one if it had none. */
function insertAt(doc, index, raw) {
  if (index < doc.lines.length || index === 0) { doc.lines.splice(index, 0, { ...parseLine(raw), eol: doc.eol }); return; }
  // appended after the last line: the file keeps ending the way it did (with or without a final newline)
  const prev = doc.lines[index - 1];
  const finalEol = prev.eol;
  prev.eol = prev.eol || doc.eol;
  doc.lines.push({ ...parseLine(raw), eol: finalEol });
}

/** index range [start, end) of a section's lines (after its ".NAME" line), or the whole file when `name` is empty */
function sectionRange(doc, name) {
  if (!name) return [0, doc.lines.length];
  const up = name.toUpperCase();
  const at = doc.lines.findIndex((l) => l.kind === 'section' && l.name === up);
  if (at < 0) return null;
  let end = doc.lines.length;
  for (let i = at + 1; i < doc.lines.length; i++) if (doc.lines[i].kind === 'section') { end = i; break; }
  return [at + 1, end];
}

/** where a new line goes: after the last non-blank line of the range */
function appendPoint(doc, range) {
  let i = range[1];
  while (i > range[0] && doc.lines[i - 1].kind === 'blank') i--;
  return i;
}

const sameKey = (l, key) => l.key === key;

/** active lines of `key` in a section ('' = whole file) */
function settings(doc, key, section = '') {
  const r = sectionRange(doc, section);
  if (!r) return [];
  const out = [];
  for (let i = r[0]; i < r[1]; i++) if (doc.lines[i].kind === 'setting' && sameKey(doc.lines[i], key)) out.push(i);
  return out;
}

function disabledLines(doc, key, section = '') {
  const r = sectionRange(doc, section);
  if (!r) return [];
  const out = [];
  for (let i = r[0]; i < r[1]; i++) if (doc.lines[i].kind === 'disabled' && sameKey(doc.lines[i], key)) out.push(i);
  return out;
}

/** the value of the first active line of `key`, or undefined */
function get(doc, key, section = '') {
  const [i] = settings(doc, key, section);
  return i === undefined ? undefined : doc.lines[i].value;
}

/** raw text of the value (spacing intact), for values where it matters */
function getRaw(doc, key, section = '') {
  const [i] = settings(doc, key, section);
  if (i === undefined) return undefined;
  const l = doc.lines[i];
  return l.valStart < 0 ? '' : l.raw.slice(l.valStart, l.valEnd);
}

function rewriteValue(line, value) {
  const raw = line.raw;
  if (line.valStart < 0) {
    // "KEY" or "KEY   ; comment": put the value after the key
    const at = line.keyEnd;
    const rest = raw.slice(at);
    return value === '' ? raw : `${raw.slice(0, at)}\t${value}${/^\s*;/.test(rest) ? rest : rest.replace(/^\s+/, '')}`;
  }
  if (value === '') return raw.slice(0, line.valStart) + raw.slice(line.valEnd);
  return raw.slice(0, line.valStart) + value + raw.slice(line.valEnd);
}

/**
 * Sets `key` to `value` ('' = a key without value). An active line is rewritten in place; a commented-out line of the
 * key is switched on; otherwise a new line goes to the end of the section.
 */
function set(doc, key, value, section = '') {
  const [i] = settings(doc, key, section);
  if (i !== undefined) {
    if (doc.lines[i].value === value) return false;
    reparse(doc, i, rewriteValue(doc.lines[i], value));
    return true;
  }
  const [d] = disabledLines(doc, key, section);
  if (d !== undefined) {
    const l = doc.lines[d];
    reparse(doc, d, l.raw.slice(0, l.semi) + l.raw.slice(l.semi + 1));
    const l2 = doc.lines[d];
    if (l2.value !== value) reparse(doc, d, rewriteValue(l2, value));
    return true;
  }
  const r = sectionRange(doc, section);
  if (!r) {
    // missing section: add it at the end
    if (doc.lines.length && doc.lines[doc.lines.length - 1].kind !== 'blank') insertAt(doc, doc.lines.length, '');
    insertAt(doc, doc.lines.length, section.toUpperCase());
    insertAt(doc, doc.lines.length, value === '' ? key : `${key}\t\t\t${value}`);
    return true;
  }
  insertAt(doc, appendPoint(doc, r), value === '' ? key : `${key}\t\t\t${value}`);
  return true;
}

/** Comments the line of `key` out (an optional setting that goes back to "automatic"). */
function disable(doc, key, section = '') {
  const [i] = settings(doc, key, section);
  if (i === undefined) return false;
  const l = doc.lines[i];
  reparse(doc, i, `${l.raw.slice(0, l.keyStart)};${l.raw.slice(l.keyStart)}`);
  return true;
}

/**
 * The active lines of a repeatable key (CALL_STATEMENT, MDO_HOOK ...) become `values`: line i keeps its place and
 * its trailing comment, extra lines are removed, extra values are added after the last one.
 */
function setList(doc, key, values, section = '') {
  const idx = settings(doc, key, section);
  let changed = false;
  const n = Math.min(idx.length, values.length);
  for (let k = 0; k < n; k++) {
    if (doc.lines[idx[k]].value !== values[k]) { reparse(doc, idx[k], rewriteValue(doc.lines[idx[k]], values[k])); changed = true; }
  }
  for (let k = idx.length - 1; k >= values.length; k--) { doc.lines.splice(idx[k], 1); changed = true; }
  if (values.length > idx.length) {
    const last = idx.length ? idx[Math.min(idx.length, values.length) - 1] : -1;
    let at;
    if (last >= 0) at = last + 1;
    else { const r = sectionRange(doc, section); at = r ? appendPoint(doc, r) : doc.lines.length; }
    for (const v of values.slice(idx.length)) { insertAt(doc, at++, `${key}\t\t\t${v}`); changed = true; }
  }
  return changed;
}

/**
 * Like setList, for lines of different keys that form one list (SYMBOL and ADDRESS entries of a BIN's USR table, or
 * every key that is not otherwise known): `pred(key)` selects the lines, `items` are {key, value}.
 */
function setKeyedList(doc, pred, items, section = '') {
  const r = sectionRange(doc, section) || [0, doc.lines.length];
  const idx = [];
  for (let i = r[0]; i < r[1]; i++) if (doc.lines[i].kind === 'setting' && pred(doc.lines[i].key)) idx.push(i);
  let changed = false;
  const n = Math.min(idx.length, items.length);
  for (let k = 0; k < n; k++) {
    let l = doc.lines[idx[k]];
    if (l.key === items[k].key && l.value === items[k].value) continue;
    if (l.key !== items[k].key) { reparse(doc, idx[k], l.raw.slice(0, l.keyStart) + items[k].key + l.raw.slice(l.keyEnd)); l = doc.lines[idx[k]]; }
    if (l.value !== items[k].value) reparse(doc, idx[k], rewriteValue(l, items[k].value));
    changed = true;
  }
  for (let k = idx.length - 1; k >= items.length; k--) { doc.lines.splice(idx[k], 1); changed = true; }
  if (items.length > idx.length) {
    let at = n > 0 ? idx[n - 1] + 1 : appendPoint(doc, section ? sectionRange(doc, section) || [0, doc.lines.length] : [0, doc.lines.length]);
    for (const it of items.slice(idx.length)) { insertAt(doc, at++, it.value === '' ? it.key : `${it.key}\t\t\t${it.value}`); changed = true; }
  }
  return changed;
}

// ---- entry files: one entry per line (a path, a regular expression ...) -------------------------------------------

/** text before the first ';' (spaces allowed inside: it is a whole path), and the trailing comment with the gap before it */
function entryParts(raw, from) {
  const body = raw.slice(from);
  const cut = body.indexOf(';');
  const text = (cut < 0 ? body : body.slice(0, cut)).trim();
  const trail = cut < 0 ? '' : body.slice(cut);
  const gap = cut < 0 ? '' : /\s*$/.exec(body.slice(0, cut))[0];
  return { text, trail, gap };
}

/** @returns {{text:string, enabled:boolean, line:number}[]} active and commented-out entries, in file order */
function entries(doc) {
  const out = [];
  doc.lines.forEach((l, line) => {
    if (l.kind === 'setting') out.push({ ...pick(entryParts(l.raw, 0)), enabled: true, line });
    else if (l.kind === 'disabled') out.push({ ...pick(entryParts(l.raw, l.semi + 1)), enabled: false, line });
  });
  return out.filter((e) => e.text);
}
const pick = (p) => ({ text: p.text });

/**
 * Applies a new ordered entry list. Entry i takes the line of the old entry i (so comments around entries stay put and
 * unchanged entries are not touched); lines of removed entries are deleted, new entries go after the last one.
 */
function setEntries(doc, items) {
  const slots = entries(doc);
  let changed = false;
  const lineOf = (s) => doc.lines[s.line];
  const render = (slot, item) => {
    const l = lineOf(slot);
    const from = l.kind === 'disabled' ? l.semi + 1 : 0;
    const p = entryParts(l.raw, from);
    const lead = /^\s*/.exec(l.raw)[0];
    return `${lead}${item.enabled ? '' : ';'}${item.text}${p.trail ? (p.gap || ' ') + p.trail : ''}`;
  };
  const n = Math.min(slots.length, items.length);
  for (let k = 0; k < n; k++) {
    if (slots[k].text === items[k].text && slots[k].enabled === items[k].enabled) continue;
    reparse(doc, slots[k].line, render(slots[k], items[k]));
    changed = true;
  }
  for (let k = slots.length - 1; k >= items.length; k--) { doc.lines.splice(slots[k].line, 1); changed = true; }
  if (items.length > slots.length) {
    const lastSlot = n > 0 ? slots[n - 1].line : -1;
    let at = lastSlot >= 0 ? lastSlot + 1 : appendPoint(doc, [0, doc.lines.length]);
    for (const it of items.slice(slots.length)) { insertAt(doc, at++, `${it.enabled ? '' : ';'}${it.text}`); changed = true; }
  }
  return changed;
}

module.exports = { load, save, get, getRaw, set, disable, setList, setKeyedList, settings, disabledLines, entries, setEntries, parseLine, tokens };
