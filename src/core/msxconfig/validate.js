'use strict';
// Context checks of the configuration dialog: values that make no sense alone (a number out of range, a bad name),
// values that contradict each other (STACK_HIMEM with RETURN_TO_BASIC), values that contradict another file
// (ZOO support without a ZOO folder) and references to things that are not on disk.
//
// Errors are things the build cannot work with (the dialog refuses to save them); warnings are suspicious but allowed.

/**
 * Backslashes in a build event command are path separators written the Windows way. make.py splits the command like a
 * POSIX shell, where a backslash is an escape character and disappears, so they become "/". A backslash that is
 * plainly an escape (before a quote, a space or another backslash) is left alone.
 */
const fixSlashes = (cmd) => String(cmd).replace(/\\(?=[A-Za-z0-9_.[\]~-]|$)/g, '/');

/** @typedef {{file:string, key?:string, severity:'error'|'warning', message:string, item?:number}} Issue */

const HEX = /^0x[0-9a-f]{1,4}$/i;
const DEC = /^\d{1,5}$/;
const addr = (s) => { const t = String(s).trim(); return HEX.test(t) ? parseInt(t, 16) : DEC.test(t) ? parseInt(t, 10) : NaN; };
const isOn = (v) => String(v).toUpperCase() === '_ON';
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

const find = (model, key) => { for (const g of model.groups || []) for (const f of g.fields) if (f.key === key) return f; return undefined; };
const list = (model, key) => ((model.lists || []).find((l) => l.key === key) || { items: [] }).items;
/** the value of a field when it is set, else undefined */
const val = (model, key) => { const f = model && find(model, key); return f && f.set ? String(f.value).trim() : undefined; };

/** expands [NAME] macros the way make.py does, from the target configuration's own variables */
function expander(vars) {
  const expand = (s, depth = 0) => String(s).replace(/\[([A-Za-z_]+)\]/g, (all, n) => (n in vars && depth < 6 ? expand(vars[n], depth + 1) : all));
  return expand;
}

function targetVars(targetModel, profile) {
  const v = { PROFILE: profile || 'Debug', MSX_DEV_PATH: '..\\..\\..', MSX_CFG_PATH: 'Config', MSX_LIB_PATH: '[MSX_DEV_PATH]\\libs' };
  for (const g of (targetModel && targetModel.groups) || []) for (const f of g.fields) if (f.set && String(f.value).trim() !== '') v[f.key] = String(f.value).trim();
  return v;
}

/**
 * @param {{type:string, pages:object[]}} state the edited models of every page, as in the dialog
 * @param {{exists:(rel:string)=>boolean, hooksOf:(rel:string)=>string[]|null, hasFile:(rel:string)=>boolean}} ctx
 *   `rel` paths are relative to the project folder; hooksOf reads the MDO_HOOK names of another project's MDOSettings
 * @returns {Issue[]}
 */
