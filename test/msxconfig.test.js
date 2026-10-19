'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tf = require('../src/core/msxconfig/textfile');
const { loadProjectConfig, saveProjectConfig, buildPage, applyPage, clone, KINDS } = require('../src/core/msxconfig/model');
const { validate } = require('../src/core/msxconfig/validate');
const { pagesFor } = require('../src/core/msxconfig/schema');

const FIX = path.join(__dirname, 'fixtures', 'msx-config');
const TYPES = ['ROM', 'COM', 'BIN', 'MDO'];
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'slnx-cfg-'));
const copyProject = (type) => { const d = tmp(); fs.cpSync(path.join(FIX, type), d, { recursive: true }); return d; };
const read = (d, f) => fs.readFileSync(path.join(d, 'Config', f), 'utf8');
/** lines that differ between two texts (same line count assumed unless told) */
const changedLines = (a, b) => { const x = a.split(/\r?\n/), y = b.split(/\r?\n/); return { x, y, diff: y.map((l, i) => (l !== x[i] ? i : -1)).filter((i) => i >= 0) }; };
const okCtx = { exists: () => true, hasFile: () => true, hooksOf: () => null };

test('every real template file is read and written back byte for byte', () => {
  for (const t of TYPES) {
    for (const f of fs.readdirSync(path.join(FIX, t, 'Config'))) {
      const text = fs.readFileSync(path.join(FIX, t, 'Config', f), 'utf8');
      assert.strictEqual(tf.save(tf.load(text)), text, `${t}/${f}`);
    }
  }
});

test('the schema knows every setting the templates use: nothing lands in "other definitions" by surprise', () => {
  for (const t of TYPES) {
    const cfg = loadProjectConfig(path.join(FIX, t), t);
    for (const p of cfg.pages) {
      const m = p.model;
      if (m.other) assert.deepStrictEqual(m.other.items, [], `${t}/${m.file}: ${JSON.stringify(m.other.items)}`);
      for (const g of m.groups || []) if (g.other) assert.deepStrictEqual(g.other.items, [], `${t}/${m.file}/${g.title}: ${JSON.stringify(g.other.items)}`);
    }
  }
});

test('the dialog of each project type has its own pages and settings', () => {
  const files = (t) => loadProjectConfig(path.join(FIX, t), t).pages.map((p) => p.model.file);
  assert.ok(!files('ROM').includes('MDOSettings.txt') && !files('BIN').includes('MDOSettings.txt'), 'only MSX-DOS projects have overlay settings');
  assert.ok(files('COM').includes('MDOSettings.txt') && files('MDO').includes('MDOSettings.txt'));
  const keys = (t) => loadProjectConfig(path.join(FIX, t), t).pages[0].model.groups.flatMap((g) => g.fields.map((f) => f.key));
  assert.ok(keys('ROM').includes('ROM_SIZE') && keys('ROM').includes('RETURN_TO_BASIC'));
  assert.ok(!keys('COM').includes('ROM_SIZE') && keys('COM').includes('MAX_CMDLINE_PARAMETERS') && keys('COM').includes('HEAP_SIZE'));
  assert.ok(keys('BIN').includes('PUBLISH_FILESTART') && !keys('BIN').includes('HEAP_SIZE'));
  assert.ok(!keys('MDO').includes('MAX_CMDLINE_PARAMETERS'));
  const target = (t) => loadProjectConfig(path.join(FIX, t), t).pages.find((p) => p.model.file === 'TargetConfig_Debug.txt').model.groups.flatMap((g) => g.fields.map((f) => f.key));
  assert.ok(target('COM').includes('MSXDOSPRINT') && !target('ROM').includes('MSXDOSPRINT'));
  assert.deepStrictEqual(pagesFor('ROM', ['TargetConfig_Debug.txt', 'TargetConfig_Release.txt']).map((p) => p.profile), ['Debug', 'Release']);
});

