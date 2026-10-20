'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { loadModel, projectsOf, configLabel } = require('./core/model');

const WATCH_GLOB = '**/*.{sln,slnx,vcxproj,csproj,vbproj,fsproj,shproj,vcxitems,projitems,filters,props,targets}';
const KEY_SOLUTION = 'fudebaSolutionist.solutionFile';
const KEY_CONFIG = 'fudebaSolutionist.config';
const KEY_STARTUP = 'fudebaSolutionist.startup';

/** State of the open solution, shared by the tree, the commands and the status bar. */
class Controller {
  constructor(context) {
    this.context = context;
    this.model = null;
    this.error = null;
    this.solutionFile = null;
    this._reloadTimer = null;
    this._changed = new vscode.EventEmitter();
    this.onChanged = this._changed.event;

    this.status = vscode.window.createStatusBarItem('fudebaSolutionist.config', vscode.StatusBarAlignment.Left, 90);
    this.status.name = 'Solution Explorer configuration';
    this.status.command = 'fudebaSolutionist.selectConfiguration';
    context.subscriptions.push(this.status, this._changed);

    const w = vscode.workspace.createFileSystemWatcher(WATCH_GLOB);
    const poke = (uri) => { if (!this._selfWrite && !/[\\/](node_modules|\.git)[\\/]/.test(uri.fsPath)) this.scheduleReload(); };
    context.subscriptions.push(w, w.onDidChange(poke), w.onDidCreate(poke), w.onDidDelete(poke));
    // another folder was opened, or the one holding the solution was closed: the old solution goes, the new folder's is opened
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.syncWithWorkspace()));
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('fudebaSolutionist.solution')) this.openConfigured(); }));
  }

  get startupId() { return this.context.workspaceState.get(KEY_STARTUP) || null; }
  setStartup(id) { return this.context.workspaceState.update(KEY_STARTUP, id).then(() => this._changed.fire()); }

  // ---- finding and loading ------------------------------------------------------------------

  async findSolutions() {
    const uris = await vscode.workspace.findFiles('**/*.{sln,slnx}', '**/{node_modules,.git,bin,obj}/**', 50);
    return uris.map((u) => u.fsPath).sort();
  }

  /** is the file inside one of the open folders? */
  inWorkspace(file) {
    return (vscode.workspace.workspaceFolders || []).some((f) => {
      const rel = path.relative(f.uri.fsPath, file);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
  }

  /** The folders changed: a solution that is no longer in any open folder is closed, and the folders' own solution is opened. */
  async syncWithWorkspace() {
    if (this.solutionFile && this.inWorkspace(this.solutionFile)) return;
    if (this.solutionFile) await this.open(null);
    await this.openConfigured();
  }

  async openConfigured() {
    const cfg = vscode.workspace.getConfiguration('fudebaSolutionist').get('solution');
    let file = null;
    // a solution opened from another folder: the window was reopened on its folder and the request waits here
    const parked = this.context.globalState.get(require('./reveal').KEY);
    if (parked && parked.file && fs.existsSync(parked.file) && this.inWorkspace(parked.file)) file = parked.file;
    if (!file && cfg) {
      const root = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0].uri.fsPath;
      const abs = path.isAbsolute(cfg) ? cfg : root && path.join(root, cfg);
      if (abs && fs.existsSync(abs)) file = abs;
    }
    if (!file) {
      const remembered = this.context.workspaceState.get(KEY_SOLUTION);
      if (remembered && fs.existsSync(remembered) && this.inWorkspace(remembered)) file = remembered; // one from a folder that is not open any more stays closed
    }
    if (!file) {
      const found = await this.findSolutions();
      // prefer a solution at the top of the workspace; with several, the first (a picker is a command away)
      file = found.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length)[0] || null;
    }
    await this.open(file);
  }

  async open(file) {
    this.solutionFile = file;
    if (file) await this.context.workspaceState.update(KEY_SOLUTION, file);
    this.reload();
  }

  scheduleReload() {
    clearTimeout(this._reloadTimer);
    this._reloadTimer = setTimeout(() => this.reload(), 250);
  }

  reload() {
    this.error = null;
    if (!this.solutionFile || !fs.existsSync(this.solutionFile)) {
      this.model = null;
    } else {
      try {
        this.model = loadModel(this.solutionFile, this.context.workspaceState.get(KEY_CONFIG));
      } catch (e) {
        this.model = null;
        this.error = e.message;
        vscode.window.showErrorMessage(`Solution Explorer: ${e.message}`);
      }
    }
    vscode.commands.executeCommand('setContext', 'fudebaSolutionist.hasSolution', !!this.model);
    this.updateStatus();
    this._changed.fire();
  }

  updateStatus() {
    if (!this.model) { this.status.hide(); return; }
    this.status.text = `$(layers) ${configLabel(this.model.sol, this.model.config) || 'no configuration'}`;
    this.status.tooltip = `${this.model.sol.name}: solution configuration (click to change)`;
    this.status.show();
  }

  async setConfig(name) {
    await this.context.workspaceState.update(KEY_CONFIG, name);
    this.reload();
  }

  /** Runs a file edit with the watcher muted, then reloads once. Errors are shown, not thrown. */
  async run(fn, what) {
    this._selfWrite = true;
    try {
      await fn();
    } catch (e) {
      vscode.window.showErrorMessage(`${what}: ${e.message}`);
    } finally {
      setTimeout(() => { this._selfWrite = false; }, 600);
      this.reload();
    }
  }

  projects() { return this.model ? projectsOf(this.model) : []; }
}

module.exports = { Controller };
