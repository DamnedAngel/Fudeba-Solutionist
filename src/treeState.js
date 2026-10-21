'use strict';

const KEY = 'fudebaSolutionist.treeState';
const SAVE_DELAY = 300;

/**
 * What the Solution Explorer tree looked like when it was last used: which nodes were expanded and which one was selected,
 * per solution file. Kept in the workspace storage of VS Code (per user, never in the solution, never committed). Nodes are
 * known by their stable ids (see SolutionTree.make), so the state survives projects being added, removed or renamed: an id
 * that no longer exists is ignored.
 */
class TreeState {
  /** @param {import('vscode').Memento} memento workspaceState */
  constructor(memento) {
    this.memento = memento;
    this.file = null;
    this.expanded = new Set();   // only what the user did: a node nobody touched keeps its default
    this.collapsed = new Set();
    this.selected = null;
    this.dirty = false;
    this._timer = null;
  }

  /** Switches to the state saved for a solution (or to none). */
  load(file) {
    if (file === this.file) return;
    this.flush();
    this.file = file;
    const saved = file ? (this.memento.get(KEY) || {})[file] : null;
    this.dirty = false;
    this.expanded = new Set(saved ? saved.expanded : []);
    this.collapsed = new Set(saved ? saved.collapsed || [] : []);
    this.selected = saved ? saved.selected || null : null;
  }

  /** The state of a node whose default is `fallback` ('expanded' | 'collapsed'). */
  isExpanded(id, fallback) {
    if (this.expanded.has(id)) return true;
    if (this.collapsed.has(id)) return false;
    return fallback;
  }

  expand(id) { this.collapsed.delete(id); this.expanded.add(id); this._touch(); }
  collapse(id) { this.expanded.delete(id); this.collapsed.add(id); this._touch(); }
  select(id) { this.selected = id || null; this._touch(); }

  _touch() { this.dirty = true; this._schedule(); }

  _schedule() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), SAVE_DELAY);
  }

  /** Writes the state now (also on deactivation). */
  flush() {
    clearTimeout(this._timer);
    this._timer = null;
    if (!this.file || !this.dirty) return Promise.resolve();
    const all = { ...(this.memento.get(KEY) || {}) };
    all[this.file] = { expanded: [...this.expanded].sort(), collapsed: [...this.collapsed].sort(), selected: this.selected };
    return Promise.resolve(this.memento.update(KEY, all));
  }
}

module.exports = { TreeState, KEY };
