'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fixSlashes, validate } = require('../src/core/msxconfig/validate');
const { loadProjectConfig, saveProjectConfig, normalizeEvents, clone } = require('../src/core/msxconfig/model');

const FIX = path.join(__dirname, 'fixtures', 'msx-config', 'ROM');

test('backslash path separators of build event commands become "/", real escapes stay', () => {
  assert.strictEqual(fixSlashes('copy ..\\out\\a.bin x'), 'copy ../out/a.bin x');
  assert.strictEqual(fixSlashes('run.bat c:\\x'), 'run.bat c:/x');
  assert.strictEqual(fixSlashes('copy "[PROFILE]\\bin\\x.rom" y'), 'copy "[PROFILE]/bin/x.rom" y');
  assert.strictEqual(fixSlashes('dir ..\\out\\'), 'dir ../out/', 'a trailing separator too');
  assert.strictEqual(fixSlashes('echo \\"hi\\"'), 'echo \\"hi\\"', 'an escaped quote is an escape, not a path');
  assert.strictEqual(fixSlashes('cd my\\ dir'), 'cd my\\ dir', 'an escaped space is an escape');
  assert.strictEqual(fixSlashes('a \\\\ b'), 'a \\\\ b', 'a doubled backslash is a literal backslash');
  assert.strictEqual(fixSlashes('copy ../ok/a x'), 'copy ../ok/a x', 'nothing to fix');
});

test('the warning offers the fix, and saving applies it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slnx-ev-'));
  fs.cpSync(FIX, dir, { recursive: true });
  const cfg = loadProjectConfig(dir, 'ROM');
  const edited = clone(cfg.pages.map((p) => p.model));
  const ev = edited.find((p) => p.file === 'BuildEvents.txt');
  const field = (k) => ev.groups.flatMap((g) => g.fields).find((f) => f.key === k);
  field('AFTER_BINARY_ACTION').value = 'copy "[PROFILE]\\bin\\MSXAPP.ROM" ..\\emu\\';
  field('BUILD_END_ACTION').value = 'echo done';
  const issues = validate({ type: 'ROM', pages: edited }, { exists: () => true, hasFile: () => true, hooksOf: () => null });
  const w = issues.filter((i) => i.file === 'BuildEvents.txt');
  assert.deepStrictEqual(w.map((i) => [i.key, i.severity, i.fix]), [['AFTER_BINARY_ACTION', 'warning', 'slashes']]);

  assert.deepStrictEqual(normalizeEvents(edited), ['AFTER_BINARY_ACTION']);
  assert.strictEqual(field('AFTER_BINARY_ACTION').value, 'copy "[PROFILE]/bin/MSXAPP.ROM" ../emu/');
  saveProjectConfig(cfg, edited);
  const text = fs.readFileSync(path.join(dir, 'Config', 'BuildEvents.txt'), 'utf8');
  assert.match(text, /^AFTER_BINARY_ACTION\s+copy "\[PROFILE\]\/bin\/MSXAPP\.ROM" \.\.\/emu\/\s*$/m);
  assert.match(text, /^BUILD_END_ACTION\s+echo done\s*$/m);
  assert.deepStrictEqual(validate({ type: 'ROM', pages: clone(loadProjectConfig(dir, 'ROM').pages.map((p) => p.model)) }, { exists: () => true, hasFile: () => true, hooksOf: () => null }).filter((i) => i.file === 'BuildEvents.txt'), [], 'no warning after the fix');
});
