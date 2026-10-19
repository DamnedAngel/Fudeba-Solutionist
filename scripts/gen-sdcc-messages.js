'use strict';
// Builds src/core/data/sdcc-messages.json from SDCC's sources: the number SDCC prints ("error 20",
// "warning 196") is the explicit value of the E_/W_ constant in SDCCerr.h; the text and severity come from the
// ErrTab entry of the same name in SDCCerr.c. Numbering changes between releases: use the files of the release
// in use (svn revision 14184 = SDCC 4.3.0):
//   https://sourceforge.net/p/sdcc/code/<rev>/tree/trunk/sdcc/src/SDCCerr.{h,c}?format=raw
//   node scripts/gen-sdcc-messages.js SDCCerr.h SDCCerr.c
const fs = require('fs');
const path = require('path');

const hdr = fs.readFileSync(process.argv[2], 'utf8');
const src = fs.readFileSync(process.argv[3], 'utf8');

const numbers = new Map([...hdr.matchAll(/^\s*([EW]_\w+)\s*=\s*(\d+)\s*,/gm)].map((m) => [m[1], Number(m[2])]));

const start = src.indexOf('ErrTab [] =');
const end = src.indexOf('\n};', start);
const body = src.slice(start, end);
const starts = [...body.matchAll(/^\s*\{\s*([EW]_\w+)\s*,/gm)];
const byName = new Map();
starts.forEach((s, i) => {
  const chunk = body.slice(s.index, i + 1 < starts.length ? starts[i + 1].index : body.length);
  const level = /ERROR_LEVEL_(\w+)/.exec(chunk);
  const lits = [...chunk.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]);
  byName.set(s[1], {
    level: level ? level[1].toLowerCase() : 'error',
    text: lits.join('').replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim(),
  });
});

const out = {};
let missing = 0;
for (const [name, n] of numbers) {
  const t = byName.get(name);
  if (!t) { missing++; continue; }
  out[n] = { name, ...t };
}
const dest = path.join(__dirname, '..', 'src', 'core', 'data', 'sdcc-messages.json');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(out, null, 1));
console.log(`${Object.keys(out).length} messages (${missing} enum names without a table entry) -> ${dest}`);
for (const n of [20, 59, 85, 196]) console.log(n, out[n] && `${out[n].name} ${out[n].level} ${out[n].text}`);
