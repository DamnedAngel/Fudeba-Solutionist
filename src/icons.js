'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { KEYS, fileKey, indexFolder, resolveIcon, interpret } = require('./core/icons');

const THEMES = [
  { id: 'vs', label: 'Visual Studio style', detail: 'The built-in set (original artwork, light and dark).' },
  { id: 'codicons', label: 'VS Code icons', detail: 'VS Code\'s own icons (codicons).' },
  { id: 'folder', label: 'Icons from a folder...', detail: 'Pick icons by name from a folder, e.g. your copy of the Visual Studio Image Library.' },
];

/**
 * The icons of the tree, switchable while VS Code runs: changing a setting, an icon file in the chosen folder,
 * or running one of the icon commands redraws the tree at once.
 */
class Icons {
  constructor(context) {
    this.context = context;
    this.builtinDir = path.join(context.extensionUri.fsPath, 'media', 'icons');
    this._changed = new vscode.EventEmitter();
    this.onChanged = this._changed.event;
    this.index = null;
    this.watcher = null;
    this.reload();
    context.subscriptions.push(this._changed,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('fudebaSolutionist.iconTheme') || e.affectsConfiguration('fudebaSolutionist.iconFolder') ||
          e.affectsConfiguration('fudebaSolutionist.icons') || e.affectsConfiguration('fudebaSolutionist.fileIcons')) this.reload();
      }),
      { dispose: () => this.watcher && this.watcher.dispose() },
      vscode.commands.registerCommand('fudebaSolutionist.chooseIconTheme', () => this.chooseTheme()),
      vscode.commands.registerCommand('fudebaSolutionist.setIcon', (node) => this.setIcon(node)),
      vscode.commands.registerCommand('fudebaSolutionist.reloadIcons', () => this.reload()),
    );
  }

  cfg() { return vscode.workspace.getConfiguration('fudebaSolutionist'); }

  /** Re-reads settings and (when a folder is in use) re-indexes it; then tells the tree. */
  reload() {
    const c = this.cfg();
    this.theme = c.get('iconTheme') || 'vs';
    this.iconFolder = this.expand(c.get('iconFolder') || '');
    this.overrides = c.get('icons') || {};
    this.fileIcons = c.get('fileIcons') || 'mixed';
    this.index = this.theme === 'folder' && this.iconFolder && fs.existsSync(this.iconFolder) ? indexFolder(this.iconFolder) : null;
    this.cache = new Map();
    if (this.watcher) { this.watcher.dispose(); this.watcher = null; }
    if (this.index) {
      // Node's own recursive watcher: the folder is usually outside the workspace, where VS Code's watcher is not reliable.
      try {
        const w = fs.watch(this.iconFolder, { recursive: true }, (_event, name) => {
          if (name && !/\.(svg|png)$/i.test(String(name))) return;
          clearTimeout(this._t);
          this._t = setTimeout(() => this.reload(), 300);
        });
        w.on('error', () => { /* the folder went away: the next reload notices */ });
        this.watcher = { dispose: () => w.close() };
      } catch { /* no recursive watching on this platform: "Reload Icons" still works */ }
    }
    this._changed.fire();
  }

  expand(p) {
    if (!p) return '';
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const wf = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0].uri.fsPath;
    return p.replace(/^~(?=[\\/]|$)/, home).replace(/\$\{workspaceFolder\}/g, wf || '');
  }

  baseDir() { const wf = vscode.workspace.workspaceFolders; return wf && wf[0].uri.fsPath; }

  /**
   * Icon of a file node: our sheet icons for C/H/ASM/INC files ("mixed", the default, and "vs"), the generic sheet
   * for every other file ("vs"), or the user's file icon theme (undefined result, "fileTheme").
   */
  fileIcon(file, scmStatus) {
    const k = this.fileIcons === 'fileTheme' ? null : fileKey(file);
    // a source control mark is part of the icon image, so a file under source control gets one of our own icons
    // (the dedicated one, else the generic sheet) with the mark drawn on it
    if (scmStatus && this.fileIcons !== 'fileTheme' && this.theme !== 'codicons') {
      const base = k || 'file';
      if (this.describe(base).source !== 'override') return this.get(`${base}+${scmStatus}`);
    }
    if (k) return this.get(k);
    return this.fileIcons === 'vs' ? this.get('file') : vscode.ThemeIcon.File;
  }

  /**
   * @param {string} key  one of KEYS
   * @param {{color?:vscode.ThemeColor}} [opt]  colour for codicons only
   */
  get(key, opt = {}) {
    const ck = `${key}|${opt.color ? opt.color.id : ''}`;
    if (this.cache.has(ck)) return this.cache.get(ck);
    const r = resolveIcon(key, { theme: this.theme, iconFolder: this.iconFolder, overrides: this.overrides, builtinDir: this.builtinDir, baseDir: this.baseDir(), index: this.index || undefined });
    const icon = r.type === 'codicon'
      ? new vscode.ThemeIcon(r.id, opt.color)
      : { light: vscode.Uri.file(r.light), dark: vscode.Uri.file(r.dark) };
    this.cache.set(ck, icon);
    return icon;
  }

  describe(key) { return resolveIcon(key, { theme: this.theme, iconFolder: this.iconFolder, overrides: this.overrides, builtinDir: this.builtinDir, baseDir: this.baseDir(), index: this.index || undefined }); }

  // ---- commands ---------------------------------------------------------------------------------

  async chooseTheme() {
    const pick = await vscode.window.showQuickPick(THEMES.map((t) => ({ ...t, description: t.id === this.theme ? 'current' : '' })), { placeHolder: 'Icons of the Solution Explorer' });
    if (!pick) return;
    const c = this.cfg();
    if (pick.id === 'folder') {
      const u = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, title: 'Folder with the icons (SVG or PNG)', defaultUri: this.iconFolder ? vscode.Uri.file(this.iconFolder) : undefined });
      if (!u) return;
      await c.update('iconFolder', u[0].fsPath, vscode.ConfigurationTarget.Global);
    }
    await c.update('iconTheme', pick.id, vscode.ConfigurationTarget.Global);
    if (pick.id === 'folder') this.report();
  }

  /** After picking a folder: which of our icons were found in it. */
  report() {
    const found = KEYS.filter((k) => this.describe(k).source === 'folder');
    vscode.window.showInformationMessage(`${found.length} of ${KEYS.length} icons found in the folder; the rest use the built-in set. Assign the others with "Set Icon..." or the fudebaSolutionist.icons setting.`);
  }

  /** Per-icon customisation: pick which icon (the clicked node's by default) and what it should show. */
  async setIcon(node) {
    const guess = node ? keyForNode(node) : null;
    const items = KEYS.map((k) => ({ label: k, description: this.overrides[k] ? `override: ${JSON.stringify(this.overrides[k])}` : this.describe(k).source, picked: k === guess }));
    items.sort((a, b) => (a.label === guess ? -1 : b.label === guess ? 1 : 0));
    const key = guess && node ? guess : (await vscode.window.showQuickPick(items, { placeHolder: 'Which icon?' }) || {}).label;
    if (!key) return;
    const cur = this.overrides[key];
    const val = await vscode.window.showInputBox({
      title: `Icon "${key}"`, value: typeof cur === 'string' ? cur : '',
      prompt: 'A codicon name (e.g. tools, rocket), or the path of an SVG/PNG file. Leave empty to remove the override.',
      validateInput: (v) => {
        const x = interpret(v.trim(), this.baseDir());
        if (!v.trim() || !x) return null;
        return x.type === 'file' && !fs.existsSync(x.light) ? 'File not found' : null;
      },
    });
    if (val === undefined) return;
    const next = { ...this.overrides };
    if (val.trim()) next[key] = val.trim(); else delete next[key];
    await this.cfg().update('icons', Object.keys(next).length ? next : undefined, vscode.ConfigurationTarget.Global);
  }
}

/** The icon key a tree node uses (for "Set Icon..." on a clicked node). */
function keyForNode(node) {
  switch (node.kind) {
    case 'solution': return node.iconKey || 'solution';
    case 'solutionFolder': return 'solutionFolder';
    case 'projectMissing': return 'project.missing';
    case 'actions': return 'buildActions';
    case 'action': return `action.${node.action}`;
    case 'deps': return 'dependencies';
    case 'filter': return 'filter';
    case 'folder': return 'folder';
    case 'file': return 'file';
    default: return /^project/.test(node.kind) ? (node.iconKey || 'project.cpp') : null;
  }
}

module.exports = { Icons, keyForNode };
