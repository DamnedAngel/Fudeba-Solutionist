'use strict';
// MSX specifics of the user's templates: the kind of application a project builds, taken from the
// `PROJECT_TYPE` line of its Config\ApplicationSettings.txt (DOS, MDO, ROM, BIN in the real projects).
const fs = require('fs');
const path = require('path');
const { resolveIn } = require('./fsx');

/** What the project's output is called to the user: DOS applications are .COM files. */
const LABELS = { DOS: 'COM', COM: 'COM', MDO: 'MDO', ROM: 'ROM', BIN: 'BIN' };

/** @param {string} text  contents of ApplicationSettings.txt @returns {string|null} the raw PROJECT_TYPE value */
function parseProjectType(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*PROJECT_TYPE\s+([A-Za-z0-9_]+)/.exec(line); // a ';' comment never starts with the keyword
    if (m) return m[1].toUpperCase();
  }
  return null;
}

/**
 * The MSX project type of a loaded project (see loadProject), or null when it has no ApplicationSettings.txt.
 * @returns {{type:string, label:string}|null}  label is ROM, COM, BIN or MDO
 */
function msxProjectType(pd) {
  if (!pd || !pd.exists) return null;
  const listed = (pd.items || []).find((i) => /(^|[\\/])applicationsettings\.txt$/i.test(i.include));
  const file = listed ? listed.path : resolveIn(pd.dir, 'Config\\ApplicationSettings.txt');
  try {
    const type = parseProjectType(fs.readFileSync(file, 'utf8'));
    return type && LABELS[type] ? { type, label: LABELS[type] } : null;
  } catch { return null; }
}

module.exports = { parseProjectType, msxProjectType, LABELS };
