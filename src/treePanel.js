'use strict';
const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VIEW = 'fudebaSolutionist.tree';

/**
 * The Solution Explorer as an editor tab. A side bar view cannot leave the side bar, but an editor tab can be dragged out of the
 * window ("Move Editor into New Window"), so this is a second rendering of the same nodes: the rows come from SolutionTree, the
 * menus from the package.json entries of the view, and the commands receive the very same node objects.
 */
class TreePanel {
  /** @param {vscode.WebviewPanel} [restored] the tab VS Code restored at start; a new tab is made without it */
  constructor(context, ctl, tree, runner, restored) {
    this.context = context;
    this.ctl = ctl;
    this.tree = tree;
    this.runner = runner;
    this.ready = false;
    this.menus = context.extension.packageJSON.contributes.menus;
    this.commands = new Map(context.extension.packageJSON.contributes.commands.map((c) => [c.command, c]));
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    this.panel = restored || vscode.window.createWebviewPanel(TreePanel.TYPE, 'Solution Explorer', vscode.ViewColumn.Active, { enableScripts: true });
    this.panel.webview.options = { enableScripts: true, localResourceRoots: [media, ...this.iconRoots()] };
    this.panel.iconPath = vscode.Uri.joinPath(media, 'sln.svg');
    this.panel.webview.html = this.html();
    this.subs = [
      this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m)),
      tree.onDidChangeTreeData(() => this.update()),
    ];
    this.panel.onDidDispose(() => { this.subs.forEach((s) => s.dispose()); if (TreePanel.current === this) TreePanel.current = null; });
  }

  /** VS Code gives an open tab back after a restart only to an extension that asks for it; otherwise the tab comes back empty */
  static serializer(context, ctl, tree, runner) {
    return vscode.window.registerWebviewPanelSerializer(TreePanel.TYPE, {
      deserializeWebviewPanel: async (panel) => {
        if (TreePanel.current) { panel.dispose(); return; }
        TreePanel.current = new TreePanel(context, ctl, tree, runner, panel);
      },
    });
  }

  /** the tab, moved into a window of its own */
  static async popOut(context, ctl, tree, runner) {
    TreePanel.open(context, ctl, tree, runner);
    await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
  }

  static open(context, ctl, tree, runner) {
    if (TreePanel.current) { TreePanel.current.panel.reveal(); return TreePanel.current; }
    TreePanel.current = new TreePanel(context, ctl, tree, runner);
    return TreePanel.current;
  }

  /** Folders the page may load icons from besides media/: the icon folder, the workspace and where the icon overrides point. */
  iconRoots() {
    const out = [];
    const icons = this.ctl.icons;
    if (icons.iconFolder && fs.existsSync(icons.iconFolder)) out.push(vscode.Uri.file(icons.iconFolder));
    for (const f of vscode.workspace.workspaceFolders || []) out.push(f.uri);
    for (const v of Object.values(icons.overrides || {})) {
      for (const p of typeof v === 'string' ? [v] : [v && v.light, v && v.dark]) {
        if (typeof p === 'string' && /[\\/]/.test(p)) { const x = icons.expand(p); out.push(vscode.Uri.file(path.isAbsolute(x) ? path.dirname(x) : path.dirname(path.resolve(icons.baseDir() || '.', x)))); }
      }
    }
    return out;
  }

  html() {
    const w = this.panel.webview;
    const media = (...p) => w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', ...p));
    const nonce = crypto.randomBytes(16).toString('hex');
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${w.cspSource} data:; font-src ${w.cspSource}; style-src ${w.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${media('codicons', 'codicon.css')}">
<link rel="stylesheet" href="${media('tree', 'tree.css')}">
</head><body>
<div id="bar"></div>
<div id="tree" tabindex="0" role="tree"></div>
<div id="empty" hidden></div>
<div id="menu" hidden></div>
<div id="tip" hidden></div>
<script nonce="${nonce}" src="${media('tree', 'tree.js')}"></script>
</body></html>`;
  }

  // ---- what the page shows ------------------------------------------------------------------

  icon(i) {
    if (!i) return null;
    const w = this.panel.webview;
    if (i instanceof vscode.ThemeIcon) return { codicon: i.id, color: i.color ? `--vscode-${i.color.id.replace(/\./g, '-')}` : undefined };
    const uri = (u) => w.asWebviewUri(u).toString();
    return { light: uri(i.light || i), dark: uri(i.dark || i) };
  }

  context_() { return { 'view': VIEW, 'fudebaSolutionist.hasSolution': !!this.ctl.model, 'fudebaSolutionist.building': !!this.runner.busy }; }

  /** the `when` clauses of package.json: `&&`, `||`, `!`, `==`, `=~` over viewItem and the two context keys */
  test(when, viewItem) {
    const ctx = { ...this.context_(), viewItem };
    const term = (t) => {
      t = t.trim();
      let m;
      if ((m = /^(\S+)\s*=~\s*\/(.*)\/(\w*)$/.exec(t))) return new RegExp(m[2], m[3]).test(String(ctx[m[1]] || ''));
      if ((m = /^(\S+)\s*==\s*(\S+)$/.exec(t))) return String(ctx[m[1]]) === m[2];
      if (t.startsWith('!')) return !ctx[t.slice(1).trim()];
      return !!ctx[t];
    };
    // `||` binds weaker than `&&`; a regex may hold a single `|`, so only the spaced operators separate clauses
    return when.split(' || ').some((or) => or.split(' && ').every(term));
  }

  entry(e) {
    const c = this.commands.get(e.command) || {};
    const m = /^\$\(([\w-]+)\)$/.exec(typeof c.icon === 'string' ? c.icon : '');
    return { command: e.command, title: c.title || e.command, group: e.group || '', codicon: m ? m[1] : null };
  }

  menuFor(viewItem) {
    const out = (this.menus['view/item/context'] || []).filter((e) => this.test(e.when || 'true', viewItem)).map((e) => this.entry(e));
    return {
      inline: out.filter((e) => e.group.startsWith('inline')).sort((a, b) => a.group.localeCompare(b.group, undefined, { numeric: true })),
      menu: out.filter((e) => !e.group.startsWith('inline')).sort((a, b) => a.group.localeCompare(b.group, undefined, { numeric: true })),
    };
  }

  /** the toolbar: the `navigation` entries of the view title as buttons, the others behind the "..." button */
  toolbar() {
    const list = (this.menus['view/title'] || []).filter((e) => this.test(e.when || 'true', ''));
    const sort = (a, b) => a.group.localeCompare(b.group, undefined, { numeric: true });
    const all = list.map((e) => this.entry(e));
    return { buttons: all.filter((e) => e.group.startsWith('navigation')).sort(sort), more: all.filter((e) => !e.group.startsWith('navigation')).sort(sort) };
  }

  plainText(t) {
    if (!t) return undefined;
    return (typeof t === 'string' ? t : t.value).replace(/[*`]/g, '').replace(/ {2}\n/g, '\n');
  }

  ser(node, menus) {
    const it = node.item;
    const label = typeof it.label === 'string' ? it.label : it.label.label;
    const cv = it.contextValue || '';
    if (!menus[cv]) menus[cv] = this.menuFor(cv);
    const out = {
      id: node.id, label, kind: node.kind, cv, icon: this.icon(it.iconPath),
      description: it.description || undefined, tooltip: this.plainText(it.tooltip), missing: it.description === '(missing)' || undefined,
      draggable: node.kind === 'file' || node.kind === 'filter' || undefined,
      droppable: node.kind === 'filter' || /^project/.test(node.kind) || undefined,
      hasCommand: !!it.command || undefined,
    };
    if (it.collapsibleState !== vscode.TreeItemCollapsibleState.None && node.children) {
      out.open = it.collapsibleState === vscode.TreeItemCollapsibleState.Expanded || undefined;
      out.children = node.children().map((c) => this.ser(c, menus));
    }
    return out;
  }

  update() {
    if (!this.ready) return;
    const menus = {};
    const roots = this.tree.getChildren(null).map((n) => this.ser(n, menus));
    this.panel.title = this.ctl.model ? `Solution Explorer — ${this.ctl.model.sol.name}` : 'Solution Explorer';
    this.panel.webview.postMessage({ type: 'tree', roots, menus, toolbar: this.toolbar(), hasSolution: !!this.ctl.model });
  }

  // ---- what the page asks for ---------------------------------------------------------------

  async onMessage(m) {
    if (m.type === 'ready') { this.ready = true; this.update(); return; }
    const node = m.id ? this.tree.cache.get(m.id) : null;
    if (m.type === 'click') {
      const c = node && node.item.command;
      if (c) await vscode.commands.executeCommand(c.command, ...(c.arguments || []));
    } else if (m.type === 'run') {
      await vscode.commands.executeCommand(m.command, ...(node ? [node] : []));
    } else if (m.type === 'drop') {
      await this.drop(m);
    }
  }

  /** a drop in the page goes through the same handlers as a drop in the side bar view */
  async drop(m) {
    const target = this.tree.cache.get(m.target);
    const sources = (m.sources || []).map((id) => this.tree.cache.get(id)).filter(Boolean);
    if (!target || !sources.length) return;
    const held = new Map();
    this.tree.handleDrag(sources, { set: (k, v) => held.set(k, v) });
    await this.tree.handleDrop(target, { get: (k) => held.get(k) });
  }
}

TreePanel.current = null;
TreePanel.TYPE = 'fudebaSolutionist.treePanel';

module.exports = { TreePanel };
