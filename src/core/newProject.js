'use strict';
const fs = require('fs');
const path = require('path');
const { instantiate } = require('./vstemplate');
const { loadProject } = require('./project');
const { addProjectToSln, addProjectToSlnx, createSolutionText } = require('./slnEdit');

const BAD = /[<>:"/\\|?*\x00-\x1f]/;
/** Validation message for a project/solution name, or null when fine. */
function validateName(name) {
  if (!name || !name.trim()) return 'A name is required.';
  if (BAD.test(name)) return 'The name contains characters that are not valid in a file name.';
  if (/[. ]$/.test(name)) return 'The name cannot end with a dot or a space.';
  return null;
}

/**
 * Creates a project from a template and registers it in a solution.
 *
 * - existing solution: the project is written to <location>/<name> (CreateNewFolder) and added to the .sln/.slnx;
 * - no solution: a new solution is created. Like VS, <location>/<solutionName>/ holds the solution and the
 *   project goes in its own folder below it, unless `sameDirectory` puts both in <location>/<solutionName>.
 *
 * @param {import('./vstemplate').Template} template
 * @param {{projectName:string, location:string, solutionFile?:string|null, solutionName?:string, sameDirectory?:boolean}} o
 * @returns {{solutionFile:string, projectFile:string, createdSolution:boolean, files:string[]}}
 */
function createFromTemplate(template, o) {
  const bad = validateName(o.projectName);
  if (bad) throw new Error(bad);
  let solutionFile = o.solutionFile || null;
  let solutionDir, projectDir, created = false;

  if (solutionFile) {
    solutionDir = path.dirname(solutionFile);
    projectDir = template.createNewFolder ? path.join(o.location || solutionDir, o.projectName) : (o.location || solutionDir);
  } else {
    const solName = o.solutionName || o.projectName;
    const badSol = validateName(solName);
    if (badSol) throw new Error(badSol);
    solutionDir = path.join(o.location, solName);
    projectDir = o.sameDirectory || !template.createNewFolder ? solutionDir : path.join(solutionDir, o.projectName);
    if (fs.existsSync(path.join(solutionDir, `${solName}.sln`))) throw new Error(`${solName}.sln already exists in ${solutionDir}.`);
    solutionFile = path.join(solutionDir, `${solName}.sln`);
    created = true;
  }

  const res = instantiate(template, {
    projectName: o.projectName, projectDir, solutionName: path.basename(solutionFile, path.extname(solutionFile)), solutionDir,
  });
  const pd = loadProject(res.projectFile);
  const rel = path.relative(solutionDir, res.projectFile).replace(/\//g, '\\');

  if (created) {
    fs.mkdirSync(solutionDir, { recursive: true });
    fs.writeFileSync(solutionFile, createSolutionText(pd.configs.length ? pd.configs : [{ config: 'Debug', platform: 'Win32', name: 'Debug|Win32' }]), 'utf8');
  }
  if (/\.slnx$/i.test(solutionFile)) addProjectToSlnx(solutionFile, rel);
  else {
    const text = fs.readFileSync(solutionFile, 'utf8');
    fs.writeFileSync(solutionFile, addProjectToSln(text, { name: o.projectName, relPath: rel, guid: res.guid, projectConfigs: pd.configs }), 'utf8');
  }
  return { solutionFile, projectFile: res.projectFile, createdSolution: created, files: res.files };
}

module.exports = { createFromTemplate, validateName };
