'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveIcon, indexFolder, KEYS, interpret, norm } = require('../src/core/icons');

const BUILTIN = path.join(__dirname, '..', 'media', 'icons');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'slnx-ic-'));
const touch = (...p) => { const f = path.join(...p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, '<svg xmlns="http://www.w3.org/2000/svg"/>'); return f; };
const base = { builtinDir: BUILTIN };

test('built-in set: every key has a light and a dark SVG', () => {
  for (const k of KEYS) {
    for (const t of ['light', 'dark']) assert.ok(fs.existsSync(path.join(BUILTIN, t, `${k}.svg`)), `${t}/${k}.svg`);
    const r = resolveIcon(k, { ...base, theme: 'vs' });
    assert.strictEqual(r.source, 'builtin');
  }
});

test('themes: codicons, and vs as the default', () => {
  assert.deepStrictEqual(resolveIcon('project.makefile', { ...base, theme: 'codicons' }), { type: 'codicon', id: 'tools', source: 'codicon' });
  assert.strictEqual(resolveIcon('solution', { ...base, theme: 'vs' }).type, 'file');
  assert.strictEqual(resolveIcon('nonexistent.key', { ...base, theme: 'vs' }).id, 'file', 'unknown keys fall back to a codicon');
});

test('overrides: codicon names, files (relative to the workspace), light/dark pairs; broken ones fall through', () => {
  const dir = tmp();
  const f = touch(dir, 'my', 'proj.svg');
  const l = touch(dir, 'my', 'l.svg'), d = touch(dir, 'my', 'd.svg');
  const cfg = { ...base, theme: 'vs', baseDir: dir, overrides: {
    'project.makefile': 'rocket', 'project.dotnet': '$(beaker)', 'project.cpp': 'my/proj.svg',
    solution: { light: 'my/l.svg', dark: 'my/d.svg' }, folder: 'nowhere/missing.svg', file: '   ',
  } };
  assert.deepStrictEqual(resolveIcon('project.makefile', cfg), { type: 'codicon', id: 'rocket', source: 'override' });
  assert.strictEqual(resolveIcon('project.dotnet', cfg).id, 'beaker');
  const p = resolveIcon('project.cpp', cfg);
  assert.deepStrictEqual([p.light, p.dark, p.source], [f, f, 'override']);
  const s = resolveIcon('solution', cfg);
  assert.deepStrictEqual([s.light, s.dark], [l, d]);
  assert.strictEqual(resolveIcon('folder', cfg).source, 'builtin', 'a missing file is ignored, not shown broken');
  assert.strictEqual(resolveIcon('file', cfg).source, 'builtin', 'blank override is ignored');
  assert.strictEqual(interpret('C:\\icons\\a.svg').type, 'file');
});

test('folder: finds icons by Visual Studio Image Library style names, svg beats png, others fall back', () => {
  const dir = tmp();
  touch(dir, 'Solution_16x.svg');
  touch(dir, 'CPPProjectNode_16x.svg');
  touch(dir, 'FolderClosed_16x.png');
  touch(dir, 'FolderClosed_16x.svg');
  touch(dir, 'Build_16x.svg');
  touch(dir, 'nested', 'deeper', 'Document_16x.svg');
  const cfg = { ...base, theme: 'folder', iconFolder: dir };
  assert.strictEqual(resolveIcon('solution', cfg).light, path.join(dir, 'Solution_16x.svg'));
  assert.strictEqual(resolveIcon('project.cpp', cfg).source, 'folder');
  assert.strictEqual(resolveIcon('project.makefile', cfg).light, path.join(dir, 'CPPProjectNode_16x.svg'), 'second-best alias when no makefile icon exists');
  assert.strictEqual(resolveIcon('folder', cfg).light, path.join(dir, 'FolderClosed_16x.svg'));
  assert.strictEqual(resolveIcon('action.build', cfg).source, 'folder');
  assert.strictEqual(resolveIcon('file', cfg).source, 'folder', 'found below sub-folders');
  assert.strictEqual(resolveIcon('action.clean', cfg).source, 'builtin', 'not in the folder: the built-in set fills in');
  assert.strictEqual(resolveIcon('solution', { ...base, theme: 'folder', iconFolder: path.join(dir, 'missing') }).source, 'builtin');
  assert.strictEqual(norm('CPPProjectNode_16x.svg'), 'cppprojectnode');
});

test('folder: light and dark sub-folders supply the theme variants', () => {
  const dir = tmp();
  const l = touch(dir, 'Light', 'Solution_16x.svg'), d = touch(dir, 'Dark', 'Solution_16x.svg');
  const r = resolveIcon('solution', { ...base, theme: 'folder', iconFolder: dir });
  assert.deepStrictEqual([r.light, r.dark], [l, d]);
  const only = tmp();
  const one = touch(only, 'Dark', 'Project_16x.svg');
  const r2 = resolveIcon('project.unknown', { ...base, theme: 'folder', iconFolder: only });
  assert.deepStrictEqual([r2.light, r2.dark], [one, one], 'a theme with no variant of its own reuses the other');
  assert.ok(indexFolder(dir).size >= 1);
});

test('override beats folder beats built-in', () => {
  const dir = tmp();
  touch(dir, 'Solution_16x.svg');
  const cfg = { ...base, theme: 'folder', iconFolder: dir, overrides: { solution: 'star' } };
  assert.strictEqual(resolveIcon('solution', cfg).id, 'star');
  assert.strictEqual(resolveIcon('solution', { ...cfg, overrides: {} }).source, 'folder');
});

test('source files: C, H, ASM (.asm and .s) and INC have their own icon key', () => {
  const { fileKey } = require('../src/core/icons');
  assert.deepStrictEqual(['a.c', 'A.H', 'x.hpp', 'm.asm', 'm.s', 'm.S', 'z.inc', 'Ship.zml', 'readme.txt'].map(fileKey),
    ['file.c', 'file.h', 'file.h', 'file.asm', 'file.asm', 'file.asm', 'file.inc', 'file.zoo', null]);
});

test('MSX project type: PROJECT_TYPE of ApplicationSettings.txt, DOS shown as COM, comments ignored, defaults otherwise', () => {
  const { parseProjectType, msxProjectType } = require('../src/core/msx');
  assert.strictEqual(parseProjectType(';\tPROJECT_TYPE\tROM\nPROJECT_TYPE\t\tDOS ; app\n'), 'DOS');
  assert.strictEqual(parseProjectType('; nothing here\n'), null);
  const dir = tmp();
  const pd = (type) => { fs.mkdirSync(path.join(dir, 'Config'), { recursive: true }); fs.writeFileSync(path.join(dir, 'Config', 'ApplicationSettings.txt'), `PROJECT_TYPE ${type}\r\n`); return { exists: true, dir, items: [] }; };
  assert.deepStrictEqual(['DOS', 'MDO', 'ROM', 'BIN'].map((t) => msxProjectType(pd(t)).label), ['COM', 'MDO', 'ROM', 'BIN']);
  assert.strictEqual(msxProjectType(pd('SOMETHING')), null, 'unknown type: caller uses the default icon');
  assert.strictEqual(msxProjectType({ exists: true, dir: tmp(), items: [] }), null, 'no settings file: defaults');
  assert.strictEqual(msxProjectType({ exists: false }), null);
  for (const k of ['rom', 'com', 'bin', 'mdo']) assert.ok(KEYS.includes(`project.${k}`));
});
