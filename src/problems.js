'use strict';
const vscode = require('vscode');
const { DiagnosticParser } = require('./core/diagnostics');
const { explain, searchUrl } = require('./core/explain');
const { findCrashingLine } = require('./core/bisect');

const SEVERITY = { error: vscode.DiagnosticSeverity.Error, warning: vscode.DiagnosticSeverity.Warning, info: vscode.DiagnosticSeverity.Information };
const SCHEME = 'slnx-explain';

/**
 * Build errors and warnings in the Problems panel, with explanations for the cryptic ones.
 * Lines are read here, per project, because tool paths are relative to each project's own folder (a VS Code
 * problem matcher can only resolve against one fixed folder).
 */
class Problems {
  constructor(context) {
    this.collection = vscode.languages.createDiagnosticCollection('Solution Explorer');
    this.byProject = new Map(); // project id -> Set(uri string)
    this.meta = new Map();      // key -> {diag, step}
    this.docs = new Map();      // explain doc path -> markdown
    this.stepInfo = new Map();  // output project number -> parser context (for terminal links)
    this.seen = new Set();      // keys already reported in the current build
    this._emitter = new vscode.EventEmitter();
    context.subscriptions.push(this.collection, this._emitter);

    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(SCHEME, { provideTextDocumentContent: (uri) => this.docs.get(uri.path) || '', onDidChange: this._emitter.event }),
      vscode.languages.registerCodeActionsProvider({ pattern: '**' }, this, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
      vscode.window.registerTerminalLinkProvider(this),
      vscode.commands.registerCommand('slnExplorer.explainDiagnostic', (key) => this.showExplanation(key)),
      vscode.commands.registerCommand('slnExplorer.searchDiagnostic', (key) => this.search(key)),
      vscode.commands.registerCommand('slnExplorer.findCrashLine', (key) => this.findCrash(key)),
    );
  }

  static keyOf(uri, line, d) { return `${uri.toString()}|${line}|${d.source}|${d.code || ''}|${d.message}`; }

  enabled() { return vscode.workspace.getConfiguration('slnExplorer').get('problems') !== false; }

  /** Called when a project starts building: its old problems are stale. */
  startProject(step, n, projectFile) {
    this.stepInfo.set(n, { projectDir: step.cwd, projectFile });
    const uris = this.byProject.get(step.id);
    if (uris) for (const u of uris) this.collection.delete(vscode.Uri.parse(u));
    this.byProject.set(step.id, new Set());
  }

  newParser(n) { return new DiagnosticParser(this.stepInfo.get(n)); }

  add(step, d) {
    if (!this.enabled()) return;
    const uri = vscode.Uri.file(d.file);
    const line = Math.max(0, d.line - 1);
    const range = new vscode.Range(line, Math.max(0, d.column - 1), line, 10000);
    const code = d.code ? (d.source === 'SDAS' && d.code.length === 1 ? `<${d.code}>` : d.code) : '';
    const keyed = Problems.keyOf(uri, line, { source: d.source, code, message: d.message });
    if (this.seen.has(keyed)) return; // the same line reported twice by the tool
    this.seen.add(keyed);
    const diag = new vscode.Diagnostic(range, d.message, SEVERITY[d.severity]);
    diag.source = d.source;
    if (code) diag.code = code;
    const e = explain(d);
    if (e) diag.relatedInformation = [new vscode.DiagnosticRelatedInformation(new vscode.Location(uri, range), e.hint)];
    this.meta.set(keyed, { diag: d, step });
    this.collection.set(uri, [...(this.collection.get(uri) || []), diag]);
    this.byProject.get(step.id)?.add(uri.toString());
  }

  clearAll() { this.collection.clear(); this.byProject.clear(); this.meta.clear(); this.seen.clear(); }

  /** A new build run begins: forget what the previous one reported (the problems of re-built projects are cleared as each starts). */
  beginRun() { this.seen.clear(); this.stepInfo.clear(); }

  // ---- quick fixes ---------------------------------------------------------------------------