test('every option has an explanation', () => {
  for (const t of TYPES) {
    for (const p of loadProjectConfig(path.join(FIX, t), t).pages) {
      const m = p.model;
      assert.ok(m.blurb && m.blurb.length > 20, `${t}/${m.file} page text`);
      for (const g of m.groups || []) {
        for (const f of g.fields) assert.ok(f.help && f.help.length > 20, `${t}/${m.file}/${f.key} has no explanation`);
        if (g.other) assert.ok(g.other.help);
      }
      for (const l of m.lists || []) assert.ok(l.help && l.help.length > 20, `${t}/${m.file}/${l.key}`);
      if (m.items) assert.ok(m.help, `${t}/${m.file}`);
    }
  }
});

test('editing a value rewrites only that value; comments and layout stay', () => {
  const d = copyProject('ROM');
  const cfg = loadProjectConfig(d, 'ROM');
  const edited = clone(cfg.pages.map((p) => p.model));
  const f = edited[0].groups.flatMap((g) => g.fields).find((x) => x.key === 'ROM_SIZE');
  f.value = '32k';
  const before = read(d, 'ApplicationSettings.txt');
  assert.deepStrictEqual(saveProjectConfig(cfg, edited).map((x) => path.basename(x)), ['ApplicationSettings.txt']);
  const { x, y, diff } = changedLines(before, read(d, 'ApplicationSettings.txt'));
  assert.deepStrictEqual(diff.length, 1);
  assert.match(x[diff[0]], /^ROM_SIZE\t+16k\t+; ?16k\/32k$/);
  assert.match(y[diff[0]], /^ROM_SIZE\t+32k\t+; ?16k\/32k$/, 'the comment after the value is kept');
});

test('nothing is written when nothing changed', () => {
  for (const t of TYPES) {
    const d = copyProject(t);
    const cfg = loadProjectConfig(d, t);
    assert.deepStrictEqual([...saveProjectConfig(cfg, clone(cfg.pages.map((p) => p.model)))], [], t);
  }
});

test('flags, optional settings (commented-out lines) and new settings', () => {
  const d = copyProject('ROM');
  const cfg = loadProjectConfig(d, 'ROM');
  const edited = clone(cfg.pages.map((p) => p.model));
  const field = (k) => edited[0].groups.flatMap((g) => g.fields).find((x) => x.key === k);
  field('STACK_HIMEM').value = '_ON';
  field('CODE_LOC').set = true; field('CODE_LOC').value = '0x4100';      // ";CODE_LOC 0x8100" is switched on
  field('DATA_LOC').set = false;                                         // "DATA_LOC 0xC000" is commented out
  edited[0].other.items.push({ key: 'MY_SWITCH', value: '_ON' });
  saveProjectConfig(cfg, edited);
  const t = read(d, 'ApplicationSettings.txt');
  assert.match(t, /^STACK_HIMEM\t+_ON\s/m);
  assert.match(t, /^CODE_LOC\t+0x4100$/m, 'the commented-out line was switched on and given the new value');
  assert.match(t, /^;DATA_LOC\t+0xC000$/m, 'a disabled setting is commented out, not deleted');
  assert.match(t, /^MY_SWITCH\t+_ON$/m);
  const again = loadProjectConfig(d, 'ROM').pages[0].model;
  const g = (k) => again.groups.flatMap((x) => x.fields).find((f) => f.key === k);
  assert.deepStrictEqual([g('STACK_HIMEM').value, g('CODE_LOC').set, g('CODE_LOC').value, g('DATA_LOC').set], ['_ON', true, '0x4100', false]);
  assert.deepStrictEqual(again.other.items, [{ key: 'MY_SWITCH', value: '_ON' }]);
});

test('repeatable settings: CALL statements are added, changed and removed in place', () => {
  const d = copyProject('ROM');
  const cfg = loadProjectConfig(d, 'ROM');
  const edited = clone(cfg.pages.map((p) => p.model));
  const calls = edited[0].lists.find((l) => l.key === 'CALL_STATEMENT');
  assert.deepStrictEqual(calls.items.map((i) => i.value), ['CMD1', 'RUNCART']);
  calls.items = [{ value: 'CMD1' }, { value: 'MYCALL' }, { value: 'THIRD' }];
  saveProjectConfig(cfg, edited);
  const lines = read(d, 'ApplicationSettings.txt').split(/\r?\n/);
  const at = lines.findIndex((l) => /^CALL_STATEMENT\s+CMD1/.test(l));
  assert.match(lines[at + 1], /^CALL_STATEMENT\s+MYCALL$/);
  assert.match(lines[at + 2], /^CALL_STATEMENT\s+THIRD$/);
  assert.match(lines[at + 3], /^\s*$/, 'the new line is part of the block, before the blank line that follows it');
});

