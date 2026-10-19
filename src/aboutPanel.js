'use strict';
const vscode = require('vscode');
const crypto = require('crypto');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** The About box: what the extension is, who made it, with what help, the credits and the diagnostics for a bug report. */
class AboutPanel {
  constructor(context, ctl) {
    this.context = context;
    this.ctl = ctl;
    const pkg = context.extension.packageJSON;
    this.pkg = pkg;
    this.panel = vscode.window.createWebviewPanel('slnExplorer.about', `About ${pkg.displayName}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'sln.svg');
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m));
    this.panel.onDidDispose(() => { AboutPanel.current = null; });
  }

  static open(context, ctl) {
    if (AboutPanel.current) { AboutPanel.current.panel.reveal(); AboutPanel.current.panel.webview.html = AboutPanel.current.html(); return AboutPanel.current; }
    AboutPanel.current = new AboutPanel(context, ctl);
    return AboutPanel.current;
  }

  get repoUrl() {
    const r = this.pkg.repository && (this.pkg.repository.url || this.pkg.repository);
    return r ? String(r).replace(/\.git$/, '') : '';
  }

  /** plain text for a bug report */
  diagnostics() {
    const m = this.ctl.model;
    const cfg = vscode.workspace.getConfiguration('slnExplorer');
    const changed = {};
    for (const k of Object.keys(this.pkg.contributes.configuration.properties || {})) {
      const key = k.replace(/^slnExplorer\./, '');
      const insp = cfg.inspect(key);
      const v = insp && (insp.workspaceFolderValue !== undefined ? insp.workspaceFolderValue : insp.workspaceValue !== undefined ? insp.workspaceValue : insp.globalValue);
      if (v !== undefined) changed[key] = v;
    }
    const git = vscode.extensions.getExtension('vscode.git');
    return [
      `${this.pkg.displayName} ${this.pkg.version}`,
      `VS Code ${vscode.version} (${vscode.env.appName}), ${process.platform} ${process.arch}, Node ${process.versions.node}`,
      m ? `Solution: ${m.sol.file} (${m.sol.format}), ${m.entries.size} entries, configuration ${m.config || '-'}` : 'Solution: none open',
      `Git extension: ${git ? (git.isActive ? 'active' : 'installed, not active') : 'not available'}`,
      `Changed settings: ${Object.keys(changed).length ? JSON.stringify(changed) : 'none'}`,
    ].join('\n');
  }

  html() {
    const w = this.panel.webview;
    const media = (...p) => w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', ...p));
    const nonce = crypto.randomBytes(16).toString('hex');
    const pkg = this.pkg;
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${w.cspSource}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { margin: 0; padding: 32px 40px 40px; color: var(--vscode-foreground); background: var(--vscode-editor-background);
         font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); line-height: 1.5; }
  .wrap { max-width: 720px; margin: 0 auto; }
  header { display: flex; align-items: center; gap: 22px; margin-bottom: 18px; }
  header img { width: 96px; height: 96px; image-rendering: pixelated; border-radius: 12px; }
  h1 { margin: 0; font-size: 2em; font-weight: 600; }
  .version { opacity: .75; }
  .tag { margin-top: 2px; opacity: .9; }
  h2 { margin: 26px 0 6px; font-size: 1.1em; font-weight: 600; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); padding-bottom: 3px; }
  p { margin: 6px 0; }
  .ai { margin: 18px 0 4px; padding: 10px 14px; border-radius: 4px; border: 1px solid var(--vscode-editorInfo-foreground, #3794ff);
        background: var(--vscode-textBlockQuote-background, rgba(55,148,255,.08)); }
  ul { margin: 6px 0; padding-left: 22px; }
  code, pre { font-family: var(--vscode-editor-font-family); }
  pre { margin: 8px 0; padding: 8px 10px; white-space: pre-wrap; word-break: break-word; border-radius: 3px; font-size: .92em;
        background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.15)); }
  .buttons { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
  button { font: inherit; cursor: pointer; padding: 4px 14px; border-radius: 2px; border: 1px solid transparent;
           color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  .small { opacity: .75; font-size: .92em; }
</style></head>
<body><div class="wrap">
<header>
  <img src="${media('icons', 'dark', 'solution.msx.svg')}" alt="">
  <div>
    <h1>${esc(pkg.displayName)}</h1>
    <div class="version">Version ${esc(pkg.version)}</div>
    <div class="tag">A Visual Studio-style Solution Explorer for VS Code.</div>
  </div>
</header>

<div class="ai" id="made-with-claude"><b>Author: Damned Angel</b>, with aid from Anthropic Claude.</div>

<p>It is meant to support <b>generic Microsoft Visual Studio solutions</b>, but it has <b>specialized MSX features</b>, and it works in pair with the author's
<a href="https://github.com/DamnedAngel/MSX-Templates-for-VisualStudio">MSX templates for Visual Studio</a> and with the author's <a href="https://github.com/DamnedAngel/Zoo">ZOO framework</a> (ZOO is currently a private repository; it will eventually be made public).</p>

<h2>What it does</h2>
<ul>
  <li>Opens <code>.sln</code> and <code>.slnx</code> solutions with their projects, filters and files, as the Visual Studio Solution Explorer does.</li>
  <li>Per-project build, rebuild and clean, project dependencies and build order, with Visual Studio-style build output and a Problems panel that explains SDCC, SDAS and ZOO messages.</li>
  <li>Creates projects from Visual Studio project templates, and edits the configuration files of the MSX templates (ROM, MSX-DOS, BIN and overlay projects) in a settings dialog.</li>
  <li>Shows source control status next to the files, and runs on Windows and Linux.</li>
  <li>For MSX: project icons by type, a settings dialog for the Config files of the templates, and the error explanations above.</li>
</ul>

<h2>Credits and notices</h2>
<ul>
  <li><b>Aleste</b> ship icon: Compile; the artwork belongs to its owners.</li>
  <li>Works in pair with the author's <a href="https://github.com/DamnedAngel/MSX-Templates-for-VisualStudio">MSX templates for Visual Studio</a> (the project templates and their <code>make.py</code>) and the author's <a href="https://github.com/DamnedAngel/Zoo">ZOO framework</a> (a Z80 object-oriented engine); builds use <b>SDCC</b> (compiler, <code>sdasz80</code> assembler and linker).</li>
  <li><b>MSX</b> is a trademark of its owner; this extension is an independent tool and is not affiliated with or endorsed by it, or by Microsoft or Mr. Nishi.</li>
  <li>"Fudeba" is Brazilian MSX community slang.</li>
</ul>

<h2>Support</h2>
<p>When you report a problem, include this:</p>
<pre id="diag">${esc(this.diagnostics())}</pre>
<div class="buttons">
  <button class="primary" id="copy">Copy diagnostics</button>
  <button id="settings">Open settings</button>
  ${this.repoUrl ? '<button id="issues">Report an issue</button>' : ''}
</div>
<p class="small" id="status" aria-live="polite">&nbsp;</p>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const status = (t) => { document.getElementById('status').textContent = t; };
  document.getElementById('copy').addEventListener('click', () => { vscode.postMessage({ type: 'copy' }); status('Copied to the clipboard.'); });
  document.getElementById('settings').addEventListener('click', () => vscode.postMessage({ type: 'settings' }));
  const issues = document.getElementById('issues');
  if (issues) issues.addEventListener('click', () => vscode.postMessage({ type: 'issues' }));
</script></body></html>`;
  }

  async onMessage(m) {
    if (m.type === 'copy') await vscode.env.clipboard.writeText(this.diagnostics());
    else if (m.type === 'settings') await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:' + this.context.extension.id);
    else if (m.type === 'issues' && this.repoUrl) await vscode.env.openExternal(vscode.Uri.parse(`${this.repoUrl}/issues/new?body=${encodeURIComponent(`\n\n---\n${this.diagnostics()}\n`)}`));
  }
}
AboutPanel.current = null;

module.exports = { AboutPanel };
