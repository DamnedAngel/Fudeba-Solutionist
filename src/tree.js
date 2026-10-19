'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { projectsOf, dependencySources, configLabel } = require('./core/model');
const { commandFor } = require('./core/build');
const { msxProjectType } = require('./core/msx');

const ACTIONS = [['build', 'Build'], ['rebuild', 'Rebuild'], ['clean', 'Clean']];
const MIME = 'application/vnd.code.tree.fudebasolutionist';
const SCM_TEXT = { in: 'Checked in (no changes)', mod: 'Changed (pending changes)', add: 'New (not yet in source control)' };

const byLabel = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });

/**
 * Virtual folder tree of a project: the .filters hierarchy when there is one, otherwise the folders on disk.
 * @returns {{children: Map, files: object[], full: string}}
 */
function fileTree(pd) {
  const root = { children: new Map(), files: [], full: '' };
  const hasFilters = !!pd.filtersFile;
  const descend = (segs) => {
    let n = root;
    for (const s of segs) {
      const key = s.toLowerCase();
      if (!n.children.has(key)) n.children.set(key, { name: s, children: new Map(), files: [], full: n.full ? `${n.full}\\${s}` : s });
      n = n.children.get(key);
    }
    return n;
  };
  if (hasFilters) for (const f of pd.filters) descend(f.split('\\'));
  for (const it of pd.items) {
    let segs;
    if (hasFilters) segs = it.filter ? it.filter.split('\\') : [];
    else segs = it.include.split(/[\\/]/).slice(0, -1).filter((s) => s && s !== '..' && s !== '.');
    descend(segs).files.push(it);
  }
  return root;
}

class SolutionTree {
  /** @param {import('./controller').Controller} ctl */
  constructor(ctl) {
    this.ctl = ctl;
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
    this.dragMimeTypes = [MIME];
    this.dropMimeTypes = [MIME];
    this.cache = new Map();
  }

  refresh() { this.cache.clear(); this._emitter.fire(); }

  getParent(node) { return node.parent || undefined; }

  getChildren(node) {
    const ctl = this.ctl;
    if (!ctl.model) return [];
    if (!node) return [this.configNode(), this.solutionNode()];
    return node.children ? node.children() : [];
  }

  getTreeItem(node) { return node.item; }

  // ---- node builders ------------------------------------------------------------------------

  make(node, label, state, extra = {}) {
    const item = new vscode.TreeItem(label, state);
    item.id = node.id;
    item.contextValue = node.kind;
    Object.assign(item, extra);
    node.item = item;
    this.cache.set(node.id, node);
    return node;
  }

  /** Top row: the active solution configuration; clicking it opens the picker (a tree has no real dropdown). */
  configNode() {
    const m = this.ctl.model;
    const node = { kind: 'config', id: 'cfg', parent: null };
    return this.make(node, `Configuration: ${configLabel(m.sol, m.config) || 'none'}`, vscode.TreeItemCollapsibleState.None, {
      description: `${m.sol.configs.length} available  ▾`,
      iconPath: new vscode.ThemeIcon('layers'),
      tooltip: 'Solution configuration: decides which project configuration every build action uses. Click to change.',
      command: { command: 'fudebaSolutionist.selectConfiguration', title: 'Select Solution Configuration' },
    });
  }

  solutionNode() {
    const m = this.ctl.model;
    const projects = projectsOf(m);
    // the Aleste ship when the solution has an MSX project (ROM, COM, BIN or MDO), the plain icon otherwise
    const hasMsx = projects.some((e) => e.data.exists && e.data.kind === 'makefile' && msxProjectType(e.data));
    const node = { kind: 'solution', id: `sln:${m.sol.file}`, file: m.sol.file, parent: null, iconKey: hasMsx ? 'solution.msx' : 'solution' };
    node.children = () => this.folderChildren(node, null);
    return this.make(node, `Solution '${m.sol.name}'`, vscode.TreeItemCollapsibleState.Expanded, {
      description: `${projects.length} project${projects.length === 1 ? '' : 's'}${m.config ? `  ·  ${configLabel(m.sol, m.config)}` : ''}`,
      iconPath: this.ctl.icons.get(node.iconKey),
      tooltip: m.sol.file,
      resourceUri: vscode.Uri.file(m.sol.file),
    });
  }

