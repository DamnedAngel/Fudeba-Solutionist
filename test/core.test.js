'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadModel, topoOrder, projectsOf, dependencySources } = require('../src/core/model');
const { plan, commandFor, portableCommand, pythonFallback } = require('../src/core/build');
const edit = require('../src/core/edit');
const { loadProject } = require('../src/core/project');
const slnEdit = require('../src/core/slnEdit');
const { parseSln } = require('../src/core/sln');
const { discoverTemplates, defaultTemplateRoots, instantiate } = require('../src/core/vstemplate');
const { createFromTemplate, validateName } = require('../src/core/newProject');
const { evalCondition, Props } = require('../src/core/props');
const { parseXml } = require('../src/core/xml');

const FIX = path.join(__dirname, 'fixtures');
function work(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slnx-'));
  fs.cpSync(path.join(FIX, name), dir, { recursive: true });
  return dir;
}
const byName = (m, n) => projectsOf(m).find((e) => e.sln.name === n);

test('xml: positions survive, entities decode', () => {
  const src = '﻿<?xml version="1.0"?>\r\n<A x="1&amp;2">\r\n  <!-- c --><B/>\r\n  <C>t&lt;u</C>\r\n</A>';
  const a = parseXml(src).children[0];
  assert.strictEqual(a.attrs.x, '1&2');
  assert.deepStrictEqual(a.children.map((c) => c.name), ['B', 'C']);
  assert.strictEqual(a.children[1].text, 't<u');
  assert.strictEqual(src.slice(a.children[1].start, a.children[1].end), '<C>t&lt;u</C>');
});

test('conditions: the NMake configuration/platform idiom and boolean operators', () => {
  const p = new Props({ Configuration: 'Debug', Platform: 'Win32' });
  assert.ok(evalCondition("'$(Configuration)|$(Platform)'=='Debug|Win32'", p));
  assert.ok(!evalCondition("'$(Configuration)|$(Platform)'=='Release|Win32'", p));
  assert.ok(evalCondition("'$(Configuration)'=='debug' And '$(Platform)'!='x64'", p));
  assert.ok(evalCondition("'$(Nope)'=='' Or false", p));
  assert.ok(evalCondition('', p));
});

test('solution: MSX multi-project .sln is read with configurations and mapping', () => {
  const dir = work('msx-overlays');
  const m = loadModel(path.join(dir, 'My Game with Overlays.sln'), 'Debug|x86');
  assert.deepStrictEqual(m.sol.configs, ['Debug|x86', 'Release|x86']);
  assert.deepStrictEqual(projectsOf(m).map((e) => e.sln.name), ['Game', 'Overlay1']);
  const g = byName(m, 'Game');
  assert.strictEqual(g.projectConfig, 'Debug|Win32');
  assert.ok(g.builds);
  assert.strictEqual(g.data.kind, 'makefile');
  assert.strictEqual(g.data.guid, '{4BD08F44-14E0-48F1-8ACE-83B9363D7A6C}');
});

test('project: per-project build actions come from the NMake properties of the active configuration', () => {
  const dir = work('msx-overlays');
  const m = loadModel(path.join(dir, 'My Game with Overlays.sln'), 'Release|x86');
  const g = byName(m, 'Game');
  assert.strictEqual(g.data.props.get('NMakeBuildCommandLine'), 'python Make\\make.py Release');
  assert.strictEqual(commandFor(g, 'build', { win: true }).command, 'python Make\\make.py Release');
  assert.strictEqual(commandFor(g, 'clean', { win: true }).command, 'python Make\\make.py Release clean');
  assert.strictEqual(commandFor(g, 'rebuild', { win: true }).command, 'python Make\\make.py Release clean all');
  assert.match(g.data.props.get('NMakePreprocessorDefinitions'), /^WIN32NDEBUG;/);
});

