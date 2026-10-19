'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { ZipArchive } = require('./zip');
const { parseXml, kid, kids, attr, value, eq } = require('./xml');

/**
 * @typedef {object} Template
 * @property {string} name
 * @property {string} description
 * @property {string} defaultName
 * @property {boolean} createNewFolder
 * @property {string} projectType
 * @property {number} sortOrder
 * @property {string} origin      zip file or folder it was found in
 * @property {'zip'|'dir'} kind
 * @property {string} vstemplate  entry name of the .vstemplate inside the origin
 * @property {number} mtime
 * @property {string|null} icon   entry name of the icon inside the origin
 */

// ---- Sources: a template is either a .zip or an unzipped folder -------------------------------

function openSource(t) {
  if (t.kind === 'zip') {
    const z = new ZipArchive(t.origin);
    return { read: (rel) => z.read(rel), has: (rel) => !!z.find(rel) };
  }
  const resolve = (rel) => path.join(t.origin, rel.replace(/[\\/]/g, path.sep));
  return { read: (rel) => fs.readFileSync(resolve(rel)), has: (rel) => fs.existsSync(resolve(rel)) };
}

function parseVsTemplate(text, fallbackName) {
  const root = kid(parseXml(text), 'VSTemplate');
  if (!root) return null;
  const data = kid(root, 'TemplateData');
  const content = kid(root, 'TemplateContent');
  if (!data || !content || !kid(content, 'Project')) return null; // multi-project and item templates are out of scope
  const t = (n) => value(kid(data, n));
  const plain = (s) => (s && !/^#|^%/.test(s) ? s : '');
  return {
    root,
    meta: {
      name: plain(t('Name')) || fallbackName,
      description: plain(t('Description')),
      defaultName: plain(t('DefaultName')) || fallbackName,
      createNewFolder: !/^false$/i.test(t('CreateNewFolder') || 'true'),
      projectType: t('ProjectType'),
      sortOrder: Number(t('SortOrder')) || 1000,
      icon: t('Icon') || null,
    },
  };
}

function scanZip(file) {
  let z;
  try { z = new ZipArchive(file); } catch { return null; }
  const entry = z.entries.find((e) => !e.dir && !e.name.includes('/') && /\.vstemplate$/i.test(e.name));
  if (!entry) return null;
  const parsed = parseVsTemplate(z.read(entry).toString('utf8'), path.basename(file, '.zip'));
  if (!parsed) return null;
  return { ...parsed.meta, origin: file, kind: 'zip', vstemplate: entry.name, mtime: fs.statSync(file).mtimeMs };
}

function scanDir(dir) {
  let f;
  try { f = fs.readdirSync(dir).find((n) => /\.vstemplate$/i.test(n)); } catch { return null; }
  if (!f) return null;
  const parsed = parseVsTemplate(fs.readFileSync(path.join(dir, f), 'utf8'), path.basename(dir));
  if (!parsed) return null;
  return { ...parsed.meta, origin: dir, kind: 'dir', vstemplate: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs };
}

/**
 * Finds project templates under the given folders: zips holding a root .vstemplate and unzipped template
 * folders. The same template installed several times (several VS versions) shows once, newest copy wins.
 * @returns {Template[]}
 */
function discoverTemplates(roots) {
  const found = [];
  const seen = new Set();
  const visit = (dir, depth) => {
    const key = path.resolve(dir).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const own = scanDir(dir);
    if (own) { found.push(own); return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isFile() && /\.zip$/i.test(e.name)) { const t = scanZip(full); if (t) found.push(t); }
      else if (e.isDirectory() && depth < 3) visit(full, depth + 1);
    }
  };
  for (const r of roots) visit(r, 0);
  const byName = new Map();
  for (const t of found) {
    const prev = byName.get(t.name.toLowerCase());
    if (!prev || t.mtime > prev.mtime) byName.set(t.name.toLowerCase(), t);
  }
  return [...byName.values()].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

/** Default places where Visual Studio keeps user project templates. */
function defaultTemplateRoots(home = os.homedir()) {
  const out = [];
  const docs = [path.join(home, 'Documents'), path.join(home, 'OneDrive', 'Documents')];
  for (const d of docs) {
    let vs;
    try { vs = fs.readdirSync(d).filter((n) => /^Visual Studio \d+/i.test(n)); } catch { continue; }
    for (const n of vs) out.push(path.join(d, n, 'Templates', 'ProjectTemplates'));
  }
  return out.filter((p) => fs.existsSync(p));
}

// ---- Instantiation ------------------------------------------------------------------------

const safeIdentifier = (s) => {
  const r = s.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[0-9]/.test(r) ? `_${r}` : r;
};

function makeParams(o) {
  const now = new Date();
  const p = {
    projectname: o.projectName,
    safeprojectname: safeIdentifier(o.projectName),
    rootnamespace: safeIdentifier(o.projectName),
    solutionname: o.solutionName,
    specifiedsolutionname: o.solutionName,
    destinationdirectory: o.projectDir,
    solutiondirectory: o.solutionDir,
    year: String(now.getFullYear()),
    time: now.toLocaleString(),
    username: os.userInfo().username,
    userdomain: process.env.USERDOMAIN || os.hostname(),
    machinename: os.hostname(),
    registeredorganization: '',
    clrversion: '', targetframeworkversion: '', targetframeworkidentifier: '',
    wizarddata: '', itemname: o.projectName, safeitemname: safeIdentifier(o.projectName),
  };
  for (let i = 1; i <= 10; i++) p[`guid${i}`] = crypto.randomUUID();
  Object.assign(p, o.extra || {});
  return p;
}

const replaceParams = (s, params) => s.replace(/\$([A-Za-z0-9_]+)\$/g, (m, k) => (params[k.toLowerCase()] !== undefined ? params[k.toLowerCase()] : m));

const norm = (s) => s.replace(/\//g, '\\').toLowerCase();

/** Item Include paths declared in a (substituted) project file, for the layout rule below. */
function declaredIncludes(projectText) {
  const out = [];
  try {
    const root = kid(parseXml(projectText), 'Project');
    for (const g of kids(root, 'ItemGroup')) {
      if (/ProjectConfigurations/i.test(attr(g, 'Label') || '')) continue;
      for (const c of g.children) {
        const inc = attr(c, 'Include');
        if (inc && !/^(projectreference|reference|packagereference)$/i.test(c.name) && !/[*$]/.test(inc)) out.push(inc);
      }
    }
  } catch { /* an unreadable project file simply yields no layout hints */ }
  return out;
}

/** Lists what a template would write: [{source, dest, replace, isProject}] (project file first). */
function planTemplate(t) {
  const src = openSource(t);
  const root = parseVsTemplate(src.read(t.vstemplate).toString('utf8'), t.name).root;
  const content = kid(root, 'TemplateContent');
  const proj = kid(content, 'Project');
  const plan = [{
    source: attr(proj, 'File'), dest: attr(proj, 'TargetFileName') || attr(proj, 'File'),
    replace: true, isProject: true,
  }];
  const walk = (node, prefix) => {
    for (const c of node.children) {
      if (eq(c.name, 'ProjectItem')) {
        const source = value(c);
        plan.push({
          source, dest: prefix + (attr(c, 'TargetFileName') || source),
          replace: /^true$/i.test(attr(c, 'ReplaceParameters') || ''), isProject: false,
        });
      } else if (eq(c.name, 'Folder')) {
        walk(c, `${prefix}${attr(c, 'TargetFolderName') || attr(c, 'Name')}\\`);
      }
    }
  };
  walk(proj, '');
  const custom = {};
  const cp = kid(content, 'CustomParameters');
  if (cp) for (const c of kids(cp, 'CustomParameter')) custom[(attr(c, 'Name') || '').replace(/\$/g, '').toLowerCase()] = attr(c, 'Value') || '';
  return { plan, custom, src };
}

/**
 * Writes a new project from a template.
 * File layout: a template item with a bare target name (VS flattens "MAKE\make.py" to "make.py") goes where the
 * generated project file itself says it lives (<None Include="Make\make.py"/>), which is how the projects VS
 * produces from these templates end up organised.
 * @returns {{projectFile:string, files:string[], guid:string}}
 */
function instantiate(t, opt) {
  const { plan, custom, src } = planTemplate(t);
  const params = makeParams({ ...opt, extra: custom });
  const projectName = opt.projectName;
  if (fs.existsSync(opt.projectDir) && fs.readdirSync(opt.projectDir).length) throw new Error(`The folder ${opt.projectDir} already exists and is not empty.`);

  const readText = (rel) => {
    const buf = src.read(rel);
    const bom = buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
    return { text: buf.toString('utf8', bom ? 3 : 0), bom };
  };

  const projPlan = plan[0];
  const projExt = path.extname(projPlan.dest.replace(/\$[^$]+\$/g, '') || projPlan.source) || path.extname(projPlan.source);
  const projectFileName = projectName + projExt;
  const pr = readText(projPlan.source);
  const projectText = replaceParams(pr.text, params);
  const includes = declaredIncludes(projectText);
  const byNorm = new Map(includes.map((i) => [norm(i), i]));
  const byBase = new Map();
  for (const i of includes) {
    const b = path.win32.basename(i).toLowerCase();
    byBase.set(b, byBase.has(b) ? null : i); // ambiguous basenames are not guessed
  }

  const out = [];
  const write = (rel, data) => {
    const full = path.join(opt.projectDir, rel.replace(/[\\/]/g, path.sep));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, data);
    out.push(full);
  };
  write(projectFileName, (pr.bom ? '﻿' : '') + projectText);

  for (const it of plan.slice(1)) {
    let dest = replaceParams(it.dest, params);
    if (!/[\\/]/.test(dest)) {
      const viaSource = byNorm.get(norm(it.source));
      const viaBase = byBase.get(dest.toLowerCase());
      dest = viaSource || viaBase || dest;
    }
    // the filters file follows the project file's name
    if (/\.filters$/i.test(dest) && /\.(vcxproj|vcxitems|csproj)\.filters$/i.test(dest)) dest = `${projectFileName}.filters`;
    if (it.replace) {
      const r = readText(it.source);
      write(dest, (r.bom ? '﻿' : '') + replaceParams(r.text, params));
    } else {
      write(dest, src.read(it.source));
    }
  }
  return { projectFile: path.join(opt.projectDir, projectFileName), files: out, guid: params.guid1.toUpperCase() };
}

module.exports = { discoverTemplates, defaultTemplateRoots, instantiate, planTemplate, replaceParams, safeIdentifier, openSource };