test('entry lists: switch an entry on or off, add one, remove one; the template comments stay', () => {
  const d = copyProject('ROM');
  const cfg = loadProjectConfig(d, 'ROM');
  const i = cfg.pages.findIndex((p) => p.model.file === 'ApplicationSources.txt');
  const before = cfg.pages[i].model.items.map((e) => `${e.enabled ? '+' : '-'}${e.text}`);
  assert.ok(before.includes('-msxromapp.s') && before.includes('+msxromapp.c'), before.join());
  const edited = clone(cfg.pages.map((p) => p.model));
  const items = edited[i].items;
  items.find((e) => e.text === 'msxromapp.s').enabled = true;
  items.find((e) => e.text === 'msxromapp.c').enabled = false;
  items.push({ text: 'extra.c', enabled: true });
  saveProjectConfig(cfg, edited);
  const t = read(d, 'ApplicationSources.txt');
  assert.match(t, /^msxromapp\.s$/m);
  assert.match(t, /^;msxromapp\.c$/m);
  assert.match(t, /^extra\.c$/m);
  assert.match(t, /^;\tChoose ONE and ONLY ONE of the lines below,$/m, 'comment lines are untouched');
  // remove the new one again
  const cfg2 = loadProjectConfig(d, 'ROM');
  const e2 = clone(cfg2.pages.map((p) => p.model));
  e2[i].items = e2[i].items.filter((e) => e.text !== 'extra.c');
  saveProjectConfig(cfg2, e2);
  assert.ok(!/extra\.c/.test(read(d, 'ApplicationSources.txt')));
});

test('BIN: the USR routines table mixes SYMBOL and ADDRESS entries in order', () => {
  const d = copyProject('BIN');
  const cfg = loadProjectConfig(d, 'BIN');
  const edited = clone(cfg.pages.map((p) => p.model));
  const usr = edited[0].lists.find((l) => l.key === 'SYMBOL');
  assert.deepStrictEqual(usr.items, [{ kind: 'SYMBOL', value: '_printFromBasic' }]);
  usr.items.push({ kind: 'ADDRESS', value: '0xB100' }, { kind: 'SYMBOL', value: '_second' });
  saveProjectConfig(cfg, edited);
  const m = loadProjectConfig(d, 'BIN').pages[0].model.lists.find((l) => l.key === 'SYMBOL');
  assert.deepStrictEqual(m.items.map((i) => `${i.kind}:${i.value}`), ['SYMBOL:_printFromBasic', 'ADDRESS:0xB100', 'SYMBOL:_second']);
});

test('MDO settings: children, hooks and implementations are parsed and written in the templates\' syntax', () => {
  const child = KINDS.child;
  assert.deepStrictEqual(child.parse('OVERLAY_ONE ^/MSXOVL1 / MDO'), { name: 'OVERLAY_ONE', file: 'MSXOVL1', ext: 'MDO' });
  assert.strictEqual(child.format({ name: 'OVERLAY_ONE', file: 'MSXOVL1', ext: 'MDO' }), 'OVERLAY_ONE ^/MSXOVL1 / MDO', 'the file name is padded to 8 characters');
  assert.strictEqual(child.format({ name: 'B', file: 'AB', ext: 'MD' }), 'B ^/AB      / ^/MD /');
  assert.deepStrictEqual(KINDS.hook.parse('void|mdoChildHello|(void)'), { ret: 'void', name: 'mdoChildHello', sig: '(void)' });
  assert.deepStrictEqual(KINDS.hook.parse('unsigned char|mdoDo|(int)'), { ret: 'unsigned char', name: 'mdoDo', sig: '(int)' });
  const d = copyProject('MDO');
  const cfg = loadProjectConfig(d, 'MDO');
  const i = cfg.pages.findIndex((p) => p.model.file === 'MDOSettings.txt');
  const m = cfg.pages[i].model;
  assert.deepStrictEqual(m.lists.find((l) => l.key === 'MDO_HOOK_IMPLEMENTATION').items.map((h) => `${h.hook}=${h.symbol}`), ['mdoChildHello=_hello', 'mdoChildGoodbye=_goodbye']);
  const edited = clone(cfg.pages.map((p) => p.model));
  edited[i].lists.find((l) => l.key === 'MDO_CHILD').items.push({ name: 'OVERLAY_TWO', file: 'MSXOVL2', ext: 'MDO' });
  edited[i].groups.flatMap((g) => g.fields).find((f) => f.key === 'MDO_NAME').value = 'OVERLAY_NINE';
  saveProjectConfig(cfg, edited);
  const t = read(d, 'MDOSettings.txt');
  assert.match(t, /^MDO_CHILD\s+OVERLAY_TWO \^\/MSXOVL2 \/ MDO$/m);
  assert.match(t, /^MDO_NAME\t+OVERLAY_NINE$/m);
});

