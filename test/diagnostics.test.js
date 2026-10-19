'use strict';
// Lines below are real: copied from the user's MSX build logs, produced by running SDCC 4.3.0's own tools on
// deliberately broken input, or taken from ZOO's source (zooexception.py / zoologger.py).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { DiagnosticParser, crashCode } = require('../src/core/diagnostics');
const { explain, searchUrl } = require('../src/core/explain');
const { findCrashingLine, tokenize } = require('../src/core/bisect');

const DIR = path.join(os.tmpdir(), 'slnx-diag');
const PROJECT = path.join(DIR, 'Game.vcxproj');
const parser = () => new DiagnosticParser({ projectDir: DIR, projectFile: PROJECT });
const one = (line, p = parser()) => p.parse(line);

test('SDCC: error and warning lines from the logs, with and without the VS indentation', () => {
  let d = one("msxromapp.c:70: error 20: Undefined identifier 'true'");
  assert.deepStrictEqual([d.severity, d.line, d.code, d.source, d.message], ['error', 70, '20', 'SDCC', "Undefined identifier 'true'"]);
  assert.strictEqual(d.file, path.join(DIR, 'msxromapp.c'), 'relative to the project folder');
  d = one('  ..\\..\\..\\libs\\util\\printf.c:144: warning 196: pointer target lost const qualifier');
  assert.deepStrictEqual([d.severity, d.line, d.code], ['warning', 144, '196']);
  assert.strictEqual(d.file, path.resolve(DIR, '..', '..', '..', 'libs', 'util', 'printf.c').replace(/\\/g, path.sep));
  assert.deepStrictEqual(d.span, [2, '..\\..\\..\\libs\\util\\printf.c:144'.length], 'span covers file:line for terminal links');
  d = one("bad.c:4: syntax error: token -> ';' ; column 11");
  assert.deepStrictEqual([d.severity, d.line, d.column, d.source], ['error', 4, 11, 'SDCC']);
  d = one("c2.c:2: warning 59: function 'g' must return value");
  assert.strictEqual(d.code, '59');
});

test('SDAS 4.3: "file:line: Error: <x> text" gives the code separately', () => {
  let d = one('m1.s:5: Error: <a> Branching Range Exceeded.');
  assert.deepStrictEqual([d.source, d.code, d.line, d.message], ['SDAS', 'a', 5, 'Branching Range Exceeded.']);
  d = one('multi.s:2: Error: <m> multiple definitions error or macro recursion error');
  assert.strictEqual(d.code, 'm');
  d = one('dot.s:2: Error: <.> use ". = . + <arg>" not ". = <arg>"');
  assert.strictEqual(d.code, '.');
});

test('SDAS/SDLD without a position: file from the quoted path or the last Processing line', () => {
  const p = parser();
  let d = one('  ?ASxxxx-Error-<cannot open> : "..\\..\\..\\libs\\msx\\msxinterrupt.s"', p);
  assert.strictEqual(d.source, 'SDAS');
  assert.ok(d.file.endsWith(path.join('libs', 'msx', 'msxinterrupt.s')));
  one('Processing ASM file MSX\\ROM\\msxromcrt0.s...', p);
  d = one('?ASxxxx-Warning-Unkown option -e ignored', p);
  assert.deepStrictEqual([d.severity, d.located], ['warning', false]);
  assert.ok(d.file.endsWith(path.join('MSX', 'ROM', 'msxromcrt0.s')), 'attributed to the file being processed');
  d = one("  ?ASlink-Warning-Undefined Global '_mnemo_init' referenced by module 'msxdosapp'", p);
  assert.deepStrictEqual([d.source, d.severity, d.file], ['SDLD', 'warning', PROJECT]);
});