test('project: filters give the virtual folder of each file', () => {
  const dir = work('msx-overlays');
  const pd = loadProject(path.join(dir, 'Game', 'Game.vcxproj'), { config: 'Debug', platform: 'Win32' });
  assert.ok(pd.filtersFile);
  assert.ok(pd.filters.includes('ASM Source Files\\MSX\\MSX-DOS'));
  assert.ok(pd.filters.includes('ASM Source Files'), 'ancestors are filters too');
  const mdo = pd.items.find((i) => i.include === 'mdo.c');
  assert.strictEqual(mdo.type, 'ClCompile');
  assert.strictEqual(mdo.filter, 'C Source Files');
  assert.ok(pd.items.some((i) => i.type === 'Text' && i.include === 'Config\\ApplicationSettings.txt'));
});

test('dependencies: solution-level edit, ordering, cycle detection', () => {
  const dir = work('msx-overlays');
  const file = path.join(dir, 'My Game with Overlays.sln');
  let m = loadModel(file, 'Debug|x86');
  const [game, ovl] = [byName(m, 'Game'), byName(m, 'Overlay1')];
  assert.deepStrictEqual(ovl.deps, []);

  const before = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, slnEdit.setSlnDependencies(before, ovl.sln.id, [game.sln.id]));
  const after = fs.readFileSync(file, 'utf8');
  assert.ok(after.includes('ProjectSection(ProjectDependencies) = postProject'));
  assert.ok(after.startsWith('﻿') === before.startsWith('﻿'), 'BOM kept');
  assert.ok(!/[^\r]\n/.test(after), 'CRLF kept');

  m = loadModel(file, 'Debug|x86');
  assert.deepStrictEqual(byName(m, 'Overlay1').deps, [game.sln.id]);
  assert.deepStrictEqual(topoOrder(m, [ovl.sln.id, game.sln.id]), [game.sln.id, ovl.sln.id]);

  const steps = plan(m, { ids: [ovl.sln.id], action: 'build' }, { win: true });
  assert.deepStrictEqual(steps.map((s) => s.name), ['Game', 'Overlay1'], 'building a project builds what it depends on first');
  assert.deepStrictEqual(plan(m, { ids: [ovl.sln.id], action: 'build', withDeps: false }, { win: true }).map((s) => s.name), ['Overlay1']);
  assert.deepStrictEqual(plan(m, { ids: null, action: 'clean' }, { win: true }).map((s) => s.name), ['Overlay1', 'Game'], 'clean runs dependents first');
  assert.deepStrictEqual(plan(m, { ids: null, action: 'rebuild' }, { win: true }).map((s) => s.name), ['Game', 'Overlay1']);

  // remove again
  fs.writeFileSync(file, slnEdit.setSlnDependencies(after, ovl.sln.id, []));
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'removing the only dependency restores the file byte for byte');

  // cycle
  let t = slnEdit.setSlnDependencies(before, ovl.sln.id, [game.sln.id]);
  t = slnEdit.setSlnDependencies(t, game.sln.id, [ovl.sln.id]);
  fs.writeFileSync(file, t);
  m = loadModel(file, 'Debug|x86');
  assert.throws(() => plan(m, { ids: null, action: 'build' }), /Circular project dependency/);
});

test('dependencies: ProjectReference counts too and is reported as such', () => {
  const dir = work('dotnet-slnx');
  const m = loadModel(path.join(dir, 'Demo.slnx'), 'Debug|Any CPU');
  const tool = byName(m, 'Tool');
  const lib = byName(m, 'Lib');
  assert.deepStrictEqual(tool.deps, [lib.sln.id]);
  assert.deepStrictEqual([...dependencySources(m, tool.sln.id).values()], [{ sln: false, ref: true }]);
  assert.deepStrictEqual(byName(m, 'App').deps, [lib.sln.id]);
  assert.deepStrictEqual(dependencySources(m, byName(m, 'App').sln.id).get(lib.sln.id), { sln: true, ref: false });
});

