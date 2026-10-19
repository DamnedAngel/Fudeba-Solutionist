'use strict';
const fs = require('fs');
const path = require('path');
const { parseXml, kids, kid, attr, value, eq } = require('./xml');
const { Props, expand, evalCondition } = require('./props');

const { native: winPath, resolveIn } = require('./fsx');
const normInclude = (s) => s.replace(/\//g, '\\').toLowerCase();

// Item types that are not files of the project.
const NON_FILE = new Set(['projectconfiguration', 'projectreference', 'reference', 'packagereference', 'comreference',
  'frameworkreference', 'analyzer', 'service', 'bootstrapperpackage', 'import', 'sdk', 'assemblyreference', 'sharedprojectreference']);
const SKIP_DIRS = new Set(['bin', 'obj', 'node_modules', '.git', '.vs', '.svn', 'packages', 'debug', 'release', 'x64', 'x86']);

/**
 * @typedef {object} ProjectItem
 * @property {string} type       MSBuild item type (ClCompile, None, Compile, Text ...)
 * @property {string} include    as written (backslashes)
 * @property {string} path       absolute
 * @property {string|null} filter  filter name from the .filters file
 *
 * @typedef {object} ProjectData
 * @property {string} file
 * @property {string} dir
 * @property {string} name
 * @property {'cpp'|'makefile'|'dotnet'|'shared'|'unknown'} kind
 * @property {boolean} sdk
 * @property {boolean} exists
 * @property {string} config
 * @property {string} platform
 * @property {{config:string, platform:string, name:string}[]} configs
 * @property {Props} props
 * @property {ProjectItem[]} items
 * @property {{path:string, guid:string|null, include:string}[]} refs
 * @property {string|null} filtersFile
 * @property {string[]} filters   all filter names (full backslash paths), incl. ancestors
 * @property {string|null} guid
 * @property {string} configurationType
 */

function kindOf(file, configurationType) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.vcxproj') return /makefile/i.test(configurationType) ? 'makefile' : 'cpp';
  if (['.csproj', '.vbproj', '.fsproj'].includes(ext)) return 'dotnet';
  if (['.shproj', '.vcxitems', '.projitems'].includes(ext)) return 'shared';
  return 'unknown';
}

function seedProps(file, solVars, config, platform) {
  const dir = path.dirname(file);
  const ext = path.extname(file);
  const name = path.basename(file, ext);
  const p = new Props({
    Configuration: config, Platform: platform,
    MSBuildProjectName: name, MSBuildProjectFile: path.basename(file), MSBuildProjectExtension: ext,
    MSBuildProjectDirectory: dir, MSBuildProjectFullPath: file, MSBuildThisFileDirectory: dir + path.sep,
    ProjectName: name, ProjectDir: dir + path.sep, ProjectPath: file, ProjectFileName: path.basename(file), ProjectExt: ext,
    TargetName: name, VCTargetsPath: '', ...solVars,
  });
  if (/\.vcxproj$/i.test(file)) {
    const sd = p.get('SolutionDir') || dir + path.sep;
    p.set('OutDir', platform === 'Win32' ? `${sd}${config}\\` : `${sd}${platform}\\${config}\\`);
    p.set('IntDir', `${config}\\`);
    p.set('TargetExt', '');
  }
  return p;
}

/** First pass: properties, in document order, following local imports. */
function evalProperties(nodes, props, dir, depth) {
  for (const n of nodes) {
    const nm = n.name.toLowerCase();
    if (nm === 'propertygroup') {
      if (!evalCondition(attr(n, 'Condition'), props, dir)) continue;
      for (const c of n.children) {
        if (!evalCondition(attr(c, 'Condition'), props, dir)) continue;
        props.set(c.name, expand(value(c), props));
      }
    } else if (nm === 'import' && depth < 4) {
      const proj = expand(attr(n, 'Project') || '', props);
      if (!proj || !evalCondition(attr(n, 'Condition'), props, dir)) continue;
      const f = resolveIn(dir, proj);
      if (!/\.(props|targets)$/i.test(f) || !fs.existsSync(f)) continue;
      try {
        const doc = parseXml(fs.readFileSync(f, 'utf8'));
        const r = kid(doc, 'Project');
        if (r) evalProperties(r.children, props, path.dirname(f), depth + 1);
      } catch { /* an unreadable import is ignored, as a missing SDK would be */ }
    } else if (nm === 'choose') {
      for (const w of kids(n, 'When')) {
        if (evalCondition(attr(w, 'Condition'), props, dir)) { evalProperties(w.children, props, dir, depth); break; }
      }
    }
  }
}

function listConfigs(root, props, dir) {
  const out = [];
  for (const g of kids(root, 'ItemGroup')) {
    if (!/ProjectConfigurations/i.test(attr(g, 'Label') || '')) continue;
    for (const c of kids(g, 'ProjectConfiguration')) {
      const config = value(kid(c, 'Configuration')), platform = value(kid(c, 'Platform'));
      if (config) out.push({ config, platform, name: `${config}|${platform}` });
    }
  }
  if (out.length) return out;
  const cfgs = (props.get('Configurations') || 'Debug;Release').split(';').filter(Boolean);
  const pls = (props.get('Platforms') || props.get('Platform') || 'AnyCPU').split(';').filter(Boolean);
  for (const config of cfgs) for (const platform of pls) out.push({ config, platform, name: `${config}|${platform}` });
  return out;
}

