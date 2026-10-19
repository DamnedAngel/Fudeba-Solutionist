'use strict';
// Source control status of a file as shown in the tree, independent of VS Code.
//   'in'   tracked and unchanged (Visual Studio's padlock: "checked in")
//   'mod'  changed in the working tree or the index (Visual Studio's red check mark: "checked out"/pending change)
//   'add'  new: untracked or added (Visual Studio's plus)
//   null   not under source control, ignored, or unknown

/** Status codes of the VS Code git extension API (vscode.git, enum Status). */
const GIT = {
  INDEX_MODIFIED: 0, INDEX_ADDED: 1, INDEX_DELETED: 2, INDEX_RENAMED: 3, INDEX_COPIED: 4,
  MODIFIED: 5, DELETED: 6, UNTRACKED: 7, IGNORED: 8, INTENT_TO_ADD: 9, INTENT_TO_RENAME: 10, TYPE_CHANGED: 11,
};

/** @param {number} code a git extension Status @returns {'mod'|'add'|null} */
function classify(code) {
  switch (code) {
    case GIT.IGNORED: return null;
    case GIT.UNTRACKED: case GIT.INDEX_ADDED: case GIT.INTENT_TO_ADD: return 'add';
    default: return 'mod'; // modified, deleted, renamed, copied, type changed and every kind of conflict
  }
}

/** When a file has several entries (staged and unstaged), a change beats an addition. */
const merge = (a, b) => (a === 'mod' || b === 'mod' ? 'mod' : a || b);

const key = (p) => p.replace(/\\/g, '/').toLowerCase();

/** Index of changes of one repository: normalised path -> 'mod' | 'add'. */
function indexChanges(lists) {
  const m = new Map();
  for (const list of lists) {
    for (const c of list || []) {
      const s = classify(c.status);
      if (s) m.set(key(c.uri.fsPath), merge(m.get(key(c.uri.fsPath)), s));
    }
  }
  return m;
}

const inside = (root, file) => {
  const r = key(root).replace(/\/$/, '');
  const f = key(file);
  return f === r || f.startsWith(`${r}/`);
};

module.exports = { GIT, classify, merge, indexChanges, inside, key };
