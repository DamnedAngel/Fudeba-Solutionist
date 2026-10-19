'use strict';
const fs = require('fs');
const path = require('path');

// Which icon a tree node shows. Resolution order, first hit wins:
//   1. an explicit override for the key        (setting fudebaSolutionist.icons)
//   2. a file found by name in a folder         (fudebaSolutionist.iconTheme = "folder", fudebaSolutionist.iconFolder)
//   3. the built-in Visual Studio-style set     (fudebaSolutionist.iconTheme = "vs"; also the fallback of "folder")
//   4. a VS Code codicon                         (fudebaSolutionist.iconTheme = "codicons"; last resort)
// Everything here is pure file-system logic so it can be tested without VS Code.

/** Keys of every icon the extension asks for. */
const KEYS = ['solution', 'solution.msx', 'solutionFolder', 'project.cpp', 'project.makefile', 'project.rom', 'project.com', 'project.bin', 'project.mdo', 'project.dotnet', 'project.shared', 'project.unknown',
  'project.missing', 'folder', 'filter', 'file', 'file.c', 'file.h', 'file.asm', 'file.inc', 'file.zoo', 'file.missing', 'buildActions', 'action.build', 'action.rebuild', 'action.clean', 'dependencies'];

const CODICON = {
  solution: 'layers', 'solution.msx': 'rocket', solutionFolder: 'folder-library', 'project.cpp': 'file-code', 'project.makefile': 'tools', 'project.rom': 'tools', 'project.com': 'tools', 'project.bin': 'tools', 'project.mdo': 'tools', 'project.dotnet': 'symbol-namespace',
  'project.shared': 'references', 'project.unknown': 'question', 'project.missing': 'warning', folder: 'folder', filter: 'folder',
  file: 'file', 'file.c': 'file-code', 'file.h': 'file-code', 'file.asm': 'file-binary', 'file.inc': 'file-code', 'file.zoo': 'symbol-class', 'file.missing': 'warning', buildActions: 'gear', 'action.build': 'play', 'action.rebuild': 'debug-restart', 'action.clean': 'trash',
  dependencies: 'references',
};

/**
 * Names under which an icon is looked for in a user's folder, best first. They follow the naming of Microsoft's
 * Visual Studio Image Library (files such as Solution_16x.svg, CPPProjectNode_16x.svg), but any folder of
 * SVG/PNG files named like this works; individual files can always be assigned through the icons setting.
 */
const ALIASES = {
  solution: ['Solution', 'VSSolution', 'SolutionExplorer'],
  'solution.msx': ['MSXSolution', 'SolutionMSX', 'Solution'],
  solutionFolder: ['SolutionFolder', 'SolutionFolderClosed', 'FolderClosed', 'Folder'],
  'project.cpp': ['CPPProjectNode', 'CppProject', 'VCProject', 'CPPProject', 'ProjectNode', 'Project'],
  'project.makefile': ['MakefileProject', 'CPPMakefileProject', 'CPPProjectNode', 'CppProject', 'ProjectNode', 'Project'],
  'project.dotnet': ['CSProjectNode', 'CSharpProject', 'CSProject', 'CSharpProjectNode', 'ProjectNode', 'Project'],
  'project.shared': ['SharedProject', 'SharedItems', 'ProjectNode', 'Project'],
  'project.unknown': ['Project', 'ProjectNode', 'UnknownProject'],
  'project.missing': ['ProjectWarning', 'StatusWarning', 'Warning', 'UnloadedProject', 'ProjectError'],
  folder: ['FolderClosed', 'Folder', 'FolderOpened'],
  filter: ['FilterFolder', 'Filter', 'VirtualFolder', 'FolderClosed', 'Folder'],
  file: ['Document', 'TextFile', 'File', 'GenericFile', 'Page'],
  'file.c': ['CFile', 'CSourceFile', 'CPPFile', 'Document'],
  'file.h': ['CHeaderFile', 'HeaderFile', 'CPPHeaderFile', 'Document'],
  'file.asm': ['AssemblyFile', 'ASMFile', 'Assembly', 'Document'],
  'file.inc': ['IncludeFile', 'INCFile', 'Document'],
  'file.zoo': ['ZooFile', 'Zoo', 'ClassFile', 'Class', 'Document'],
  'file.missing': ['DocumentWarning', 'StatusWarning', 'Warning', 'Document'],
  buildActions: ['Settings', 'Properties', 'BuildSolution', 'Configuration', 'Gear'],
  'action.build': ['Build', 'BuildSolution', 'BuildSelection', 'Run', 'Start'],
  'action.rebuild': ['RebuildSolution', 'Rebuild', 'RebuildSelection', 'Refresh'],
  'action.clean': ['CleanSolution', 'Clean', 'CleanData', 'Cleanup', 'Delete'],
  dependencies: ['Reference', 'References', 'ProjectReference', 'ReferenceGroup', 'DependencyGraph'],
};

