'use strict';
const fs = require('fs');
const path = require('path');
const { parseSolutionFile, projectConfigFor } = require('./sln');
const { loadProject } = require('./project');
const { normInclude } = require('./project');
const { mapConfig } = require('./slnEdit');

/**
 * @typedef {object} Entry
 * @property {import('./sln').SlnProject} sln
 * @property {import('./project').ProjectData|null} data   null for solution folders
 * @property {string} projectConfig   e.g. 'Debug|Win32'
 * @property {boolean} builds         whether the active solution configuration builds it
 * @property {string[]} deps          project ids this project depends on (solution + ProjectReference)
 *
 * @typedef {object} Model
 * @property {import('./sln').Solution} sol
 * @property {string} config          active solution configuration
 * @property {Map<string, Entry>} entries
 */

function solutionVars(sol) {
  const ext = path.extname(sol.file);
  return {
    SolutionDir: sol.dir + path.sep, SolutionName: sol.name, SolutionPath: sol.file,
    SolutionFileName: path.basename(sol.file), SolutionExt: ext,
  };
}

/** True when every configuration of the solution uses the same platform, so the platform carries no information. */
function singlePlatform(sol) {
  return new Set(sol.configs.map((c) => c.split('|')[1])).size <= 1;
}

/** Configuration as shown to the user: "Debug", not "Debug|x86", unless the solution really has several platforms. */
function configLabel(sol, cfg) {
  return cfg && singlePlatform(sol) ? cfg.split('|')[0] : cfg || '';
}

/** @returns {Model} */
function loadModel(file, activeConfig) {
  const sol = parseSolutionFile(file, fs.readFileSync(file, 'utf8'));
  const config = sol.configs.includes(activeConfig) ? activeConfig : (sol.configs[0] || '');
  const vars = solutionVars(sol);
  const entries = new Map();
  for (const p of sol.projects) {
    if (p.isFolder) { entries.set(p.id, { sln: p, data: null, projectConfig: '', builds: false, deps: [] }); continue; }
    let pc = projectConfigFor(sol, p.id, config);
    const [c, pl] = pc.cfg.split('|');
    let data = loadProject(p.path, { config: c, platform: pl, solVars: vars });
    // a .slnx has no per-project configuration mapping: the solution's configuration is used as is, which for a
    // C++ project means "x86" has to be read as the project's "Win32" (as Visual Studio maps it in a .sln)
    if (sol.format === 'slnx' && data.exists && data.configs.length && !data.configs.some((x) => x.name.toLowerCase() === pc.cfg.toLowerCase())) {
      const mapped = mapConfig(pc.cfg, data.configs);
      const [c2, p2] = mapped.split('|');
      data = loadProject(p.path, { config: c2, platform: p2, solVars: vars });
      pc = { ...pc, cfg: mapped };
    }
    entries.set(p.id, { sln: p, data, projectConfig: pc.cfg, builds: pc.build && data.exists, deps: [] });
  }
  // dependency ids: the solution's own list plus ProjectReference entries that resolve to a solution project
  const byPath = new Map();
  const byGuid = new Map();
  for (const e of entries.values()) {
    if (e.sln.isFolder) continue;
    byPath.set(path.resolve(e.sln.path).toLowerCase(), e.sln.id);
    byGuid.set(e.sln.id.toUpperCase(), e.sln.id);
  }
  for (const e of entries.values()) {
    if (e.sln.isFolder) continue;
    const set = new Set(e.sln.deps.filter((d) => entries.has(d)));
    for (const r of e.data.refs) {
      const id = (r.guid && byGuid.get(r.guid.toUpperCase().startsWith('{') ? r.guid.toUpperCase() : `{${r.guid.toUpperCase()}}`)) || byPath.get(path.resolve(r.path).toLowerCase());
      if (id && id !== e.sln.id) set.add(id);
    }
    e.deps = [...set];
  }
  return { sol, config, entries };
}

/** Where a dependency is stored, so the editor can remove it from the right place. */
function dependencySources(model, id) {
  const e = model.entries.get(id);
  const out = new Map();
  for (const d of e.sln.deps) out.set(d, { sln: true, ref: false });
  for (const d of e.deps) {
    const cur = out.get(d) || { sln: false, ref: false };
    if (!e.sln.deps.includes(d)) cur.ref = true;
    out.set(d, cur);
  }
  return out;
}

/** Projects (not folders) in solution order. */
const projectsOf = (model) => [...model.entries.values()].filter((e) => !e.sln.isFolder);

/** Dependency-first ordering of `ids`; throws on a cycle. Ties keep solution order. */
function topoOrder(model, ids) {
  const want = new Set(ids);
  const order = [];
  const state = new Map();
  const names = (stack) => stack.map((i) => model.entries.get(i).sln.name).join(' -> ');
  const visit = (id, stack) => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) throw new Error(`Circular project dependency: ${names([...stack, id])}`);
    state.set(id, 1);
    const e = model.entries.get(id);
    for (const d of e.deps) if (want.has(d)) visit(d, [...stack, id]);
    state.set(id, 2);
    order.push(id);
  };
  for (const e of projectsOf(model)) if (want.has(e.sln.id)) visit(e.sln.id, []);
  return order;
}

/** `id` plus everything it (transitively) depends on. */
function closure(model, id) {
  const seen = new Set();
  const walk = (i) => { if (seen.has(i)) return; seen.add(i); for (const d of model.entries.get(i).deps) if (model.entries.has(d)) walk(d); };
  walk(id);
  return [...seen];
}

/** Projects that (transitively) depend on `id`. */
function dependents(model, id) {
  const out = new Set();
  const grow = (target) => {
    for (const e of projectsOf(model)) if (e.deps.includes(target) && !out.has(e.sln.id)) { out.add(e.sln.id); grow(e.sln.id); }
  };
  grow(id);
  return [...out];
}

module.exports = { loadModel, topoOrder, closure, dependents, dependencySources, projectsOf, solutionVars, normInclude, configLabel, singlePlatform };