  /** Children of the solution (parentId null) or of a solution folder. */
  folderChildren(parent, parentId) {
    const m = this.ctl.model;
    const all = [...m.entries.values()].map((e) => e.sln).filter((p) => (p.parent || null) === parentId);
    const folders = all.filter((p) => p.isFolder).sort(byLabel);
    const projects = all.filter((p) => !p.isFolder).sort(byLabel);
    const out = folders.map((f) => this.solutionFolderNode(f, parent));
    out.push(...projects.map((p) => this.projectNode(p, parent)));
    if (parentId) {
      const f = m.entries.get(parentId).sln;
      for (const rel of f.items) out.push(this.plainFile(`${parentId}:${rel}`, path.resolve(m.sol.dir, rel.replace(/\\/g, '/')), parent, null));
    }
    return out;
  }

  solutionFolderNode(f, parent) {
    const node = { kind: 'solutionFolder', id: `fld:${f.id}`, parent };
    node.children = () => this.folderChildren(node, f.id);
    return this.make(node, f.name, vscode.TreeItemCollapsibleState.Collapsed, { iconPath: this.ctl.icons.get('solutionFolder') });
  }

  /** MSX projects show ROM / COM / BIN / MDO from ApplicationSettings.txt; without it they keep the generic icon. */
  projectIconKey(pd) {
    if (!pd.exists) return 'project.missing';
    const t = pd.kind === 'makefile' ? msxProjectType(pd) : null;
    return t ? `project.${t.label.toLowerCase()}` : `project.${pd.kind}`;
  }

  projectNode(p, parent) {
    const ctl = this.ctl;
    const e = ctl.model.entries.get(p.id);
    const pd = e.data;
    const startup = ctl.startupId === p.id;
    const msxType = pd.exists && pd.kind === 'makefile' ? msxProjectType(pd) : null;
    const iconKey = this.projectIconKey(pd);
    const node = { kind: !pd.exists ? 'projectMissing' : startup ? 'project.startup' : 'project', id: `prj:${p.id}`, projectId: p.id, parent, iconKey, msxType: msxType ? msxType.label : null };
    node.children = () => this.projectChildren(node, e);
    const flags = [];
    if (startup) flags.push('startup');
    if (!e.builds) flags.push(pd.exists ? 'not built in this configuration' : 'missing');
    return this.make(node, p.name, vscode.TreeItemCollapsibleState.Collapsed, {
      // MSX projects get a ".msx" suffix: the settings button of the row is shown only for them
      contextValue: msxType ? `${node.kind}.msx` : node.kind,
      description: flags.join(' · ') || undefined,
      iconPath: this.ctl.icons.get(iconKey, { color: startup ? new vscode.ThemeColor('charts.green') : undefined }),
      tooltip: new vscode.MarkdownString(
        `**${p.name}**  \n${pd.file}  \n\nConfiguration: \`${e.projectConfig || '-'}\`${pd.kind === 'makefile' ? `  \nMakefile project${msxType ? ` · MSX ${msxType.label}` : ''}` : ''}`),
    });
  }

  projectChildren(node, e) {
    const pd = e.data;
    if (!pd.exists) return [];
    const out = [];
    out.push(this.actionsNode(node, e));
    if (e.deps.length) out.push(this.depsNode(node, e));
    out.push(...this.treeChildren(node, e, fileTree(pd), null));
    return out;
  }

  actionsNode(parent, e) {
    const node = { kind: 'actions', id: `act:${e.sln.id}`, parent, projectId: e.sln.id };
    node.children = () => ACTIONS.map(([a, label]) => this.actionNode(node, e, a, label));
    return this.make(node, 'Build Actions', vscode.TreeItemCollapsibleState.Collapsed, {
      iconPath: this.ctl.icons.get('buildActions'), description: e.data.kind === 'makefile' ? configLabel(this.ctl.model.sol, `${e.data.config}|${e.data.platform}`) : e.data.kind,
    });
  }

  actionNode(parent, e, action, label) {
    const c = commandFor(e, action);
    const node = { kind: 'action', id: `act:${e.sln.id}:${action}`, parent, projectId: e.sln.id, action };
    return this.make(node, label, vscode.TreeItemCollapsibleState.None, {
      description: c.command || `(${c.skip})`,
      tooltip: c.command || c.skip,
      iconPath: this.ctl.icons.get(`action.${action}`),
      command: { command: 'fudebaSolutionist.editAction', title: 'Edit', arguments: [node] },
    });
  }

