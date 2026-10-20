'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveIn, native } = require('./core/fsx');
const tf = require('./core/msxconfig/textfile');
const { loadProjectConfig, saveProjectConfig, normalizeEvents } = require('./core/msxconfig/model');
const { defaultsProvider } = require('./core/msxconfig/defaults');
const { defaultTemplateRoots } = require('./core/vstemplate');
const edit = require('./core/edit');
const { validate } = require('./core/msxconfig/validate');

/**
 * The project settings dialog of an MSX project: one page per configuration file in the project's Config folder,
 * specific to the project type (ROM, COM, BIN, MDO). The page itself lives in media/properties (a webview); this
 * class loads and saves the files and runs the context checks.
 */
class PropertiesPanel {
  /** @param {object} ctl the controller @param {string} projectId @param {'ROM'|'COM'|'BIN'|'MDO'} type */
  constructor(context, ctl, projectId, type) {
    this.ctl = ctl;
    this.context = context;
    this.projectId = projectId;
    this.type = type;
    const e = ctl.model.entries.get(projectId);
    this.dir = e.data.dir;
    this.name = e.sln.name;
    this.sent = []; // what was posted to the page (read by the tests)
    this.creating = new Set();
    this.panel = vscode.window.createWebviewPanel('fudebaSolutionist.projectSettings', `${this.name} - Settings`, vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media', 'properties')],
    });
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'sln.svg');
    this.panel.webview.html = this.html(context);
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m));
    this.panel.onDidDispose(() => { this.settle(true); PropertiesPanel.panels.delete(projectId); });
    this.reload();
  }

  static open(context, ctl, projectId, type) {
    const existing = PropertiesPanel.panels.get(projectId);
    if (existing) { existing.panel.reveal(); return existing; }
    const p = new PropertiesPanel(context, ctl, projectId, type);
    PropertiesPanel.panels.set(projectId, p);
    return p;
  }

  html(context) {
    const w = this.panel.webview;
    const uri = (f) => w.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'properties', f));
    const nonce = crypto.randomBytes(16).toString('hex');
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${uri('properties.css')}"></head>
<body><div id="main"><nav id="index"></nav><div id="page"></div></div>
<div id="desc"></div>
<div id="buttons"><span id="summary"></span><span class="spacer"></span><button id="ok" class="primary">OK</button><button id="cancel">Cancel</button><button id="apply" disabled>Apply</button></div>
<script nonce="${nonce}" src="${uri('properties.js')}"></script></body></html>`;
  }

  post(m) { this.sent.push(m); this.panel.webview.postMessage(m); }

  /** (re)reads the files and gives the page fresh models */
  reload() {
    // files the project lacks are shown too, filled from its template (installed in Visual Studio, else the copy shipped here)
    const extra = vscode.workspace.getConfiguration('fudebaSolutionist').get('templateFolders') || [];
    const defaults = defaultsProvider({ type: this.type, templateRoots: [...defaultTemplateRoots(), ...extra], bundledDir: path.join(this.context.extensionUri.fsPath, 'media', 'msx-config-defaults') });
    this.cfg = loadProjectConfig(this.dir, this.type, defaults);
    this.state = { type: this.type, project: this.name, pages: this.cfg.pages.map((p) => p.model) };
  }

  // ---- checks ------------------------------------------------------------------------------------------------------
  checkContext() {
    const dir = this.dir;
    const ex = (rel) => { try { return fs.existsSync(resolveIn(dir, rel)); } catch { return false; } };
    return {
      exists: ex,
      hasFile: ex,
      hooksOf: (rel) => {
        try {
          const f = resolveIn(dir, `${rel}\\Config\\MDOSettings.txt`);
          if (!fs.existsSync(f)) return null;
          const doc = tf.load(fs.readFileSync(f, 'utf8'));
          return tf.settings(doc, 'MDO_HOOK').map((i) => (doc.lines[i].value.split('|')[1] || '').trim()).filter(Boolean);
        } catch { return null; }
      },
    };
  }

  /** a missing file that has not been edited is not checked: it does not exist yet */
  check(pages) {
    const orig = this.state.pages;
    const live = pages.filter((pg, i) => !pg.missing || JSON.stringify(pg) !== JSON.stringify(orig[i]) || this.creating.has(pg.id));
    return validate({ type: this.type, pages: live }, this.checkContext());
  }

  /** the pages sent back by the dialog must be the ones that were sent out */
  sane(pages) {
    return Array.isArray(pages) && pages.length === this.cfg.pages.length && pages.every((p, i) => p && p.id === this.cfg.pages[i].model.id);
  }

  // ---- messages ----------------------------------------------------------------------------------------------------
  async onMessage(m) {
    switch (m.type) {
      case 'ready':
        this.post({ type: 'init', state: this.state, issues: this.check(this.state.pages) });
        break;
      case 'validate':
        if (this.sane(m.pages)) this.post({ type: 'issues', issues: this.check(m.pages) });
        break;
      case 'dirty':
        this.panel.title = `${m.dirty ? '● ' : ''}${this.name} - Settings`;
        break;
      case 'browse':
        await this.browse(m);
        break;
      case 'cancel':
        if (m.dirty) {
          const ok = await vscode.window.showWarningMessage('Discard the changes made in the project settings?', { modal: true }, 'Discard');
          if (ok !== 'Discard') return;
        }
        this.panel.dispose();
        break;
      case 'save':
        await this.save(m);
        break;
      case 'flushed':
        this.settle(true);
        break;
      default: break;
    }
  }

  async browse(m) {
    const start = path.resolve(this.dir, native(m.value || '.'));
    const pick = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, defaultUri: vscode.Uri.file(fs.existsSync(start) ? start : this.dir), openLabel: 'Select folder' });
    if (!pick) return this.post({ type: 'picked', token: m.token, value: m.value });
    const rel = path.relative(this.dir, pick[0].fsPath).replace(/\//g, '\\');
    this.post({ type: 'picked', token: m.token, value: rel || '.' });
  }

  /** new configuration files go into the project, in the filter the other Config files are in ("Project Config" in the templates) */
  registerInProject(files) {
    if (!files || !files.length) return;
    const pd = this.ctl.model.entries.get(this.projectId).data;
    const norm = (s) => s.replace(/\//g, '\\').toLowerCase();
    const filter = (pd.items.find((i) => /^Config[\\/]/i.test(i.include) && i.filter) || {}).filter || 'Project Config';
    for (const f of files) {
      const include = `Config\\${path.basename(f)}`;
      if (pd.items.some((i) => norm(i.include) === norm(include))) continue;
      edit.addItem(pd.file, 'Text', include, filter);
    }
  }

  /** Applies the edits still pending in this dialog (a build must see them). @returns {Promise<boolean>} false when they could not be saved */
  flush() {
    return new Promise((resolve) => {
      this.settle(true);
      this._flush = resolve;
      this._flushTimer = setTimeout(() => this.settle(true), 5000); // a page that never answers must not block the build
      this.post({ type: 'flush' });
    });
  }

  settle(ok) {
    clearTimeout(this._flushTimer);
    const r = this._flush;
    this._flush = null;
    if (r) r(ok);
  }

  /** Applies the pending edits of every open settings dialog. @returns {Promise<boolean>} */
  static async flushAll() {
    let ok = true;
    for (const p of [...PropertiesPanel.panels.values()]) if (!(await p.flush())) ok = false;
    return ok;
  }

  async save(m) {
    try { await this.doSave(m); } finally { this.settle(!this._failed); this._failed = false; }
  }

  async doSave(m) {
    this._failed = false;
    if (!this.sane(m.pages)) { this._failed = true; this.post({ type: 'saveFailed', issues: [{ file: '', severity: 'error', message: 'The settings changed on disk structure; reopen the dialog.' }] }); return; }
    const fixed = normalizeEvents(m.pages); // backslashes in build event commands become "/"
    this.creating = new Set(m.create || []);
    const issues = this.check(m.pages);
    if (issues.some((i) => i.severity === 'error')) { this._failed = true; this.creating = new Set(); this.post({ type: 'saveFailed', issues }); return; }
    let written = [];
    await this.ctl.run(() => {
      written = saveProjectConfig(this.cfg, m.pages, { create: m.create || [] });
      this.registerInProject(written.created);
    }, 'Save project settings');
    this.creating = new Set();
    if (m.close) { this.panel.dispose(); return; }
    this.reload();
    this.post({ type: 'init', state: this.state, issues: this.check(this.state.pages) });
    this.panel.title = `${this.name} - Settings`;
    if (fixed.length) vscode.window.showInformationMessage(`Build events: backslashes in ${fixed.join(', ')} were converted to "/" (make.py would have dropped them).`);
    if (written.length) {
      const names = (l) => l.map((f) => path.basename(f)).join(', ');
      const updated = written.filter((f) => !written.created.includes(f));
      vscode.window.setStatusBarMessage(`$(check) ${[written.created.length ? `Created ${names(written.created)}` : '', updated.length ? `saved ${names(updated)}` : ''].filter(Boolean).join('; ')}`, 6000);
    }
  }
}
PropertiesPanel.panels = new Map();
PropertiesPanel.flushAll = PropertiesPanel.flushAll.bind(PropertiesPanel);

module.exports = { PropertiesPanel };