// ---- context checks ------------------------------------------------------------------------------------------------

function check(type, edit, ctx = okCtx) {
  const cfg = loadProjectConfig(path.join(FIX, type), type);
  const state = { type, pages: clone(cfg.pages.map((p) => p.model)) };
  edit(state);
  return validate(state, ctx);
}
const fld = (state, file, key) => state.pages.find((p) => p.file === file).groups.flatMap((g) => g.fields).find((f) => f.key === key);
const has = (issues, severity, re) => issues.some((i) => i.severity === severity && re.test(i.message));

test('context: the real templates produce no warnings', () => {
  for (const t of TYPES) assert.deepStrictEqual(check(t, () => {}), [], t);
});

test('context: ROM settings that contradict each other', () => {
  const issues = check('ROM', (s) => {
    fld(s, 'ApplicationSettings.txt', 'STACK_HIMEM').value = '_ON'; // while RETURN_TO_BASIC is _ON
    fld(s, 'ApplicationSettings.txt', 'ROM_SIZE').value = '32k';    // at 0x4000: fine
    fld(s, 'ApplicationSettings.txt', 'FILESTART').value = '0x6000';
    fld(s, 'ApplicationSettings.txt', 'DATA_LOC').value = '0x4000';
    s.pages[0].lists.find((l) => l.key === 'CALL_STATEMENT').items = [];
  });
  assert.ok(has(issues, 'error', /STACK_HIMEM needs RETURN_TO_BASIC/));
  assert.ok(has(issues, 'warning', /32 kB ROM is normally mapped at 0x4000/));
  assert.ok(has(issues, 'warning', /variables in RAM/));
  assert.ok(has(issues, 'warning', /CALL expansion is on but no CALL statement/));
});

test('context: numbers and names are checked', () => {
  const issues = check('COM', (s) => {
    fld(s, 'ApplicationSettings.txt', 'MAX_CMDLINE_PARAMETERS').value = '64';
    fld(s, 'ApplicationSettings.txt', 'HEAP_SIZE').value = '70000';
    fld(s, 'TargetConfig_Debug.txt', 'MSX_FILE_NAME').value = 'WAYTOOLONGNAME';
    fld(s, 'TargetConfig_Debug.txt', 'BUILD_DEBUG').value = '300';
    fld(s, 'TargetConfig_Release.txt', 'MSX_FILE_EXTENSION').value = 'EXE';
    fld(s, 'MDOSettings.txt', 'MDO_NAME').value = '1bad name';
  });
  assert.ok(has(issues, 'error', /maximum is 63/));
  assert.ok(has(issues, 'error', /heap size is above 0xFFFF/));
  assert.ok(has(issues, 'error', /at most 8 characters/));
  assert.ok(has(issues, 'error', /0 to 255/));
  assert.ok(has(issues, 'warning', /template extension of a COM project is COM/));
  assert.ok(has(issues, 'error', /C-style identifier/));
});

