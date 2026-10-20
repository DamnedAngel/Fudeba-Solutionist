'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { createBlankSolution } = require('../src/core/newSolution');
const { loadModel } = require('../src/core/model');
const { addProjectToSln } = require('../src/core/slnEdit');
const { parseSolutionFile } = require('../src/core/sln');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'slnx-ns-'));

test('a blank .sln is written the way Visual Studio writes one', () => {
  const r = createBlankSolution({ location: tmp(), name: 'Demo', format: 'sln' });
  assert.strictEqual(path.basename(r.dir), 'Demo');
  assert.strictEqual(path.basename(r.file), 'Demo.sln');
  const raw = fs.readFileSync(r.file, 'utf8');
  assert.ok(raw.startsWith('\uFEFF'), 'with a BOM, as Visual Studio does');
  assert.ok(raw.includes('\r\n') && !/[^\r]\n/.test(raw), 'CRLF line ends');
  assert.match(raw, /^\uFEFF\r\nMicrosoft Visual Studio Solution File, Format Version 12\.00\r\n# Visual Studio Version 17\r\n/);
  assert.match(raw, /GlobalSection\(SolutionConfigurationPlatforms\) = preSolution\r\n\t\tDebug\|x86 = Debug\|x86\r\n\t\tRelease\|x86 = Release\|x86\r\n\tEndGlobalSection/);
  assert.ok(!/ProjectConfigurationPlatforms/.test(raw), 'no empty project configuration section (it appears with the first project)');
  assert.match(raw, /SolutionGuid = \{[0-9A-F-]{36}\}/);
  const m = loadModel(r.file);
  assert.deepStrictEqual([m.sol.configs, m.entries.size], [['Debug|x86', 'Release|x86'], 0]);
});

test('a blank .slnx is a valid <Solution> with its configurations', () => {
  const r = createBlankSolution({ location: tmp(), name: 'Demo', format: 'slnx' });
  assert.strictEqual(path.basename(r.file), 'Demo.slnx');
  const raw = fs.readFileSync(r.file, 'utf8');
  assert.strictEqual(raw, '<Solution>\r\n  <Configurations>\r\n    <BuildType Name="Debug" />\r\n    <BuildType Name="Release" />\r\n    <Platform Name="x86" />\r\n  </Configurations>\r\n</Solution>\r\n');
  assert.deepStrictEqual(loadModel(r.file).sol.configs, ['Debug|x86', 'Release|x86']);
});

test('a project added to a blank .sln brings its configuration section along', () => {
  const r = createBlankSolution({ location: tmp(), name: 'Demo', format: 'sln' });
  const text = addProjectToSln(fs.readFileSync(r.file, 'utf8'), { name: 'Game', relPath: 'Game\\Game.vcxproj', guid: '2C11C32A-C3CC-495F-93A9-B9EE59DA2C67', projectConfigs: [{ config: 'Debug', platform: 'Win32', name: 'Debug|Win32' }, { config: 'Release', platform: 'Win32', name: 'Release|Win32' }] });
  assert.match(text, /GlobalSection\(ProjectConfigurationPlatforms\) = postSolution\r?\n\t\t\{2C11C32A-C3CC-495F-93A9-B9EE59DA2C67\}\.Debug\|x86\.ActiveCfg = Debug\|Win32/);
  const s = parseSolutionFile(r.file, text);
  assert.strictEqual(s.projects.length, 1);
});

test('names are checked and an existing solution is never overwritten', () => {
  const loc = tmp();
  assert.throws(() => createBlankSolution({ location: loc, name: 'bad/name', format: 'sln' }));
  assert.throws(() => createBlankSolution({ location: loc, name: '', format: 'sln' }));
  createBlankSolution({ location: loc, name: 'Same', format: 'slnx' });
  assert.throws(() => createBlankSolution({ location: loc, name: 'Same', format: 'slnx' }), /already exists/);
});

// ---- Visual Studio's own MSBuild reads them (only where Visual Studio is installed) -----------------------------------

function msbuildPaths() {
  if (process.platform !== 'win32') return [];
  const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!fs.existsSync(vswhere)) return [];
  const r = cp.spawnSync(vswhere, ['-all', '-products', '*', '-requires', 'Microsoft.Component.MSBuild', '-find', 'MSBuild\\**\\Bin\\MSBuild.exe'], { encoding: 'utf8' });
  return (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && fs.existsSync(s));
}

test('Visual Studio\'s MSBuild reads the blank solutions (skipped where Visual Studio is not installed)', (t) => {
  const msb = msbuildPaths();
  if (!msb.length) return t.skip('Visual Studio is not installed');
  for (const exe of msb) {
    for (const format of ['sln', 'slnx']) {
      const r = createBlankSolution({ location: tmp(), name: 'Demo', format });
      const out = cp.spawnSync(exe, [r.file, '-nologo', '-v:m'], { encoding: 'utf8' });
      // an old MSBuild does not know .slnx: that is the tool's age, not a fault of the file
      if (format === 'slnx' && /MSB4025|MSB5009|not a valid solution|Invalid/i.test(out.stdout + out.stderr) && /Current\\Bin|15\.0/.test(exe) && /2019|2017/.test(exe)) continue;
      assert.strictEqual(out.status, 0, `${exe} on .${format}:\n${out.stdout}\n${out.stderr}`);
    }
  }
});
