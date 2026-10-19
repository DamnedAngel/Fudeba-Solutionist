'use strict';
const crypto = require('crypto');
const path = require('path');
const { parseXml, kids, kid, attr, encodeAttr } = require('./xml');
const { appendChild, removeNode, read, write, projectRoot } = require('./edit');
const { setSlnDependencies } = require('./sln');

const TYPE_GUIDS = {
  '.vcxproj': '8BC9CEB8-8B4A-11D0-8D11-00A0C91BC942', '.csproj': 'FAE04EC0-301F-11D3-BF4B-00C04F79EFBC',
  '.vbproj': 'F184B08F-C81C-45F6-A57F-5ABD9991F28F', '.fsproj': 'F2A71F9B-5D33-465A-A702-920D77279786',
  '.shproj': 'D954291E-2A0B-460D-934E-DC6B0785DB48',
};
const typeGuidFor = (file) => `{${TYPE_GUIDS[path.extname(file).toLowerCase()] || TYPE_GUIDS['.vcxproj']}}`;

/** Visual Studio names the 32-bit C++ platform Win32 in projects and x86 in solutions. */
const SOL_PLATFORM = { win32: 'x86', anycpu: 'Any CPU' };
const toSolPlatform = (p) => SOL_PLATFORM[String(p).toLowerCase()] || p;
const toProjPlatform = (p) => ({ x86: 'Win32', 'any cpu': 'AnyCPU' }[String(p).toLowerCase()] || p);

/** Picks the project configuration a solution configuration should use. */
function mapConfig(solCfg, projectConfigs) {
  const [sc, sp] = solCfg.split('|');
  const want = `${sc}|${toProjPlatform(sp)}`.toLowerCase();
  const exact = projectConfigs.find((c) => c.name.toLowerCase() === want);
  if (exact) return exact.name;
  const sameName = projectConfigs.find((c) => c.config.toLowerCase() === sc.toLowerCase());
  return (sameName || projectConfigs[0] || { name: solCfg }).name;
}

const newLine = (t) => (t.includes('\r\n') ? '\r\n' : '\n');

/** Registers a project in .sln text with its per-configuration mapping. */
function addProjectToSln(text, o) {
  const eol = newLine(text);
  const lines = text.split(/\r?\n/);
  const guid = o.guid.startsWith('{') ? o.guid.toUpperCase() : `{${o.guid.toUpperCase()}}`;
  const solCfgs = [];
  let sect = null;
  for (const l of lines) {
    const m = /^\s*GlobalSection\((\w+)\)/.exec(l);
    if (m) sect = m[1]; else if (/^\s*EndGlobalSection/.test(l)) sect = null;
    else if (sect === 'SolutionConfigurationPlatforms') { const c = /^\s*(.+?)\s*=/.exec(l); if (c) solCfgs.push(c[1]); }
  }
  // 1. the Project block, after the last existing one (or before Global)
  let at = lines.map((l) => l.trim()).lastIndexOf('EndProject') + 1;
  if (at === 0) at = Math.max(0, lines.findIndex((l) => l.trim() === 'Global'));
  lines.splice(at, 0, `Project("${o.typeGuid || typeGuidFor(o.relPath)}") = "${o.name}", "${o.relPath}", "${guid}"`, 'EndProject');

  // 2. configuration mapping
  const cfgLines = [];
  for (const sc of solCfgs) {
    const pc = mapConfig(sc, o.projectConfigs);
    cfgLines.push(`\t\t${guid}.${sc}.ActiveCfg = ${pc}`, `\t\t${guid}.${sc}.Build.0 = ${pc}`);
  }
  const start = lines.findIndex((l) => /GlobalSection\(ProjectConfigurationPlatforms\)/.test(l));
  if (start >= 0) {
    let end = start;
    while (end < lines.length && !/EndGlobalSection/.test(lines[end])) end++;
    lines.splice(end, 0, ...cfgLines);
  } else {
    const after = lines.findIndex((l) => /GlobalSection\(SolutionConfigurationPlatforms\)/.test(l));
    let end = after;
    while (end >= 0 && end < lines.length && !/EndGlobalSection/.test(lines[end])) end++;
    lines.splice(end + 1, 0, '\tGlobalSection(ProjectConfigurationPlatforms) = postSolution', ...cfgLines, '\tEndGlobalSection');
  }
  return lines.join(eol);
}

