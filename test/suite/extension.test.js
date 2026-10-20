'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const WS = process.env.SLNX_TEST_WORKSPACE;
let api;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, what = 'condition') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}
const kids = async (node) => api.tree.getChildren(node);
const solutionRoot = async () => (await kids()).find((n) => n.kind === 'solution');
const label = (n) => n.item.label;
const projectNode = async (name) => {
  const root = (await solutionRoot());
  return (await kids(root)).find((n) => n.kind !== 'solutionFolder' && label(n) === name);
};

/** Temporarily answers the next dialog calls (the commands are real; only the human is faked). */
function answer(map) {
  const saved = {};
  for (const [k, fn] of Object.entries(map)) { saved[k] = vscode.window[k]; vscode.window[k] = fn; }
  return () => { for (const [k, fn] of Object.entries(saved)) vscode.window[k] = fn; };
}

suite('Solution Explorer', function () {
  suiteSetup(async function () {
    const ext = vscode.extensions.getExtension('damnedangel.fudeba-solutionist');
    assert.ok(ext, 'extension is installed in the test host');
    api = await ext.activate();
    await until(() => api.controller.model, 15000, 'the solution to load');
  });

  test('finds the workspace solution and lists its projects', async () => {
    const top = (await kids())[0];
    assert.strictEqual(top.kind, 'config', 'the configuration row comes first');
    assert.match(label(top), /^Configuration: Debug$/, 'only Debug, no platform, when the solution has one platform');
    assert.strictEqual(top.item.command.command, 'fudebaSolutionist.selectConfiguration');
    const root = (await solutionRoot());
    assert.strictEqual(root.kind, 'solution');
    assert.match(label(root), /My Game with Overlays/);
    const names = (await kids(root)).map(label);
    assert.deepStrictEqual(names, ['Game', 'Overlay1']);
    assert.strictEqual(api.controller.model.config, 'Debug|x86');
  });

  test('a project shows its build actions, filters and files', async () => {
    const game = await projectNode('Game');
    const parts = await kids(game);
    assert.strictEqual(label(parts[0]), 'Build Actions');
    const actions = await kids(parts[0]);
    assert.deepStrictEqual(actions.map(label), ['Build', 'Rebuild', 'Clean']);
    assert.match(actions[0].item.description, /make\.py/);
    const filters = parts.filter((p) => p.kind === 'filter').map(label);
    assert.ok(filters.includes('ASM Source Files') && filters.includes('C Source Files'), filters.join());
    const c = parts.find((p) => label(p) === 'C Source Files');
    assert.ok((await kids(c)).some((f) => label(f) === 'mdo.c'));
  });

  test('per-project build actions are editable, only that property changes', async () => {
    const before = fs.readFileSync(path.join(WS, 'Game', 'Game.vcxproj'), 'utf8');
    const restore = answer({
      showInputBox: async (o) => (/NMakeBuildCommandLine/.test(o.title) ? 'echo Game>>..\\build.log' : /NMakeCleanCommandLine/.test(o.title) ? 'echo cleanGame>>..\\build.log' : undefined),
    });
    try {
      for (const a of ['build', 'clean']) {
        const game = await projectNode('Game');
        const node = (await kids((await kids(game))[0])).find((n) => n.action === a);
        await vscode.commands.executeCommand('fudebaSolutionist.editAction', node);
      }
    } finally { restore(); }
    const after = fs.readFileSync(path.join(WS, 'Game', 'Game.vcxproj'), 'utf8');
    const changed = before.split('\r\n').filter((l, i) => l !== after.split('\r\n')[i]);
    assert.strictEqual(changed.length, 2, `two lines changed: ${changed.join(' | ')}`);
    const game = await projectNode('Game');
    const acts = await kids((await kids(game))[0]);
    assert.match(acts[0].item.description, /echo Game/);
    // the other configuration is untouched
    await api.controller.setConfig('Release|x86');
    const rel = await projectNode('Game');
    assert.match((await kids((await kids(rel))[0]))[0].item.description, /make\.py Release/);
    await api.controller.setConfig('Debug|x86');
  });

  test('project dependencies come from the dependency dialog and show in the tree', async () => {
    const ovl = await projectNode('Overlay1');
    const gameId = [...api.controller.model.entries.values()].find((e) => e.sln.name === 'Game').sln.id;
    const restore = answer({
      showQuickPick: async (items, o) => {
        assert.match(o.title, /Project Dependencies - Overlay1/);
        assert.ok(o.canPickMany);
        assert.deepStrictEqual(items.map((i) => i.label), ['Game'], 'only projects that would not make a cycle');
        return items;
      },
    });
    try { await vscode.commands.executeCommand('fudebaSolutionist.editDependencies', ovl); } finally { restore(); }
    await until(() => api.controller.model.entries.get([...api.controller.model.entries.keys()].find((k) => api.controller.model.entries.get(k).sln.name === 'Overlay1')).deps.length === 1, 5000, 'dependency saved');
    const o2 = await projectNode('Overlay1');
    const deps = (await kids(o2)).find((n) => n.kind === 'deps');
    assert.ok(deps);
    const d = await kids(deps);
    assert.deepStrictEqual(d.map(label), ['Game']);
    assert.strictEqual(d[0].depId, gameId);
    assert.match(fs.readFileSync(path.join(WS, 'My Game with Overlays.sln'), 'utf8'), /ProjectSection\(ProjectDependencies\) = postProject/);

    // Game depending on Overlay1 would be a cycle: nothing is offered, so the dialog does not even open
    const g = await projectNode('Game');
    let warned = '', picked = false;
    const restore2 = answer({ showQuickPick: async () => { picked = true; return undefined; }, showWarningMessage: async (m) => { warned = m; } });
    try { await vscode.commands.executeCommand('fudebaSolutionist.editDependencies', g); } finally { restore2(); }
    assert.ok(!picked);
    assert.match(warned, /no other projects/);
  });

  test('building a project builds its dependencies first, in order, through real tasks', async () => {
    const log = path.join(WS, 'build.log');
    // Overlay1's own build action (via the same editor the user would use)
    const restore = answer({ showInputBox: async () => 'echo Overlay1>>..\\build.log' });
    try {
      const ovl = await projectNode('Overlay1');
      const node = (await kids((await kids(ovl))[0])).find((n) => n.action === 'build');
      await vscode.commands.executeCommand('fudebaSolutionist.editAction', node);
    } finally { restore(); }
    fs.rmSync(log, { force: true });
    const ok = await api.runner.run({ ids: [[...api.controller.model.entries.values()].find((e) => e.sln.name === 'Overlay1').sln.id], action: 'build' });
    assert.ok(ok, 'build reported success');
    assert.deepStrictEqual(fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => l.trim()), ['Game', 'Overlay1']);

    // without dependencies only the project itself
    fs.rmSync(log);
    await api.runner.run({ ids: [[...api.controller.model.entries.values()].find((e) => e.sln.name === 'Overlay1').sln.id], action: 'build', withDeps: false });
    assert.deepStrictEqual(fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => l.trim()), ['Overlay1']);
  });

  test('a failing project stops the solution build and is reported', async () => {
    const restore = answer({ showInputBox: async () => 'exit 3', showErrorMessage: async () => undefined });
    try {
      const game = await projectNode('Game');
      const node = (await kids((await kids(game))[0])).find((n) => n.action === 'build');
      await vscode.commands.executeCommand('fudebaSolutionist.editAction', node);
    } finally { restore(); }
    const restore2 = answer({ showErrorMessage: async () => undefined });
    let ok;
    try { ok = await api.runner.run({ ids: null, action: 'build' }); } finally { restore2(); }
    assert.strictEqual(ok, false);
  });

  test('build output lands in the Problems panel with explanations and quick fixes', async () => {
    // cmd.exe's echo keeps single quotes, /bin/sh's eats them: escape them on Linux so both print what a real tool prints
    const Q = process.platform === 'win32' ? "'" : "\\'";
    const cmd = "echo Processing C file mdo.c... && echo mdo.c:12: error 20: Undefined identifier 'x' && echo ..\\libs\\util\\printf.c:144: warning 196: pointer target lost const qualifier && echo ?ASlink-Warning-Undefined Global " + Q + "_foo" + Q + " referenced by module " + Q + "m" + Q + " && echo ERROR: Ship.zml:7: Duplicate member x in class Ship.";
    const restore = answer({ showInputBox: async (o) => (/NMakeBuildCommandLine/.test(o.title) ? cmd : undefined) });
    try {
      const game = await projectNode('Game');
      const node = (await kids((await kids(game))[0])).find((n) => n.action === 'build');
      await vscode.commands.executeCommand('fudebaSolutionist.editAction', node);
    } finally { restore(); }
    const gameId = [...api.controller.model.entries.values()].find((e) => e.sln.name === 'Game').sln.id;
    const ok = await api.runner.run({ ids: [gameId], action: 'build', withDeps: false });
    assert.ok(ok, 'diagnostics do not make the build fail by themselves');

    const dir = path.join(WS, 'Game');
    const mdo = vscode.languages.getDiagnostics(vscode.Uri.file(path.join(dir, 'mdo.c')));
    assert.strictEqual(mdo.length, 1);
    assert.deepStrictEqual([mdo[0].source, String(mdo[0].code), mdo[0].range.start.line, mdo[0].severity], ['SDCC', '20', 11, vscode.DiagnosticSeverity.Error]);
    assert.match(mdo[0].relatedInformation[0].message, /SDCC error 20|compile error/);

    const printf = vscode.languages.getDiagnostics(vscode.Uri.file(path.resolve(dir, '..', 'libs', 'util', 'printf.c')));
    assert.strictEqual(printf.length, 1, 'paths are resolved against the project folder');
    assert.strictEqual(printf[0].severity, vscode.DiagnosticSeverity.Warning);
    assert.match(printf[0].relatedInformation[0].message, /--disable-warning 196/);

    const zoo = vscode.languages.getDiagnostics(vscode.Uri.file(path.join(dir, 'Ship.zml')));
    assert.deepStrictEqual([zoo[0].source, zoo[0].range.start.line, zoo[0].message], ['ZOO', 6, 'Duplicate member x in class Ship.']);

    const proj = vscode.languages.getDiagnostics(vscode.Uri.file(path.join(dir, 'Game.vcxproj')));
    assert.strictEqual(proj.length, 1, 'a linker message with no file goes on the project');
    assert.strictEqual(proj[0].source, 'SDLD');
    assert.match(proj[0].relatedInformation[0].message, /'_foo' is referenced by module m/);

    fs.writeFileSync(path.join(dir, 'mdo.c'), Array.from({ length: 20 }, (_, i) => `/* line ${i + 1} */`).join('\n') + '\n');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(dir, 'mdo.c')));
    const actions = api.problems.provideCodeActions(doc, new vscode.Range(11, 0, 11, 1), { diagnostics: vscode.languages.getDiagnostics(doc.uri) });
    // and through VS Code's own quick-fix machinery (what the lightbulb uses)
    const viaVsCode = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', doc.uri, new vscode.Selection(11, 0, 11, 5), vscode.CodeActionKind.QuickFix.value, 10);
    assert.ok(viaVsCode.some((a) => /^Explain: SDCC error 20/.test(a.title)), `VS Code returned: ${viaVsCode.map((a) => a.title).join(' | ')}`);
    const titles = actions.map((a) => a.title);
    assert.ok(titles.some((t) => /^Explain: SDCC error 20/.test(t)), titles.join(' | '));
    assert.ok(titles.includes('Search the web for this error'));

    // a rebuild of the project replaces its old problems
    const restore2 = answer({ showInputBox: async (o) => (/NMakeBuildCommandLine/.test(o.title) ? 'echo all fine' : undefined) });
    try {
      const game = await projectNode('Game');
      const node = (await kids((await kids(game))[0])).find((n) => n.action === 'build');
      await vscode.commands.executeCommand('fudebaSolutionist.editAction', node);
    } finally { restore2(); }
    await api.runner.run({ ids: [gameId], action: 'build', withDeps: false });
    assert.strictEqual(vscode.languages.getDiagnostics(vscode.Uri.file(path.join(dir, 'mdo.c'))).length, 0);
  });

  test('filters: create, then move a file by drag and drop, then rename and delete', async () => {
    const game = await projectNode('Game');
    let restore = answer({ showInputBox: async () => 'Sounds' });
    try { await vscode.commands.executeCommand('fudebaSolutionist.newFilter', game); } finally { restore(); }
    await until(async () => (await kids(await projectNode('Game'))).some((n) => label(n) === 'Sounds'), 5000, 'new filter');

    const g2 = await projectNode('Game');
    const csrc = (await kids(g2)).find((n) => label(n) === 'C Source Files');
    const file = (await kids(csrc)).find((n) => label(n) === 'mdo.c');
    const sounds = (await kids(g2)).find((n) => label(n) === 'Sounds');
    const dt = new vscode.DataTransfer();
    api.tree.handleDrag([file], dt);
    await api.tree.handleDrop(sounds, dt);
    await until(async () => (await kids((await kids(await projectNode('Game'))).find((n) => label(n) === 'Sounds'))).some((f) => label(f) === 'mdo.c'), 5000, 'moved file');
    assert.match(fs.readFileSync(path.join(WS, 'Game', 'Game.vcxproj.filters'), 'utf8'), /<ClCompile Include="mdo\.c">\s*<Filter>Sounds<\/Filter>/);

    restore = answer({ showInputBox: async () => 'Audio' });
    try { await vscode.commands.executeCommand('fudebaSolutionist.renameFilter', (await kids(await projectNode('Game'))).find((n) => label(n) === 'Sounds')); } finally { restore(); }
    await until(async () => (await kids(await projectNode('Game'))).some((n) => label(n) === 'Audio'), 5000, 'renamed filter');

    // put it back, then the empty filter can go
    const g3 = await projectNode('Game');
    const audio = (await kids(g3)).find((n) => label(n) === 'Audio');
    const mdo = (await kids(audio)).find((f) => label(f) === 'mdo.c');
    const dt2 = new vscode.DataTransfer();
    api.tree.handleDrag([mdo], dt2);
    await api.tree.handleDrop((await kids(g3)).find((n) => label(n) === 'C Source Files'), dt2);
    await until(async () => !(await kids((await kids(await projectNode('Game'))).find((n) => label(n) === 'Audio'))).length, 5000, 'empty filter');
    await vscode.commands.executeCommand('fudebaSolutionist.deleteFilter', (await kids(await projectNode('Game'))).find((n) => label(n) === 'Audio'));
    await until(async () => !(await kids(await projectNode('Game'))).some((n) => label(n) === 'Audio'), 5000, 'filter deleted');
  });

  test('filters: drag a filter (with what it holds) into another filter and back to the project', async () => {
    const make = async (name) => {
      const r = answer({ showInputBox: async () => name });
      try { await vscode.commands.executeCommand('fudebaSolutionist.newFilter', await projectNode('Game')); } finally { r(); }
      await until(async () => (await kids(await projectNode('Game'))).some((n) => label(n) === name), 5000, `filter ${name}`);
    };
    const top = async (name) => (await kids(await projectNode('Game'))).find((n) => label(n) === name);
    await make('Outer');
    await make('Inner');
    const filtersFile = path.join(WS, 'Game', 'Game.vcxproj.filters');

    // put a file in Inner, so something travels with it
    const csrc = (await kids(await projectNode('Game'))).find((n) => label(n) === 'C Source Files');
    const file = (await kids(csrc)).find((n) => label(n) === 'mdo.c');
    const dt0 = new vscode.DataTransfer();
    api.tree.handleDrag([file], dt0);
    await api.tree.handleDrop(await top('Inner'), dt0);
    await until(async () => (await kids(await top('Inner'))).some((f) => label(f) === 'mdo.c'), 5000, 'file in Inner');

    // Inner into Outer; the destination opens to show what arrived
    const revealed = [];
    const realReveal = api.tree.view.reveal.bind(api.tree.view);
    api.tree.view.reveal = (n, o) => { revealed.push([n.id, o]); return realReveal(n, o); };
    const dt = new vscode.DataTransfer();
    api.tree.handleDrag([await top('Inner')], dt);
    const outerNode = await top('Outer');
    try { await api.tree.handleDrop(outerNode, dt); } finally { api.tree.view.reveal = realReveal; }
    assert.deepStrictEqual(revealed.map((r) => r[0]), [outerNode.id], 'the destination was revealed');
    assert.strictEqual(revealed[0][1].expand, true, 'and expanded');
    await until(async () => !(await top('Inner')), 5000, 'Inner left the project root');
    const outer = await top('Outer');
    const inner = (await kids(outer)).find((n) => label(n) === 'Inner');
    assert.ok(inner, 'Inner is inside Outer');
    assert.ok((await kids(inner)).some((f) => label(f) === 'mdo.c'), 'its file went with it');
    assert.match(fs.readFileSync(filtersFile, 'utf8'), /<Filter>Outer\\Inner<\/Filter>/);

    // a filter cannot go into itself or its own descendant
    const dt1 = new vscode.DataTransfer();
    api.tree.handleDrag([outer], dt1);
    const warned = answer({ showWarningMessage: async () => undefined });
    try { await api.tree.handleDrop(inner, dt1); } finally { warned(); }
    assert.ok(await top('Outer'), 'Outer is still at the project root');

    // and back to the project root: dropped on the project row
    const dt2 = new vscode.DataTransfer();
    api.tree.handleDrag([inner], dt2);
    await api.tree.handleDrop(await projectNode('Game'), dt2);
    await until(async () => !!(await top('Inner')), 5000, 'Inner is back at the project root');
    assert.ok((await kids(await top('Inner'))).some((f) => label(f) === 'mdo.c'));

    // tidy up: the file back, the filters gone
    const dt3 = new vscode.DataTransfer();
    api.tree.handleDrag([(await kids(await top('Inner'))).find((f) => label(f) === 'mdo.c')], dt3);
    await api.tree.handleDrop((await kids(await projectNode('Game'))).find((n) => label(n) === 'C Source Files'), dt3);
    await until(async () => !(await kids(await top('Inner'))).length, 5000, 'Inner is empty');
    await vscode.commands.executeCommand('fudebaSolutionist.deleteFilter', await top('Inner'));
    await vscode.commands.executeCommand('fudebaSolutionist.deleteFilter', await top('Outer'));
    await until(async () => !(await top('Inner')) && !(await top('Outer')), 5000, 'filters deleted');
  });

  test('the explorer in an editor tab: same rows, the menus of the view, clicks, commands and drag and drop', async () => {
    await vscode.commands.executeCommand('fudebaSolutionist.openInEditor');
    const tp = api.treePanel.current;
    assert.ok(tp, 'the tab is open');
    let last = null;
    const realPost = tp.panel.webview.postMessage.bind(tp.panel.webview);
    tp.panel.webview.postMessage = (m) => { last = m; return realPost(m); };
    try {
      await tp.onMessage({ type: 'ready' });
      assert.strictEqual(last.type, 'tree');
      assert.strictEqual(last.roots[0].kind, 'config');
      const sln = last.roots.find((r) => r.kind === 'solution');
      assert.ok(sln.open && sln.children.length, 'the solution row is open, with its projects');
      const game = sln.children.find((c) => c.label === 'Game');
      assert.ok(game.droppable && game.children.some((c) => c.kind === 'actions'));
      const titles = last.menus[game.cv].menu.map((e) => e.title);
      assert.ok(titles.includes('Rebuild') && titles.includes('Set as Startup Project') && titles.includes('Remove from Solution...'), titles.join());
      assert.ok(last.menus[game.cv].inline.some((e) => e.command === 'fudebaSolutionist.build'), 'the inline Build button');
      assert.ok(!last.menus['file'].menu.some((e) => e.command === 'fudebaSolutionist.deleteFilter'), 'filter commands are not offered on a file');
      assert.ok(last.toolbar.buttons.some((b) => b.command === 'fudebaSolutionist.buildSolution' && b.codicon === 'play'));
      assert.ok(last.toolbar.more.some((b) => b.command === 'fudebaSolutionist.openSolution'));

      // a click runs the command of the row
      const opened = [];
      const realExec = vscode.commands.executeCommand;
      vscode.commands.executeCommand = (c, ...a) => { opened.push(c); return c === 'fudebaSolutionist.selectConfiguration' ? undefined : realExec(c, ...a); };
      try { await tp.onMessage({ type: 'click', id: 'cfg' }); } finally { vscode.commands.executeCommand = realExec; }
      assert.deepStrictEqual(opened, ['fudebaSolutionist.selectConfiguration']);

      // a command from a menu gets the node: make a filter, drop a file on it, drop the file back
      const r = answer({ showInputBox: async () => 'TabF' });
      try { await tp.onMessage({ type: 'run', command: 'fudebaSolutionist.newFilter', id: game.id }); } finally { r(); }
      const top = async (name) => (await kids(await projectNode('Game'))).find((n) => label(n) === name);
      await until(() => top('TabF'), 5000, 'filter TabF');
      const csrc = (await kids(await projectNode('Game'))).find((n) => label(n) === 'C Source Files');
      const file = (await kids(csrc)).find((n) => label(n) === 'mdo.c');
      await tp.onMessage({ type: 'drop', target: (await top('TabF')).id, sources: [file.id] });
      await until(async () => (await kids(await top('TabF'))).some((f) => label(f) === 'mdo.c'), 5000, 'file dropped on the filter');
      await until(() => last.roots && JSON.stringify(last.roots).includes('"TabF"'), 5000, 'the tab shows the change');
      const moved = (await kids(await top('TabF'))).find((f) => label(f) === 'mdo.c');
      await tp.onMessage({ type: 'drop', target: csrc.id, sources: [moved.id] });
      await until(async () => (await kids(await top('TabF'))).length === 0, 5000, 'file back');
      await vscode.commands.executeCommand('fudebaSolutionist.deleteFilter', await top('TabF'));
      await until(async () => !(await top('TabF')), 5000, 'filter deleted');
    } finally {
      tp.panel.webview.postMessage = realPost;
      tp.panel.dispose();
    }
    assert.strictEqual(api.treePanel.current, null, 'closing the tab frees the slot');
  });

  test('remove a project from the solution: files stay, dependency lines go, startup is cleared', async () => {
    const file = api.controller.model.sol.file;
    const original = fs.readFileSync(file);
    const g = await projectNode('Game');
    const guid = g.projectId.replace(/[{}]/g, '');
    await api.controller.setStartup(g.projectId);
    const restore = answer({ showWarningMessage: async () => 'Remove' });
    try {
      await vscode.commands.executeCommand('fudebaSolutionist.removeProject', g);
      await until(async () => !(await kids(await solutionRoot())).some((n) => label(n) === 'Game'), 5000, 'project removed from the tree');
      assert.ok(!fs.readFileSync(file, 'utf8').toUpperCase().includes(guid.toUpperCase()), 'no trace of the project in the solution');
      assert.ok(fs.existsSync(path.join(WS, 'Game', 'Game.vcxproj')), 'the project files are not deleted');
      assert.strictEqual(api.controller.startupId, null);
    } finally {
      restore();
      fs.writeFileSync(file, original);
      await api.controller.setStartup(null);
      api.controller.reload();
    }
    assert.ok(await projectNode('Game'), 'back after restoring the solution file');
  });

  test('project icon follows PROJECT_TYPE in Config/ApplicationSettings.txt (ROM, COM for DOS, BIN, MDO)', async () => {
    const f = path.join(WS, 'Game', 'Config', 'ApplicationSettings.txt');
    const had = fs.existsSync(f);
    const before = had ? fs.readFileSync(f) : null;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    try {
      for (const [type, svg] of [['ROM', 'project.rom'], ['DOS', 'project.com'], ['BIN', 'project.bin'], ['MDO', 'project.mdo']]) {
        fs.writeFileSync(f, `;\tProject Type\r\n;PROJECT_TYPE\tROM\r\nPROJECT_TYPE\t\t\t${type}\r\n`);
        api.controller.reload();
        assert.match((await projectNode('Game')).item.iconPath.dark.fsPath, new RegExp(`${svg.replace('.', '\\.')}\\.svg$`), type);
        assert.match((await solutionRoot()).item.iconPath.dark.fsPath, /solution\.msx\.svg$/, `${type}: a solution with an MSX project shows the Aleste ship`);
      }
      fs.writeFileSync(f, 'PROJECT_TYPE\tSOMETHING_ELSE\r\n');
      api.controller.reload();
      assert.match((await projectNode('Game')).item.iconPath.dark.fsPath, /project\.makefile\.svg$/, 'unknown type: the default icon');
      assert.match((await solutionRoot()).item.iconPath.dark.fsPath, /[\\/]solution\.svg$/, 'no MSX project: the plain solution icon');
    } finally {
      if (had) fs.writeFileSync(f, before); else fs.rmSync(f, { force: true });
      api.controller.reload();
    }
  });

  test('icons switch while running: built-in set, codicons, an icon folder, and single overrides', async () => {
    const cfg = vscode.workspace.getConfiguration('fudebaSolutionist');
    const W = vscode.ConfigurationTarget.Workspace;
    const iconOf = async () => (await projectNode('Game')).item.iconPath;
    const waitIcon = async (pred, what) => until(async () => { const i = await iconOf(); return pred(i) ? i : null; }, 8000, what);
    try {
      let i = await iconOf();
      assert.match(i.dark.fsPath, /project\.makefile\.svg$/, 'default is the built-in Visual Studio style set');
      assert.match(i.light.fsPath, /light/);

      await cfg.update('iconTheme', 'codicons', W);
      i = await waitIcon((x) => x.id === 'tools', 'codicons');
      assert.strictEqual(i.id, 'tools');

      // a folder with Image Library style names: the project icon changes, others keep the built-in ones
      const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'slnx-icons-'));
      fs.writeFileSync(path.join(dir, 'CPPProjectNode_16x.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
      await cfg.update('iconFolder', dir, W);
      await cfg.update('iconTheme', 'folder', W);
      i = await waitIcon((x) => x.dark && /CPPProjectNode_16x\.svg$/.test(x.dark.fsPath), 'folder icon');
      const root = (await solutionRoot());
      assert.match(root.item.iconPath.dark.fsPath, /solution\.svg$/, 'icons the folder lacks come from the built-in set');

      // dropping a file into the folder takes effect without any action
      fs.writeFileSync(path.join(dir, 'Solution_16x.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
      const t0 = Date.now();
      await until(async () => /Solution_16x\.svg$/.test(((await solutionRoot())).item.iconPath.dark.fsPath), 25000, 'new file picked up');
      console.log(`      (icon file noticed after ${Date.now() - t0} ms)`);

      // one override on top
      await cfg.update('icons', { 'project.makefile': 'rocket' }, W);
      i = await waitIcon((x) => x.id === 'rocket', 'override');
      assert.strictEqual(i.id, 'rocket');
      await cfg.update('icons', undefined, W);
      await waitIcon((x) => x.dark && /CPPProjectNode_16x/.test(x.dark.fsPath), 'override removed');

      // files: file icon theme by default, our icon on request
      fs.writeFileSync(path.join(WS, 'Game', 'mdo.c'), '/* exists */\n');
      const files = async () => { const g = await projectNode('Game'); const c = (await kids(g)).find((n) => label(n) === 'C Source Files'); return (await kids(c)).find((n) => label(n) === 'mdo.c'); };
      assert.match((await files()).item.iconPath.dark.fsPath, /file\.c\.svg$/, 'a .c file gets the white sheet with the C badge by default');
      await cfg.update('fileIcons', 'fileTheme', W);
      await until(async () => (await files()).item.iconPath === vscode.ThemeIcon.File, 8000, 'file icon theme only');
    } finally {
      for (const k of ['iconTheme', 'iconFolder', 'icons', 'fileIcons']) await cfg.update(k, undefined, W);
    }
    await until(async () => /project\.makefile\.svg$/.test((await iconOf()).dark.fsPath), 8000, 'back to default');
  });

  test('configuration switch changes what every project builds', async () => {
    const restore = answer({ showQuickPick: async (items) => items.find((i) => i.label === 'Release') });
    try { await vscode.commands.executeCommand('fudebaSolutionist.selectConfiguration'); } finally { restore(); }
    await until(() => api.controller.model.config === 'Release|x86', 5000, 'config');
    assert.strictEqual([...api.controller.model.entries.values()][0].projectConfig, 'Release|Win32');
    await api.controller.setConfig('Debug|x86');
  });

  test('new project from the installed MSX templates', async function () {
    const { discoverTemplates, defaultTemplateRoots } = require('../../src/core/vstemplate');
    const roots = process.env.SLNX_TEMPLATE_ROOTS ? process.env.SLNX_TEMPLATE_ROOTS.split(path.delimiter) : defaultTemplateRoots();
    const ts = discoverTemplates(roots).filter((t) => /^MSX/.test(t.name));
    if (!ts.length) return this.skip();
    await vscode.workspace.getConfiguration('fudebaSolutionist').update('templateFolders', roots, vscode.ConfigurationTarget.Workspace);
    let seenTemplates;
    const restore = answer({
      showQuickPick: async (items) => { seenTemplates = items.map((i) => i.label); return items.find((i) => i.label === 'MSX-DOS Overlay'); },
      showInputBox: async (o) => (/^New /.test(o.title) ? 'Overlay2' : undefined),
    });
    try { await vscode.commands.executeCommand('fudebaSolutionist.newProject'); } finally { restore(); }
    assert.ok(seenTemplates.includes('MSX ROM Application') && seenTemplates.includes('MSX-DOS Overlay'), seenTemplates.join());
    await until(() => [...api.controller.model.entries.values()].some((e) => e.sln.name === 'Overlay2'), 10000, 'new project in solution');
    assert.ok(fs.existsSync(path.join(WS, 'Overlay2', 'Overlay2.vcxproj')));
    assert.ok(fs.existsSync(path.join(WS, 'Overlay2', 'Make', 'make.py')));
    const names = (await kids((await solutionRoot()))).map(label);
    assert.deepStrictEqual(names, ['Game', 'Overlay1', 'Overlay2']);
    const e = [...api.controller.model.entries.values()].find((x) => x.sln.name === 'Overlay2');
    assert.strictEqual(e.projectConfig, 'Debug|Win32');
    assert.ok(e.builds);
  });

  test('About box: version, the Claude credit, notices and diagnostics', async function () {
    await vscode.commands.executeCommand('fudebaSolutionist.about');
    const about = api.about.current;
    assert.ok(about, 'the About panel is open');
    const html = about.panel.webview.html;
    const pkg = require('../../package.json');
    assert.ok(html.includes(`Version ${pkg.version}`) && html.includes(pkg.displayName));
    assert.match(html, /id="made-with-claude">[\s\S]*?Author:[\s\S]*?<\/b>[^<]*\baid\b[^<]*Anthropic Claude/, 'the credit box names the author and says Claude aided');
    assert.match(html, /Aleste/);
    assert.match(html, /generic Microsoft Visual Studio solutions/);
    assert.match(html, /<b>specialized MSX features<\/b>/);
    assert.ok(html.includes('https://github.com/DamnedAngel/MSX-Templates-for-VisualStudio') && html.includes('https://github.com/DamnedAngel/Zoo'), 'links to the templates and to ZOO');
    const d = about.diagnostics();
    assert.match(d, new RegExp(`${pkg.displayName} ${pkg.version.replace(/\./g, '\\.')}`));
    assert.match(d, /VS Code \d+\.\d+/);
    assert.match(d, /Solution: .*\.sln/);
    await about.onMessage({ type: 'copy' });
    assert.strictEqual(await vscode.env.clipboard.readText(), d, 'Copy diagnostics puts the text on the clipboard');
    // opening it again reuses the panel
    await vscode.commands.executeCommand('fudebaSolutionist.about');
    assert.strictEqual(api.about.current, about);
    about.panel.dispose();
  });

  test('Create a New Solution: File > New File, the Welcome walkthrough and the empty tree lead to a command that creates it', async function () {
    this.timeout(30000);
    const pkg = require('../../package.json');
    const c = pkg.contributes;
    assert.ok(c.menus['file/newFile'].some((m) => m.command === 'fudebaSolutionist.newSolution'), 'an entry in File > New File...');
    assert.ok(c.walkthroughs[0].steps.some((s) => /command:fudebaSolutionist\.newSolution/.test(s.description)), 'a step of the Welcome walkthrough');
    assert.ok(c.viewsWelcome.some((v) => v.view === 'fudebaSolutionist.tree' && /command:fudebaSolutionist\.newSolution/.test(v.contents)), 'the empty tree offers it');
    const all = await vscode.commands.getCommands(true);
    for (const link of JSON.stringify([c.viewsWelcome, c.walkthroughs]).match(/command:[A-Za-z.]+/g)) assert.ok(all.includes(link.slice(8)), `${link} is a registered command`);
    for (const s of c.walkthroughs[0].steps) assert.ok(fs.existsSync(path.join(__dirname, '..', '..', s.media.markdown)), `${s.media.markdown} exists`);

    const original = api.controller.model.sol.file;
    const loc = fs.mkdtempSync(path.join(require('os').tmpdir(), 'slnx-newsol-'));
    const run = async (name, quick) => {
      const restore = answer({
        showOpenDialog: async () => [vscode.Uri.file(loc)],
        showInputBox: async () => name,
        showQuickPick: quick || (async () => { throw new Error('the format must not be asked'); }),
        showInformationMessage: async () => undefined,
        showErrorMessage: async (m) => { throw new Error(`error shown to the user: ${m}`); },
      });
      try { await vscode.commands.executeCommand('fudebaSolutionist.newSolution'); } finally { restore(); }
    };
    try {
      // the format is asked (the default) ...
      await run('MySolution', async (items) => items.find((i) => i.f === 'slnx'));
      const slnx = path.join(loc, 'MySolution', 'MySolution.slnx');
      const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(); // VS Code lower-cases the drive letter
      await until(() => api.controller.model && same(api.controller.model.sol.file, slnx), 8000, 'the new solution is open');
      assert.match(fs.readFileSync(slnx, 'utf8'), /^<Solution>/);
      assert.deepStrictEqual(api.controller.model.sol.configs, ['Debug|x86', 'Release|x86']);
      assert.strictEqual((await solutionRoot()).item.label, "Solution 'MySolution'");
      // ... or fixed by the setting
      await vscode.workspace.getConfiguration('fudebaSolutionist').update('newSolutionFormat', 'sln', vscode.ConfigurationTarget.Workspace);
      await run('Second');
      const sln = path.join(loc, 'Second', 'Second.sln');
      assert.ok(fs.existsSync(sln));
      await until(() => same(api.controller.model.sol.file, sln), 8000, 'the second solution is open');
      assert.match(fs.readFileSync(sln, 'utf8'), /Microsoft Visual Studio Solution File, Format Version 12\.00/);
    } finally {
      await vscode.workspace.getConfiguration('fudebaSolutionist').update('newSolutionFormat', undefined, vscode.ConfigurationTarget.Workspace);
      await api.controller.open(original);
    }
  });

  test('a solution created from the Start page (no folder open) is shown once its folder has been opened', async function () {
    const file = api.controller.model.sol.file;
    const offered = [];
    const restore = answer({ showInformationMessage: async (msg, ...buttons) => { offered.push([msg, buttons]); return undefined; } });
    try {
      // parked for this solution: the view is shown and the offer is made
      await api.reveal.schedule(api.context, file, { addProject: true });
      assert.strictEqual(await api.reveal.runPending(api.context, api.controller), true);
      await until(() => offered.length === 1, 3000, 'the offer');
      assert.match(offered[0][0], /Created .*\.sln\. Add a project to it now\?/);
      assert.deepStrictEqual(offered[0][1], ['Add Project from Template...']);
      assert.strictEqual(api.context.globalState.get(api.reveal.KEY), undefined, 'the request is used up');
      // without the offer
      await api.reveal.schedule(api.context, file, {});
      assert.strictEqual(await api.reveal.runPending(api.context, api.controller), true);
      await sleep(200);
      assert.strictEqual(offered.length, 1, 'no offer when none was asked for');
      // parked for another solution: dropped
      await api.reveal.schedule(api.context, path.join(WS, 'Elsewhere', 'Other.sln'), { addProject: true });
      assert.strictEqual(await api.reveal.runPending(api.context, api.controller), false);
      assert.strictEqual(api.context.globalState.get(api.reveal.KEY), undefined);
      assert.strictEqual(await api.reveal.runPending(api.context, api.controller), false, 'nothing parked: nothing to do');
    } finally { restore(); }
  });

  test('MSX project settings dialog: opens for MSX projects only, shows the pages of its type, checks and saves', async function () {
    this.timeout(30000);
    const cfgDir = path.join(WS, 'Game', 'Config');
    const had = fs.existsSync(cfgDir);
    const backup = had ? fs.readdirSync(cfgDir).map((f) => [f, fs.readFileSync(path.join(cfgDir, f))]) : [];
    fs.mkdirSync(cfgDir, { recursive: true });
    for (const f of fs.readdirSync(path.join(__dirname, '..', 'fixtures', 'msx-config', 'ROM', 'Config'))) fs.copyFileSync(path.join(__dirname, '..', 'fixtures', 'msx-config', 'ROM', 'Config', f), path.join(cfgDir, f));
    try {
      api.controller.reload();
      const game = await projectNode('Game');
      assert.strictEqual(game.item.contextValue, 'project.msx', 'the settings button of the row is for MSX projects');
      const other = (await kids(await solutionRoot())).find((n) => label(n) === 'Overlay1');
      assert.ok(other && !/\.msx$/.test(other.item.contextValue), 'a non-MSX project has no settings button');

      await vscode.commands.executeCommand('fudebaSolutionist.projectProperties', game);
      const panel = api.properties.panels.get(game.projectId);
      assert.ok(panel, 'the dialog is open');
      assert.strictEqual(panel.type, 'ROM');
      await panel.onMessage({ type: 'ready' });
      const init = panel.sent.find((m) => m.type === 'init');
      const files = init.state.pages.map((p) => p.file);
      assert.deepStrictEqual(files, ['ApplicationSettings.txt', 'TargetConfig_Debug.txt', 'TargetConfig_Release.txt', 'ApplicationSources.txt', 'LibrarySources.txt', 'Libraries.txt', 'IncludeDirectories.txt', 'Symbols.txt', 'BuildEvents.txt'], 'one page per file, specific to a ROM project');
      assert.deepStrictEqual(init.issues.filter((i) => i.severity === 'error'), [], 'the template files have no errors');
      assert.ok(init.issues.some((i) => /was not found/.test(i.message)), 'the sources the template lists are not in this test project: reported as not found, as warnings');

      // the context check runs while editing
      const pages = JSON.parse(JSON.stringify(init.state.pages));
      const field = (k) => pages[0].groups.flatMap((g) => g.fields).find((f) => f.key === k);
      field('STACK_HIMEM').value = '_ON';
      await panel.onMessage({ type: 'validate', pages });
      assert.ok(panel.sent.filter((m) => m.type === 'issues').pop().issues.some((i) => i.severity === 'error' && /RETURN_TO_BASIC/.test(i.message)));
      // ... and an error stops the save
      await panel.onMessage({ type: 'save', pages, close: false });
      assert.ok(panel.sent.some((m) => m.type === 'saveFailed'));
      assert.match(fs.readFileSync(path.join(cfgDir, 'ApplicationSettings.txt'), 'utf8'), /^STACK_HIMEM\s+_OFF/m, 'nothing was written');

      // a valid change is saved, only in the file it belongs to
      field('STACK_HIMEM').value = '_OFF';
      field('ROM_SIZE').value = '32k';
      await panel.onMessage({ type: 'save', pages, close: false });
      assert.match(fs.readFileSync(path.join(cfgDir, 'ApplicationSettings.txt'), 'utf8'), /^ROM_SIZE\s+32k/m);
      const after = panel.sent.filter((m) => m.type === 'init').pop();
      assert.strictEqual(after.state.pages[0].groups.flatMap((g) => g.fields).find((f) => f.key === 'ROM_SIZE').value, '32k', 'the dialog is given the saved state');
      panel.panel.dispose();

      // a file the template defines but the project lacks (neither on disk nor in the project): shown, created on request
      const edit = require('../../src/core/edit');
      const vcx = path.join(WS, 'Game', 'Game.vcxproj');
      fs.rmSync(path.join(cfgDir, 'Symbols.txt'));
      edit.removeItem(vcx, 'Config\\Symbols.txt');
      await until(() => !api.properties.panels.has(game.projectId), 5000, 'dialog closed');
      api.controller.reload();
      await vscode.commands.executeCommand('fudebaSolutionist.projectProperties', await projectNode('Game'));
      const p2 = api.properties.panels.get(game.projectId);
      await p2.onMessage({ type: 'ready' });
      const init2 = p2.sent.filter((m) => m.type === 'init').pop();
      const sym = init2.state.pages.find((p) => p.file === 'Symbols.txt');
      assert.ok(sym && sym.missing, 'the missing file has its page, marked as missing');
      assert.ok(sym.items.length >= 1, 'filled with the template\'s entries');
      const pages2 = JSON.parse(JSON.stringify(init2.state.pages));
      await p2.onMessage({ type: 'save', pages: pages2, close: false });
      assert.ok(!fs.existsSync(path.join(cfgDir, 'Symbols.txt')), 'an untouched missing file is not created by Apply');
      await p2.onMessage({ type: 'save', pages: pages2, close: false, create: ['Symbols.txt'] });
      assert.strictEqual(fs.readFileSync(path.join(cfgDir, 'Symbols.txt'), 'utf8'), fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'msx-config', 'ROM', 'Config', 'Symbols.txt'), 'utf8'), 'created as the template has it');
      assert.match(fs.readFileSync(vcx, 'utf8'), /<Text Include="Config\\Symbols\.txt"/, 'added to the project');
      assert.match(fs.readFileSync(`${vcx}.filters`, 'utf8'), /Config\\Symbols\.txt">\s*<Filter>Project Config<\/Filter>/, 'in the Config filter of the project');
      assert.ok(!p2.sent.filter((m) => m.type === 'init').pop().state.pages.some((p) => p.missing && p.file === 'Symbols.txt'), 'and no longer missing');
      p2.panel.dispose();
    } finally {
      fs.rmSync(cfgDir, { recursive: true, force: true });
      if (had) { fs.mkdirSync(cfgDir, { recursive: true }); for (const [f, b] of backup) fs.writeFileSync(path.join(cfgDir, f), b); }
      api.controller.reload();
    }
  });

  test('build / rebuild / clean apply the edits pending in the MSX settings dialog first', async function () {
    this.timeout(30000);
    const cfgDir = path.join(WS, 'Game', 'Config');
    const had = fs.existsSync(cfgDir);
    const backup = had ? fs.readdirSync(cfgDir).map((f) => [f, fs.readFileSync(path.join(cfgDir, f))]) : [];
    fs.mkdirSync(cfgDir, { recursive: true });
    for (const f of fs.readdirSync(path.join(__dirname, '..', 'fixtures', 'msx-config', 'ROM', 'Config'))) fs.copyFileSync(path.join(__dirname, '..', 'fixtures', 'msx-config', 'ROM', 'Config', f), path.join(cfgDir, f));
    try {
      api.controller.reload();
      const game = await projectNode('Game');
      await vscode.commands.executeCommand('fudebaSolutionist.projectProperties', game);
      const panel = api.properties.panels.get(game.projectId);
      await panel.onMessage({ type: 'ready' });
      const pages = JSON.parse(JSON.stringify(panel.sent.filter((m) => m.type === 'init').pop().state.pages));
      const field = (k) => pages[0].groups.flatMap((g) => g.fields).find((f) => f.key === k);
      // the dialog plays the page: on "flush" it sends its pending state like Apply does (or says it has nothing pending)
      let pending = null;
      const realPost = panel.post.bind(panel);
      panel.post = (m) => {
        if (m.type !== 'flush') realPost(m); // (the real page of the test host must not answer too)
        if (m.type === 'flush') setTimeout(() => panel.onMessage(pending ? { type: 'save', pages: pending, close: false, flush: true } : { type: 'flushed' }), 0);
      };
      assert.strictEqual(await api.properties.flushAll(), true, 'nothing pending: nothing to do');

      field('ROM_SIZE').value = '32k';
      pending = pages;
      assert.strictEqual(await api.properties.flushAll(), true);
      assert.match(fs.readFileSync(path.join(cfgDir, 'ApplicationSettings.txt'), 'utf8'), /^ROM_SIZE\s+32k/m, 'the pending edit was written');

      // pending edits with an error: not written, and no build is started
      field('STACK_HIMEM').value = '_ON';
      assert.strictEqual(await api.properties.flushAll(), false);
      assert.match(fs.readFileSync(path.join(cfgDir, 'ApplicationSettings.txt'), 'utf8'), /^STACK_HIMEM\s+_OFF/m);
      const before = api.runner.busy;
      assert.strictEqual(await api.runner.run({ ids: null, action: 'clean' }), false, 'the run is refused');
      assert.strictEqual(api.runner.busy, before, 'and nothing is left running');
      panel.panel.dispose();
    } finally {
      fs.rmSync(cfgDir, { recursive: true, force: true });
      if (had) { fs.mkdirSync(cfgDir, { recursive: true }); for (const [f, b] of backup) fs.writeFileSync(path.join(cfgDir, f), b); }
      api.controller.reload();
    }
  });

  test('another folder / another solution: the old solution is closed, and a solution from outside moves the window to its folder', async function () {
    this.timeout(30000);
    const ctl = api.controller;
    const home = ctl.solutionFile;
    assert.ok(home && ctl.inWorkspace(home), 'the test workspace solution is open');
    const ext = fs.mkdtempSync(path.join(require('os').tmpdir(), 'fudeba-ext-'));
    const extSln = path.join(ext, 'Elsewhere.sln');
    fs.writeFileSync(extSln, 'Microsoft Visual Studio Solution File, Format Version 12.00\r\nGlobal\r\nEndGlobal\r\n');
    const realExec = vscode.commands.executeCommand;
    const calls = [];
    try {
      // a solution that is not in an open folder is closed when the folders change; the folder's own solution is opened
      await ctl.open(extSln);
      assert.strictEqual(ctl.solutionFile, extSln);
      assert.ok(!ctl.inWorkspace(extSln));
      await ctl.syncWithWorkspace();
      assert.strictEqual(ctl.solutionFile, home, 'back on the solution of the open folder');
      await ctl.syncWithWorkspace();
      assert.strictEqual(ctl.solutionFile, home, 'a solution of the open folder is left alone');

      // opening a solution from another folder: the window is moved to that folder (here: the call is only observed)
      vscode.commands.executeCommand = (c, ...a) => { if (c === 'vscode.openFolder') { calls.push([c, ...a]); return Promise.resolve(); } return realExec(c, ...a); };
      const restore = answer({ showQuickPick: async (items) => items.find((i) => !i.file), showOpenDialog: async () => [vscode.Uri.file(extSln)] });
      try { await vscode.commands.executeCommand('fudebaSolutionist.openSolution'); } finally { restore(); vscode.commands.executeCommand = realExec; }
      assert.strictEqual(calls.length, 1, 'the window is asked to open the solution\'s folder');
      assert.strictEqual(calls[0][1].fsPath.toLowerCase(), ext.toLowerCase());
      const parked = api.context.globalState.get(api.reveal.KEY);
      assert.strictEqual(parked && parked.file.toLowerCase(), extSln.toLowerCase(), 'the choice waits for the restarted extension');
      assert.strictEqual(ctl.solutionFile, home, 'nothing is opened in this window: it is being replaced');
    } finally {
      vscode.commands.executeCommand = realExec;
      await api.context.globalState.update(api.reveal.KEY, undefined);
      fs.rmSync(ext, { recursive: true, force: true });
      await ctl.open(home);
    }
  });

  test('source control: files show checked in / changed / new marks from the git extension', async function () {
    this.timeout(60000);
    const gitExt = vscode.extensions.getExtension('vscode.git');
    if (!gitExt) return this.skip();
    const gitApi = (gitExt.isActive ? gitExt.exports : await gitExt.activate()).getAPI(1);
    const git = (...a) => require('child_process').execFileSync('git', a, { cwd: WS, stdio: 'pipe' });
    const mdo = path.join(WS, 'Game', 'mdo.c');
    fs.writeFileSync(mdo, '/* committed */\n');
    git('init'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'Test'); git('config', 'core.autocrlf', 'false');
    git('add', '-A'); git('commit', '-q', '-m', 'init');
    try {
      await gitApi.openRepository(vscode.Uri.file(WS));
      const iconOf = async () => {
        const g = await projectNode('Game');
        const c = (await kids(g)).find((n) => label(n) === 'C Source Files');
        const f = (await kids(c)).find((n) => label(n) === 'mdo.c');
        return { icon: f.item.iconPath.dark.fsPath, tip: f.item.tooltip };
      };
      api.tree.refresh();
      let r = await until(async () => { api.tree.refresh(); const x = await iconOf(); return /file\.c\+in\.svg$/.test(x.icon) ? x : null; }, 20000, 'checked in mark');
      assert.match(r.tip, /Checked in/);
      fs.writeFileSync(mdo, '/* changed */\n');
      const repo = gitApi.getRepository(vscode.Uri.file(WS));
      await repo.status();
      r = await until(async () => { api.tree.refresh(); const x = await iconOf(); return /file\.c\+mod\.svg$/.test(x.icon) ? x : null; }, 20000, 'changed mark');
      assert.match(r.tip, /Changed/);
      git('checkout', '--', 'Game/mdo.c');
      await repo.status();
      await until(async () => { api.tree.refresh(); return /file\.c\+in\.svg$/.test((await iconOf()).icon); }, 20000, 'checked in again');
      // the project row shows the state of its project file and its filters file; the solution row, that of the .sln
      const rowIcons = async () => {
        api.tree.refresh();
        const g = await projectNode('Game');
        const s = (await kids(undefined)).find((n) => n.kind === 'solution');
        return { project: g.item.iconPath.dark.fsPath, solution: s.item.iconPath.dark.fsPath };
      };
      await until(async () => { const x = await rowIcons(); return /project\.[a-z]+\+in\.svg$/.test(x.project) && /solution(\.msx)?\+in\.svg$/.test(x.solution); }, 20000, 'project and solution checked in');
      // a filter is created: only the .filters file changes, and the project row notices; the solution row does not
      const mk = answer({ showInputBox: async () => 'Marked' });
      try { await vscode.commands.executeCommand('fudebaSolutionist.newFilter', await projectNode('Game')); } finally { mk(); }
      await repo.status();
      let x = await until(async () => { const y = await rowIcons(); return /project\.[a-z]+\+mod\.svg$/.test(y.project) ? y : null; }, 20000, 'project marked as changed');
      assert.match(x.solution, /solution(\.msx)?\+in\.svg$/, 'the solution file did not change');
      git('checkout', '--', 'Game/Game.vcxproj.filters');
      await repo.status();
      await until(async () => /project\.[a-z]+\+in\.svg$/.test((await rowIcons()).project), 20000, 'project checked in again');
      // switched off by the setting: our plain icons again
      await vscode.workspace.getConfiguration('fudebaSolutionist').update('sourceControl.icons', false, vscode.ConfigurationTarget.Workspace);
      await until(async () => /file\.c\.svg$/.test((await iconOf()).icon), 10000, 'marks switched off');
    } finally {
      await vscode.workspace.getConfiguration('fudebaSolutionist').update('sourceControl.icons', undefined, vscode.ConfigurationTarget.Workspace);
      // the git extension may still hold files open on Windows; this is the last test and the folder is a temp copy
      try { fs.rmSync(path.join(WS, '.git'), { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* left for the OS temp cleaner */ }
    }
  });
});
