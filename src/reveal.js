'use strict';
const vscode = require('vscode');
const path = require('path');

// A solution created from an empty window (the Start page, no folder open) can only be shown after VS Code has opened the
// solution's folder, which restarts the extension. The request is parked in the global state and carried out when the
// extension starts again in that folder: the view is shown, and the "add a project" offer is made.
const KEY = 'fudebaSolutionist.revealOnStart';

const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** Parks the request; the next start of the extension with this solution open carries it out. */
function schedule(context, file, opt = {}) {
  return context.globalState.update(KEY, { file, addProject: !!opt.addProject });
}

/** Shows the Fudeba Solutionist view (the sidebar, if it was hidden). */
function showView() {
  return vscode.commands.executeCommand('fudebaSolutionist.tree.focus');
}

/**
 * Called when the extension has started and opened its solution: if a parked request matches that solution, shows the view
 * and makes the offer; a request for another solution is dropped.
 * @returns {Promise<boolean>} true when a request was carried out
 */
async function runPending(context, ctl) {
  const p = context.globalState.get(KEY);
  if (!p) return false;
  await context.globalState.update(KEY, undefined);
  if (!ctl.model || !same(ctl.model.sol.file, p.file)) return false;
  await showView();
  if (p.addProject) {
    // not awaited: the offer stays open without holding the start of the extension
    vscode.window.showInformationMessage(`Created ${path.basename(p.file)}. Add a project to it now?`, 'Add Project from Template...')
      .then((c) => { if (c) vscode.commands.executeCommand('fudebaSolutionist.newProject'); });
  }
  return true;
}

module.exports = { schedule, showView, runPending, KEY };