function createSolutionText(projectConfigs) {
  const cfgs = [];
  for (const c of projectConfigs) { const n = `${c.config}|${toSolPlatform(c.platform)}`; if (!cfgs.includes(n)) cfgs.push(n); }
  const L = [
    '', 'Microsoft Visual Studio Solution File, Format Version 12.00', '# Visual Studio Version 17',
    'VisualStudioVersion = 17.7.34003.232', 'MinimumVisualStudioVersion = 10.0.40219.1',
    'Global', '\tGlobalSection(SolutionConfigurationPlatforms) = preSolution', ...cfgs.map((c) => `\t\t${c} = ${c}`), '\tEndGlobalSection',
    '\tGlobalSection(ProjectConfigurationPlatforms) = postSolution', '\tEndGlobalSection',
    '\tGlobalSection(SolutionProperties) = preSolution', '\t\tHideSolutionNode = FALSE', '\tEndGlobalSection',
    '\tGlobalSection(ExtensibilityGlobals) = postSolution', `\t\tSolutionGuid = {${crypto.randomUUID().toUpperCase()}}`, '\tEndGlobalSection',
    'EndGlobal', '',
  ];
  return '﻿' + L.join('\r\n');
}

/** Removes a project's Project block, config lines, nesting and dependency lines that point at it. */
function removeProjectFromSln(text, id) {
  const eol = newLine(text);
  const guid = id.replace(/[{}]/g, '').toUpperCase();
  const lines = text.split(/\r?\n/);
  const out = [];
  let skipping = false;
  for (const l of lines) {
    const m = /^Project\("\{[^}]+\}"\)\s*=\s*"[^"]*"\s*,\s*"[^"]*"\s*,\s*"\{([^}]+)\}"/.exec(l.trim());
    if (m && m[1].toUpperCase() === guid) { skipping = true; continue; }
    if (skipping) { if (l.trim() === 'EndProject') skipping = false; continue; }
    if (l.toUpperCase().includes(`{${guid}}`)) continue; // config mapping, nesting and ProjectDependencies entries
    out.push(l);
  }
  return out.join(eol);
}

// ---- .slnx ------------------------------------------------------------------------------------

function slnxProjectNode(t, relPath) {
  const root = kid(parseXml(t), 'Solution');
  const norm = (s) => s.replace(/\\/g, '/').toLowerCase();
  return { root, node: kids(root, 'Project').find((p) => norm(attr(p, 'Path') || '') === norm(relPath)) };
}

function setSlnxDependencies(file, projectRel, depRels) {
  let t = read(file);
  const { node } = slnxProjectNode(t, projectRel);
  if (!node) throw new Error(`Project ${projectRel} not found in ${file}`);
  for (const d of kids(node, 'BuildDependency').reverse()) t = removeNode(t, d);
  if (depRels.length) {
    for (const d of depRels) t = appendChild(t, slnxProjectNode(t, projectRel).node, `<BuildDependency Project="${encodeAttr(d)}" />`);
  }
  write(file, t);
}

function addProjectToSlnx(file, relPath) {
  const t = read(file);
  const root = kid(parseXml(t), 'Solution');
  write(file, appendChild(t, root, `<Project Path="${encodeAttr(relPath.replace(/\\/g, '/'))}" />`));
}

/**
 * Removes a project from a .slnx, plus the BuildDependency entries of other projects that pointed at it.
 * Project files on disk are left alone (as Visual Studio's "Remove" does).
 */
function removeProjectFromSlnx(file, projectRel) {
  const norm = (s) => String(s || '').replace(/\\/g, '/').toLowerCase();
  const target = norm(projectRel);
  let t = read(file);
  const find = (node, pred, out = []) => {
    for (const c of node.children) { if (pred(c)) out.push(c); find(c, pred, out); }
    return out;
  };
  // each removal shifts the offsets, so re-parse after every one
  for (;;) {
    const root = kid(parseXml(t), 'Solution');
    const hit = find(root, (n) => (n.name === 'BuildDependency' && norm(attr(n, 'Project')) === target) || (n.name === 'Project' && norm(attr(n, 'Path')) === target))[0];
    if (!hit) break;
    t = removeNode(t, hit);
  }
  write(file, t);
}

module.exports = {
  addProjectToSln, createSolutionText, removeProjectFromSln, removeProjectFromSlnx, setSlnxDependencies, addProjectToSlnx,
  setSlnDependencies, typeGuidFor, toSolPlatform, mapConfig,
};
