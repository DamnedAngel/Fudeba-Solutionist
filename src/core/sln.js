'use strict';
const path = require('path');
const { parseXml, kids, attr } = require('./xml');

const FOLDER_TYPE = '{2150E333-8FDC-42A3-9474-1A3956D46DE8}';

/**
 * @typedef {object} SlnProject
 * @property {string} id        upper-case {GUID} (or the normalised relative path for .slnx)
 * @property {string} name
 * @property {string} relPath   as written in the solution
 * @property {string} path      absolute
 * @property {string} typeGuid
 * @property {boolean} isFolder
 * @property {string|null} parent   id of the containing solution folder
 * @property {string[]} deps        ids of the projects this one depends on (solution-level)
 * @property {string[]} items       solution items (folders only), relative paths
 *
 * @typedef {object} Solution
 * @property {string} file
 * @property {string} dir
 * @property {string} name
 * @property {'sln'|'slnx'} format
 * @property {SlnProject[]} projects     solution folders included
 * @property {string[]} configs          e.g. ['Debug|x86', 'Release|x86']
 * @property {Record<string, Record<string, {cfg:string, build:boolean}>>} map  id -> solConfig -> project config
 * @property {boolean} hasMap
 */

const norm = (g) => g.toUpperCase();
const { native: winPath, resolveIn } = require('./fsx');

function parseSln(text, file) {
  const lines = text.split(/\r?\n/);
  const projects = [];
  const byId = new Map();
  let cur = null;
  let section = null;
  const sol = { file, dir: path.dirname(file), name: path.basename(file, path.extname(file)), format: 'sln', projects, configs: [], map: {}, hasMap: false };

  for (const raw of lines) {
    const line = raw.trim();
    let m = /^Project\("\{([^}]+)\}"\)\s*=\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*"\{([^}]+)\}"/.exec(line);
    if (m) {
      const typeGuid = `{${norm(m[1])}}`;
      cur = {
        id: `{${norm(m[4])}}`, name: m[2], relPath: m[3], path: resolveIn(sol.dir, m[3]),
        typeGuid, isFolder: typeGuid === FOLDER_TYPE, parent: null, deps: [], items: [],
      };
      projects.push(cur);
      byId.set(cur.id, cur);
      continue;
    }
    if (cur) {
      if (line === 'EndProject') { cur = null; section = null; continue; }
      m = /^ProjectSection\((\w+)\)/.exec(line);
      if (m) { section = m[1]; continue; }
      if (line === 'EndProjectSection') { section = null; continue; }
      if (section === 'ProjectDependencies') {
        m = /^\{([^}]+)\}\s*=/.exec(line);
        if (m) cur.deps.push(`{${norm(m[1])}}`);
      } else if (section === 'SolutionItems') {
        m = /^(.+?)\s*=\s*(.+)$/.exec(line);
        if (m) cur.items.push(m[1]);
      }
      continue;
    }
    m = /^GlobalSection\((\w+)\)/.exec(line);
    if (m) { section = m[1]; continue; }
    if (line === 'EndGlobalSection') { section = null; continue; }
    if (section === 'SolutionConfigurationPlatforms') {
      m = /^(.+?)\s*=\s*(.+)$/.exec(line);
      if (m && !sol.configs.includes(m[1])) sol.configs.push(m[1]);
    } else if (section === 'ProjectConfigurationPlatforms') {
      sol.hasMap = true;
      m = /^\{([^}]+)\}\.(.+?)\.(ActiveCfg|Build\.0|Deploy\.0)\s*=\s*(.+)$/.exec(line);
      if (m) {
        const id = `{${norm(m[1])}}`;
        const e = ((sol.map[id] = sol.map[id] || {})[m[2]] = sol.map[id][m[2]] || { cfg: m[2], build: false });
        if (m[3] === 'ActiveCfg') e.cfg = m[4];
        else if (m[3] === 'Build.0') e.build = true;
      }
    } else if (section === 'NestedProjects') {
      m = /^\{([^}]+)\}\s*=\s*\{([^}]+)\}/.exec(line);
      if (m) { const c = byId.get(`{${norm(m[1])}}`); if (c) c.parent = `{${norm(m[2])}}`; }
    }
  }
  return sol;
}

