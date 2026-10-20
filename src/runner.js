'use strict';
const vscode = require('vscode');
const { plan } = require('./core/build');
const { configLabel } = require('./core/model');
const { PropertiesPanel } = require('./propertiesPanel');
const { runPlan, killTree } = require('./core/buildrun');

const VERB = { build: 'Build', rebuild: 'Rebuild', clean: 'Clean' };
const BOLD = '\x1b[1m', RED = '\x1b[1;31m', DIM = '\x1b[2m', OFF = '\x1b[0m';
const STYLE = { header: BOLD, summary: BOLD, error: RED };

/**
 * Builds run inside one terminal (a VS Code task with a custom execution), so that every output line can carry
 * the project number like Visual Studio's Output window does and the run can end with its summary.
 */
class Runner {
  /** @param {import('./controller').Controller} ctl */
  constructor(ctl, problems) {
    this.ctl = ctl;
    this.problems = problems;
    this.cancelled = false;
    this.proc = null;
    this._running = false;
    this.out = vscode.window.createOutputChannel('Solution Explorer');
  }

  get busy() { return this._running; }

  /**
   * @param {{ids:string[]|null, action:'build'|'rebuild'|'clean', withDeps?:boolean}} req
   * @returns {Promise<boolean>} true when nothing failed and the run was not cancelled
   */
  async run(req) {
    if (this._running) { vscode.window.showWarningMessage('A build is already running.'); return false; }
    const ctl = this.ctl;
    // Save All: the open files and the edits pending in the project settings pages, before anything is planned or run
    await vscode.workspace.saveAll(false);
    if (!(await PropertiesPanel.flushAll())) {
      vscode.window.showErrorMessage('The build was not started: the project settings have errors and could not be saved. Fix them in the settings page.');
      return false;
    }
    if (this._running) return false;
    if (!ctl.model) return false;
    const cfg = vscode.workspace.getConfiguration('fudebaSolutionist');
    let steps;
    try {
      steps = plan(ctl.model, req, { msbuild: cfg.get('msbuildPath') || 'msbuild' });
    } catch (e) {
      vscode.window.showErrorMessage(e.message);
      return false;
    }
    if (!steps.length) { vscode.window.showInformationMessage('No projects to build.'); return true; }

    this._running = true;
    this.cancelled = false;
    await vscode.commands.executeCommand('setContext', 'fudebaSolutionist.building', true);

    const model = ctl.model;
    const title = req.ids && req.ids.length === 1 ? `${VERB[req.action]} ${model.entries.get(req.ids[0]).sln.name}` : `${VERB[req.action]} Solution`;
    let result;
    const done = new Promise((resolve) => { this._finish = resolve; });
    const write = new vscode.EventEmitter();
    const close = new vscode.EventEmitter();
    const pty = {
      onDidWrite: write.event,
      onDidClose: close.event,
      open: () => {
        const emit = (line, kind) => write.fire(`${STYLE[kind] || ''}${line}${kind ? OFF : ''}\r\n`);
        write.fire(`${DIM}${model.sol.name} - ${configLabel(model.sol, model.config)}${OFF}\r\n`);
        const parsers = new Map();
        this.problems.beginRun();
        runPlan({
          steps, action: req.action, stopOnError: cfg.get('stopOnError'), echoCommand: cfg.get('echoCommand'),
          configOf: (id) => configLabel(model.sol, model.entries.get(id).projectConfig),
          write: emit,
          onStepStart: (step, n) => {
            this.problems.startProject(step, n, model.entries.get(step.id).data.file);
            parsers.set(n, this.problems.newParser(n));
          },
          onToolLine: (step, n, line) => {
            const d = parsers.get(n).parse(line);
            if (d) this.problems.add(step, d);
          },
          cancelled: () => this.cancelled,
          onProc: (p) => { this.proc = p; },
          onProgress: (m) => { this.progress = m; },
        }).then((r) => { result = r; close.fire(r.failed || r.canceled ? 1 : 0); this._finish(); },
          (e) => { emit(`Internal error: ${e.message}`, 'error'); result = { failed: 1, succeeded: 0, skipped: 0, canceled: false }; close.fire(1); this._finish(); });
      },
      close: () => this.cancel(),
      handleInput: (d) => { if (d === '\x03') this.cancel(); }, // Ctrl+C in the terminal
    };
    const task = new vscode.Task(
      { type: 'fudebaSolutionist', project: title, action: req.action }, vscode.TaskScope.Workspace, title, 'Solution Explorer',
      new vscode.CustomExecution(async () => pty), cfg.get('problemMatchers') || []);
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Shared, clear: true, showReuseMessage: false, echo: false, focus: false };
    task.group = vscode.TaskGroup.Build;

    try {
      await vscode.tasks.executeTask(task);
      await done;
    } catch (e) {
      vscode.window.showErrorMessage(`Could not start the build: ${e.message}`);
      result = { failed: 1, succeeded: 0, skipped: 0, canceled: false };
    } finally {
      this._running = false;
      this.proc = null;
      await vscode.commands.executeCommand('setContext', 'fudebaSolutionist.building', false);
    }
    const ok = !!result && !result.failed && !result.canceled;
    const text = `${VERB[req.action]}: ${result.succeeded} succeeded, ${result.failed} failed${result.skipped ? `, ${result.skipped} skipped` : ''}${result.canceled ? ' (canceled)' : ''}`;
    if (ok) vscode.window.setStatusBarMessage(`$(check) ${text}`, 6000);
    else vscode.window.showErrorMessage(text, 'Show Output').then((c) => { if (c) vscode.commands.executeCommand('workbench.action.terminal.focus'); });
    return ok;
  }

  cancel() {
    if (!this._running) return;
    this.cancelled = true;
    killTree(this.proc);
  }
}

module.exports = { Runner };