test('context: one file against another (ZOO support, .zml sources)', () => {
  const zoo = check('ROM', (s) => { fld(s, 'ApplicationSettings.txt', 'ZOO_SUPPORT').value = '_ON'; });
  assert.strictEqual(zoo.filter((i) => /no ZOO folder is set/.test(i.message)).length, 2, 'a warning in each configuration file that lacks ZOO_PATH');
  const zml = check('ROM', (s) => { s.pages.find((p) => p.file === 'ApplicationSources.txt').items.push({ text: 'Ship.zml', enabled: true }); });
  assert.ok(has(zml, 'error', /ZOO class file but ZOO_SUPPORT is _OFF/));
  const missing = check('ROM', (s) => { fld(s, 'ApplicationSettings.txt', 'ZOO_SUPPORT').value = '_ON'; fld(s, 'TargetConfig_Debug.txt', 'ZOO_PATH').set = true; fld(s, 'TargetConfig_Debug.txt', 'ZOO_PATH').value = '..\\NoZoo'; }, { ...okCtx, exists: (p) => p !== '..\\NoZoo' });
  assert.ok(has(missing, 'warning', /"..\\NoZoo" was not found/));
});

test('context: sources on disk, the crt0 entry, either/or pairs, symbols', () => {
  const issues = check('ROM', (s) => {
    const p = s.pages.find((x) => x.file === 'ApplicationSources.txt');
    p.items.find((e) => e.text === 'msxromapp.s').enabled = true;                  // both .s and .c of the app on
    p.items.push({ text: 'nothere.c', enabled: true }, { text: 'readme.txt', enabled: true });
    const sym = s.pages.find((x) => x.file === 'Symbols.txt');
    sym.items.push({ text: '[unclosed', enabled: true }, { text: 'a b', enabled: true });
  }, { ...okCtx, exists: (p) => p !== 'nothere.c' });
  assert.ok(has(issues, 'warning', /Both "msxromapp\.s" and "msxromapp\.c" are switched on/));
  assert.ok(has(issues, 'warning', /"nothere\.c" was not found/));
  assert.ok(has(issues, 'warning', /"readme\.txt": a source file is normally/));
  assert.ok(has(issues, 'error', /"\[unclosed" is not a valid regular expression/));
  assert.ok(has(issues, 'warning', /a rename needs both a search expression and a replacement/));
  const crt0 = check('ROM', (s) => { s.pages.find((x) => x.file === 'ApplicationSources.txt').items[0].enabled = false; });
  assert.ok(has(crt0, 'error', /startup code \(crt0\); it must stay first/));
});

test('context: an overlay against its parent', () => {
  const ctx = { exists: () => true, hasFile: () => true, hooksOf: () => ['mdoChildHello', 'mdoChildGoodbye', 'mdoNew'] };
  const issues = check('MDO', (s) => {
    const m = s.pages.find((p) => p.file === 'MDOSettings.txt');
    m.lists.find((l) => l.key === 'MDO_HOOK_IMPLEMENTATION').items.push({ hook: 'nonexistent', symbol: 'bare' });
    m.lists.find((l) => l.key === 'MDO_CHILD').items.push({ name: 'KID', file: 'TOOLONGNAME', ext: 'MDOX' });
    fld(s, 'MDOSettings.txt', 'FILESTART').value = 'PREVIOUS_AFTERHEAP';
  }, ctx);
  assert.ok(has(issues, 'warning', /parent does not declare a hook named "nonexistent"/));
  assert.ok(has(issues, 'warning', /parent declares the hook "mdoNew" but this overlay does not implement it/));
  assert.ok(has(issues, 'warning', /starts with an underscore/));
  assert.ok(has(issues, 'error', /longer than 8 characters/));
  assert.ok(has(issues, 'error', /extension .* longer than 3/));
  assert.ok(has(issues, 'error', /PREVIOUS_AFTERHEAP needs a previous project/));
  const noParent = check('MDO', (s) => { fld(s, 'MDOSettings.txt', 'MDO_PARENT_PROJECT_PATH').value = '../Nowhere'; }, { ...okCtx, exists: (p) => p !== '../Nowhere' });
  assert.ok(has(noParent, 'warning', /"..\/Nowhere" was not found/));
});