test('edit: changing a build action touches one line only', () => {
  const dir = work('msx-overlays');
  const file = path.join(dir, 'Game', 'Game.vcxproj');
  const orig = fs.readFileSync(file, 'utf8');
  const pd = loadProject(file, { config: 'Release', platform: 'Win32' });
  assert.strictEqual(edit.getRawConfigProperty(pd, 'NMakeBuildCommandLine'), 'python Make\\make.py $(Configuration)');
  edit.setConfigProperty(pd, 'NMakeBuildCommandLine', 'python Make\\make.py $(Configuration) --fast');
  const now = fs.readFileSync(file, 'utf8');
  const a = orig.split('\r\n'), b = now.split('\r\n');
  assert.strictEqual(a.length, b.length);
  const diff = a.map((l, i) => (l === b[i] ? null : i)).filter((x) => x !== null);
  assert.strictEqual(diff.length, 1);
  assert.match(b[diff[0]], /--fast/);
  const re = loadProject(file, { config: 'Release', platform: 'Win32' });
  assert.strictEqual(re.props.get('NMakeBuildCommandLine'), 'python Make\\make.py Release --fast');
  assert.strictEqual(loadProject(file, { config: 'Debug', platform: 'Win32' }).props.get('NMakeBuildCommandLine'), 'python Make\\make.py Debug');
});

test('edit: adding a missing action property creates it in the right configuration group', () => {
  const dir = work('msx-overlays');
  const file = path.join(dir, 'Game', 'Game.vcxproj');
  let pd = loadProject(file, { config: 'Debug', platform: 'Win32' });
  edit.setConfigProperty(pd, 'NMakeOutput', '$(ProjectName).ROM');
  pd = loadProject(file, { config: 'Debug', platform: 'Win32' });
  assert.strictEqual(pd.props.get('NMakeOutput'), 'Game.ROM');
  assert.strictEqual(loadProject(file, { config: 'Release', platform: 'Win32' }).props.get('NMakeOutput'), 'Game.BIN');
});

test('filters: add, move, rename, remove, with file and item bookkeeping', () => {
  const dir = work('msx-overlays');
  const file = path.join(dir, 'Game', 'Game.vcxproj');
  const load = () => loadProject(file, { config: 'Debug', platform: 'Win32' });

  edit.addFilter(file, 'Sounds\\Music');
  assert.ok(load().filters.includes('Sounds'));
  assert.ok(load().filters.includes('Sounds\\Music'));

  edit.setItemFilter(file, 'ClCompile', 'mdo.c', 'Sounds\\Music');
  assert.strictEqual(load().items.find((i) => i.include === 'mdo.c').filter, 'Sounds\\Music');
  assert.throws(() => edit.removeFilter(file, 'Sounds\\Music'), /not empty/);
  assert.throws(() => edit.removeFilter(file, 'Sounds'), /not empty/, 'an item further down counts');

  edit.renameFilter(file, 'Sounds', 'Audio');
  const p = load();
  assert.ok(p.filters.includes('Audio\\Music') && !p.filters.includes('Sounds'));
  assert.strictEqual(p.items.find((i) => i.include === 'mdo.c').filter, 'Audio\\Music');

  edit.setItemFilter(file, 'ClCompile', 'mdo.c', 'C Source Files');
  assert.throws(() => edit.removeFilter(file, 'Audio'), /sub-filters/);
  edit.removeFilter(file, 'Audio\\Music');
  edit.removeFilter(file, 'Audio');
  assert.ok(!load().filters.some((f) => f.startsWith('Audio')));
  assert.strictEqual(load().items.find((i) => i.include === 'mdo.c').filter, 'C Source Files');
});

test('files: add to a filter, remove from the project', () => {
  const dir = work('msx-overlays');
  const file = path.join(dir, 'Game', 'Game.vcxproj');
  const load = () => loadProject(file, { config: 'Debug', platform: 'Win32' });
  edit.addItem(file, 'ClCompile', 'extra.c', 'C Source Files');
  let it = load().items.find((i) => i.include === 'extra.c');
  assert.ok(it);
  assert.strictEqual(it.type, 'ClCompile');
  assert.strictEqual(it.filter, 'C Source Files');
  edit.removeItem(file, 'extra.c');
  assert.ok(!load().items.some((i) => i.include === 'extra.c'));
  assert.ok(!fs.readFileSync(`${file}.filters`, 'utf8').includes('extra.c'));
  edit.setItemFilter(file, 'None', 'print.s', null);
  assert.strictEqual(load().items.find((i) => i.include === 'print.s').filter, null);
});

