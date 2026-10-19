'use strict';
const fs = require('fs');
const path = require('path');
const { native, resolveInsensitive } = require('./fsx');

// Turns tool output lines into diagnostics (file, line, severity, message). Written from real MSX build logs and
// the ZOO sources:
//   SDCC     msxromapp.c:70: error 20: Undefined identifier 'true'
//            ..\..\..\libs\util\printf.c:144: warning 196: pointer target lost const qualifier
//   SDAS     ?ASxxxx-Error-<cannot open> : "..\..\..\libs\msx\msxinterrupt.s"
//   SDLD     ?ASlink-Warning-Undefined Global '_mnemo_init' referenced by module 'msxdosapp'
//   ZOO      ERROR: dir\Class.zml:12: message      ERROR: dir\Class.zml: message      ERROR: message
//            [12:30:01] WARNING: flag property x in class Y has no named flags
//   make.py  Processing C file msxromapp.c...      (context for tool messages that carry no file name)
// plus the generic gcc and MSBuild shapes, so C# and other projects report too.
//
// Paths are relative to the folder the tool ran in (the project folder), which is why this is done per project
// here and not with a VS Code problem matcher (that can only resolve against one fixed folder).

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/**
 * @typedef {object} Diagnostic
 * @property {'error'|'warning'|'info'} severity
 * @property {string} file       absolute path
 * @property {number} line       1-based
 * @property {number} column     1-based (1 when the tool gives none)
 * @property {string} message
 * @property {string} [code]
 * @property {string} source     SDCC, SDAS, SDLD, ZOO, GCC, MSBuild
 * @property {boolean} located   false when the file was inferred (project file or last processed source)
 * @property {[number, number]|null} span  [start, length] of the "file:line" text in the raw line
 */

const SEV = (s) => (/warn/i.test(s) ? 'warning' : /note|info/i.test(s) ? 'info' : 'error');

// Windows NTSTATUS values a crashed tool leaves as its exit code (shown signed by make.py: -1073741784).
const NTSTATUS = {
  0xC0000005: 'STATUS_ACCESS_VIOLATION', 0xC00000FD: 'STATUS_STACK_OVERFLOW', 0xC0000028: 'STATUS_BAD_STACK',
  0xC0000409: 'STATUS_STACK_BUFFER_OVERRUN', 0xC0000374: 'STATUS_HEAP_CORRUPTION', 0xC000001D: 'STATUS_ILLEGAL_INSTRUCTION',
  0xC0000094: 'STATUS_INTEGER_DIVIDE_BY_ZERO', 0xC0000135: 'STATUS_DLL_NOT_FOUND', 0xC0000142: 'STATUS_DLL_INIT_FAILED',
  0xC000013A: 'STATUS_CONTROL_C_EXIT', 0xC0000017: 'STATUS_NO_MEMORY',
};
const SIGNALS = { 134: 'SIGABRT', 136: 'SIGFPE', 139: 'SIGSEGV', 137: 'SIGKILL (out of memory?)', 132: 'SIGILL' };

/**
 * Decodes an exit code that means "the program crashed". Returns null for ordinary failure codes.
 * @returns {{value:number, hex:string, name:string}|null}
 */
function crashCode(exit) {
  const u = exit < 0 ? exit + 0x100000000 : exit;
  if (u >= 0xC0000000 && u <= 0xC0FFFFFF) return { value: u, hex: '0x' + u.toString(16).toUpperCase(), name: NTSTATUS[u] || '' };
  if (SIGNALS[u]) return { value: u, hex: String(u), name: SIGNALS[u] };
  return null;
}