test('context: BIN USR table, build events', () => {
  const bin = check('BIN', (s) => {
    const l = s.pages[0].lists.find((x) => x.key === 'SYMBOL');
    for (let i = 0; i < 10; i++) l.items.push({ kind: 'SYMBOL', value: `_r${i}` });
    fld(s, 'ApplicationSettings.txt', 'FILESTART').value = '0x4000';
  });
  assert.ok(has(bin, 'error', /only ten USR functions/));
  assert.ok(has(bin, 'warning', /RAM, which starts at 0x8000/));
  const ev = check('ROM', (s) => { fld(s, 'BuildEvents.txt', 'BUILD_START_ACTION').value = 'copy "a b'; fld(s, 'BuildEvents.txt', 'BUILD_END_ACTION').value = 'run.bat c:\\x'; });
  assert.ok(has(ev, 'error', /quotes are not balanced/));
  assert.ok(has(ev, 'warning', /use "\/" as the separator/));
});

test('a model applied to a file that changed meanwhile is merged onto the new text', () => {
  const d = copyProject('ROM');
  const cfg = loadProjectConfig(d, 'ROM');
  const edited = clone(cfg.pages.map((p) => p.model));
  edited[0].groups.flatMap((g) => g.fields).find((f) => f.key === 'SDCCCALL').value = '0';
  // somebody edits another line by hand after the dialog was opened
  const file = path.join(d, 'Config', 'ApplicationSettings.txt');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('HEAP', 'HEAP').replace('ROM_SIZE\t\t\t\t16k', 'ROM_SIZE\t\t\t\t32k'));
  saveProjectConfig(cfg, edited);
  const t = fs.readFileSync(file, 'utf8');
  assert.match(t, /^SDCCCALL\s+0\s/m);
  assert.match(t, /^ROM_SIZE\t+32k\t/m, 'the hand edit is still there');
});

test('buildPage/applyPage work on a single document too', () => {
  const doc = tf.load('PROJECT_TYPE ROM\r\nFILESTART 0x4000 ; where\r\n');
  const page = pagesFor('ROM', ['ApplicationSettings.txt'])[0];
  const was = buildPage(page, doc, 'ROM');
  const now = clone(was);
  now.groups.flatMap((g) => g.fields).find((f) => f.key === 'FILESTART').value = '0x8000';
  assert.ok(applyPage(page, doc, now, was, 'ROM'));
  assert.strictEqual(tf.save(doc), 'PROJECT_TYPE ROM\r\nFILESTART 0x8000 ; where\r\n', 'CRLF and the comment are kept');
});

// ---- missing files -----------------------------------------------------------------------------------------------

const BUNDLED = path.join(__dirname, '..', 'media', 'msx-config-defaults');
const { defaultsProvider } = require('../src/core/msxconfig/defaults');

test('missing configuration files: the pages are there, filled from the template, and only created on request or on edit', () => {
  for (const t of TYPES) {
    const d = copyProject(t);
    fs.rmSync(path.join(d, 'Config', 'Symbols.txt'));
    fs.rmSync(path.join(d, 'Config', 'TargetConfig_Release.txt'));
    const defaults = defaultsProvider({ type: t, bundledDir: BUNDLED, templateRoots: [] });
    const cfg = loadProjectConfig(d, t, defaults);
    const missing = cfg.pages.filter((p) => p.missing).map((p) => p.model.file);
    assert.deepStrictEqual(missing.sort(), ['Symbols.txt', 'TargetConfig_Release.txt'], t);
    assert.strictEqual(cfg.pages.length, loadProjectConfig(path.join(FIX, t), t).pages.length, 'the same pages as a complete project');
    assert.ok(cfg.pages.find((p) => p.missing).model.missing, 'the page model says so');
    // untouched: nothing is created
    assert.deepStrictEqual([...saveProjectConfig(cfg, clone(cfg.pages.map((p) => p.model)))], [], t);
    assert.ok(!fs.existsSync(path.join(d, 'Config', 'Symbols.txt')));
  }
});