test('project references: add and remove', () => {
  const dir = work('msx-overlays');
  const file = path.join(dir, 'Overlay1', 'Overlay1.vcxproj');
  edit.addProjectReference(file, '..\\Game\\Game.vcxproj', '{4BD08F44-14E0-48F1-8ACE-83B9363D7A6C}');
  let m = loadModel(path.join(dir, 'My Game with Overlays.sln'), 'Debug|x86');
  assert.strictEqual(byName(m, 'Overlay1').deps.length, 1);
  edit.removeProjectReference(file, null, (inc) => /Game\.vcxproj$/i.test(inc));
  m = loadModel(path.join(dir, 'My Game with Overlays.sln'), 'Debug|x86');
  assert.strictEqual(byName(m, 'Overlay1').deps.length, 0);
});

test('slnx: dotnet projects, solution folders, build commands, dependency edit', () => {
  const dir = work('dotnet-slnx');
  const file = path.join(dir, 'Demo.slnx');
  let m = loadModel(file, 'Debug|Any CPU');
  assert.deepStrictEqual(projectsOf(m).map((e) => e.sln.name), ['Lib', 'Tool', 'App']);
  assert.ok([...m.entries.values()].some((e) => e.sln.isFolder && e.sln.name === 'Solution Items'));
  const app = byName(m, 'App');
  assert.strictEqual(app.data.kind, 'dotnet');
  assert.ok(app.data.sdk);
  assert.ok(app.data.items.some((i) => i.include === 'Program.cs' && i.type === 'Compile'));
  assert.match(commandFor(app, 'build', { win: true }).command, /^dotnet build ".*App\.csproj" -c "Debug"$/);
  assert.match(commandFor(app, 'rebuild', { win: true }).command, /--no-incremental$/);
  assert.match(commandFor(app, 'clean', { win: true }).command, /^dotnet clean/);

  slnEdit.setSlnxDependencies(file, 'App/App.csproj', ['Lib/Lib.csproj', 'Tool/Tool.csproj']);
  m = loadModel(file, 'Debug|Any CPU');
  assert.deepStrictEqual(byName(m, 'App').deps.length, 2);
  slnEdit.setSlnxDependencies(file, 'App/App.csproj', []);
  m = loadModel(file, 'Debug|Any CPU');
  assert.deepStrictEqual(byName(m, 'App').deps, []);
});

test('solution folders and solution items in a .sln', () => {
  const text = [
    'Microsoft Visual Studio Solution File, Format Version 12.00',
    'Project("{2150E333-8FDC-42A3-9474-1A3956D46DE8}") = "Docs", "Docs", "{11111111-1111-1111-1111-111111111111}"',
    '\tProjectSection(SolutionItems) = preProject',
    '\t\tREADME.md = README.md',
    '\tEndProjectSection',
    'EndProject',
    'Project("{8BC9CEB8-8B4A-11D0-8D11-00A0C91BC942}") = "A", "A\\A.vcxproj", "{22222222-2222-2222-2222-222222222222}"',
    '\tProjectSection(ProjectDependencies) = postProject',
    '\t\t{33333333-3333-3333-3333-333333333333} = {33333333-3333-3333-3333-333333333333}',
    '\tEndProjectSection',
    'EndProject',
    'Project("{8BC9CEB8-8B4A-11D0-8D11-00A0C91BC942}") = "B", "B\\B.vcxproj", "{33333333-3333-3333-3333-333333333333}"',
    'EndProject',
    'Global',
    '\tGlobalSection(NestedProjects) = preSolution',
    '\t\t{22222222-2222-2222-2222-222222222222} = {11111111-1111-1111-1111-111111111111}',
    '\tEndGlobalSection',
    'EndGlobal',
  ].join('\n');
  const s = parseSln(text, path.join(os.tmpdir(), 'x.sln'));
  const [docs, a, b] = s.projects;
  assert.ok(docs.isFolder);
  assert.deepStrictEqual(docs.items, ['README.md']);
  assert.strictEqual(a.parent, docs.id);
  assert.strictEqual(b.parent, null);
  assert.deepStrictEqual(a.deps, [b.id]);
  assert.strictEqual(a.path, path.join(os.tmpdir(), 'A', 'A.vcxproj').replace(/\\/g, path.sep), 'backslash paths are native after parsing');
  // removing B takes its dependency line out of A as well
  const without = slnEdit.removeProjectFromSln(text, b.id);
  assert.ok(!without.includes('3333'));
});

