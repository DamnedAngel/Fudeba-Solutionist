'use strict';
const fs = require('fs');
const path = require('path');

/** MSBuild property bag: names are case-insensitive, unknown names fall back to the environment. */
class Props {
  constructor(seed) {
    this.map = new Map();
    if (seed) for (const [k, v] of Object.entries(seed)) this.set(k, v);
  }
  get(name) {
    const k = String(name).toLowerCase();
    if (this.map.has(k)) return this.map.get(k).value;
    const env = Object.keys(process.env).find((e) => e.toLowerCase() === k);
    return env === undefined ? '' : process.env[env];
  }
  has(name) { return this.map.has(String(name).toLowerCase()); }
  set(name, value) { this.map.set(String(name).toLowerCase(), { name, value: String(value) }); }
  clone() { const p = new Props(); for (const [k, v] of this.map) p.map.set(k, { ...v }); return p; }
}

/** Expands $(Name). Property functions $([...]) and item references @(...) are not evaluated. */
function expand(str, props, depth = 0) {
  if (!str || str.indexOf('$(') < 0) return str || '';
  let out = str.replace(/\$\(\[[^)]*\)?[^)]*\)/g, '');
  out = out.replace(/\$\(([A-Za-z_][\w.\-]*)\)/g, (m, name) => props.get(name));
  // values may themselves hold references (set from other files); bounded to stop cycles
  if (depth < 6 && out.indexOf('$(') >= 0 && out !== str) return expand(out, props, depth + 1);
  return out;
}

// ---- Conditions ------------------------------------------------------------------------------

function tokenize(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'" || c === '"') {
      const e = s.indexOf(c, i + 1);
      out.push({ t: 's', v: s.slice(i + 1, e < 0 ? s.length : e) });
      i = e < 0 ? s.length : e + 1;
      continue;
    }
    const two = s.substr(i, 2);
    if (two === '==' || two === '!=' || two === '<=' || two === '>=') { out.push({ t: 'op', v: two }); i += 2; continue; }
    if ('()<>!,'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    let j = i;
    while (j < s.length && !/[\s()<>!=,'"]/.test(s[j])) j++;
    if (j === i) j = i + 1;
    out.push({ t: 'w', v: s.slice(i, j) });
    i = j;
  }
  return out;
}

const num = (v) => (/^\s*-?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN);

/** Evaluates an MSBuild Condition against the current properties; unparseable conditions are true. */
function evalCondition(cond, props, baseDir) {
  if (cond === undefined || cond === null || !String(cond).trim()) return true;
  const toks = tokenize(expand(String(cond), props));
  let p = 0;
  const peek = () => toks[p];
  const isWord = (w) => peek() && peek().t === 'w' && peek().v.toLowerCase() === w;
  const isOp = (o) => peek() && peek().t === 'op' && peek().v === o;

  function truthy(v) {
    const l = String(v).trim().toLowerCase();
    if (l === 'true' || l === 'on' || l === 'yes' || l === '!false') return true;
    return false;
  }
  function primary() {
    const t = peek();
    if (!t) throw new Error('eof');
    if (isOp('(')) { p++; const v = or(); if (!isOp(')')) throw new Error('paren'); p++; return v; }
    if (isOp('!')) { p++; return !truthy(primary()); }
    if (t.t === 'w' && /^(exists|hastrailingslash)$/i.test(t.v) && toks[p + 1] && toks[p + 1].v === '(') {
      p += 2;
      const arg = peek() ? peek().v : '';
      p++;
      if (!isOp(')')) throw new Error('paren');
      p++;
      if (/^exists$/i.test(t.v)) return fs.existsSync(path.resolve(baseDir || '.', arg.replace(/\\/g, path.sep)));
      return /[\\/]$/.test(arg);
    }
    p++;
    return t.v;
  }
  function rel() {
    const l = primary();
    if (peek() && peek().t === 'op' && ['==', '!=', '<', '>', '<=', '>='].includes(peek().v)) {
      const op = peek().v; p++;
      const r = primary();
      const ln = num(String(l)), rn = num(String(r));
      if (op === '==') return String(l).toLowerCase() === String(r).toLowerCase();
      if (op === '!=') return String(l).toLowerCase() !== String(r).toLowerCase();
      if (Number.isNaN(ln) || Number.isNaN(rn)) return false;
      return op === '<' ? ln < rn : op === '>' ? ln > rn : op === '<=' ? ln <= rn : ln >= rn;
    }
    return l;
  }
  function and() {
    let v = rel();
    while (isWord('and')) { p++; const r = rel(); v = truthy(v) && truthy(r); }
    return v;
  }
  function or() {
    let v = and();
    while (isWord('or')) { p++; const r = and(); v = truthy(v) || truthy(r); }
    return v;
  }
  try {
    const v = or();
    return p >= toks.length ? truthy(v) : true;
  } catch {
    return true;
  }
}

module.exports = { Props, expand, evalCondition };