test('ZOO: file:line, file only, and no location', () => {
  let d = one('ERROR: classes\\Ship.zml:12: Duplicate member x in class Ship.');
  assert.deepStrictEqual([d.source, d.severity, d.line, d.message], ['ZOO', 'error', 12, 'Duplicate member x in class Ship.']);
  assert.ok(d.file.endsWith(path.join('classes', 'Ship.zml')));
  d = one('ERROR: C:\\proj\\Ship.zml:7: Value not defined for equ SIZE.');
  assert.strictEqual(d.line, 7);
  assert.strictEqual(path.basename(d.file), 'Ship.zml');
  d = one('ERROR: classes\\Ship.zml: Invalid class definition.');
  assert.deepStrictEqual([d.line, d.located], [1, true]);
  d = one('ERROR: No implementation found for class or namespace Foo.');
  assert.deepStrictEqual([d.file, d.located, d.message], [PROJECT, false, 'No implementation found for class or namespace Foo.']);
  d = one('  [12:30:01] WARNING: flag property x in class Y has no named flags (only reservations).');
  assert.deepStrictEqual([d.severity, d.source], ['warning', 'ZOO']);
});

test('generic shapes: gcc and MSBuild', () => {
  let d = one('src/main.cpp:10:5: error: expected \';\' before \'}\' token');
  assert.deepStrictEqual([d.source, d.line, d.column], ['GCC', 10, 5]);
  d = one('Program.cs(12,5): error CS1002: ; expected');
  assert.deepStrictEqual([d.source, d.line, d.column, d.code, d.message], ['MSBuild', 12, 5, 'CS1002', '; expected']);
  assert.strictEqual(one('Processing C file msxromapp.c...'), null, 'context lines are not diagnostics');
  assert.strictEqual(one('  Linking project...'), null);
  assert.strictEqual(one('## sdcc --opt-code-size -mz80 ... -o x.ihx'), null);
});

test('crash: make.py "### Error <huge>" becomes a diagnostic on the source file being processed', () => {
  const p = parser();
  one('Processing ASM file foo.s...', p);
  one('## sdasz80 -l -o "Debug\\objs\\foo.rel" "foo.s"', p);
  const d = one('### Error -1073741784 executing', p);
  assert.strictEqual(d.code, 'crash');
  assert.strictEqual(d.crash.hex, '0xC0000028');
  assert.strictEqual(d.crash.name, 'STATUS_BAD_STACK');
  assert.strictEqual(d.crash.tool, 'sdasz80');
  assert.strictEqual(d.file, path.join(DIR, 'foo.s'));
  assert.match(d.message, /sdasz80 crashed \(exit code 0xC0000028, STATUS_BAD_STACK\) and printed no error message/);
  assert.strictEqual(one('### Error 1 executing', parser()), null, 'ordinary failures are explained by the lines above them');
  assert.strictEqual(crashCode(3), null);
  assert.strictEqual(crashCode(-1073741819).name, 'STATUS_ACCESS_VIOLATION');
  assert.strictEqual(crashCode(139).name, 'SIGSEGV');
});

test('explain: SDAS codes, linker messages, SDCC numbers, crashes', () => {
  let e = explain(one('x.s:2: Error: <a> Invalid Addressing Mode.'));
  assert.match(e.title, /SDAS <a>/);
  assert.match(e.body, /missing `#`/, 'the most common cause is called out first');
  e = explain(one('x.s:2: Error: <q> Questionable syntax'));
  assert.match(e.body, /unbalanced/);
  for (const c of ['.', 'a', 'b', 'd', 'i', 'm', 'n', 'o', 'p', 'q', 'r', 's', 'u', 'z']) {
    assert.ok(explain({ source: 'SDAS', code: c, message: 'x' }), `code ${c} is covered (the whole list from the ASxxxx manual)`);
  }
  e = explain(one("?ASlink-Warning-Undefined Global '_mnemo_init' referenced by module 'msxdosapp'"));
  assert.match(e.title, /Undefined Global '_mnemo_init'/);
  assert.match(e.body, /::/);
  assert.match(e.body, /ApplicationSources\.txt/);
  e = explain(one("?ASlink-Warning-Undefined Global 'zoo.abstractMethodCall' referenced by module ''"));
  assert.match(e.body, /ZOO/);
  assert.match(e.body, /no `\.module` name/);
  e = explain(one('?ASlink-Warning-Byte PCR relocation error for symbol far'));
  assert.match(e.hint, /jr/);
  e = explain(one('  ?ASxxxx-Error-<cannot create> : "\\objs\\scamm_vdp.rel"'));
  assert.match(e.body, /empty/);
  // SDCC numbers: verified against real output of the installed compiler
  e = explain(one('c2.c:1: warning 196: pointer target lost const qualifier'));
  assert.match(e.title, /SDCC warning 196: pointer target lost … qualifier/);
  assert.match(e.hint, /--disable-warning 196/);
  e = explain(one("c1.c:2: error 20: Undefined identifier 'x'"));
  assert.match(e.title, /SDCC error 20: Undefined identifier/);
  assert.match(explain(one("bad.c:4: syntax error: token -> ';' ; column 11")).hint, /real mistake/);
  const p = parser();
  one('## sdasz80 -l -o "x.rel" "foo.s"', p);
  e = explain(one('### Error -1073741784 executing', p));
  assert.match(e.body, /operand cut short/);
  assert.match(e.body, /Find the crashing line/);
  assert.strictEqual(explain(one('ERROR: whatever')), null);
});