test('.slnx: removing a project takes out its entry and the BuildDependency lines that point at it, nothing else', () => {
  const dir = work('dotnet-slnx');
  const file = path.join(dir, 'Demo.slnx');
  slnEdit.removeProjectFromSlnx(file, 'Lib\\Lib.csproj');
  const t = fs.readFileSync(file, 'utf8');
  assert.ok(!t.includes('Lib.csproj'), t);
  assert.ok(t.includes('<Project Path="Tool/Tool.csproj" />') && t.includes('<Project Path="App/App.csproj">') && t.includes('README.md'), t);
  assert.ok(fs.existsSync(path.join(dir, 'Lib')), 'files on disk stay');
  assert.strictEqual(loadModel(file).entries.size, 3, 'the solution folder and the two remaining projects still load');
});

test('portability: NMake command lines run on Linux/macOS hosts', () => {
  assert.strictEqual(portableCommand('python Make\\make.py Debug clean all', false), 'python Make/make.py Debug clean all');
  assert.strictEqual(portableCommand('python Make\\make.py Debug', true), 'python Make\\make.py Debug');
  assert.strictEqual(portableCommand('python "Tools\\x y.py" -o "..\\out\\a.bin"', false), 'python "Tools/x y.py" -o "../out/a.bin"');
  assert.strictEqual(portableCommand('echo a\\ b', false), 'echo a\\ b', 'escaped space stays');
  assert.strictEqual(pythonFallback('python Make/make.py', false, (n) => n === 'python3'), 'python3 Make/make.py');
  assert.strictEqual(pythonFallback('python Make/make.py', false, () => true), 'python Make/make.py');
  assert.strictEqual(pythonFallback('python Make\\make.py', true, () => false), 'python Make\\make.py');
  const dir = work('msx-overlays');
  const m = loadModel(path.join(dir, 'My Game with Overlays.sln'), 'Debug|x86');
  const cmd = commandFor(byName(m, 'Game'), 'rebuild', { win: false }).command;
  assert.ok(/^python3? Make\/make\.py Debug clean all$/.test(cmd), cmd);
  assert.match(commandFor(byName(m, 'Game'), 'build', { win: false }).command, /Make\/make\.py/);
});

test('names are validated like VS does', () => {
  assert.ok(validateName(''));
  assert.ok(validateName('a/b'));
  assert.ok(validateName('bad.'));
  assert.strictEqual(validateName('My Game 2'), null);
});

// ---- templates: only when the user's MSX templates are installed on this machine -------------------

const roots = process.env.SLNX_TEMPLATE_ROOTS ? process.env.SLNX_TEMPLATE_ROOTS.split(path.delimiter) : defaultTemplateRoots();
const templates = discoverTemplates(roots);
const msx = templates.filter((t) => /^MSX/.test(t.name));

test('templates: the installed MSX templates are found', { skip: !msx.length && 'MSX templates not installed here' }, () => {
  const names = msx.map((t) => t.name);
  for (const n of ['MSX BIN Application', 'MSX ROM Application', 'MSX-DOS Application', 'MSX-DOS Overlay']) assert.ok(names.includes(n), `${n} in ${names}`);
  assert.ok(msx.every((t) => t.createNewFolder && t.projectType === 'VC'));
});

