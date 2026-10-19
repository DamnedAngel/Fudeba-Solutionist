'use strict';
// Cross-platform path helpers. Solutions and projects written on Windows use backslashes and refer to files
// without regard to case; on Linux both have to be reconciled with the real file system.
const fs = require('fs');
const path = require('path');

const isWin = process.platform === 'win32';
/** Backslash path from a project/solution file -> native path. */
const native = (p) => (isWin ? p.replace(/\//g, '\\') : p.replace(/\\/g, '/'));

/**
 * Resolves `p` against the file system ignoring case where the platform's file system is case-sensitive.
 * Returns `p` unchanged when it exists, or when nothing matches (callers decide what a missing file means).
 */
function resolveInsensitive(p) {
  if (isWin || fs.existsSync(p)) return p;
  const abs = path.resolve(p);
  const parts = abs.split(path.sep).filter(Boolean);
  let cur = path.sep;
  for (const part of parts) {
    const next = path.join(cur, part);
    if (fs.existsSync(next)) { cur = next; continue; }
    let match;
    try { match = fs.readdirSync(cur).find((n) => n.toLowerCase() === part.toLowerCase()); } catch { return p; }
    if (!match) return p;
    cur = path.join(cur, match);
  }
  return cur;
}

/** Resolves an item/project path written inside a project or solution file, relative to `dir`. */
const resolveIn = (dir, rel) => resolveInsensitive(path.resolve(dir, native(rel)));

module.exports = { isWin, native, resolveInsensitive, resolveIn };
