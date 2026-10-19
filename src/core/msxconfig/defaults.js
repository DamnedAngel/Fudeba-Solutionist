'use strict';
// Where the text of a configuration file that a project lacks comes from: the project template of its type, as
// installed in Visual Studio (so the file is the user's current version of the template), else the copy of the
// 00.07.00 templates that ships inside the extension.
const fs = require('fs');
const path = require('path');
const { discoverTemplates, openSource } = require('../vstemplate');

/** which installed template belongs to which project type */
const TEMPLATE_NAME = {
  ROM: /ROM Application/i,
  COM: /DOS Application/i,
  BIN: /BIN Application/i,
  MDO: /Overlay/i,
};

/**
 * @param {{type:string, templateRoots?:string[], bundledDir:string}} o  bundledDir holds <type>/Config/*.txt
 * @returns {(file:string)=>string|null} the text of Config\<file> for a new project of that type, or null
 */
function defaultsProvider(o) {
  let source;
  const installed = () => {
    if (source !== undefined) return source;
    source = null;
    try {
      const t = discoverTemplates(o.templateRoots || []).find((x) => TEMPLATE_NAME[o.type] && TEMPLATE_NAME[o.type].test(x.name));
      if (t) source = openSource(t);
    } catch { source = null; }
    return source;
  };
  return (file) => {
    const s = installed();
    try { if (s && s.has(file)) return s.read(file).toString('utf8'); } catch { /* fall back to the bundled copy */ }
    const f = path.join(o.bundledDir, o.type, 'Config', file);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
  };
}

module.exports = { defaultsProvider, TEMPLATE_NAME };