test('missing configuration files are created from the template, with the edits made to them', () => {
  const d = copyProject('ROM');
  fs.rmSync(path.join(d, 'Config', 'TargetConfig_Release.txt'));
  fs.rmSync(path.join(d, 'Config', 'Libraries.txt'));
  const defaults = defaultsProvider({ type: 'ROM', bundledDir: BUNDLED, templateRoots: [] });
  const cfg = loadProjectConfig(d, 'ROM', defaults);
  const edited = clone(cfg.pages.map((p) => p.model));
  const rel = edited.find((p) => p.file === 'TargetConfig_Release.txt');
  rel.groups.flatMap((g) => g.fields).find((f) => f.key === 'MSX_FILE_NAME').value = 'MYROM';          // edited: created
  const written = saveProjectConfig(cfg, edited, { create: ['Libraries.txt'] });                      // asked: created as the template has it
  assert.deepStrictEqual(written.created.map((f) => path.basename(f)).sort(), ['Libraries.txt', 'TargetConfig_Release.txt']);
  assert.strictEqual(read(d, 'Libraries.txt'), fs.readFileSync(path.join(FIX, 'ROM', 'Config', 'Libraries.txt'), 'utf8'), 'created exactly as the template has it');
  assert.match(read(d, 'TargetConfig_Release.txt'), /^MSX_FILE_NAME\s+MYROM\s*$/m);
  assert.match(read(d, 'TargetConfig_Release.txt'), /^DEBUG\s+_OFF/m, 'the rest is the template\'s Release configuration');
  const again = loadProjectConfig(d, 'ROM', defaults);
  assert.deepStrictEqual(again.pages.filter((p) => p.missing), [], 'nothing is missing any more');
});

test('a project with no Config folder at all gets every file of its type', () => {
  for (const t of TYPES) {
    const d = tmp();
    const defaults = defaultsProvider({ type: t, bundledDir: BUNDLED, templateRoots: [] });
    const cfg = loadProjectConfig(d, t, defaults);
    assert.ok(cfg.pages.length >= 9 && cfg.pages.every((p) => p.missing), t);
    const written = saveProjectConfig(cfg, clone(cfg.pages.map((p) => p.model)), { create: cfg.pages.map((p) => p.model.id) });
    assert.strictEqual(written.created.length, cfg.pages.length);
    const names = fs.readdirSync(path.join(d, 'Config')).sort();
    assert.deepStrictEqual(names, fs.readdirSync(path.join(FIX, t, 'Config')).sort(), `${t}: the same files as the template`);
  }
});

test('the defaults come from the installed template when there is one, else from the copy inside the extension', () => {
  const { ZipArchive } = require('../src/core/zip');
  void ZipArchive;
  // an unzipped template folder with its own, different ApplicationSettings.txt
  const root = tmp();
  const tdir = path.join(root, 'MyRom');
  fs.mkdirSync(tdir);
  fs.writeFileSync(path.join(tdir, 'MyTemplate.vstemplate'), '<VSTemplate Version="3.0.0" Type="Project" xmlns="http://schemas.microsoft.com/developer/vstemplate/2005"><TemplateData><Name>MSX ROM Application</Name><ProjectType>VC</ProjectType></TemplateData><TemplateContent><Project File="a.vcxproj"><ProjectItem>a.vcxproj</ProjectItem></Project></TemplateContent></VSTemplate>');
  fs.writeFileSync(path.join(tdir, 'ApplicationSettings.txt'), 'PROJECT_TYPE ROM ; from the installed template\r\n');
  const get = defaultsProvider({ type: 'ROM', bundledDir: BUNDLED, templateRoots: [root] });
  assert.match(get('ApplicationSettings.txt'), /from the installed template/);
  assert.match(get('Symbols.txt'), /Symbol export configuration/, 'a file the installed template lacks comes from the bundled copy');
  assert.strictEqual(get('NoSuchFile.txt'), null);
  const bundledOnly = defaultsProvider({ type: 'COM', bundledDir: BUNDLED, templateRoots: [root] });
  assert.match(bundledOnly('MDOSettings.txt'), /MDO_APPLICATION_PROJECT_PATH/, 'the ROM template is not used for a COM project');
});
