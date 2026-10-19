'use strict';
const vscode = require('vscode');
const { indexChanges, inside, key } = require('./core/scm');

/**
 * Source control status of the files in the tree, taken from VS Code's built-in git extension (any git
 * repository: GitHub, GitLab, local ...). Status('file') answers synchronously from a cache that is refreshed when a
 * repository changes; ignored files are looked up lazily with `git check-ignore`, so they never show as checked in.
 */
class Scm {
  constructor(context) {
    this._changed = new vscode.EventEmitter();
    this.onChanged = this._changed.event;
    this.repos = new Map();     // repository -> { root, changes: Map }
    this.ignored = new Map();   // normalised path -> boolean
    this.queue = new Map();     // repository -> Set(paths) waiting for check-ignore
    this.api = null;
    context.subscriptions.push(this._changed, { dispose: () => this.subs.forEach((d) => d.dispose()) });
    this.subs = [];
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('slnExplorer.sourceControl')) this._changed.fire(); }, null, this.subs);
    this.start().catch(() => { /* no git extension: the tree simply shows no status */ });
  }

  get enabled() { return vscode.workspace.getConfiguration('slnExplorer').get('sourceControl.icons') !== false; }

  async start() {
    const ext = vscode.extensions.getExtension('vscode.git');
    if (!ext) return;
    const exp = ext.isActive ? ext.exports : await ext.activate();
    if (!exp || !exp.enabled) {
      if (exp && exp.onDidChangeEnablement) exp.onDidChangeEnablement((on) => { if (on) this.start().catch(() => {}); }, null, this.subs);
      return;
    }
    this.api = exp.getAPI(1);
    this.api.onDidOpenRepository((r) => this.watch(r), null, this.subs);
    this.api.onDidCloseRepository((r) => { this.repos.delete(r); this._changed.fire(); }, null, this.subs);
    for (const r of this.api.repositories) this.watch(r);
  }

  watch(repo) {
    const refresh = () => {
      this.repos.set(repo, { root: repo.rootUri.fsPath, changes: indexChanges([repo.state.workingTreeChanges, repo.state.indexChanges, repo.state.mergeChanges, repo.state.untrackedChanges]) });
      clearTimeout(this._t);
      this._t = setTimeout(() => this._changed.fire(), 150);
    };
    refresh();
    repo.state.onDidChange(refresh, null, this.subs);
  }

  /** Forget what was learned about ignored files (the solution was reloaded). */
  reset() { this.ignored.clear(); }

  /** @returns {'in'|'mod'|'add'|null} */
  status(file) {
    if (!this.enabled || !this.api) return null;
    const k = key(file);
    for (const [repo, info] of this.repos) {
      if (!inside(info.root, file)) continue;
      const c = info.changes.get(k);
      if (c) return c;
      if (this.ignored.has(k)) return this.ignored.get(k) ? null : 'in';
      this.ask(repo, file, k);
      return null; // unknown until check-ignore answers; the tree is refreshed then
    }
    return null;
  }

  ask(repo, file, k) {
    if (typeof repo.checkIgnore !== 'function') { this.ignored.set(k, false); return; }
    let q = this.queue.get(repo);
    if (!q) { q = new Map(); this.queue.set(repo, q); }
    if (q.has(k)) return;
    q.set(k, file);
    clearTimeout(this._q);
    this._q = setTimeout(() => this.flush(), 60);
  }

  async flush() {
    const queue = this.queue;
    this.queue = new Map();
    for (const [repo, q] of queue) {
      const files = [...q.values()];
      for (let i = 0; i < files.length; i += 100) {
        const chunk = files.slice(i, i + 100);
        let ignoredSet = new Set();
        try { ignoredSet = await repo.checkIgnore(chunk); } catch { /* treat as not ignored */ }
        const ig = new Set([...ignoredSet].map(key));
        for (const f of chunk) this.ignored.set(key(f), ig.has(key(f)));
      }
    }
    this._changed.fire();
  }
}

module.exports = { Scm };