test('templates: every MSX template instantiates into a working, loadable project', { skip: !msx.length && 'MSX templates not installed here' }, () => {
  for (const t of msx) {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'slnx-t-'));
    const r = instantiate(t, { projectName: 'My Proj 1', projectDir: path.join(out, 'My Proj 1'), solutionName: 'S', solutionDir: out });
    const pd = loadProject(r.projectFile, { config: 'Debug', platform: 'Win32' });
    assert.strictEqual(pd.kind, 'makefile', t.name);
    assert.strictEqual(pd.guid, `{${r.guid}}`, 'the project GUID placeholder was substituted');
    assert.ok(!fs.readFileSync(r.projectFile, 'utf8').includes('$guid1$'));
    assert.strictEqual(pd.props.get('NMakeBuildCommandLine'), 'python Make\\make.py Debug');
    // every file the project declares is on disk, at the declared place (this is what the layout rule guarantees)
    const missing = pd.items.filter((i) => !fs.existsSync(i.path)).map((i) => i.include);
    assert.deepStrictEqual(missing, [], `${t.name}: declared but not written`);
    assert.ok(pd.filtersFile && fs.existsSync(pd.filtersFile), 'filters file follows the project name');
    assert.ok(pd.items.some((i) => i.filter), 'filters still match the items');
  }
});

test('templates: new solution, then a second project added to it, with dependency', { skip: !msx.length && 'MSX templates not installed here' }, () => {
  const loc = fs.mkdtempSync(path.join(os.tmpdir(), 'slnx-n-'));
  const dos = msx.find((t) => t.name === 'MSX-DOS Application');
  const ovl = msx.find((t) => t.name === 'MSX-DOS Overlay');
  const a = createFromTemplate(dos, { projectName: 'Game', location: loc, solutionName: 'My Game' });
  assert.ok(a.createdSolution);
  assert.strictEqual(a.solutionFile, path.join(loc, 'My Game', 'My Game.sln'));
  assert.strictEqual(a.projectFile, path.join(loc, 'My Game', 'Game', 'Game.vcxproj'));
  const b = createFromTemplate(ovl, { projectName: 'Overlay1', location: null, solutionFile: a.solutionFile });
  assert.ok(!b.createdSolution);
  assert.strictEqual(b.projectFile, path.join(loc, 'My Game', 'Overlay1', 'Overlay1.vcxproj'));

  let m = loadModel(a.solutionFile, 'Debug|x86');
  assert.deepStrictEqual(projectsOf(m).map((e) => e.sln.name), ['Game', 'Overlay1']);
  assert.ok(projectsOf(m).every((e) => e.builds && e.projectConfig === 'Debug|Win32'));
  const sol = parseSln(fs.readFileSync(a.solutionFile, 'utf8'), a.solutionFile);
  assert.deepStrictEqual(sol.configs, ['Debug|x86', 'Release|x86']);
  assert.strictEqual(sol.map[byName(m, 'Overlay1').sln.id]['Release|x86'].cfg, 'Release|Win32');

  fs.writeFileSync(a.solutionFile, slnEdit.setSlnDependencies(fs.readFileSync(a.solutionFile, 'utf8'), byName(m, 'Overlay1').sln.id, [byName(m, 'Game').sln.id]));
  m = loadModel(a.solutionFile, 'Debug|x86');
  assert.deepStrictEqual(plan(m, { ids: [byName(m, 'Overlay1').sln.id], action: 'build' }, { win: true }).map((s) => s.name), ['Game', 'Overlay1']);

  // same-directory option puts solution and project together
  const c = createFromTemplate(msx[0], { projectName: 'Solo', location: loc, sameDirectory: true });
  assert.strictEqual(path.dirname(c.projectFile), path.dirname(c.solutionFile));
  assert.throws(() => createFromTemplate(msx[0], { projectName: 'Solo', location: loc, sameDirectory: true }), /already exists/);
});

test('templates: .slnx targets get a <Project> entry', { skip: !msx.length && 'MSX templates not installed here' }, () => {
  const dir = work('dotnet-slnx');
  const file = path.join(dir, 'Demo.slnx');
  const r = createFromTemplate(msx[0], { projectName: 'Rom1', location: null, solutionFile: file });
  assert.match(fs.readFileSync(file, 'utf8'), /<Project Path="Rom1\/Rom1\.vcxproj" \/>/);
  const m = loadModel(file, 'Debug|Any CPU');
  assert.ok(byName(m, 'Rom1'));
  assert.ok(fs.existsSync(r.projectFile));
});