function walkDisk(dir, rel, out) {
  let ents;
  try { ents = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (out.length > 5000) return;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name.toLowerCase()) && !rel || e.name.startsWith('.')) continue;
      walkDisk(dir, rel ? `${rel}\\${e.name}` : e.name, out);
    } else if (!/\.(user|suo)$/i.test(e.name)) {
      out.push(rel ? `${rel}\\${e.name}` : e.name);
    }
  }
}

function readFilters(file, items) {
  const ff = `${file}.filters`;
  if (!fs.existsSync(ff)) return { filtersFile: null, filters: [] };
  const doc = parseXml(fs.readFileSync(ff, 'utf8'));
  const root = kid(doc, 'Project');
  const names = new Set();
  const itemFilter = new Map();
  if (root) {
    for (const g of kids(root, 'ItemGroup')) {
      for (const c of g.children) {
        const inc = attr(c, 'Include');
        if (inc === undefined) continue;
        if (eq(c.name, 'Filter')) names.add(inc);
        else { const f = kid(c, 'Filter'); if (f) itemFilter.set(normInclude(inc), value(f)); }
      }
    }
  }
  // ancestors are filters too, even when the file does not list them
  for (const n of [...names, ...itemFilter.values()]) {
    const parts = n.split('\\');
    for (let i = 1; i <= parts.length; i++) names.add(parts.slice(0, i).join('\\'));
  }
  for (const it of items) it.filter = itemFilter.get(normInclude(it.include)) || null;
  return { filtersFile: ff, filters: [...names] };
}

/**
 * @param {string} file absolute project path
 * @param {{config?:string, platform?:string, solVars?:object}} opt
 * @returns {ProjectData}
 */
function loadProject(file, opt = {}) {
  const dir = path.dirname(file);
  const base = { file, dir, name: path.basename(file, path.extname(file)), exists: false, items: [], refs: [], filtersFile: null, filters: [], configs: [], sdk: false, guid: null, configurationType: '' };
  if (!fs.existsSync(file)) return { ...base, kind: kindOf(file, ''), config: opt.config || '', platform: opt.platform || '', props: new Props() };
  const text = fs.readFileSync(file, 'utf8');
  const doc = parseXml(text);
  const root = kid(doc, 'Project');
  if (!root) return { ...base, exists: true, kind: kindOf(file, ''), config: opt.config || '', platform: opt.platform || '', props: new Props() };

  // pass 0: find the configurations without any configuration selected
  const probe = seedProps(file, opt.solVars || {}, 'Debug', 'AnyCPU');
  evalProperties(root.children, probe, dir, 0);
  const configs = listConfigs(root, probe, dir);
  let config = opt.config, platform = opt.platform;
  if (!config) { const c0 = configs[0] || { config: 'Debug', platform: 'AnyCPU' }; config = c0.config; platform = c0.platform; }

  const props = seedProps(file, opt.solVars || {}, config, platform || '');
  evalProperties(root.children, props, dir, 0);

  const sdk = !!(attr(root, 'Sdk') || kid(root, 'Sdk') || kids(root, 'Import').some((i) => attr(i, 'Sdk')));
  const guid = (value(kids(kids(root, 'PropertyGroup').find((g) => kid(g, 'ProjectGuid')) || { children: [] }, 'ProjectGuid')[0]) || '').toUpperCase() || null;

  // pass 2: items
  const items = [];
  const refs = [];
  for (const g of kids(root, 'ItemGroup')) {
    if (/ProjectConfigurations/i.test(attr(g, 'Label') || '')) continue;
    if (!evalCondition(attr(g, 'Condition'), props, dir)) continue;
    for (const c of g.children) {
      if (!evalCondition(attr(c, 'Condition'), props, dir)) continue;
      const inc = attr(c, 'Include');
      if (inc === undefined) continue;
      const lname = c.name.toLowerCase();
      if (lname === 'projectreference') {
        const e = expand(inc, props);
        refs.push({ include: e, path: resolveIn(dir, e), guid: (value(kid(c, 'Project')) || '').toUpperCase() || null });
        continue;
      }
      if (NON_FILE.has(lname)) continue;
      for (const one of expand(inc, props).split(';').filter(Boolean)) {
        if (/[*?]/.test(one)) continue; // wildcard includes on legacy projects: shown through the folder scan below
        items.push({ type: c.name, include: one, path: resolveIn(dir, one), filter: null });
      }
    }
  }
  if (sdk) {
    // SDK-style projects include their files by convention: show the folder content
    const have = new Set(items.map((i) => normInclude(i.include)));
    const found = [];
    walkDisk(dir, '', found);
    for (const rel of found) {
      if (/\.(csproj|vbproj|fsproj|vcxproj)$/i.test(rel) && !rel.includes('\\')) continue;
      if (have.has(normInclude(rel))) continue;
      items.push({ type: /\.(cs|vb|fs)$/i.test(rel) ? 'Compile' : 'None', include: rel, path: path.join(dir, winPath(rel)), filter: null });
    }
  }
  const { filtersFile, filters } = readFilters(file, items);
  const configurationType = props.get('ConfigurationType');
  return {
    file, dir, name: base.name, exists: true, kind: kindOf(file, configurationType), sdk, guid, config, platform: platform || '', configs, props,
    items, refs, filtersFile, filters, configurationType,
  };
}

/** Expands a raw property value (as the build would see it) with the project's evaluated properties. */
const prop = (pd, name) => (pd.props ? pd.props.get(name) : '');

module.exports = { loadProject, kindOf, normInclude, prop };