class DiagnosticParser {
  /**
   * @param {{projectDir:string, projectFile:string, extraDirs?:string[]}} ctx
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.current = null; // last source file make.py announced
    this.lastCommand = null; // last tool command line make.py echoed ("## sdasz80 ...")
  }

  resolve(p) {
    const clean = native(p.trim().replace(/^"|"$/g, ''));
    if (path.isAbsolute(clean)) return resolveInsensitive(clean);
    for (const d of [this.ctx.projectDir, ...(this.ctx.extraDirs || [])]) {
      const f = resolveInsensitive(path.resolve(d, clean));
      if (fs.existsSync(f)) return f;
    }
    return path.resolve(this.ctx.projectDir, clean);
  }

  /** @returns {Diagnostic|null} */
  parse(raw) {
    const stripped = raw.replace(ANSI, '');
    const lead = /^\s*/.exec(stripped)[0].length;
    const line = stripped.slice(lead).replace(/\s+$/, '');
    if (!line) return null;
    let m;

    // context announced by make.py
    if ((m = /^Processing (?:ASM|C) file (.+?)\.{3}/.exec(line))) { this.current = m[1]; return null; }
    if ((m = /^#{2,3} ((?:sdas|sdld|sdcc|sdar|sdcpp)\S*)\s+(.*)$/.exec(line))) { this.lastCommand = { tool: m[1], line: `${m[1]} ${m[2]}` }; return null; }

    const mk = (o) => ({ column: 1, located: true, span: null, ...o });
    const spanOf = (len) => [lead, len];

    // make.py reports a tool that died: "### Error -1073741784 executing". Small codes are ordinary failures whose
    // messages were printed above; huge ones (Windows NTSTATUS, or 128+signal) are crashes with nothing to read.
    if ((m = /^### Error (-?\d+) executing$/.exec(line))) {
      const code = crashCode(+m[1]);
      if (code === null) return null;
      const cmd = this.lastCommand;
      const tool = cmd ? cmd.tool : 'tool';
      return mk({
        severity: 'error', file: this.current ? this.resolve(this.current) : this.ctx.projectFile, line: 1,
        message: `${tool} crashed (exit code ${code.hex}${code.name ? `, ${code.name}` : ''}) and printed no error message`,
        code: 'crash', source: /^sdas/.test(tool) ? 'SDAS' : /^sdld/.test(tool) ? 'SDLD' : /^sdcc/.test(tool) ? 'SDCC' : tool,
        located: false, crash: { exit: code.value, hex: code.hex, name: code.name, command: cmd ? cmd.line : null, tool, sourceFile: this.current ? this.resolve(this.current) : null },
      });
    }

    // gcc / clang style: file:line:col: severity: message
    if ((m = /^(.+?):(\d+):(\d+):\s+(fatal error|error|warning|note):\s*(.*)$/.exec(line)) && !/^[A-Za-z]$/.test(m[1])) {
      return mk({ severity: SEV(m[4]), file: this.resolve(m[1]), line: +m[2], column: +m[3], message: m[5], source: 'GCC', span: spanOf(m[1].length + 1 + m[2].length + 1 + m[3].length) });
    }
    // SDCC (and new-style SDAS): file:line: severity [code]: message
    if ((m = /^(.+?):(\d+):\s+(syntax error|error|warning|info)(?:\s+(\d+))?\s*:\s*(.*)$/i.exec(line))) {
      const isSyntax = /^syntax error$/i.test(m[3]);
      let message = isSyntax ? `syntax error: ${m[5]}` : (m[5] || m[3]);
      let code = m[4] || (isSyntax ? 'syntax' : undefined);
      let column = 1;
      const asm = /\.(s|asm|inc)$/i.test(m[1]);
      const ac = /^<(.)>\s*(.*)$/.exec(message); // SDAS: "<q> Questionable syntax..."
      if (ac) { code = ac[1]; message = ac[2]; }
      const cm = /;\s*column (\d+)\s*$/.exec(message); // SDCC: "syntax error: token -> ';' ; column 11"
      if (cm) column = +cm[1];
      return mk({ severity: SEV(m[3]), file: this.resolve(m[1]), line: +m[2], column, code, message, source: asm || ac ? 'SDAS' : 'SDCC', span: spanOf(m[1].length + 1 + m[2].length) });
    }
    // MSBuild / cl / dotnet: file(line[,col]): error CODE: message
    if ((m = /^(.+?)\((\d+)(?:,(\d+))?(?:,\d+,\d+)?\)\s*:\s*(error|warning)\s+([A-Za-z]+\d+)\s*:\s*(.*)$/.exec(line))) {
      return mk({ severity: SEV(m[4]), file: this.resolve(m[1]), line: +m[2], column: m[3] ? +m[3] : 1, code: m[5], message: m[6], source: 'MSBuild', span: spanOf(m[1].length + 1 + m[2].length + (m[3] ? 1 + m[3].length : 0) + 1) });
    }
    // SDAS with a position: ?ASxxxx-Error-<o> in line 12 of file.s
    if ((m = /^\?AS\w*-(Error|Warning)-(<[^>]*>)?\s*in line (\d+) of (.+)$/.exec(line))) {
      return mk({ severity: SEV(m[1]), file: this.resolve(m[4]), line: +m[3], message: `${m[2] || ''} in line ${m[3]}`.trim(), source: 'SDAS' });
    }
    // SDAS / SDLD without a position
    if ((m = /^\?AS(xxxx|link)-(Error|Warning)-(.*)$/.exec(line))) {
      const asm = m[1] === 'xxxx';
      const quoted = /"([^"]+)"/.exec(m[3]);
      const msg = m[3].trim();
      if (quoted && asm) return mk({ severity: SEV(m[2]), file: this.resolve(quoted[1]), message: msg, source: 'SDAS' });
      if (asm && this.current) return mk({ severity: SEV(m[2]), file: this.resolve(this.current), message: msg, source: 'SDAS', located: false });
      return mk({ severity: SEV(m[2]), file: this.ctx.projectFile, message: msg, source: asm ? 'SDAS' : 'SDLD', located: false });
    }
    // ZOO
    if ((m = /^ERROR:\s*(.+?):(\d+):\s*(.*)$/.exec(line))) {
      const at = line.indexOf(m[1]); // the file:line text, after "ERROR: "
      return mk({ severity: 'error', file: this.resolve(m[1]), line: +m[2], message: m[3], source: 'ZOO', span: [lead + at, m[1].length + 1 + m[2].length] });
    }
    if ((m = /^ERROR:\s*(.+?\.zml):\s*(.*)$/i.exec(line))) {
      return mk({ severity: 'error', file: this.resolve(m[1]), line: 1, message: m[2], source: 'ZOO' });
    }
    if ((m = /^ERROR:\s*(.*)$/.exec(line))) {
      return mk({ severity: 'error', file: this.ctx.projectFile, message: m[1], source: 'ZOO', located: false });
    }
    if ((m = /^\[\d\d:\d\d:\d\d\]\s+WARNING:\s*(.*)$/.exec(line))) {
      return mk({ severity: 'warning', file: this.ctx.projectFile, message: m[1], source: 'ZOO', located: false });
    }
    return null;
  }
}

module.exports = { DiagnosticParser, crashCode };
