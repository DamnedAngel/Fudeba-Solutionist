'use strict';
// Creates an empty solution: <location>/<name>/<name>.sln (or .slnx), the way Visual Studio's "Blank Solution" does.
// The files open in Visual Studio and build with its MSBuild (checked against VS 2022 17.14, see test/newsolution.test.js).
const fs = require('fs');
const path = require('path');
const { createSolutionText } = require('./slnEdit');
const { validateName } = require('./newProject');

/** The configurations of a new solution: Debug and Release; the platform is the one of the MSX (Win32) project templates. */
const DEFAULT_CONFIGS = [{ config: 'Debug', platform: 'Win32' }, { config: 'Release', platform: 'Win32' }];

const slnxText = () => [
  '<Solution>',
  '  <Configurations>',
  '    <BuildType Name="Debug" />',
  '    <BuildType Name="Release" />',
  '    <Platform Name="x86" />',
  '  </Configurations>',
  '</Solution>',
  '',
].join('\r\n');

/**
 * A blank .sln the way Visual Studio writes it: no project block and no (empty) ProjectConfigurationPlatforms section,
 * which appears when the first project is added.
 */
function slnText() {
  return createSolutionText(DEFAULT_CONFIGS).replace(/\t?GlobalSection\(ProjectConfigurationPlatforms\) = postSolution\r?\n\t?EndGlobalSection\r?\n/, '');
}

/**
 * @param {{location:string, name:string, format?:'sln'|'slnx'}} o
 * @returns {{file:string, dir:string}}
 */
function createBlankSolution(o) {
  const bad = validateName(o.name);
  if (bad) throw new Error(bad);
  const format = o.format === 'slnx' ? 'slnx' : 'sln';
  const dir = path.join(o.location, o.name);
  const file = path.join(dir, `${o.name}.${format}`);
  if (fs.existsSync(file)) throw new Error(`${path.basename(file)} already exists in ${dir}.`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, format === 'slnx' ? slnxText() : slnText(), 'utf8');
  return { file, dir };
}

module.exports = { createBlankSolution, DEFAULT_CONFIGS };