  provideCodeActions(doc, range, ctx) {
    const out = [];
    for (const diag of ctx.diagnostics) {
      const key = Problems.keyOf(doc.uri, diag.range.start.line, { source: diag.source, code: diag.code ? String(diag.code) : '', message: diag.message });
      const m = this.meta.get(key);
      if (!m) continue;
      const e = explain(m.diag);
      if (e) {
        const a = new vscode.CodeAction(`Explain: ${e.title}`, vscode.CodeActionKind.QuickFix);
        a.command = { command: 'slnExplorer.explainDiagnostic', title: 'Explain', arguments: [key] };
        a.diagnostics = [diag]; a.isPreferred = true;
        out.push(a);
      }
      const s = new vscode.CodeAction('Search the web for this error', vscode.CodeActionKind.QuickFix);
      s.command = { command: 'slnExplorer.searchDiagnostic', title: 'Search', arguments: [key] };
      s.diagnostics = [diag];
      out.push(s);
      const c = m.diag.crash;
      if (c && c.command && c.sourceFile && /^sdas/.test(c.tool)) {
        const f = new vscode.CodeAction(`Find the line that crashes ${c.tool}`, vscode.CodeActionKind.QuickFix);
        f.command = { command: 'slnExplorer.findCrashLine', title: 'Find the crashing line', arguments: [key] };
        f.diagnostics = [diag]; f.isPreferred = !e;
        out.push(f);
      }
    }
    return out;
  }

  async showExplanation(key) {
    const m = this.meta.get(key);
    const e = m && explain(m.diag);
    if (!e) return;
    const url = searchUrl(m.diag, vscode.workspace.getConfiguration('slnExplorer').get('searchUrl'));
    const md = `# ${e.title}\n\n${e.body}\n\n---\n\n[Search the web for this error](${url})\n`;
    const p = `/${e.title.replace(/[^\w.-]+/g, '_').slice(0, 60)}.md`;
    this.docs.set(p, md);
    const uri = vscode.Uri.from({ scheme: SCHEME, path: p });
    this._emitter.fire(uri);
    await vscode.commands.executeCommand('markdown.showPreviewToSide', uri);
  }

  search(key) {
    const m = this.meta.get(key);
    if (!m) return;
    return vscode.env.openExternal(vscode.Uri.parse(searchUrl(m.diag, vscode.workspace.getConfiguration('slnExplorer').get('searchUrl'))));
  }

  /** Locates the line that makes a silently crashing assembler die and reports it as a problem on that line. */
  async findCrash(key) {
    const m = this.meta.get(key);
    if (!m || !m.diag.crash) return;
    const c = m.diag.crash;
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Looking for the line that crashes ${c.tool}...` },
      () => new Promise((resolve) => setTimeout(() => {
        try { resolve(findCrashingLine({ command: c.command, cwd: m.step.cwd, sourceFile: c.sourceFile })); } catch (e) { resolve({ found: false, reason: e.message }); }
      }, 20)));
    if (!r.found) { vscode.window.showWarningMessage(r.reason); return; }
    const uri = vscode.Uri.file(c.sourceFile);
    const d = {
      severity: 'error', file: c.sourceFile, line: r.line, column: 1, source: c.tool.startsWith('sdas') ? 'SDAS' : c.tool, code: 'crash',
      message: `${c.tool} crashes while assembling this line: ${r.text.trim()}`, located: true, crash: { ...c },
    };
    this.add(m.step, d);
    const doc = await vscode.workspace.openTextDocument(uri);
    const ed = await vscode.window.showTextDocument(doc, { preview: false });
    const pos = new vscode.Position(r.line - 1, 0);
    ed.selection = new vscode.Selection(pos, doc.lineAt(r.line - 1).range.end);
    ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    vscode.window.showInformationMessage(`${c.tool} crashes on line ${r.line}: ${r.text.trim()}`, 'Explain').then((x) => { if (x) vscode.commands.executeCommand('slnExplorer.explainDiagnostic', Problems.keyOf(uri, r.line - 1, { source: d.source, code: 'crash', message: d.message })); });
  }

  // ---- terminal links: file:line in the build output opens the file ------------------------------

  provideTerminalLinks(ctx) {
    const m = /^(\d+)>/.exec(ctx.line);
    const info = m && this.stepInfo.get(Number(m[1]));
    if (!info) return [];
    const d = new DiagnosticParser(info).parse(ctx.line.slice(m[0].length));
    if (!d || !d.span || !d.located) return [];
    return [{ startIndex: m[0].length + d.span[0], length: d.span[1], tooltip: 'Open the source file', data: { file: d.file, line: d.line, column: d.column } }];
  }

  async handleTerminalLink(link) {
    const { file, line, column } = link.data;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const pos = new vscode.Position(Math.max(0, line - 1), Math.max(0, column - 1));
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos) });
  }
}

module.exports = { Problems };
