'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { crashCode } = require('./diagnostics');

// When sdasz80 dies without a message there is no line number to go by. Assembling the first K lines of the file for
// growing K and looking for the smallest K that still crashes finds the line that triggers it (the assembler reads
// line by line, so the crash happens as soon as the offending line is in). Includes keep working because the temp
// copy is written next to the original and run from the same folder with the original's options.

/**
 * Splits a command line into raw tokens, keeping quotes in place: make.py writes options like -I"my dir" with the
 * quotes inside the token, and those must survive a re-render unchanged.
 */
function tokenize(cmd) {
  return cmd.match(/(?:[^\s"]|"[^"]*")+/g) || [];
}
const unquote = (t) => t.replace(/"/g, '');
const render = (toks) => toks.join(' ');

const isCrash = (r) => !!r && (r.signal ? true : r.status !== null && !!crashCode(r.status));

/**
 * @param {{command:string, cwd:string, sourceFile:string, run?:Function, timeout?:number}} o
 * @returns {{found:boolean, line?:number, text?:string, reason?:string, runs:number}}
 */
function findCrashingLine(o) {
  const toks = tokenize(o.command);
  const srcIdx = toks.map((t, i) => [t, i]).reverse().find(([t]) => /\.(s|asm)$/i.test(unquote(t)));
  if (!srcIdx) return { found: false, reason: 'The command line has no assembler source file.', runs: 0 };
  const srcTok = srcIdx[1];
  const outIdx = toks.findIndex((t, i) => t === '-o' && toks[i + 1]);
  const lines = fs.readFileSync(o.sourceFile, 'utf8').split(/\r?\n/);
  const dir = path.dirname(o.sourceFile);
  const stamp = `slnx-bisect-${process.pid}`;
  const tmpSrc = path.join(dir, `${stamp}${path.extname(o.sourceFile)}`);
  const tmpOut = path.join(os.tmpdir(), `${stamp}.rel`);
  const run = o.run || ((cmd, cwd) => spawnSync(cmd, { cwd, shell: true, windowsHide: true, timeout: o.timeout || 20000, encoding: 'utf8' }));
  let runs = 0;

  const attempt = (k) => {
    fs.writeFileSync(tmpSrc, lines.slice(0, k).join('\n') + '\n');
    const t = [...toks];
    t[srcTok] = `"${tmpSrc}"`;
    if (outIdx >= 0) t[outIdx + 1] = `"${tmpOut}"`;
    runs++;
    return isCrash(run(render(t), o.cwd));
  };
  const cleanup = () => {
    for (const f of fs.readdirSync(dir)) if (f.startsWith(stamp)) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* best effort */ } }
    try { fs.unlinkSync(tmpOut); } catch { /* best effort */ }
  };

  try {
    if (!attempt(lines.length)) return { found: false, reason: 'The assembler no longer crashes on this file (it may depend on another file or on the build state).', runs };
    let lo = 1, hi = lines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (attempt(mid)) hi = mid; else lo = mid + 1;
    }
    return { found: true, line: lo, text: lines[lo - 1], runs };
  } finally { cleanup(); }
}

module.exports = { findCrashingLine, tokenize };
