'use strict';
const SDCC = require('./data/sdcc-messages.json');

// Explanations for diagnostics produced by the SDCC toolchain and ZOO.
// Sources: the ASxxxx manual shipped with SDCC (doc/sdas/asmlnk.txt: section 1.6 "Errors" and 3.6.10 "ASlink Error
// Messages"), SDCC 4.3.0's own message table (SDCCerr.h/.c, rev. 14184), and what the tools were observed to do on
// this machine. Statements marked "hint" are practical experience, not manual text.

/** @typedef {{title:string, hint:string, body:string, query:string}} Explanation */

const SDAS = {
  '.': ['Absolute assignment of the location counter',
    'The line assigns `. = value` instead of advancing the counter.',
    'Write `. = . + n` (or use `.ds n`) to reserve space; `. = value` only makes sense in an absolute area.'],
  a: ['Addressing mode error',
    'The operand is not valid for this instruction (manual: "machine specific addressing or addressing mode error").',
    ['Hint - usual causes (each checked against SDCC 4.3.0\'s sdasz80):',
      '- **a missing `#` on an immediate value**: SDAS requires `ld a,#5` and `ld hl,#label`. `ld a,5` and `ld hl,label` are rejected with this error; `ld a,(label)` is the memory form;',
      '- an operand combination the CPU does not have (`ld hl,hl`);',
      '- "Branching Range Exceeded": `jr`/`djnz` can only reach -128..+127 bytes. Use `jp`, or move the code closer;',
      '- a misspelled register or mnemonic operand.'].join('\n')],
  b: ['Direct page boundary error', 'Direct page boundary error (manual). Not used by the Z80 assembler.', ''],
  d: ['Direct page addressing error', 'Direct page addressing error (manual). Not used by the Z80 assembler.', ''],
  i: ['Include or conditional error',
    'Caused by an `.include` file error or an `.if`/`.endif` mismatch (manual).',
    ['Hint:',
      '- the included file is missing: paths are looked up relative to the folder the assembler runs in and in the `-I` directories (IncludeDirectories.txt in the MSX templates);',
      '- an `.endif` without a matching `.if`, or an `.if` that is never closed before the end of the file.'].join('\n')],
  m: ['Multiple definitions',
    'The same label is defined twice, `.module` appears more than once, or an `.area` is redeclared with conflicting attributes (manual).',
    ['Hint:',
      '- the same label (or a `::` global) defined in two places, or one file assembled/included twice;',
      '- it is usually followed by `<p>` phase errors on the same lines. Fix the duplicate and both go away;',
      '- inside a macro, a fixed label is defined again at every expansion.'].join('\n')],
  n: ['Macro directive outside a macro', '`.mexit`, `.endm` or `.narg` outside of a macro, repeat block or indefinite repeat block (manual).',
    'Hint: an extra `.endm`, or a macro whose `.macro` line is missing or was commented out.'],
  o: ['Directive or mnemonic error',
    'Unknown directive or mnemonic, or `.org` used in a relocatable area (manual).',
    ['Hint:',
      '- a misspelled instruction or directive (`foo bar baz` gives exactly this);',
      '- `.org` only works in an absolute area: declare `.area NAME (ABS)` first. In a relocatable area `sdasz80` 4.3.0 usually crashes without any message instead of reporting this (see the crash notes);',
      '- a lone word on a line, such as a label missing its `:`, also crashes `sdasz80` 4.3.0 silently.'].join('\n')],
  p: ['Phase error',
    'A label\'s address changed between assembler passes 2 and 3, normally from more than one level of forward referencing (manual).',
    ['Hint:',
      '- look for a `<m>` (multiple definition) on the same line first: it is the usual cause and the phase error disappears with it;',
      '- otherwise an expression sized by a label that is defined later (`.ds`/`.blkb` with a forward label, or `.if` on a forward label).'].join('\n')],
  q: ['Questionable syntax',
    'Missing or improper operator, terminator or delimiter (manual).',
    ['Hint:',
      '- unbalanced parentheses or quotes, a stray character, a missing comma between operands;',
      '- an expression with a missing operand (`ld a,1+`);',
      '- NOTE: `sdasz80` 4.3.0 crashes without any message on an operand that is cut short (`ld a,(`, `call (`) instead of reporting `<q>`.'].join('\n')],
  r: ['Relocation error',
    'A logical operation was attempted on a relocatable term, two relocatable terms were added, or two relocatable terms from different areas/externals were subtracted (manual).',
    ['Hint:',
      '- `ld a,#label1+label2` adds two addresses ("Arg1 + Arg2, Arg2 must be a constant"); only `label - label` (same area) or `label + constant` are legal;',
      '- a logical operation on an address: `ld a,#label & 0xFF` is rejected; use `#<label` and `#>label` for the low and high byte.'].join('\n')],
  s: ['String substitution / recursion error',
    'A macro string substitution (the `\'` concatenation operator) or macro recursion failed (manual).',
    'Hint: with ZOO\'s macros, check the argument that is being concatenated (`object\'.__$Start`) and that no macro calls itself.'],
  u: ['Undefined symbol',
    'A symbol used in an expression was never defined (manual).',
    ['Hint:',
      '- a misspelled name, or one defined elsewhere under a different spelling or case;',
      '- a symbol that lives in another file: declare it here with `.globl name`. The assembler then leaves it to the linker, and if it is still missing there it is reported as `?ASlink-Warning-Undefined Global`.'].join('\n')],
  z: ['Division by zero',
    'Divide by 0 or modulus by 0 in an expression: the result is 0 (manual).',
    'Hint: often a symbol that is still 0 (an `.equ` that is defined later or in another file) used as a divisor.'],
};

