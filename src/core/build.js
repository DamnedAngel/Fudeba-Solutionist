'use strict';
const fs = require('fs');
const path = require('path');
const { topoOrder, closure, projectsOf } = require('./model');

/**
 * Build actions are per project: for a Makefile (NMake) project they are the project's own
 * NMakeBuild / NMakeClean / NMakeReBuild command lines for the active configuration; other project
 * kinds get the toolchain's standard command.
 *
 * @typedef {'build'|'rebuild'|'clean'} Action
 * @typedef {object} Step
 * @property {string} id
 * @property {string} name
 * @property {Action} action
 * @property {string|null} command   null: nothing to run (reason in `skip`)
 * @property {string} cwd
 * @property {string} [skip]
 */

const NMAKE_PROP = { build: 'NMakeBuildCommandLine', clean: 'NMakeCleanCommandLine', rebuild: 'NMakeReBuildCommandLine' };
const isWinHost = () => process.platform === 'win32';

/**
 * NMake command lines are written for cmd.exe. On other hosts the path separators inside them are converted
 * so the same project builds from Linux/macOS (`python Make\make.py Debug` -> `python Make/make.py Debug`).
 * Backslashes that escape a quote or a space are left alone.
 */
function portableCommand(cmd, win = isWinHost()) {
  if (win) return cmd;
  return cmd.replace(/(?<=[\w.$)\]\-"'])\\(?=[\w.$(\[\-])/g, '/');
}

/** `python` -> `python3` when only the latter exists on this host (typical Linux). */
function pythonFallback(cmd, win = isWinHost(), onPath = commandOnPath) {
  if (win) return cmd;
  const m = /^(\s*)python(\s|$)/.exec(cmd);
  if (m && !onPath('python') && onPath('python3')) return cmd.replace(/^(\s*)python/, '$1python3');
  return cmd;
}

function commandOnPath(name) {
  const exts = isWinHost() ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const ext of exts) {
      try { if (fs.statSync(path.join(dir, name + ext)).isFile()) return true; } catch { /* keep looking */ }
    }
  }
  return false;
}

const q = (s) => `"${s}"`;

/** @returns {{command:string|null, skip?:string}} */
function commandFor(entry, action, opt = {}) {
  const pd = entry.data;
  const win = opt.win === undefined ? isWinHost() : opt.win;
  if (!pd.exists) return { command: null, skip: 'project file not found' };
  if (pd.kind === 'makefile') {
    const get = (a) => pd.props.get(NMAKE_PROP[a]).trim();
    let cmd = get(action);
    if (!cmd && action === 'rebuild') {
      const c = get('clean'), b = get('build');
      cmd = c && b ? `${c} && ${b}` : b;
    }
    if (!cmd) return { command: null, skip: `${NMAKE_PROP[action]} is empty for ${pd.config}|${pd.platform}` };
    return { command: pythonFallback(portableCommand(cmd, win), win) };
  }
  if (pd.kind === 'dotnet') {
    const plat = pd.platform && !/^any ?cpu$/i.test(pd.platform) ? ` -p:Platform=${q(pd.platform)}` : '';
    const base = `dotnet ${action === 'clean' ? 'clean' : 'build'} ${q(pd.file)} -c ${q(pd.config)}${plat}`;
    return { command: action === 'rebuild' ? `${base} --no-incremental` : base };
  }
  if (pd.kind === 'cpp') {
    if (!win) return { command: null, skip: 'C++ (MSBuild) projects can only be built on Windows' };
    const t = { build: 'Build', clean: 'Clean', rebuild: 'Rebuild' }[action];
    return { command: `${opt.msbuild || 'msbuild'} ${q(pd.file)} /t:${t} /p:Configuration=${q(pd.config)} /p:Platform=${q(pd.platform)} /nologo /v:m` };
  }
  return { command: null, skip: `no build action for ${path.extname(pd.file) || 'this'} projects` };
}

/**
 * Orders the work for an action.
 * @param {import('./model').Model} model
 * @param {{ids?: string[]|null, action:Action, withDeps?:boolean}} o  ids null = whole solution
 * @returns {Step[]}
 */
function plan(model, o, opt = {}) {
  let ids;
  if (!o.ids) ids = projectsOf(model).map((e) => e.sln.id);
  else if (o.withDeps === false || o.action === 'clean') ids = o.ids;
  else ids = [...new Set(o.ids.flatMap((i) => closure(model, i)))];
  const ordered = topoOrder(model, ids);
  // cleaning runs the other way round, as dependents are cleaned before what they were built from
  const seq = o.action === 'clean' ? [...ordered].reverse() : ordered;
  return seq.map((id) => {
    const e = model.entries.get(id);
    const base = { id, name: e.sln.name, action: o.action, cwd: e.data.dir };
    if (!e.builds && !(o.ids && o.ids.includes(id))) return { ...base, command: null, skip: 'not built in this solution configuration' };
    return { ...base, ...commandFor(e, o.action, opt) };
  });
}

module.exports = { commandFor, plan, portableCommand, pythonFallback, commandOnPath };
