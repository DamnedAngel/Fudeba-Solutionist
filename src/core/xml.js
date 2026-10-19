'use strict';
// Minimal position-preserving XML reader. MSBuild files are edited by splicing text (never by
// re-serialising), so every node remembers where it starts and ends in the source; formatting,
// comments and line endings of the user's project files survive an edit untouched.

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENT[e];
  });
}
const encode = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const encodeAttr = (s) => encode(s).replace(/"/g, '&quot;');

/**
 * @typedef {object} XNode
 * @property {string} name
 * @property {Record<string,string>} attrs
 * @property {XNode[]} children
 * @property {string} text      decoded character data directly inside the element
 * @property {number} start     index of '<'
 * @property {number} openEnd   index just after the '>' of the opening tag
 * @property {number} closeStart index of '</' (or -1 when self-closing)
 * @property {number} end       index just after the whole element
 * @property {boolean} selfClosing
 * @property {XNode|null} parent
 */

/** @returns {XNode} a synthetic '#document' node whose children are the top-level elements */
function parseXml(src) {
  const n = src.length;
  const root = { name: '#document', attrs: {}, children: [], text: '', start: 0, openEnd: 0, closeStart: n, end: n, selfClosing: false, parent: null };
  let cur = root;
  let i = src.charCodeAt(0) === 0xFEFF ? 1 : 0;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i) cur.text += decode(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
    if (src.startsWith('<![CDATA[', lt)) { const e = src.indexOf(']]>', lt); cur.text += src.slice(lt + 9, e < 0 ? n : e); i = e < 0 ? n : e + 3; continue; }
    if (src.startsWith('<?', lt)) { const e = src.indexOf('?>', lt); i = e < 0 ? n : e + 2; continue; }
    if (src.startsWith('<!', lt)) { const e = src.indexOf('>', lt); i = e < 0 ? n : e + 1; continue; }
    if (src[lt + 1] === '/') {
      const gt = src.indexOf('>', lt);
      if (cur.parent) { cur.closeStart = lt; cur.end = gt < 0 ? n : gt + 1; cur = cur.parent; }
      i = gt < 0 ? n : gt + 1;
      continue;
    }
    // opening tag
    let j = lt + 1;
    while (j < n && !/[\s/>]/.test(src[j])) j++;
    const node = { name: src.slice(lt + 1, j), attrs: {}, children: [], text: '', start: lt, openEnd: 0, closeStart: -1, end: 0, selfClosing: false, parent: cur };
    for (;;) {
      while (j < n && /\s/.test(src[j])) j++;
      if (j >= n) break;
      if (src[j] === '/') { node.selfClosing = true; j++; continue; }
      if (src[j] === '>') { j++; break; }
      const a = j;
      while (j < n && !/[\s=/>]/.test(src[j])) j++;
      const an = src.slice(a, j);
      while (j < n && /\s/.test(src[j])) j++;
      let av = '';
      if (src[j] === '=') {
        j++;
        while (j < n && /\s/.test(src[j])) j++;
        const q = src[j];
        if (q === '"' || q === "'") { const e = src.indexOf(q, j + 1); av = src.slice(j + 1, e < 0 ? n : e); j = e < 0 ? n : e + 1; }
      }
      node.attrs[an] = decode(av);
    }
    node.openEnd = j;
    cur.children.push(node);
    if (node.selfClosing) { node.end = j; node.closeStart = -1; } else cur = node;
    i = j;
  }
  return root;
}

const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
/** child elements by (case-insensitive) name; no name = all */
const kids = (node, name) => (name ? node.children.filter((c) => eq(c.name, name)) : node.children);
const kid = (node, name) => kids(node, name)[0];
const attr = (node, name) => {
  if (name in node.attrs) return node.attrs[name];
  const k = Object.keys(node.attrs).find((a) => eq(a, name));
  return k === undefined ? undefined : node.attrs[k];
};
const value = (node) => (node ? node.text.trim() : '');

module.exports = { parseXml, decode, encode, encodeAttr, kids, kid, attr, value, eq };