  depsNode(parent, e) {
    const node = { kind: 'deps', id: `dep:${e.sln.id}`, parent, projectId: e.sln.id };
    node.children = () => {
      const m = this.ctl.model;
      const src = dependencySources(m, e.sln.id);
      return e.deps.map((d) => {
        const t = m.entries.get(d);
        const n = { kind: 'dep', id: `dep:${e.sln.id}:${d}`, parent: node, projectId: e.sln.id, depId: d };
        const s = src.get(d);
        return this.make(n, t.sln.name, vscode.TreeItemCollapsibleState.None, {
          iconPath: this.ctl.icons.get(this.projectIconKey(t.data)),
          description: s && s.ref && !s.sln ? 'ProjectReference' : undefined,
          command: { command: 'fudebaSolutionist.reveal', title: 'Reveal', arguments: [d] },
        });
      });
    };
    return this.make(node, 'Dependencies', vscode.TreeItemCollapsibleState.Collapsed, {
      iconPath: this.ctl.icons.get('dependencies'), description: String(e.deps.length),
    });
  }

  /** Filters/folders first (alphabetical), then files (alphabetical). */
  treeChildren(parent, e, t, _) {
    const pd = e.data;
    const isFilter = !!pd.filtersFile;
    const out = [];
    const folders = [...t.children.values()].sort(byLabel);
    for (const f of folders) {
      const node = { kind: isFilter ? 'filter' : 'folder', id: `${isFilter ? 'flt' : 'dir'}:${e.sln.id}:${f.full}`, parent, projectId: e.sln.id, filter: f.full };
      node.children = () => this.treeChildren(node, e, f);
      out.push(this.make(node, f.name, vscode.TreeItemCollapsibleState.Collapsed, { iconPath: this.ctl.icons.get(isFilter ? 'filter' : 'folder') }));
    }
    const files = [...t.files].sort((a, b) => path.basename(a.path).localeCompare(path.basename(b.path), undefined, { sensitivity: 'base', numeric: true }));
    for (const it of files) out.push(this.plainFile(`fil:${e.sln.id}:${it.include}`, it.path, parent, e.sln.id, it));
    return out;
  }

  plainFile(id, file, parent, projectId, item) {
    const node = { kind: 'file', id, parent, projectId, file, include: item ? item.include : null, itemType: item ? item.type : null, filter: item ? item.filter : null };
    const exists = fs.existsSync(file);
    const scm = exists && this.ctl.scm ? this.ctl.scm.status(file) : null;
    return this.make(node, path.basename(file), vscode.TreeItemCollapsibleState.None, {
      resourceUri: vscode.Uri.file(file),
      description: exists ? undefined : '(missing)',
      // C/H/ASM/INC get our sheet icons; other files follow the user's file icon theme (see fudebaSolutionist.fileIcons)
      iconPath: !exists ? this.ctl.icons.get('file.missing') : this.ctl.icons.fileIcon(file, scm),
      tooltip: scm ? `${file}\n${SCM_TEXT[scm]}` : file,
      command: exists ? { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(file)] } : undefined,
    });
  }

  // ---- drag and drop: move files between the filters of a project -----------------------------

  handleDrag(sources, dataTransfer) {
    const files = sources.filter((s) => s.kind === 'file' && s.include && s.projectId);
    if (!files.length) return;
    dataTransfer.set(MIME, new vscode.DataTransferItem(files.map((f) => ({ projectId: f.projectId, include: f.include, type: f.itemType }))));
  }

  async handleDrop(target, dataTransfer) {
    const raw = dataTransfer.get(MIME);
    if (!raw || !target) return;
    const moved = raw.value;
    const pid = target.projectId;
    if (!pid || (target.kind !== 'filter' && !/^project/.test(target.kind))) return;
    if (moved.some((m) => m.projectId !== pid)) { vscode.window.showWarningMessage('Files can only be moved between the filters of the same project.'); return; }
    const entry = this.ctl.model.entries.get(pid);
    if (!entry.data.filtersFile && target.kind === 'filter') return;
    await this.ctl.run(() => {
      const edit = require('./core/edit');
      for (const m of moved) edit.setItemFilter(entry.data.file, m.type, m.include, target.kind === 'filter' ? target.filter : null);
    }, 'Move file');
  }
}

module.exports = { SolutionTree, fileTree, ACTIONS };
