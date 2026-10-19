'use strict';
// Build output in Visual Studio's style, produced by real child processes.
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const { runPlan, header, summary, duration } = require('../src/core/buildrun');

const nodeCmd = (js) => `node -e "${js}"`;
const collect = () => { const lines = []; const kinds = []; return { lines, kinds, write: (l, k) => { lines.push(l); kinds.push(k); } }; };
const cfg = () => 'Debug|Win32';

test('output: header and summary formats match Visual Studio', () => {
  assert.strictEqual(header(1, 'build', 'Game', 'Debug|Win32'), '1>------ Build started: Project: Game, Configuration: Debug Win32 ------');
  assert.strictEqual(header(2, 'rebuild', 'X', 'Release|x64'), '2>------ Rebuild started: Project: X, Configuration: Release x64 ------');
  assert.strictEqual(duration(1228), '01.228 seconds');
  assert.strictEqual(duration(65236), '01:05.236 minutes');
  assert.strictEqual(summary('build', { succeeded: 2, failed: 0, upToDate: 0, skipped: 1 }, 1228)[0], '========== Build: 2 succeeded, 0 failed, 0 up-to-date, 1 skipped ==========');
  assert.strictEqual(summary('rebuild', { succeeded: 1, failed: 1, upToDate: 0, skipped: 0 }, 5)[0], '========== Rebuild All: 1 succeeded, 1 failed, 0 skipped ==========');
  assert.match(summary('clean', { succeeded: 3, failed: 0, upToDate: 0, skipped: 0 }, 5)[1], /^========== Clean completed at .+ and took 00\.005 seconds ==========$/);
});

test('output: every line carries its project number, then the summary', async () => {
  const out = collect();
  const steps = [
    { id: 'a', name: 'Game', action: 'build', command: nodeCmd("console.log('compiling');console.error('warn: x')"), cwd: os.tmpdir() },
    { id: 'b', name: 'Overlay1', action: 'build', command: nodeCmd("console.log('line1');console.log('line2')"), cwd: os.tmpdir() },
    { id: 'c', name: 'Off', action: 'build', command: null, skip: 'not built in this solution configuration', cwd: os.tmpdir() },
  ];
  const r = await runPlan({ steps, action: 'build', configOf: cfg, write: out.write, echoCommand: false });
  assert.deepStrictEqual([r.succeeded, r.failed, r.skipped], [2, 0, 1]);
  const t = out.lines;
  assert.strictEqual(t[0], '1>------ Build started: Project: Game, Configuration: Debug Win32 ------');
  assert.ok(t.includes('1>compiling') && t.includes('1>warn: x'), 'stdout and stderr are both prefixed');
  assert.ok(t.indexOf('2>------ Build started: Project: Overlay1, Configuration: Debug Win32 ------') > t.indexOf('1>compiling'));
  assert.ok(t.includes('2>line1') && t.includes('2>line2'));
  assert.strictEqual(t[t.length - 2], '========== Build: 2 succeeded, 0 failed, 0 up-to-date, 1 skipped ==========');
  assert.match(t[t.length - 1], /^========== Build completed at /);
});

test('output: a failure is reported for its project and the run stops', async () => {
  const steps = [
    { id: 'a', name: 'Lib', action: 'build', command: nodeCmd('process.exit(3)'), cwd: os.tmpdir() },
    { id: 'b', name: 'App', action: 'build', command: nodeCmd("console.log('never')"), cwd: os.tmpdir() },
  ];
  const out = collect();
  const r = await runPlan({ steps, action: 'build', configOf: cfg, write: out.write, stopOnError: true, echoCommand: false });
  assert.deepStrictEqual([r.succeeded, r.failed, r.skipped], [0, 1, 1]);
  assert.ok(out.lines.includes('1>Done building project "Lib" -- FAILED.'));
  assert.ok(!out.lines.some((l) => l.includes('never')));
  const sum = out.lines.find((l) => l.startsWith('========== Build:'));
  assert.strictEqual(sum, '========== Build: 0 succeeded, 1 failed, 0 up-to-date, 1 skipped ==========');
  assert.strictEqual(out.kinds[out.lines.indexOf(sum)], 'error');

  const out2 = collect();
  const r2 = await runPlan({ steps, action: 'build', configOf: cfg, write: out2.write, stopOnError: false, echoCommand: false });
  assert.deepStrictEqual([r2.succeeded, r2.failed, r2.skipped], [1, 1, 0], 'without stop-on-error the next project still builds');
  assert.ok(out2.lines.includes('2>never'));
});

test('output: the command line is echoed under the header by default; clean has no up-to-date count', async () => {
  const out = collect();
  const cmd = nodeCmd("console.log('x')");
  await runPlan({ steps: [{ id: 'a', name: 'P', action: 'clean', command: cmd, cwd: os.tmpdir() }], action: 'clean', configOf: cfg, write: out.write });
  assert.strictEqual(out.lines[0], '1>------ Clean started: Project: P, Configuration: Debug Win32 ------');
  assert.strictEqual(out.lines[1], `1>${cmd}`);
  assert.strictEqual(out.lines[out.lines.length - 2], '========== Clean: 1 succeeded, 0 failed, 0 skipped ==========');
});

test('output: cancelling stops the run and counts the rest as skipped', async () => {
  const out = collect();
  let cancel = false;
  const steps = [
    { id: 'a', name: 'Slow', action: 'build', command: nodeCmd('setTimeout(()=>{},60000)'), cwd: os.tmpdir() },
    { id: 'b', name: 'Next', action: 'build', command: nodeCmd("console.log('no')"), cwd: os.tmpdir() },
  ];
  const { killTree } = require('../src/core/buildrun');
  let proc;
  const run = runPlan({ steps, action: 'build', configOf: cfg, write: out.write, echoCommand: false, cancelled: () => cancel, onProc: (p) => { proc = p; } });
  await new Promise((r) => setTimeout(r, 600));
  cancel = true;
  killTree(proc);
  const r = await run;
  assert.ok(r.canceled);
  assert.deepStrictEqual([r.succeeded, r.failed, r.skipped], [0, 0, 2]);
  assert.ok(out.lines.includes('Build canceled.'));
  assert.ok(!out.lines.some((l) => l.includes('no')));
});