/** Windows NTSTATUS / signal causes, shared wording. */
const CRASH_TEXT = {
  STATUS_BAD_STACK: 'Windows could not unwind the stack while the tool was handling an error (0xC0000028, "an invalid or unaligned stack was encountered during an unwind operation").',
  STATUS_ACCESS_VIOLATION: 'The tool read or wrote memory it does not own (0xC0000005).',
  STATUS_STACK_OVERFLOW: 'The tool ran out of stack, typically from runaway recursion (0xC00000FD).',
  STATUS_STACK_BUFFER_OVERRUN: 'The tool detected a corrupted stack (0xC0000409).',
  STATUS_HEAP_CORRUPTION: 'The tool\'s memory management was corrupted (0xC0000374).',
  STATUS_DLL_NOT_FOUND: 'A DLL the tool needs was not found (0xC0000135): check that the SDCC `bin` folder is intact and on PATH.',
  STATUS_DLL_INIT_FAILED: 'A DLL the tool needs failed to initialise (0xC0000142), often a broken install or too many processes.',
  SIGSEGV: 'The tool crashed with a segmentation fault.',
  SIGABRT: 'The tool aborted itself.',
};

const linkerHints = [
  [/^Undefined Global '([^']*)' referenced by module '([^']*)'/,
    (m) => ({
      title: `Undefined Global '${m[1]}'`,
      hint: `'${m[1]}' is referenced${m[2] ? ` by module ${m[2]}` : ''} but no linked file defines it.`,
      body: [
        `The linker found \`${m[1]}\`${m[2] ? ` used in module \`${m[2]}\`` : ' used by a module that has no `.module` name'}, but no object file or library on the link line defines it.`,
        '', 'Hint - check, in this order:',
        '1. **Is it exported?** Another file can only see a label written `name::` (or declared `.globl name`); `name:` is local to its own file.',
        `2. **Leading underscore.** C names get an underscore in assembly: C \`foo\` is \`_foo\`${m[1].startsWith('_') ? '' : `; \`${m[1]}\` has none, so it is looked up exactly as written`}.`,
        '3. **Is the file linked?** The defining `.s`/`.c` must be in the project\'s sources (ApplicationSources.txt / LibrarySources.txt in the MSX templates), or its `.lib` listed in Libraries.txt.',
        '4. **Spelling and case.** Symbols are case-sensitive.',
        ...(/^zoo\./i.test(m[1]) ? ['5. **ZOO.** `zoo.*` symbols come from the Zoo engine library or from generated class files: run the ZOO generation step and link `zoo.engine.*.lib` (or the generated `.s` of the class).'] : []),
        ...(m[2] === '' ? ['', 'The empty module name means the referencing file has no `.module` directive; SDCC output normally has one.'] : []),
      ].join('\n'),
      query: 'ASlink Undefined Global referenced by module sdcc sdld',
    })],
  [/^Byte PCR relocation error/,
    () => ({
      title: 'Byte PC-relative relocation error',
      hint: 'A `jr`/`djnz` target is more than 127 bytes forward or 128 bytes back.',
      body: ['The linker found a relative branch (`jr`, `djnz`) whose target is outside -128..+127 bytes (manual: "exceeding the pc relative byte branch range").', '', 'Hint: change it to `jp` (or `jp cc,`), or move the target closer. The lines below the warning (Refby/Defin) give the module, area and offset of the branch; the assembler listing at that offset shows the line.'].join('\n'),
      query: 'ASlink Byte PCR relocation error jr djnz range',
    })],
  [/^Unsigned Byte error/,
    () => ({
      title: 'Unsigned byte error',
      hint: 'A value stored in one byte is negative or larger than 255.',
      body: 'The linker resolved a one-byte reference (an 8-bit immediate, `.db`, an index offset) to a value outside 0..255 (manual).\n\nHint: check constants such as `ld a,#256`, a symbol that was meant to be a 16-bit address used as a byte (use `<sym` / `>sym` for its low/high byte), or an `.equ` that resolved to a different value than expected.',
      query: 'ASlink Unsigned Byte error sdcc',
    })],
  [/^(Page0|Page Mode|2K Page|512K Page|Paged Area|Page Definition)/,
    (m) => ({
      title: `${m[1]} warning`,
      hint: 'Paging warning for CPU families other than the Z80.',
      body: 'This linker message concerns direct/paged addressing of other CPUs (6809, 8051, DS390) and is not expected for a Z80 target; it usually means the wrong assembler/linker variant is being used (check that `sdasz80` and `sdldz80`/`sdcc -mz80` are on the path).',
      query: 'ASlink Warning page relocation error',
    })],
  [/^<cannot open> : "([^"]*)"/,
    (m) => ({
      title: `Cannot open ${m[1]}`,
      hint: `${m[1]} does not exist where the tool looked for it.`,
      body: `The tool could not open \`${m[1]}\`.\n\nHint: the path is relative to the project folder; a missing \`.rel\` usually means the step that should have produced it failed earlier (look at the first error of the build), and a missing source means a wrong path or include directory.`,
      query: 'sdas cannot open file',
    })],
  [/^<cannot create> : "([^"]*)"/,
    (m) => ({
      title: `Cannot create ${m[1]}`,
      hint: 'The output folder does not exist or the path is empty.',
      body: `The tool could not create \`${m[1]}\`.\n\nHint: the output folder is missing or the path lost its first part (a path such as \`\\objs\\x.rel\` with nothing in front means a configuration variable was empty). Check the object-folder setting and that the folder is writable.`,
      query: 'sdas cannot create file',
    })],
  [/^Unkown option (\S+) ignored/,
    (m) => ({
      title: `Option ${m[1]} ignored`,
      hint: 'An option was passed to a tool that does not understand it.',
      body: `The assembler ignored \`${m[1]}\` (the tool spells it "Unkown"). It is harmless but means ASSEMBLER_EXTRA_DIRECTIVES (or a similar setting) holds an option meant for another tool.`,
      query: 'sdas Unkown option ignored',
    })],
];