const IMAGE = /\.(svg|png)$/i;

/** "CPPProjectNode_16x.svg" -> "cppprojectnode" */
const norm = (file) => path.basename(file, path.extname(file)).toLowerCase()
  .replace(/[_\-. ]?(16|24|32|48)x?$/, '').replace(/[_\-. ]?(color|colour|dark|light|blue|mono|monochrome|inverse)$/, '').replace(/[^a-z0-9]/g, '');

/**
 * Indexes the images below `dir`: normalised name -> {light, dark} paths. Sub-folders named "light"/"dark" (any
 * depth) supply the theme variants; an image outside such folders is used for both themes.
 */
function indexFolder(dir, limit = 20000) {
  const idx = new Map();
  let count = 0;
  const walk = (d, theme) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (count > limit) return;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        const n = e.name.toLowerCase();
        walk(full, n === 'light' ? 'light' : n === 'dark' ? 'dark' : theme);
      } else if (IMAGE.test(e.name)) {
        count++;
        const key = norm(e.name);
        const slot = idx.get(key) || {};
        // an SVG beats a PNG of the same name; the first file found for a theme wins otherwise
        const better = (cur) => !cur || (/\.png$/i.test(cur) && /\.svg$/i.test(full));
        if (theme !== 'dark' && better(slot.light)) slot.light = full;
        if (theme !== 'light' && better(slot.dark)) slot.dark = full;
        idx.set(key, slot);
      }
    }
  };
  walk(dir, null);
  return idx;
}

function fromIndex(idx, key) {
  for (const name of ALIASES[key] || []) {
    const hit = idx.get(norm(name));
    if (hit && (hit.light || hit.dark)) return { light: hit.light || hit.dark, dark: hit.dark || hit.light };
  }
  return null;
}

const CODICON_ID = /^\$?\(?([a-z][a-z0-9-]*)\)?$/i;

/** Interprets one value of the icons setting: a codicon id, a file path, or {light, dark}. */
function interpret(value, baseDir) {
  if (!value) return null;
  const abs = (p) => (path.isAbsolute(p) ? p : path.resolve(baseDir || '.', p));
  if (typeof value === 'object') {
    const l = value.light && abs(value.light), d = value.dark && abs(value.dark);
    return l || d ? { type: 'file', light: l || d, dark: d || l } : null;
  }
  const s = String(value).trim();
  if (!s) return null;
  if (!/[\\/.]/.test(s) && CODICON_ID.test(s)) return { type: 'codicon', id: CODICON_ID.exec(s)[1] };
  const f = abs(s);
  return { type: 'file', light: f, dark: f };
}

/**
 * @param {{theme:'vs'|'codicons'|'folder', iconFolder?:string, overrides?:object, builtinDir:string, baseDir?:string, index?:Map}} cfg
 * @returns {{type:'codicon', id:string, source:string}|{type:'file', light:string, dark:string, source:string}}
 */
function resolveIcon(key, cfg) {
  const ov = cfg.overrides && cfg.overrides[key];
  const o = interpret(ov, cfg.baseDir);
  if (o && (o.type === 'codicon' || (fs.existsSync(o.light) && fs.existsSync(o.dark)))) return { ...o, source: 'override' };

  if (cfg.theme === 'folder' && cfg.iconFolder) {
    const idx = cfg.index || indexFolder(cfg.iconFolder);
    const hit = fromIndex(idx, key);
    if (hit) return { type: 'file', ...hit, source: 'folder' };
  }
  if (cfg.theme !== 'codicons') {
    const light = path.join(cfg.builtinDir, 'light', `${key}.svg`);
    const dark = path.join(cfg.builtinDir, 'dark', `${key}.svg`);
    if (fs.existsSync(light) && fs.existsSync(dark)) return { type: 'file', light, dark, source: 'builtin' };
  }
  return { type: 'codicon', id: CODICON[key] || 'file', source: 'codicon' };
}

/** Icon key of a source file by its extension, or null when there is no dedicated icon. */
function fileKey(file) {
  const e = path.extname(file).toLowerCase();
  if (e === '.c') return 'file.c';
  if (e === '.h' || e === '.hpp') return 'file.h';
  if (e === '.asm' || e === '.s') return 'file.asm';
  if (e === '.inc') return 'file.inc';
  if (e === '.zml') return 'file.zoo';
  return null;
}

module.exports = { fileKey, KEYS, ALIASES, CODICON, indexFolder, fromIndex, interpret, resolveIcon, norm };
