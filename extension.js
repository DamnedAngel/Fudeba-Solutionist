'use strict';
const vscode = require('vscode');
const { Controller } = require('./src/controller');
const { SolutionTree } = require('./src/tree');
const { Runner } = require('./src/runner');
const { Problems } = require('./src/problems');
const { Icons } = require('./src/icons');
const { Scm } = require('./src/scm');
const { PropertiesPanel } = require('./src/propertiesPanel');
const { AboutPanel } = require('./src/aboutPanel');
const reveal = require('./src/reveal');
const { register } = require('./src/commands');

/** @returns the API used by the tests and by other extensions */
async function activate(context) {
  const ctl = new Controller(context);
  ctl.icons = new Icons(context);
  ctl.scm = new Scm(context);
  const tree = new SolutionTree(ctl);
  const problems = new Problems(context);
  const runner = new Runner(ctl, problems);
  const view = vscode.window.createTreeView('fudebaSolutionist.tree', {
    treeDataProvider: tree, showCollapseAll: true, canSelectMany: true,
    dragAndDropController: tree,
  });
  context.subscriptions.push(view, runner.out, ctl.onChanged(() => {
    tree.refresh();
    view.description = ctl.model ? ctl.model.sol.name : undefined;
  }));
  context.subscriptions.push(ctl.icons.onChanged(() => tree.refresh()), ctl.scm.onChanged(() => tree.refresh()));
  register(context, ctl, tree, runner, view);
  await vscode.commands.executeCommand('setContext', 'fudebaSolutionist.building', false);
  await ctl.openConfigured();
  await reveal.runPending(context, ctl); // a solution created from the Start page: show it now that its folder is open
  return { controller: ctl, tree, runner, problems, properties: PropertiesPanel, about: AboutPanel, reveal, context };
}

function deactivate() {}

module.exports = { activate, deactivate };