function parseSlnx(text, file) {
  const doc = parseXml(text);
  const root = kids(doc, 'Solution')[0];
  const sol = { file, dir: path.dirname(file), name: path.basename(file, path.extname(file)), format: 'slnx', projects: [], configs: [], map: {}, hasMap: false };
  if (!root) return sol;
  const byId = new Map();
  const cfgs = kids(root, 'Configurations')[0];
  const buildTypes = [];
  const platforms = [];
  if (cfgs) {
    for (const c of kids(cfgs, 'BuildType')) buildTypes.push(attr(c, 'Name'));
    for (const c of kids(cfgs, 'Platform')) platforms.push(attr(c, 'Name'));
  }
  const bts = buildTypes.length ? buildTypes : ['Debug', 'Release'];
  const pls = platforms.length ? platforms : ['Any CPU'];
  for (const b of bts) for (const p of pls) sol.configs.push(`${b}|${p}`);

  const ensureFolder = (name) => {
    // names look like "/A/B/": build the chain
    const parts = name.split('/').filter(Boolean);
    let parent = null;
    let acc = '';
    for (const part of parts) {
      acc += `/${part}`;
      const id = `folder:${acc}`;
      if (!byId.has(id)) {
        const f = { id, name: part, relPath: part, path: '', typeGuid: FOLDER_TYPE, isFolder: true, parent, deps: [], items: [] };
        byId.set(id, f); sol.projects.push(f);
      }
      parent = id;
    }
    return parent;
  };
  const projId = (p) => `proj:${path.normalize(winPath(p)).toLowerCase()}`;
  const deferred = [];
  const walk = (node, folderId) => {
    for (const c of node.children) {
      if (c.name === 'Folder') {
        const id = ensureFolder(attr(c, 'Name') || '/');
        for (const f of kids(c, 'File')) { const fo = byId.get(id); if (fo) fo.items.push(attr(f, 'Path')); }
        walk(c, id);
      } else if (c.name === 'Project') {
        const rel = attr(c, 'Path');
        const p = {
          id: projId(rel), name: path.basename(rel, path.extname(rel)), relPath: rel, path: resolveIn(sol.dir, rel),
          typeGuid: attr(c, 'Type') || '', isFolder: false, parent: folderId, deps: [], items: [],
        };
        byId.set(p.id, p); sol.projects.push(p);
        deferred.push([p, c]);
      }
    }
  };
  walk(root, null);
  for (const [p, c] of deferred) {
    for (const d of kids(c, 'BuildDependency')) p.deps.push(projId(attr(d, 'Project')));
    for (const b of kids(c, 'Build')) {
      // <Build Solution="Debug|*" Project="false" /> switches the project off for matching configs
      if (attr(b, 'Project') === 'false') {
        sol.hasMap = true;
        const sc = attr(b, 'Solution') || '*|*';
        for (const cfg of sol.configs) {
          const [sb, sp] = sc.split('|');
          const [cb, cp] = cfg.split('|');
          if ((sb === '*' || sb === cb) && (!sp || sp === '*' || sp === cp)) {
            ((sol.map[p.id] = sol.map[p.id] || {})[cfg] = { cfg, build: false });
          }
        }
      }
    }
  }
  // projects never mentioned in a <Build> element build in every configuration
  for (const p of sol.projects) {
    if (p.isFolder) continue;
    sol.map[p.id] = sol.map[p.id] || {};
    for (const cfg of sol.configs) sol.map[p.id][cfg] = sol.map[p.id][cfg] || { cfg, build: true };
  }
  return sol;
}

/** The project configuration (as the project calls it) for a solution configuration, and whether it builds. */
function projectConfigFor(sol, projectId, solConfig) {
  const e = sol.map[projectId] && sol.map[projectId][solConfig];
  if (e) return { cfg: e.cfg, build: e.build };
  // no mapping section: the project is assumed to build under the same name
  return { cfg: solConfig, build: !sol.hasMap || sol.format === 'slnx' };
}

// ---- Editing the text format ------------------------------------------------------------------

/** Replaces the ProjectDependencies section of one project in .sln text; line endings are preserved. */
function setSlnDependencies(text, projectId, depIds) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const guid = projectId.replace(/[{}]/g, '').toUpperCase();
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = /^Project\("\{[^}]+\}"\)\s*=\s*"[^"]*"\s*,\s*"[^"]*"\s*,\s*"\{([^}]+)\}"/.exec(lines[i].trim());
    if (m && m[1].toUpperCase() === guid) { start = i; break; }
  }
  if (start < 0) throw new Error(`Project ${projectId} not found in the solution file`);
  let end = start;
  while (end < lines.length && lines[end].trim() !== 'EndProject') end++;
  // drop the old section
  for (let i = start + 1; i < end; i++) {
    if (/^\s*ProjectSection\(ProjectDependencies\)/.test(lines[i])) {
      let j = i;
      while (j < end && lines[j].trim() !== 'EndProjectSection') j++;
      lines.splice(i, j - i + 1);
      end -= j - i + 1;
      break;
    }
  }
  if (depIds.length) {
    const sect = ['\tProjectSection(ProjectDependencies) = postProject', ...depIds.map((d) => `\t\t${d} = ${d}`), '\tEndProjectSection'];
    // VS keeps dependencies ahead of any other section (SolutionItems follows)
    lines.splice(start + 1, 0, ...sect);
  }
  return lines.join(eol);
}

function parseSolutionFile(file, text) {
  return /\.slnx$/i.test(file) ? parseSlnx(text, file) : parseSln(text, file);
}

module.exports = { parseSln, parseSlnx, parseSolutionFile, projectConfigFor, setSlnDependencies, FOLDER_TYPE };