function sdccExplain(code) {
  const e = SDCC[code];
  if (!e) return null;
  const text = e.text.replace(/%[sdlux]/g, '…');
  const isWarn = e.level !== 'error';
  return {
    title: `SDCC ${isWarn ? 'warning' : 'error'} ${code}: ${text}`,
    hint: isWarn ? `Silence with --disable-warning ${code} (COMPILER_EXTRA_DIRECTIVES).` : 'SDCC compile error.',
    body: [`SDCC 4.3.0 message ${code} (\`${e.name}\`, ${e.level}): ${text}`,
      ...(isWarn ? ['', `To silence this warning for the whole project add \`--disable-warning ${code}\` to COMPILER_EXTRA_DIRECTIVES (the MSX templates already do this for 196).`] : [])].join('\n'),
    query: `sdcc ${isWarn ? 'warning' : 'error'} ${code} ${text}`,
  };
}

/**
 * @param {{source:string, code?:string, message:string, crash?:object}} d  a diagnostic from DiagnosticParser
 * @returns {Explanation|null}
 */
function explain(d) {
  if (d.crash) {
    const c = d.crash;
    const sdas = /^sdas/.test(c.tool);
    return {
      title: `${c.tool} crashed (${c.hex}${c.name ? `, ${c.name}` : ''})`,
      hint: `${c.tool} died without a message - "Find the crashing line" locates the source line.`,
      body: [
        `\`${c.tool}\` terminated abnormally with exit code **${c.hex}**${c.name ? ` (${c.name})` : ''} and printed no error message, so there is no line number to show.`,
        '', CRASH_TEXT[c.name] || 'The tool crashed; this is a bug in the tool triggered by something in its input, not a message about your code.',
        ...(sdas ? ['', 'Reproduced with SDCC 4.3.0\'s `sdasz80`: each of these makes it crash silently:',
          '- an operand cut short: `ld a,(` or `call (`',
          '- `.org` inside a relocatable area (it needs `.area NAME (ABS)`)',
          '- a lone word on a line, e.g. a label missing its `:`',
          '', 'Use **Find the crashing line** (lightbulb on this problem): it assembles growing prefixes of the file until the assembler crashes and reports the first line that does.'] : []),
        ...(c.command ? ['', 'Command:', '```', c.command, '```'] : []),
      ].join('\n'),
      query: `${c.tool} crash exit code ${c.hex}`,
    };
  }
  if (d.source === 'SDAS' && d.code && SDAS[d.code]) {
    const [name, what, extra] = SDAS[d.code];
    return {
      title: `SDAS <${d.code}> ${name}`,
      hint: what,
      body: [`**<${d.code}> ${name}**`, '', what, ...(extra ? ['', extra] : []), '', `Message from the assembler: ${d.message}`].join('\n'),
      query: `sdasz80 error <${d.code}> ${name}`,
    };
  }
  if ((d.source === 'SDLD' || d.source === 'SDAS') && /^\?|Undefined Global|relocation error|Unsigned Byte|cannot (open|create)|Unkown option|Page/.test(d.message)) {
    const msg = d.message.replace(/^\?AS\w+-(?:Error|Warning)-/, '');
    for (const [re, fn] of linkerHints) { const m = re.exec(msg); if (m) return fn(m); }
  }
  if (d.source === 'SDCC' && d.code && /^\d+$/.test(d.code)) return sdccExplain(d.code);
  if (d.source === 'SDCC' && d.code === 'syntax') {
    return {
      title: 'SDCC syntax error',
      hint: 'The token shown is where the parser gave up; the real mistake is usually just before it.',
      body: 'The C parser could not continue at the token named in the message (the column is where it is). Usually the real mistake is on the previous line (a missing `;` or `}`), or a declaration after a statement in a function that SDCC treats as C89.',
      query: `sdcc syntax error ${d.message.replace(/'[^']*'/g, '').trim()}`,
    };
  }
  return null;
}

const SEARCH = 'https://www.google.com/search?q={query}';
/** URL that searches the web for a diagnostic (opened in the user's browser, never fetched by the extension). */
function searchUrl(d, template = SEARCH) {
  const e = explain(d);
  const q = e ? e.query : `${d.source} ${d.code || ''} ${d.message.replace(/"[^"]*"|'[^']*'/g, '')}`;
  return template.replace('{query}', encodeURIComponent(q.replace(/\s+/g, ' ').trim()));
}

module.exports = { explain, searchUrl, SDAS, sdccExplain };