test('web search link is built, not fetched', () => {
  const u = searchUrl(one("?ASlink-Warning-Undefined Global '_x' referenced by module 'm'"));
  assert.match(u, /^https:\/\/www\.google\.com\/search\?q=ASlink%20Undefined%20Global/);
  assert.ok(!u.includes('_x'), 'identifiers from the user\'s code are not sent to the search engine');
  const d = searchUrl(one('x.s:2: Error: <q> Questionable syntax'), 'https://duckduckgo.com/?q={query}');
  assert.match(d, /^https:\/\/duckduckgo\.com\/\?q=sdasz80%20error/);
});

// ---- the crash locator, against the real assembler when it is installed ------------------------------

const sdBin = ['C:\\Program Files\\SDCC\\bin', '/usr/bin', '/usr/local/bin'].find((d) => fs.existsSync(path.join(d, process.platform === 'win32' ? 'sdasz80.exe' : 'sdasz80')));
const withSdas = { ...process.env, PATH: sdBin ? `${sdBin}${path.delimiter}${process.env.PATH}` : process.env.PATH };

test('bisect: tokenizer keeps quoted paths', () => {
  assert.deepStrictEqual(tokenize('sdasz80 -l -I"a b" -o "x y.rel" "f.s"'), ['sdasz80', '-l', '-I"a b"', '-o', '"x y.rel"', '"f.s"']);
});

test('bisect: finds the line that crashes the real sdasz80', { skip: !sdBin && 'sdasz80 not installed here' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slnx-bi-'));
  const src = path.join(dir, 'prog.s');
  const cases = [
    ['\t.area _CODE', '\tnop', '\tnop', '\tld a,(', '\tnop', '\tret'],
    ['\t.area _CODE', '_main::', '\tnop', '\tnop', '\tnop', 'orphan', '\tret'],
    ['\t.area _CODE', '\tnop', '\t.org 0x100', '\tnop'],
  ];
  const expected = [4, 6, 3];
  const saved = process.env.PATH;
  process.env.PATH = withSdas.PATH;
  try {
    cases.forEach((lines, i) => {
      fs.writeFileSync(src, lines.join('\n') + '\n');
      const r = findCrashingLine({ command: 'sdasz80 -l -o "out.rel" "prog.s"', cwd: dir, sourceFile: src });
      assert.ok(r.found, r.reason);
      assert.strictEqual(r.line, expected[i], `case ${i}: ${lines[expected[i] - 1]}`);
      assert.strictEqual(r.text, lines[expected[i] - 1]);
    });
    // a file that assembles fine: reported honestly
    fs.writeFileSync(src, '\t.area _CODE\n\tnop\n');
    const ok = findCrashingLine({ command: 'sdasz80 -l -o "out.rel" "prog.s"', cwd: dir, sourceFile: src });
    assert.strictEqual(ok.found, false);
    assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.startsWith('slnx-bisect')), [], 'temp files removed');
  } finally { process.env.PATH = saved; }
});
