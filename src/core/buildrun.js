'use strict';
const { spawn } = require('child_process');

// Output in the style of Visual Studio's Build output window:
//   1>------ Build started: Project: Game, Configuration: Debug Win32 ------
//   1>...tool output, every line prefixed with the project's number...
//   ========== Build: 1 succeeded, 0 failed, 0 up-to-date, 0 skipped ==========
//   ========== Build completed at 3:49 PM and took 01.228 seconds ==========

const WORD = { build: 'Build', rebuild: 'Rebuild All', clean: 'Clean' };
const STARTED = { build: 'Build', rebuild: 'Rebuild', clean: 'Clean' };

const pad = (n, w = 2) => String(n).padStart(w, '0');
function duration(ms) {
  const s = ms / 1000;
  if (s < 60) return `${pad(Math.floor(s))}.${pad(Math.round(ms % 1000), 3)} seconds`;
  return `${pad(Math.floor(s / 60))}:${pad(Math.floor(s % 60))}.${pad(Math.round(ms % 1000), 3)} minutes`;
}
const clock = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** "Debug|Win32" -> "Debug Win32", as VS writes it in the project header. */
const cfgLabel = (projectConfig) => (projectConfig || '').replace('|', ' ');

function header(n, action, name, projectConfig) {
  return `${n}>------ ${STARTED[action]} started: Project: ${name}, Configuration: ${cfgLabel(projectConfig)} ------`;
}

function summary(action, c, ms, now = new Date()) {
  const counts = action === 'build'
    ? `${c.succeeded} succeeded, ${c.failed} failed, ${c.upToDate} up-to-date, ${c.skipped} skipped`
    : `${c.succeeded} succeeded, ${c.failed} failed, ${c.skipped} skipped`;
  return [
    `========== ${WORD[action]}: ${counts} ==========`,
    `========== ${WORD[action]} completed at ${clock(now)} and took ${duration(ms)} ==========`,
  ];
}

/** Ends a process and everything it started (cmd.exe / sh run the tool as a child). */
function killTree(proc) {
  if (!proc || proc.exitCode !== null || proc.killed) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else process.kill(-proc.pid, 'SIGTERM');
  } catch { try { proc.kill(); } catch { /* already gone */ } }
}

/** Runs one command, feeding each output line (without line ending) to `onLine`. Resolves with the exit code. */
function runCommand(command, cwd, onLine, onProc) {
  return new Promise((resolve) => {
    const proc = spawn(command, {
      cwd, shell: true, windowsHide: true, detached: process.platform !== 'win32',
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: process.env.PYTHONIOENCODING || 'utf-8' },
    });
    if (onProc) onProc(proc);
    const pending = { out: '', err: '' };
    const feed = (key) => (chunk) => {
      pending[key] += chunk.toString('utf8');
      const parts = pending[key].split('\n');
      pending[key] = parts.pop();
      for (const p of parts) onLine(p.replace(/\r$/, ''));
    };
    proc.stdout.on('data', feed('out'));
    proc.stderr.on('data', feed('err'));
    proc.on('error', (e) => { onLine(`could not start: ${e.message}`); resolve(1); });
    proc.on('close', (code, signal) => {
      for (const k of ['out', 'err']) if (pending[k]) onLine(pending[k].replace(/\r$/, ''));
      resolve(code === null ? (signal ? 1 : 1) : code);
    });
  });
}

/**
 * Runs a build plan the way VS reports it.
 * @param {object} o
 * @param {import('./build').Step[]} o.steps
 * @param {'build'|'rebuild'|'clean'} o.action
 * @param {(entryId:string)=>string} o.configOf      project configuration label source
 * @param {(line:string, kind?:'header'|'summary'|'error')=>void} o.write
 * @param {boolean} [o.stopOnError]
 * @param {boolean} [o.echoCommand]
 * @param {()=>boolean} [o.cancelled]
 * @param {(proc)=>void} [o.onProc]
 * @param {(msg:string)=>void} [o.onProgress]
 * @param {(step, n:number)=>void} [o.onStepStart]            a project starts building (n = its number in the output)
 * @param {(step, n:number, line:string)=>void} [o.onToolLine] every raw line the tool printed
 * @returns {Promise<{succeeded:number, failed:number, skipped:number, upToDate:number, canceled:boolean, ms:number}>}
 */
async function runPlan(o) {
  const t0 = Date.now();
  const c = { succeeded: 0, failed: 0, upToDate: 0, skipped: 0 };
  let n = 0;
  let halted = false;
  let canceled = false;
  for (const s of o.steps) {
    if (!s.command || halted || (o.cancelled && o.cancelled())) {
      if (o.cancelled && o.cancelled()) canceled = true;
      c.skipped++;
      continue;
    }
    n++;
    if (o.onProgress) o.onProgress(`${STARTED[s.action]} ${s.name}`);
    if (o.onStepStart) o.onStepStart(s, n);
    o.write(header(n, s.action, s.name, o.configOf(s.id)), 'header');
    if (o.echoCommand !== false) o.write(`${n}>${s.command}`);
    const code = await runCommand(s.command, s.cwd, (line) => {
      if (o.onToolLine) o.onToolLine(s, n, line);
      o.write(`${n}>${line}`);
    }, o.onProc);
    if (o.cancelled && o.cancelled()) {
      canceled = true;
      c.skipped++;
      continue;
    }
    if (code === 0) c.succeeded++;
    else {
      c.failed++;
      o.write(`${n}>Done building project "${s.name}" -- FAILED.`, 'error');
      if (o.stopOnError) halted = true;
    }
  }
  const ms = Date.now() - t0;
  if (canceled) o.write(`${STARTED[o.action]} canceled.`, 'header');
  const lines = summary(o.action, c, ms);
  o.write(lines[0], c.failed ? 'error' : 'summary');
  o.write(lines[1], 'summary');
  return { ...c, canceled, ms };
}

module.exports = { runPlan, runCommand, killTree, header, summary, duration, cfgLabel };