function validate(state, ctx) {
  const issues = [];
  const add = (file, severity, key, message, item) => issues.push({ file, severity, key, message, item });
  const by = (f) => state.pages.find((p) => p.file.toLowerCase() === f.toLowerCase());
  const type = state.type;
  const app = by('ApplicationSettings.txt');
  const mdo = by('MDOSettings.txt');
  const targets = state.pages.filter((p) => p.kind === 'target');
  const mainTarget = targets.find((p) => /debug/i.test(p.profile || '')) || targets[0];
  const expand = expander(targetVars(mainTarget, mainTarget && mainTarget.profile));
  // an entry with a macro nobody defined cannot be checked: assume it is fine
  const exists = (s) => { const r = expand(s); return /\[[A-Za-z_]+\]/.test(r) ? true : ctx.exists(r); };

  // ---- ApplicationSettings.txt
  if (app) {
    const F = 'ApplicationSettings.txt';
    const numeric = (key, what) => {
      const v = val(app, key);
      if (v === undefined || v === '') return undefined;
      const n = addr(v);
      if (Number.isNaN(n)) add(F, 'error', key, `${what} must be a number: decimal (4096) or hexadecimal (0x1000), up to 0xFFFF (the Z80 address space is 64 kB).`);
      else if (n > 0xFFFF) add(F, 'error', key, `${what} is above 0xFFFF: the Z80 address space is 64 kB.`);
      return n;
    };
    const filestart = numeric('FILESTART', 'The start address');
    const codeLoc = numeric('CODE_LOC', 'The code segment address');
    const dataLoc = numeric('DATA_LOC', 'The data segment address');
    numeric('BASIC_PROGRAM', 'The BASIC program address');
    numeric('HEAP_SIZE', 'The heap size');
    const cmd = val(app, 'MAX_CMDLINE_PARAMETERS');
    if (cmd !== undefined) {
      if (!/^\d+$/.test(cmd)) add(F, 'error', 'MAX_CMDLINE_PARAMETERS', 'Must be a whole number from 0 to 63.');
      else if (+cmd > 63) add(F, 'error', 'MAX_CMDLINE_PARAMETERS', 'The maximum is 63: the MSX-DOS command tail is 127 bytes long, so more parameters cannot occur (the build stops with an error).');
    }
    if (type === 'ROM') {
      if (isOn(val(app, 'STACK_HIMEM')) && isOn(val(app, 'RETURN_TO_BASIC'))) add(F, 'error', 'STACK_HIMEM', 'STACK_HIMEM needs RETURN_TO_BASIC to be _OFF: with the stack at HIMEM there is no BASIC to return to.');
      const size = val(app, 'ROM_SIZE');
      if (filestart !== undefined && !Number.isNaN(filestart)) {
        if (size === '32k' && filestart !== 0x4000) add(F, 'warning', 'FILESTART', 'A 32 kB ROM is normally mapped at 0x4000 (pages 1 and 2); at another address part of it would not be visible.');
        if (size === '16k' && filestart !== 0x4000 && filestart !== 0x8000) add(F, 'warning', 'FILESTART', 'A 16 kB ROM is normally mapped at 0x4000 or 0x8000.');
        if (filestart === 0x8000 && (isOn(val(app, 'CALL_EXPANSION')) || isOn(val(app, 'DEVICE_EXPANSION')))) add(F, 'warning', 'FILESTART', 'A ROM that expands BASIC (CALL or DEVICE) is normally mapped at 0x4000: BASIC looks for those headers in page 1.');
      }
      if (dataLoc !== undefined && !Number.isNaN(dataLoc) && dataLoc !== 0 && dataLoc < 0x8000) add(F, 'warning', 'DATA_LOC', 'A ROM keeps its variables in RAM; the data segment should be at 0x8000 or above (0xC000, page 3, is the template\'s choice).');
      if (isOn(val(app, 'LATE_EXECUTION')) && isOn(val(app, 'RETURN_TO_BASIC'))) add(F, 'warning', 'LATE_EXECUTION', 'To use disk access from the ROM (diskaccess.s) the template asks for RETURN_TO_BASIC _OFF, and a floppy interface.');
      const calls = list(app, 'CALL_STATEMENT').filter((i) => String(i.value).trim());
      const devs = list(app, 'DEVICE').filter((i) => String(i.value).trim());
      if (isOn(val(app, 'CALL_EXPANSION')) && !calls.length) add(F, 'warning', 'CALL_EXPANSION', 'CALL expansion is on but no CALL statement is listed.');
      if (!isOn(val(app, 'CALL_EXPANSION')) && calls.length) add(F, 'warning', 'CALL_EXPANSION', 'CALL statements are listed but CALL expansion is off, so they are ignored.');
      if (isOn(val(app, 'DEVICE_EXPANSION')) && !devs.length) add(F, 'warning', 'DEVICE_EXPANSION', 'Device expansion is on but no device is listed.');
      if (!isOn(val(app, 'DEVICE_EXPANSION')) && devs.length) add(F, 'warning', 'DEVICE_EXPANSION', 'Devices are listed but device expansion is off, so they are ignored.');
      const names = [...calls, ...devs].map((i) => String(i.value).trim().toUpperCase());
      if (new Set(names).size !== names.length) add(F, 'warning', 'CALL_STATEMENT', 'The same name is used twice among the CALL statements and devices.');
    }
    if (type === 'BIN') {
      if (filestart !== undefined && !Number.isNaN(filestart) && filestart < 0x8000) add(F, 'warning', 'FILESTART', 'A BIN program is loaded into RAM, which starts at 0x8000 on most MSX computers; below that the load would fail or overwrite ROM space.');
      const usr = list(app, 'SYMBOL');
      if (usr.length > 10) add(F, 'error', 'SYMBOL', 'BASIC has only ten USR functions (USR0 to USR9); the table can hold at most 10 entries.');
      usr.forEach((u, i) => {
        const v = String(u.value).trim();
        if (!v) add(F, 'error', 'SYMBOL', `Entry ${i} of the USR table is empty.`, i);
        else if (u.kind === 'SYMBOL' && !IDENT.test(v)) add(F, 'error', 'SYMBOL', `Entry ${i}: "${v}" is not a valid symbol name.`, i);
      });
      if (usr.length && !isOn(val(app, 'PUBLISH_FILESTART'))) add(F, 'warning', 'PUBLISH_FILESTART', 'The BASIC example finds the USR table through the published start address; with PUBLISH_FILESTART off the table is harder to reach.');
    }
    if (type === 'MDO' && val(app, 'MDO_SUPPORT') !== undefined && !isOn(val(app, 'MDO_SUPPORT'))) add(F, 'error', 'MDO_SUPPORT', 'An overlay project always has MDO_SUPPORT _ON.');
    if (type === 'COM' && mdo && val(app, 'MDO_SUPPORT') !== undefined && !isOn(val(app, 'MDO_SUPPORT'))) add(F, 'warning', 'MDO_SUPPORT', 'MDO support is off but the project has an MDOSettings.txt: overlays will not be usable.');
    if (type !== 'MDO' && val(app, 'ZOO_REGENERATE_TREE') === '_AUTO') add(F, 'warning', 'ZOO_REGENERATE_TREE', '_AUTO is meant for overlays; elsewhere it behaves like _ON.');
    const sdcc = val(app, 'SDCCCALL');
    if (sdcc !== undefined && sdcc !== '0' && sdcc !== '1') add(F, 'error', 'SDCCCALL', 'Must be 0 (stack) or 1 (registers).');
    if (isOn(val(app, 'ZOO_SUPPORT'))) {
      for (const t of targets) {
        if (!val(t, 'ZOO_PATH')) add(t.file, 'warning', 'ZOO_PATH', 'ZOO support is on in ApplicationSettings.txt but no ZOO folder is set: the build stops with "ZOO_SUPPORT is _ON, but ZOO_PATH is not configured".');
      }
    }
    if (type !== 'ROM' && codeLoc !== undefined && dataLoc !== undefined && !Number.isNaN(codeLoc) && !Number.isNaN(dataLoc) && dataLoc !== 0 && dataLoc <= codeLoc) add(F, 'warning', 'DATA_LOC', 'The data segment is at or below the code segment; they would overlap.');
  }

  // ---- MDOSettings.txt
  if (mdo) {
    const F = 'MDOSettings.txt';
    const name = val(mdo, 'MDO_NAME');
    if (!name) add(F, 'error', 'MDO_NAME', 'The module needs a name.');
    else if (!IDENT.test(name)) add(F, 'error', 'MDO_NAME', 'The module name must be a C-style identifier: letters, digits and underscores, not starting with a digit.');
    const pathCheck = (key, label) => {
      const p = val(mdo, key);
      if (!p) return;
      if (!ctx.exists(p)) add(F, 'warning', key, `${label} "${p}" was not found (relative to the project folder).`);
      else if (!ctx.hasFile(`${p}\\Config\\MDOSettings.txt`)) add(F, 'warning', key, `"${p}" has no Config\\MDOSettings.txt: it is not an MDO-capable project.`);
    };
    const appPath = val(mdo, 'MDO_APPLICATION_PROJECT_PATH');
    if (!appPath) add(F, 'warning', 'MDO_APPLICATION_PROJECT_PATH', 'The application project is not configured.');
    else if (type === 'COM' && appPath !== '.') add(F, 'warning', 'MDO_APPLICATION_PROJECT_PATH', 'In the application itself this is always ".".');
    else if (type === 'MDO') pathCheck('MDO_APPLICATION_PROJECT_PATH', 'The application project');
    if (type === 'MDO') {
      pathCheck('MDO_PARENT_PROJECT_PATH', 'The parent project');
      pathCheck('MDO_PREVIOUS_PROJECT_PATH', 'The previous project');
      const parent = val(mdo, 'MDO_PARENT_PROJECT_PATH');
      if (!parent) add(F, 'error', 'MDO_PARENT_PROJECT_PATH', 'An overlay needs a parent project.');
      const start = val(mdo, 'FILESTART');
      if (start === 'PREVIOUS_AFTERHEAP' && !val(mdo, 'MDO_PREVIOUS_PROJECT_PATH')) add(F, 'error', 'FILESTART', 'PREVIOUS_AFTERHEAP needs a previous project (the build stops otherwise).');
      else if (start === 'PARENT_AFTERHEAP' && !parent) add(F, 'error', 'FILESTART', 'PARENT_AFTERHEAP needs a parent project.');
      else if (start && start !== 'PARENT_AFTERHEAP' && start !== 'PREVIOUS_AFTERHEAP') {
        if (Number.isNaN(addr(start))) add(F, 'error', 'FILESTART', 'The load address is PARENT_AFTERHEAP, PREVIOUS_AFTERHEAP or a number (0x8100), up to 0xFFFF.');
      } else if (!start) add(F, 'warning', 'FILESTART', 'No load address: the overlay would be loaded at the default 0x0100, where the application is.');
      list(mdo, 'MDO_EXTRA_INTERFACE').forEach((x, i) => {
        const p = String(x.value).trim();
        if (p && !ctx.exists(p)) add(F, 'warning', 'MDO_EXTRA_INTERFACE', `"${p}" was not found (relative to the project folder).`, i);
      });
      // hook implementations must match hooks the parent declares
      const parentHooks = parent ? ctx.hooksOf(parent) : null;
      list(mdo, 'MDO_HOOK_IMPLEMENTATION').forEach((h, i) => {
        const hook = String(h.hook).trim();
        const sym = String(h.symbol).trim();
        if (!hook || !sym) { add(F, 'error', 'MDO_HOOK_IMPLEMENTATION', `Implementation ${i + 1} needs a hook name and a symbol.`, i); return; }
        if (!IDENT.test(hook)) add(F, 'error', 'MDO_HOOK_IMPLEMENTATION', `"${hook}" is not a valid hook name.`, i);
        if (!sym.startsWith('_')) add(F, 'warning', 'MDO_HOOK_IMPLEMENTATION', `The assembler symbol of a C function starts with an underscore: _${sym}.`, i);
        if (parentHooks && !parentHooks.includes(hook)) add(F, 'warning', 'MDO_HOOK_IMPLEMENTATION', `The parent does not declare a hook named "${hook}" (it declares: ${parentHooks.join(', ') || 'none'}).`, i);
      });
      if (parentHooks) {
        const impl = list(mdo, 'MDO_HOOK_IMPLEMENTATION').map((h) => String(h.hook).trim());
        for (const ph of parentHooks) if (!impl.includes(ph)) add(F, 'warning', 'MDO_HOOK_IMPLEMENTATION', `The parent declares the hook "${ph}" but this overlay does not implement it.`);
      }
    }
    const hooks = list(mdo, 'MDO_HOOK');
    hooks.forEach((h, i) => {
      const hname = String(h.name).trim();
      if (!hname) add(F, 'error', 'MDO_HOOK', `Hook ${i + 1} needs a name.`, i);
      else if (!IDENT.test(hname)) add(F, 'error', 'MDO_HOOK', `"${hname}" is not a valid hook name.`, i);
      if (!String(h.ret).trim()) add(F, 'error', 'MDO_HOOK', `Hook ${i + 1} needs a C return type (void if nothing is returned).`, i);
      if (!/^\s*\(.*\)\s*$/.test(String(h.sig))) add(F, 'error', 'MDO_HOOK', `Hook ${i + 1}: the parameter list must be in parentheses, e.g. (void) or (int).`, i);
    });
    if (new Set(hooks.map((h) => String(h.name).trim())).size !== hooks.length) add(F, 'error', 'MDO_HOOK', 'Two hooks have the same name.');
    const kids = list(mdo, 'MDO_CHILD');
    kids.forEach((c, i) => {
      if (c.raw !== undefined && !c.name) { add(F, 'warning', 'MDO_CHILD', `Child ${i + 1} is not in the "NAME ^/FILE    / EXT" form; it is kept as written.`, i); return; }
      if (!IDENT.test(String(c.name).trim())) add(F, 'error', 'MDO_CHILD', `Child ${i + 1}: "${c.name}" is not a valid module name.`, i);
      if (!String(c.file).trim()) add(F, 'error', 'MDO_CHILD', `Child ${i + 1} needs a file name.`, i);
      else if (String(c.file).length > 8) add(F, 'error', 'MDO_CHILD', `Child ${i + 1}: the file name "${c.file}" is longer than 8 characters (MSX-DOS 8.3 names).`, i);
      if (String(c.ext).length > 3) add(F, 'error', 'MDO_CHILD', `Child ${i + 1}: the extension "${c.ext}" is longer than 3 characters.`, i);
    });
    if (new Set(kids.map((c) => String(c.name).trim())).size !== kids.length) add(F, 'error', 'MDO_CHILD', 'Two children have the same module name.');
  }

  // ---- TargetConfig_<profile>.txt
  for (const t of targets) {
    const F = t.file;
    const bd = val(t, 'BUILD_DEBUG');
    if (bd !== undefined && bd !== '' && (!/^\d+$/.test(bd) || +bd > 255)) add(F, 'error', 'BUILD_DEBUG', 'Must be a whole number from 0 to 255.');
    const dbg = val(t, 'DEBUG');
    if (dbg && !/^(_ON|_OFF|\d+)$/i.test(dbg)) add(F, 'warning', 'DEBUG', 'DEBUG is normally _OFF, _ON or a debug level (a number from 1); other text becomes the value of the macro.');
    const name = val(t, 'MSX_FILE_NAME');
    const ext = val(t, 'MSX_FILE_EXTENSION');
    if (!name) add(F, 'error', 'MSX_FILE_NAME', 'The output file needs a name.');
    else {
      if (/[\\/:*?"<>|\s]/.test(name)) add(F, 'error', 'MSX_FILE_NAME', 'The file name has characters that are not allowed in a file name (spaces, \\ / : * ? " < > |).');
      if ((type === 'COM' || type === 'MDO') && name.length > 8) add(F, 'error', 'MSX_FILE_NAME', `MSX-DOS file names have at most 8 characters; "${name}" has ${name.length}.`);
    }
    if (!ext) add(F, 'error', 'MSX_FILE_EXTENSION', 'The output file needs an extension.');
    else {
      if ((type === 'COM' || type === 'MDO') && ext.length > 3) add(F, 'error', 'MSX_FILE_EXTENSION', 'MSX-DOS extensions have at most 3 characters.');
      if (ext.toUpperCase() !== type) add(F, 'warning', 'MSX_FILE_EXTENSION', `The template extension of a ${type} project is ${type}.`);
    }
    for (const k of ['MSX_BIN_PATH', 'MSX_OBJ_PATH']) if (!val(t, k)) add(F, 'error', k, 'This folder is required.');
    const tv = expander(targetVars(t, t.profile));
    const zoo = val(t, 'ZOO_PATH');
    if (zoo && !ctx.exists(tv(zoo))) add(F, 'warning', 'ZOO_PATH', `The folder "${zoo}" was not found (relative to the project folder).`);
    const lib = val(t, 'MSX_LIB_PATH');
    if (lib && !/\[/.test(tv(lib)) && !ctx.exists(tv(lib))) add(F, 'warning', 'MSX_LIB_PATH', `The libraries folder "${lib}" was not found (relative to the project folder).`);
    if (type === 'MDO') {
      const bin = val(t, 'MSX_BIN_PATH');
      if (bin && !/\.\./.test(bin)) add(F, 'warning', 'MSX_BIN_PATH', 'An overlay is normally written into the output folder of its application (a path going up to the application project), so the program finds it at run time.');
    }
    for (const g of t.groups) if (g.other) for (const o of g.other.items) if (!String(o.key).trim() || /\s/.test(String(o.key).trim())) add(F, 'error', undefined, 'A macro name cannot be empty or contain spaces.');
  }

  // ---- BuildEvents.txt: a command is split like a shell does, so unbalanced quotes break the build
  const ev = by('BuildEvents.txt');
  if (ev) {
    for (const g of ev.groups) for (const f of g.fields) {
      const v = String(f.value);
      if (!v.trim()) continue;
      if ((v.match(/"/g) || []).length % 2) add('BuildEvents.txt', 'error', f.key, 'The quotes are not balanced: the command is split like a shell command line would be, and the build stops.');
      else if (fixSlashes(v) !== v) {
        add('BuildEvents.txt', 'warning', f.key, 'Paths in build event commands use "/" as the separator; a backslash is taken as an escape character and disappears. It is converted to "/" when you save, or right now with Fix.');
        issues[issues.length - 1].fix = 'slashes';
      }
    }
  }

  // ---- ApplicationSettings.txt: custom definitions
  if (app && app.other) for (const o of app.other.items) if (!String(o.key).trim() || /\s/.test(String(o.key).trim())) add('ApplicationSettings.txt', 'error', undefined, 'A definition name cannot be empty or contain spaces.');

  // ---- the lists
  const zooOn = app ? isOn(val(app, 'ZOO_SUPPORT')) : false;
  for (const p of state.pages.filter((x) => x.items)) {
    const F = p.file;
    const seen = new Set();
    p.items.forEach((it, i) => {
      const t = String(it.text).trim();
      if (!t || !it.enabled) return;
      if (seen.has(t.toLowerCase())) add(F, 'warning', undefined, `"${t}" is listed twice.`, i);
      seen.add(t.toLowerCase());
      if (p.kind === 'symbols') {
        const parts = t.split(/\s+/);
        if (parts.length === 2) add(F, 'warning', undefined, `"${t}": a rename needs both a search expression and a replacement string.`, i);
        if (parts.length > 3) add(F, 'warning', undefined, `"${t}": at most three parts (pattern, search expression, replacement).`, i);
        for (const re of parts.slice(0, 2)) {
          try { new RegExp(re.replace(/\(\?P</g, '(?<')); } catch { add(F, 'error', undefined, `"${re}" is not a valid regular expression.`, i); }
        }
        return;
      }
      const ext = (/\.([A-Za-z0-9]+)$/.exec(t) || [])[1];
      if (p.extensions) {
        if (!ext) add(F, 'warning', undefined, `"${t}" has no file extension.`, i);
        else if (!p.extensions.includes(ext.toLowerCase())) add(F, 'warning', undefined, `"${t}": a ${p.entry} file is normally ${p.extensions.map((e) => `.${e}`).join(', ')}.`, i);
      }
      if (!exists(t)) add(F, 'warning', undefined, `"${t}" was not found (relative to the project folder).`, i);
      if (ext && ext.toLowerCase() === 'zml' && app && !zooOn) add(F, 'error', undefined, `"${t}" is a ZOO class file but ZOO_SUPPORT is _OFF in ApplicationSettings.txt: the build stops with ".zml sources found, but ZOO_SUPPORT is _OFF".`, i);
    });
    if (p.lockFirst) {
      const first = p.items.find((i) => String(i.text).trim());
      if (!first || !first.enabled) add(F, 'error', undefined, 'The first entry is the startup code (crt0); it must stay first and switched on.', 0);
      // "choose ONE and ONLY ONE": the .c and .s of the same program both switched on
      const byBase = new Map();
      p.items.forEach((it, i) => {
        if (!it.enabled) return;
        const m = /^(.*)\.(c|s)$/i.exec(String(it.text).trim());
        if (!m) return;
        const key = m[1].toLowerCase();
        if (byBase.has(key)) add(F, 'warning', undefined, `Both "${byBase.get(key)}" and "${it.text}" are switched on: they define the same routines (the template says to choose one).`, i);
        else byBase.set(key, it.text);
      });
    }
  }
  return issues;
}

module.exports = { fixSlashes, validate, addr, targetVars, expander };
