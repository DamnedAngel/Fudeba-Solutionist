'use strict';
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');

const edit = require('./core/edit');
const slnEdit = require('./core/slnEdit');
const { dependencySources, dependents, projectsOf, topoOrder, closure, configLabel } = require('./core/model');
const { plan } = require('./core/build');
const { discoverTemplates, defaultTemplateRoots } = require('./core/vstemplate');
const { createFromTemplate, validateName } = require('./core/newProject');
const { setSlnDependencies } = require('./core/sln');
const { ZipArchive } = require('./core/zip');

const NMAKE_PROP = { build: 'NMakeBuildCommandLine', clean: 'NMakeCleanCommandLine', rebuild: 'NMakeReBuildCommandLine' };
const cfg = () => vscode.workspace.getConfiguration('slnExplorer');
const warn = (m) => vscode.window.showWarningMessage(m);

function register(context, ctl, tree, runner, view) {
  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  const needModel = () => { if (!ctl.model) { warn('No solution is open.'); return false; } return true; };
  const entryOf = (node) => (node && node.projectId ? ctl.model.entries.get(node.projectId) : null);

  /** Project the command applies to: the clicked node, else the startup project, else a picker. */
  async function pickProject(node, placeHolder) {
    if (!needModel()) return null;
    const e = entryOf(node);
    if (e) return e;
    const list = projectsOf(ctl.model);
    if (!list.length) { warn('The solution has no projects.'); return null; }
    const sel = await vscode.window.showQuickPick(list.map((p) => ({ label: p.sln.name, description: p.sln.relPath, e: p })), { placeHolder });
    return sel ? sel.e : null;
  }

  // ---- solution -------------------------------------------------------------------------------

  reg('slnExplorer.openSolution', async () => {
    const found = await ctl.findSolutions();
    const items = found.map((f) => ({ label: path.basename(f), description: vscode.workspace.asRelativePath(f), file: f }));
    items.push({ label: '$(folder-opened) Browse...', file: null });
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Open a solution' });
    if (!pick) return;
    let file = pick.file;
    if (!file) {
      const u = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { Solutions: ['sln', 'slnx'] } });
      if (!u) return;
      file = u[0].fsPath;
    }
    await ctl.open(file);
  });

  reg('slnExplorer.refresh', () => ctl.reload());

  reg('slnExplorer.selectConfiguration', async () => {
    if (!needModel()) return;
    const pick = await vscode.window.showQuickPick(
      ctl.model.sol.configs.map((c) => ({ label: configLabel(ctl.model.sol, c), cfg: c, description: c === ctl.model.config ? 'active' : '' })), { placeHolder: 'Solution configuration' });
    if (pick) await ctl.setConfig(pick.cfg);
  });

  reg('slnExplorer.reveal', async (id) => {
    const node = tree.cache.get(`prj:${id}`);
    if (node) await view.reveal(node, { select: true, focus: true });
  });

  // ---- build ----------------------------------------------------------------------------------

  const solutionAction = (action) => () => (needModel() ? runner.run({ ids: null, action }) : null);
  reg('slnExplorer.buildSolution', solutionAction('build'));
  reg('slnExplorer.rebuildSolution', solutionAction('rebuild'));
  reg('slnExplorer.cleanSolution', solutionAction('clean'));
  reg('slnExplorer.cancelBuild', () => runner.cancel());

  const projectAction = (action, withDeps) => async (node) => {
    const e = await pickProject(node, `Project to ${action}`);
    if (e) await runner.run({ ids: [e.sln.id], action, withDeps });
  };
  reg('slnExplorer.build', projectAction('build', true));
  reg('slnExplorer.buildOnly', projectAction('build', false));
  reg('slnExplorer.rebuild', projectAction('rebuild', true));
  reg('slnExplorer.clean', projectAction('clean', false));

  reg('slnExplorer.buildStartup', async () => {
    if (!needModel()) return;
    const id = ctl.startupId;
    if (!id || !ctl.model.entries.has(id)) { warn('No startup project is set. Right-click a project and choose "Set as Startup Project".'); return; }
    await runner.run({ ids: [id], action: 'build', withDeps: true });
  });
  reg('slnExplorer.setStartup', async (node) => {
    const e = await pickProject(node, 'Startup project');
    if (e) await ctl.setStartup(e.sln.id);
  });

  reg('slnExplorer.showBuildOrder', () => {
    if (!needModel()) return;
    try {
      const steps = plan(ctl.model, { ids: null, action: 'build' });
      runner.out.appendLine(`\nBuild order - ${ctl.model.sol.name} - ${configLabel(ctl.model.sol, ctl.model.config)}`);
      steps.forEach((s, i) => {
        const deps = ctl.model.entries.get(s.id).deps.map((d) => ctl.model.entries.get(d).sln.name);
        runner.out.appendLine(`  ${i + 1}. ${s.name}${deps.length ? `   (after ${deps.join(', ')})` : ''}${s.command ? '' : `   [skipped: ${s.skip}]`}`);
        if (s.command) runner.out.appendLine(`       ${s.command}`);
      });
      runner.out.show(true);
    } catch (e) { vscode.window.showErrorMessage(e.message); }
  });

  // ---- build actions (per project) ------------------------------------------------------------

  reg('slnExplorer.editAction', async (node) => {
    const e = entryOf(node);
    if (!e || !node.action) return;
    const pd = e.data;
    if (pd.kind !== 'makefile') {
      const c = await vscode.window.showInformationMessage(
        `${e.sln.name} is not a Makefile project: its ${node.action} command is generated from the project type. Makefile (NMake) projects have editable build actions.`, 'Open Project File');
      if (c) vscode.commands.executeCommand('slnExplorer.openProjectFile', node);
      return;
    }
    const prop = NMAKE_PROP[node.action];
    const raw = edit.getRawConfigProperty(pd, prop);
    const val = await vscode.window.showInputBox({
      title: `${prop} - ${e.sln.name} (${configLabel(ctl.model.sol, `${pd.config}|${pd.platform}`)})`,
      prompt: 'Command line run in the project folder. $(Configuration), $(Platform), $(ProjectName) ... are expanded.',
      value: raw, ignoreFocusOut: true,
    });
    if (val === undefined || val === raw) return;
    await ctl.run(() => edit.setConfigProperty(pd, prop, val), 'Edit build action');
  });

  reg('slnExplorer.runAction', async (node) => {
    const e = entryOf(node);
    if (e && node.action) await runner.run({ ids: [e.sln.id], action: node.action, withDeps: false });
  });

  reg('slnExplorer.openProjectFile', async (node) => {
    const e = await pickProject(node, 'Project');
    if (e) await vscode.window.showTextDocument(vscode.Uri.file(e.data.file));
  });

  // ---- dependencies ---------------------------------------------------------------------------

  /** Writes the complete dependency set of one project to wherever each dependency lives. */
  async function applyDependencies(id, wantIds) {
    const m = ctl.model;
    const e = m.entries.get(id);
    const storage = cfg().get('dependencyStorage');
    const want = new Set(wantIds);
    const src = dependencySources(m, id);
    await ctl.run(() => {
      if (m.sol.format === 'slnx') {
        slnEdit.setSlnxDependencies(m.sol.file, e.sln.relPath, [...want].map((d) => m.entries.get(d).sln.relPath.replace(/\\/g, '/')));
        return;
      }
      // dependencies that live in ProjectReference items: drop the unwanted ones
      for (const [d, s] of src) {
        if (want.has(d) || !s.ref) continue;
        const t = m.entries.get(d);
        edit.removeProjectReference(e.data.file, null, (inc, node) => {
          const abs = path.resolve(e.data.dir, inc.replace(/\\/g, '/')).toLowerCase();
          const g = ((node.children.find((c) => c.name === 'Project') || { text: '' }).text || '').trim().toUpperCase();
          return abs === path.resolve(t.data.file).toLowerCase() || (g && `{${g.replace(/[{}]/g, '')}}` === t.sln.id);
        });
      }
      // the solution's own list: keep wanted, add new ones unless they are to be written as ProjectReference
      const keepSln = e.sln.deps.filter((d) => want.has(d));
      const fresh = [...want].filter((d) => !e.deps.includes(d));
      const newInSln = storage === 'solution' ? fresh : [];
      const text = fs.readFileSync(m.sol.file, 'utf8');
      const nextSln = [...keepSln, ...newInSln];
      if (nextSln.length !== e.sln.deps.length || nextSln.some((d, i) => d !== e.sln.deps[i])) fs.writeFileSync(m.sol.file, setSlnDependencies(text, id, nextSln), 'utf8');
      if (storage === 'projectReference') {
        for (const d of fresh) {
          const t = m.entries.get(d);
          edit.addProjectReference(e.data.file, path.relative(e.data.dir, t.data.file).replace(/\//g, '\\'), t.data.guid || t.sln.id);
        }
      }
    }, 'Edit dependencies');
  }

  reg('slnExplorer.editDependencies', async (node) => {
    const e = await pickProject(node, 'Project to edit dependencies of');
    if (!e) return;
    const m = ctl.model;
    const blocked = new Set(dependents(m, e.sln.id)); // depending on those would be a cycle
    const items = projectsOf(m).filter((p) => p.sln.id !== e.sln.id && !blocked.has(p.sln.id))
      .map((p) => ({ label: p.sln.name, description: p.sln.relPath, picked: e.deps.includes(p.sln.id), id: p.sln.id }));
    if (!items.length) { warn('There are no other projects this one could depend on.'); return; }
    const picks = await vscode.window.showQuickPick(items, {
      canPickMany: true, title: `Project Dependencies - ${e.sln.name}`,
      placeHolder: `Projects that ${e.sln.name} depends on (they are built first)`,
    });
    if (picks) await applyDependencies(e.sln.id, picks.map((p) => p.id));
  });

  reg('slnExplorer.removeDependency', async (node) => {
    const e = entryOf(node);
    if (!e || !node.depId) return;
    await applyDependencies(e.sln.id, e.deps.filter((d) => d !== node.depId));
  });

  // ---- remove a project from the solution --------------------------------------------------------

  /** Like Visual Studio's Remove: the solution forgets the project; its files stay on disk. */
  reg('slnExplorer.removeProject', async (node) => {
    // from the Delete key the command gets no node: use the selected project
    const sel = view.selection[0];
    const e = await pickProject(node || (sel && /^project/.test(sel.kind) ? sel : null), 'Project to remove from the solution');
    if (!e) return;
    const m = ctl.model;
    const id = e.sln.id;
    const deps = dependents(m, id).map((d) => m.entries.get(d).sln.name);
    const src = [...m.entries.values()].filter((o) => !o.sln.isFolder && o.sln.id !== id && dependencySources(m, o.sln.id).get(id)?.ref)
      .map((o) => o.sln.name);
    const lines = [`Remove "${e.sln.name}" from the solution? Its files are not deleted.`];
    if (deps.length) lines.push(`Projects that depend on it lose that dependency: ${deps.join(', ')}.`);
    if (src.length) lines.push(`${src.join(', ')} still list it as a ProjectReference in their project files; those are not changed.`);
    const ok = await vscode.window.showWarningMessage(lines[0], { modal: true, detail: lines.slice(1).join('\n') }, 'Remove');
    if (ok !== 'Remove') return;
    await ctl.run(() => {
      if (m.sol.format === 'slnx') slnEdit.removeProjectFromSlnx(m.sol.file, e.sln.relPath);
      else fs.writeFileSync(m.sol.file, slnEdit.removeProjectFromSln(fs.readFileSync(m.sol.file, 'utf8'), id), 'utf8');
    }, 'Remove project');
    if (ctl.startupId === id) await ctl.setStartup(null);
  });

  // ---- filters and files ----------------------------------------------------------------------

  const needFilters = (e) => {
    if (e.data.sdk || e.data.kind === 'dotnet') { warn('This project lists its files by folder; filters exist for C++ style projects.'); return false; }
    return true;
  };

  reg('slnExplorer.newFilter', async (node) => {
    const e = entryOf(node);
    if (!e || !needFilters(e)) return;
    const parent = node.kind === 'filter' ? node.filter : '';
    const name = await vscode.window.showInputBox({ title: 'New filter', prompt: parent ? `Inside "${parent}"` : 'Filter name', validateInput: (v) => (/[\\/:*?"<>|]/.test(v) ? 'Invalid character' : validateName(v)) });
    if (!name) return;
    await ctl.run(() => edit.addFilter(e.data.file, parent ? `${parent}\\${name}` : name), 'New filter');
  });

  reg('slnExplorer.renameFilter', async (node) => {
    const e = entryOf(node);
    if (!e || node.kind !== 'filter') return;
    const leaf = node.filter.split('\\').pop();
    const name = await vscode.window.showInputBox({ title: 'Rename filter', value: leaf, validateInput: (v) => (/[\\/:*?"<>|]/.test(v) ? 'Invalid character' : validateName(v)) });
    if (!name || name === leaf) return;
    const parts = node.filter.split('\\'); parts[parts.length - 1] = name;
    await ctl.run(() => edit.renameFilter(e.data.file, node.filter, parts.join('\\')), 'Rename filter');
  });

  reg('slnExplorer.deleteFilter', async (node) => {
    const e = entryOf(node);
    if (!e || node.kind !== 'filter') return;
    await ctl.run(() => edit.removeFilter(e.data.file, node.filter), 'Delete filter');
  });

  reg('slnExplorer.addExistingFile', async (node) => {
    const e = await pickProject(node, 'Add the file to which project?');
    if (!e) return;
    if (e.data.sdk) { warn('SDK-style projects include every file in their folder automatically.'); return; }
    const uris = await vscode.window.showOpenDialog({ canSelectMany: true, defaultUri: vscode.Uri.file(e.data.dir), title: `Add to ${e.sln.name}` });
    if (!uris) return;
    const filter = node && node.kind === 'filter' ? node.filter : null;
    const types = cfg().get('itemTypes') || {};
    await ctl.run(() => {
      for (const u of uris) {
        const rel = path.relative(e.data.dir, u.fsPath).replace(/\//g, '\\');
        edit.addItem(e.data.file, edit.itemTypeFor(u.fsPath, types), rel, e.data.filtersFile || filter ? filter : null);
      }
    }, 'Add file');
  });

  reg('slnExplorer.removeFromProject', async (node) => {
    const e = entryOf(node);
    if (!e || !node.include) return;
    await ctl.run(() => edit.removeItem(e.data.file, node.include), 'Remove file');
  });

  reg('slnExplorer.revealInOS', (node) => {
    const f = node.file || (entryOf(node) && entryOf(node).data.file) || ctl.solutionFile;
    if (f) vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(f));
  });
  reg('slnExplorer.copyPath', (node) => {
    const f = node.file || (entryOf(node) && entryOf(node).data.file) || ctl.solutionFile;
    if (f) vscode.env.clipboard.writeText(f);
  });

  // ---- new project from a template ------------------------------------------------------------

  const templateRoots = () => [
    ...defaultTemplateRoots(), path.join(context.globalStorageUri.fsPath, 'templates'),
    ...(cfg().get('templateFolders') || []),
  ].filter((p) => fs.existsSync(p));

  reg('slnExplorer.importTemplate', async () => {
    const u = await vscode.window.showOpenDialog({ canSelectMany: true, filters: { 'Project templates': ['zip'] }, title: 'Import project template(s)' });
    if (!u) return;
    const dest = path.join(context.globalStorageUri.fsPath, 'templates');
    fs.mkdirSync(dest, { recursive: true });
    let n = 0;
    for (const f of u) {
      try {
        const z = new ZipArchive(f.fsPath);
        if (!z.entries.some((x) => !x.name.includes('/') && /\.vstemplate$/i.test(x.name))) { warn(`${path.basename(f.fsPath)} has no .vstemplate at its root; skipped.`); continue; }
        fs.copyFileSync(f.fsPath, path.join(dest, path.basename(f.fsPath)));
        n++;
      } catch (e) { warn(`${path.basename(f.fsPath)}: ${e.message}`); }
    }
    if (n) vscode.window.showInformationMessage(`Imported ${n} template${n === 1 ? '' : 's'}.`);
  });

  reg('slnExplorer.newProject', async () => {
    const templates = discoverTemplates(templateRoots());
    if (!templates.length) {
      const c = await vscode.window.showInformationMessage('No project templates found. Visual Studio keeps them in Documents\\Visual Studio <version>\\Templates\\ProjectTemplates. You can import template .zip files or add folders in the settings.', 'Import Template...', 'Open Settings');
      if (c === 'Import Template...') vscode.commands.executeCommand('slnExplorer.importTemplate');
      else if (c) vscode.commands.executeCommand('workbench.action.openSettings', 'slnExplorer.templateFolders');
      return;
    }
    const pick = await vscode.window.showQuickPick(
      templates.map((t) => ({ label: t.name, description: t.description && t.description !== t.name ? t.description : '', detail: t.origin, t })),
      { placeHolder: 'Project template', matchOnDescription: true });
    if (!pick) return;
    const t = pick.t;

    const m = ctl.model;
    const taken = new Set(m ? projectsOf(m).map((p) => p.sln.name.toLowerCase()) : []);
    let n = 1;
    const base = t.defaultName.replace(/\d+$/, '');
    while (taken.has(`${base}${n}`.toLowerCase()) || fs.existsSync(path.join(m ? m.sol.dir : '', `${base}${n}`))) n++;
    const projectName = await vscode.window.showInputBox({
      title: `New ${t.name}`, prompt: 'Project name', value: m ? `${base}${n}` : t.defaultName,
      validateInput: (v) => validateName(v) || (taken.has(v.toLowerCase()) ? 'A project with this name is already in the solution.' : null),
    });
    if (!projectName) return;

    let opt;
    if (m) {
      opt = { projectName, solutionFile: m.sol.file, location: m.sol.dir };
    } else {
      const wf = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0].uri.fsPath;
      const last = context.globalState.get('slnExplorer.lastLocation');
      const loc = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, defaultUri: vscode.Uri.file(last || wf || os.homedir()), openLabel: 'Select location', title: 'Where should the new solution be created?' });
      if (!loc) return;
      const location = loc[0].fsPath;
      await context.globalState.update('slnExplorer.lastLocation', location);
      const solutionName = await vscode.window.showInputBox({ title: 'Solution name', value: projectName, validateInput: (v) => validateName(v) });
      if (!solutionName) return;
      let sameDirectory = false;
      if (t.createNewFolder) {
        const same = await vscode.window.showQuickPick(
          [{ label: 'Project in its own folder', description: `${solutionName}/${projectName}/`, v: false }, { label: 'Place solution and project in the same directory', description: `${solutionName}/`, v: true }],
          { placeHolder: 'Layout' });
        if (!same) return;
        sameDirectory = same.v;
      }
      opt = { projectName, location, solutionName, sameDirectory };
    }

    let res;
    ctl._selfWrite = true;
    try {
      res = createFromTemplate(t, opt);
    } catch (e) {
      vscode.window.showErrorMessage(`New project: ${e.message}`);
      return;
    } finally { setTimeout(() => { ctl._selfWrite = false; }, 600); }

    await ctl.open(res.solutionFile);
    const inWorkspace = (vscode.workspace.workspaceFolders || []).some((f) => !path.relative(f.uri.fsPath, res.solutionFile).startsWith('..'));
    if (!inWorkspace) {
      const c = await vscode.window.showInformationMessage(`Created ${path.basename(res.solutionFile)} outside the open workspace.`, 'Add Folder to Workspace', 'Open Folder');
      if (c === 'Add Folder to Workspace') vscode.workspace.updateWorkspaceFolders((vscode.workspace.workspaceFolders || []).length, 0, { uri: vscode.Uri.file(path.dirname(res.solutionFile)) });
      else if (c === 'Open Folder') vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(path.dirname(res.solutionFile)));
    }
    const node = tree.cache.get(`prj:${[...ctl.model.entries.values()].find((p) => p.data && p.data.file === res.projectFile)?.sln.id}`);
    if (node) view.reveal(node, { select: true, focus: true }).then(undefined, () => {});
    vscode.window.setStatusBarMessage(`$(check) Created ${projectName} from ${t.name}`, 6000);
  });
}

module.exports = { register };
