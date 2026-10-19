'use strict';
// What every configuration file of the MSX templates holds, per project type, with an explanation of each option.
//
// Sources: the comments of the template files themselves, and Make\make.py (which is what actually reads them), so the
// explanations say what the build does with a value. Project types: ROM (cartridge), COM (MSX-DOS program; the
// ApplicationSettings.txt calls it DOS), BIN (BASIC BLOAD binary) and MDO (MSX-DOS overlay module).
const ALL = ['ROM', 'COM', 'BIN', 'MDO'];
const ON_OFF = ['_ON', '_OFF'];

const flag = (key, title, help, extra = {}) => ({ key, title, kind: 'flag', help, ...extra });
const text = (key, title, help, extra = {}) => ({ key, title, kind: 'text', help, ...extra });

// ---- ApplicationSettings.txt ---------------------------------------------------------------------------------------

const ZOO_LEVELS = [
  { value: 'inheritance', label: 'inheritance', help: 'R0: classes know their parent; no polymorphism.' },
  { value: 'polymorphism', label: 'polymorphism', help: 'R1: virtual methods through each object\'s class.' },
  { value: 'classStructure', label: 'classStructure', help: 'R2: adds the class structure (member layout) at run time.' },
  { value: 'namedInheritance', label: 'namedInheritance', help: 'R3: adds class names to the inheritance tree.' },
  { value: 'namedMembers', label: 'namedMembers', help: 'R4: adds member names.' },
  { value: 'typedMembers', label: 'typedMembers', help: 'R5: adds member types; the richest reflection (largest).' },
];

const APPLICATION_SETTINGS = {
  file: 'ApplicationSettings.txt',
  title: 'Application Settings',
  category: 'General',
  kind: 'settings',
  blurb: 'General configuration of the application: what the startup code (crt0) includes, how the code is laid out in memory and, for ROM and BIN, how the program is published to BASIC. make.py turns every line of this file into a macro (C header and assembler constant) the sources can test.',
  groups: [
    {
      title: 'Project',
      fields: [
        { key: 'PROJECT_TYPE', title: 'Project type', kind: 'readonly', help: 'The kind of program this project builds: ROM = cartridge, DOS = MSX-DOS .COM program, BIN = BASIC binary loaded with BLOAD, MDO = MSX-DOS overlay module. It is fixed when the project is created because the startup code and the sources depend on it.' },
      ],
    },
    {
      title: 'Startup code (crt0) features',
      fields: [
        flag('GLOBALS_INITIALIZER', 'Initialize global variables', '_ON includes the routine that gives C global variables their initial values at startup. _OFF leaves them uninitialized, which saves space but they will then contain whatever was in memory.'),
        flag('RETURN_TO_BASIC', 'Return to BASIC', '_ON: when main returns, the MSX goes back to BASIC. _OFF: nothing to return to; if main returns the MSX is rebooted.', { types: ['ROM'] }),
        flag('STACK_HIMEM', 'Stack at HIMEM', '_ON puts the stack at HIMEM (the top of free memory). RETURN_TO_BASIC must be _OFF, because the program then owns the machine. _OFF leaves the stack where the system put it.', { types: ['ROM'] }),
        flag('SET_PAGE_2', 'Enable page 2', '_ON switches page 2 (0x8000-0xBFFF) to the same slot/sub-slot as page 1, which a ROM needs when its code spans pages 1 and 2 (a 32 kB ROM at 0x4000). _OFF leaves page 2 as the system set it.', { types: ['ROM'] }),
        flag('LATE_EXECUTION', 'Late execution', '_ON delays starting the program until the other cartridges have been initialized (it hooks H.STKE). This gives the ROM disk access, among other things. To try everything in the example diskaccess.s: set this _ON, RETURN_TO_BASIC _OFF, FILESTART 0x8000, use a floppy interface and no mass-storage unit.', { types: ['ROM'] }),
        flag('PUBLISH_FILESTART', 'Publish the start address', '_ON stores the program\'s start address at HIMEM-1 so BASIC (or another program) can find it with PEEK, which is how the BASIC USR example locates the routines index. _OFF does not store it.', { types: ['BIN'] }),
        { key: 'MAX_CMDLINE_PARAMETERS', title: 'Command line parameters', kind: 'int', min: 0, max: 63, help: '0 leaves out the command line parsing. N parses up to N parameters into argc/argv. The maximum is 63: the MSX-DOS command tail is only 127 bytes long, so more cannot occur.', types: ['COM'] },
        flag('MDO_SUPPORT', 'Overlay (MDO) support', '_ON includes the support for loading overlay modules (MDOs) at run time. An MDO project always has it _ON, because it is itself an overlay.', { types: ['COM', 'MDO'], lockedOn: ['MDO'] }),
        flag('VDP_PORT_FIX', 'VDP port fix', '_ON includes a routine that supports MA-like devices (machines whose VDP is not at the standard ports); the VDP macros in vdpportmacros.s then go through it. _OFF does not include it.', { types: ['COM', 'BIN', 'MDO'] }),
      ],
    },
    {
      title: 'ZOO object-orientation framework',
      fields: [
        flag('ZOO_SUPPORT', 'ZOO support', '_ON includes the ZOO framework (classes and objects for C and assembly). The ZOO_PATH of the TargetConfig files must then point at your ZOO checkout, and .zml class files can be listed in the source files. _OFF leaves ZOO out.'),
        { key: 'ZOO_REFLECTION_LEVEL', title: 'Reflection level', kind: 'enum', options: ZOO_LEVELS, help: 'How much information about classes ZOO keeps in the program at run time. Higher levels allow more introspection but make the program larger. Each level includes the ones before it.' },
        { key: 'ZOO_REGENERATE_TREE', title: 'Regenerate the ancestor tree', kind: 'enum', options: [
          { value: '_ON', label: '_ON', help: 'Always regenerate the ZOO ancestor tree in this project (right for a base application, or a standalone module).' },
          { value: '_OFF', label: '_OFF', help: 'Never regenerate it; the ancestors come from an upstream module.' },
          { value: '_AUTO', label: '_AUTO', help: 'For an MDO: _OFF when its parent has ZOO_SUPPORT _ON, otherwise _ON. For other projects it behaves like _ON.' },
        ], help: 'Whether this project regenerates the ZOO ancestor tree (the inheritance information shared by all classes). Overlays normally use _AUTO so they share their parent\'s tree.' },
      ],
    },
    {
      title: 'C calling convention',
      fields: [
        { key: 'SDCCCALL', title: 'SDCC calling convention', kind: 'enum', options: [
          { value: '0', label: '0 - old (stack)', help: 'Arguments are passed on the stack (SDCC\'s old convention).' },
          { value: '1', label: '1 - new (registers)', help: 'Arguments are passed in registers (SDCC\'s new convention, faster and smaller).' },
        ], help: 'How C functions receive their arguments. Every module of the program, and every library, must be built with the same value; an overlay (MDO) must use the same one as its MSX-DOS application.' },
      ],
    },
    {
      title: 'ROM settings',
      types: ['ROM'],
      fields: [
        { key: 'ROM_SIZE', title: 'ROM size', kind: 'enum', options: [
          { value: '16k', label: '16k', help: 'A 16 kB ROM image.' },
          { value: '32k', label: '32k', help: 'A 32 kB ROM image (pages 1 and 2).' },
        ], help: 'Size of the ROM image the build produces: the binary is padded to this size.', types: ['ROM'] },
        { key: 'FILESTART', title: 'Start address', kind: 'addr', help: 'Address the ROM is mapped at. Typically 0x4000 for a 32 kB ROM, or a 16 kB ROM that expands BASIC (CALL and DEVICE); 0x8000 for a 16 kB ROM, also one that carries a BASIC program.', types: ['ROM'] },
        flag('CALL_EXPANSION', 'Expand BASIC\'s CALL', '_ON adds the CALL statements listed below to BASIC\'s CALL command (see "CALL statements"). _OFF does not; the list is then ignored.', { types: ['ROM'] }),
        flag('DEVICE_EXPANSION', 'Create a BASIC device', '_ON creates the BASIC devices listed below (usable with OPEN "DEV:"...). _OFF does not; the list is then ignored.', { types: ['ROM'] }),
        { key: 'BASIC_PROGRAM', title: 'BASIC program address', kind: 'addr', help: '0 means the ROM carries no BASIC program. Any other value is the address of a tokenized BASIC program inside the ROM, which BASIC runs at startup.', types: ['ROM'] },
      ],
    },
    {
      title: 'BIN file settings',
      types: ['BIN'],
      fields: [
        { key: 'FILESTART', title: 'Start address', kind: 'addr', help: 'Address the BIN program is loaded at (BLOAD) and starts running from. It has to be in RAM and clear of the BASIC work areas and of HIMEM; the template default is 0xB000.', types: ['BIN'] },
      ],
    },
    {
      title: 'Memory layout',
      fields: [
        { key: 'CODE_LOC', title: 'Code segment address', kind: 'addr', optional: true, help: 'Address of the code segment (.area _CODE). Leave it on "automatic" unless you know what you are doing: the build then computes it from the start address and the startup header.' },
        { key: 'DATA_LOC', title: 'Data segment address', kind: 'addr', optional: true, help: '0 places the data segment right after the code; any other value is the address of the data segment. A ROM keeps its data in RAM, so for ROMs it is 0xC000 (page 3). Elsewhere leave it automatic or 0.' },
        { key: 'HEAP_SIZE', title: 'Heap size', kind: 'int', min: 0, max: 65535, help: 'Bytes reserved for dynamic memory allocation (malloc). 0 means no heap, which is right when the program does not allocate memory dynamically.', types: ['COM', 'MDO'] },
      ],
    },
  ],
  lists: [
    { key: 'CALL_STATEMENT', title: 'CALL statements', kind: 'list', types: ['ROM'], itemTitle: 'Statement name', help: 'Names of the new BASIC CALL commands, e.g. CMD1 makes CALL CMD1(...) run the C function onCallCMD1. Used only when CALL expansion is on. Statement names are upper case without spaces.', pattern: '^[A-Za-z][A-Za-z0-9_]*$' },
    { key: 'DEVICE', title: 'BASIC devices', kind: 'list', types: ['ROM'], itemTitle: 'Device name', help: 'Names of the new BASIC devices, e.g. DEV makes OPEN "DEV:" work through onDeviceDEV_IO and onDeviceDEV_getId. Used only when device expansion is on.', pattern: '^[A-Za-z][A-Za-z0-9_]*$' },
    { key: 'SYMBOL', title: 'BASIC USR routines', kind: 'usr', types: ['BIN'], help: 'The address table that BASIC (or another program) reads to reach your routines. The first entry is USR0 (DEFUSR), the next USR1, and so on up to USR9. A SYMBOL entry publishes a routine by its assembler name (for C functions: an underscore plus the name, e.g. _printFromBasic); an ADDRESS entry stores a literal address.' },
  ],
  other: { title: 'Other definitions', help: 'Any other KEY VALUE line becomes a macro of the same name for C and assembler: "KEY _ON" defines it, "KEY _OFF" leaves it undefined, "KEY value" defines it with that value. Use it for your own build switches.' },
};

// ---- MDOSettings.txt (MSX-DOS applications and overlays) -----------------------------------------------------------

const MDO_SETTINGS = {
  file: 'MDOSettings.txt',
  title: 'MDO Settings',
  category: 'General',
  kind: 'mdo',
  types: ['COM', 'MDO'],
  blurb: 'MDO (MSX-DOS Overlay) configuration: where this module sits in the overlay hierarchy, which hooks the parent offers and the children it loads. An MSX-DOS application is the root of the hierarchy; an overlay hangs from a parent.',
  groups: [
    {
      title: 'Hierarchy',
      fields: [
        { key: 'MDO_APPLICATION_PROJECT_PATH', title: 'Application project', kind: 'path', help: 'Folder of the MSX-DOS application at the root of the hierarchy. In the application itself it is always "." (this project).', types: ['COM', 'MDO'] },
        { key: 'MDO_PARENT_PROJECT_PATH', title: 'Parent project', kind: 'path', help: 'Folder of the module this overlay hangs from. The parent must be built (same configuration) before this project, because the build reads its exported interface and where its memory ends.', types: ['MDO'] },
        { key: 'MDO_PREVIOUS_PROJECT_PATH', title: 'Previous project', kind: 'path', optional: true, help: 'Optional. Folder of another overlay that may already be loaded; this one can then be loaded right after it (FILESTART PREVIOUS_AFTERHEAP), not only after its parent.', types: ['MDO'] },
      ],
    },
    {
      title: 'Overlay',
      fields: [
        { key: 'FILESTART', title: 'Load address', kind: 'enum', custom: true, options: [{ value: 'PARENT_AFTERHEAP', label: 'PARENT_AFTERHEAP', help: 'Right after the heap of the parent.' }, { value: 'PREVIOUS_AFTERHEAP', label: 'PREVIOUS_AFTERHEAP', help: 'Right after the heap of the previous project (needs a previous project).' }], help: 'Where this overlay is loaded. PARENT_AFTERHEAP: right after the parent\'s heap, so it sits behind it in memory. PREVIOUS_AFTERHEAP: right after the previous project\'s heap (needs a previous project). Or a literal address.', types: ['MDO'] },
        { key: 'MDO_NAME', title: 'Module name', kind: 'text', pattern: '^[A-Za-z_][A-Za-z0-9_]*$', help: 'Name of this module: a C-style identifier. Its parent refers to it by this name in MDO_CHILD; for the application it is the name of the root of the hierarchy.', types: ['COM', 'MDO'] },
      ],
    },
  ],
  lists: [
    { key: 'MDO_EXTRA_INTERFACE', title: 'Extra interfaces', kind: 'list', types: ['MDO'], itemTitle: 'Ancestor project folder', path: true, help: 'Optional. Folders of ancestor projects whose exported symbols this overlay also needs (for instance the root application, when the parent is another overlay). The ancestors must be built, in the same configuration, before this project.' },
    { key: 'MDO_HOOK', title: 'Hooks offered to children', kind: 'hook', types: ['COM', 'MDO'], help: 'Functions this module lets its children implement. Each hook has a C return type, a name and a C parameter list; a child implements it with an MDO_HOOK_IMPLEMENTATION line. The parent calls the hook as <name>_hook.' },
    { key: 'MDO_HOOK_IMPLEMENTATION', title: 'Hook implementations', kind: 'impl', types: ['MDO'], help: 'Which of this overlay\'s functions implements a hook declared by its parent: the hook name and the assembler symbol of the function (C functions have a leading underscore).' },
    { key: 'MDO_CHILD', title: 'Child overlays', kind: 'child', types: ['COM', 'MDO'], help: 'Overlays this module can load: the module name of the child, and the name of its file on disk (up to 8 characters) and extension (up to 3). The load address is not configured here; each overlay embeds its own (its FILESTART).' },
  ],
};

// ---- TargetConfig_<profile>.txt ------------------------------------------------------------------------------------

const DBG_LEVELS = [
  { value: '0', label: '0 - DBG_MUTE', help: 'Prints nothing.' },
  { value: '10', label: '10 - DBG_ERROR', help: 'Prints errors only.' },
  { value: '40', label: '40 - DBG_OPENING', help: 'Adds the opening banner.' },
  { value: '50', label: '50 - DBG_STEPS', help: 'Adds each build step.' },
  { value: '70', label: '70 - DBG_SETTING', help: 'Adds the settings in use.' },
  { value: '100', label: '100 - DBG_OUTPUT', help: 'Adds the tools\' output.' },
  { value: '120', label: '120 - DBG_DETAIL', help: 'Adds details for each file processed.' },
  { value: '150', label: '150 - DBG_CALL1', help: 'Adds the command line of the link step.' },
  { value: '160', label: '160 - DBG_CALL2', help: 'Adds the command lines of every compile and assemble.' },
  { value: '170', label: '170 - DBG_CALL3', help: 'Adds the command lines of the helper tools (hex2bin, symbol export, build events).' },
  { value: '190', label: '190 - DBG_TOOLSDETAIL', help: 'The tools themselves run verbosely.' },
  { value: '200', label: '200 - DBG_EXTROVERT', help: 'Prints the files being opened and what is read from them.' },
  { value: '230', label: '230 - DBG_PARAMS', help: 'Prints every argument of every tool call.' },
  { value: '255', label: '255 - DBG_VERBOSE', help: 'Prints everything.' },
];

const TARGET_CONFIG = {
  file: 'TargetConfig_<profile>.txt',
  title: 'Target Configuration',
  category: 'Build configuration',
  kind: 'target',
  blurb: 'Settings of one build configuration (profile). The Debug and Release files have the same options with different values: how much the build prints, extra tool options, macros defined for the code, and where files go.',
  groups: [
    {
      title: 'Build',
      section: '.BUILD',
      fields: [
        { key: 'BUILD_DEBUG', title: 'Build output level', kind: 'enum', options: DBG_LEVELS, custom: true, help: 'How much the build scripts print (a number from 0 to 255; each level includes the ones before it). 150 shows the link command; 100 only the tools\' own output.' },
        flag('ADB_SUPPORT', 'Source-level debug symbols (AlchemiaZ)', '_ON generates .adb debug symbols for source-level debugging in AlchemiaZ: it adds --debug to the compiler and linker and -s to the assembler, which makes the build larger and slower. _OFF leaves them out (Release).'),
        text('ASSEMBLER_EXTRA_DIRECTIVES', 'Assembler options', 'Extra options for the assembler (sdasz80) on every .s file, for example -l to produce a listing.'),
        text('COMPILER_EXTRA_DIRECTIVES', 'Compiler options', 'Extra options for the C compiler (sdcc) on every .c file, for example --opt-code-size or --max-allocs-per-node 100000.'),
        text('LINKER_EXTRA_DIRECTIVES', 'Linker options', 'Extra options for the link step (sdcc), for example --opt-code-size or --disable-warning 196.'),
        text('EXECGEN_EXTRA_DIRECTIVES', 'Executable generator options', 'Extra options for hex2bin, the tool that turns the linked output into the final .ROM/.COM/.BIN/.MDO file.'),
      ],
    },
    {
      title: 'Application',
      section: '.APPLICATION',
      fields: [
        { key: 'DEBUG', title: 'DEBUG macro', kind: 'enum', custom: true, options: [{ value: '_OFF', label: '_OFF', help: 'Not defined.' }, { value: '_ON', label: '_ON', help: 'Defined (no value).' }, { value: '1', label: '1', help: 'Defined as 1: debug level 1.' }, { value: '2', label: '2', help: 'Defined as 2: debug level 2.' }, { value: '3', label: '3', help: 'Defined as 3: debug level 3.' }], help: 'The DEBUG macro of your code. _OFF leaves it undefined, _ON defines it, and a number from 1 up defines it with that value, to use as a debug level (#if DEBUG > 1 ...).' },
        flag('MSXDOSPRINT', 'MSX-DOS print routines', '_ON makes the print routines go through MSX-DOS, so output can use pipes and redirection. _OFF writes straight to the screen, which is lighter.', { types: ['COM'] }),
      ],
      other: { title: 'Other macros', help: 'Any other line of this section becomes a macro for C and assembler: "NAME" or "NAME _ON" defines it, "NAME _OFF" leaves it undefined, "NAME value" defines it with that value.' },
    },
    {
      title: 'Files and folders',
      section: '.FILESYSTEM',
      fields: [
        text('MSX_FILE_NAME', 'Output file name', 'Name of the file the build produces (without extension). For MSX-DOS programs and overlays it must be a valid 8.3 name: at most 8 characters. An overlay\'s file must match the name its parent lists in MDO_CHILD.'),
        { key: 'MSX_FILE_EXTENSION', title: 'Output file extension', kind: 'text', help: 'Extension of the output file. ROM, COM, BIN and MDO are the templates\' standard ones for each project type.' },
        text('MSX_BIN_PATH', 'Output folder', 'Folder the final file is written to, relative to the project folder. [PROFILE] stands for the configuration name. An overlay normally writes into its application\'s output folder, so the program finds it at run time.', { path: true }),
        text('MSX_OBJ_PATH', 'Intermediate files folder', 'Folder for the object files, listings and generated headers (targetconfig.h/.s and so on). Cleaning removes everything in it. [PROFILE] stands for the configuration name.', { path: true }),
        text('MSX_DEV_PATH', 'MSX development folder', 'Root of your MSX development tree; the other paths are often built from it with [MSX_DEV_PATH].', { path: true }),
        text('MSX_LIB_PATH', 'Libraries folder', 'Folder with the shared libraries and sources ([MSX_LIB_PATH] in the lists of source files, libraries and include folders). Normally [MSX_DEV_PATH]\\libs.', { path: true }),
        text('ZOO_PATH', 'ZOO folder', 'Path to your local checkout of ZOO. Required when ZOO support is on; leave empty otherwise.', { path: true }),
      ],
    },
  ],
};

// ---- the plain lists -----------------------------------------------------------------------------------------------

const APPLICATION_SOURCES = {
  file: 'ApplicationSources.txt', title: 'Application Sources', category: 'Sources', kind: 'entries', entry: 'source',
  blurb: 'The C, assembler and ZOO (.zml) sources of this application, in the order they are compiled and linked. They are always processed by every build action. A line starting with ";" is switched off: switch on one of an "either/or" pair (the template says: choose ONE and ONLY ONE).',
  itemTitle: 'Source file', lockFirst: true,
  help: 'Source files relative to the project folder. The first entry is the startup code (crt0) and must stay first. Use [MSX_LIB_PATH] for shared folders.',
  extensions: ['c', 's', 'zml'],
};
const LIBRARY_SOURCES = {
  file: 'LibrarySources.txt', title: 'Library Sources', category: 'Sources', kind: 'entries', entry: 'source',
  blurb: 'Sources of libraries used by the application. Rebuild/Make all compiles them again; plain Build reuses their compiled objects.',
  itemTitle: 'Library source file',
  help: 'Library source files (.c, .s or .zml), relative to the project folder, usually under [MSX_LIB_PATH].',
  extensions: ['c', 's', 'zml'],
};
const LIBRARIES = {
  file: 'Libraries.txt', title: 'Libraries', category: 'Linking', kind: 'entries', entry: 'library',
  blurb: 'Already compiled libraries (.lib) and object files (.rel). They are not processed by any build action; they are only linked into the final program.',
  itemTitle: 'Library or object file',
  help: 'Compiled .lib or .rel files, usually under [MSX_LIB_PATH].',
  extensions: ['lib', 'rel'],
};
const INCLUDE_DIRECTORIES = {
  file: 'IncludeDirectories.txt', title: 'Include Directories', category: 'Linking', kind: 'entries', entry: 'directory',
  blurb: 'Folders the build searches for headers and assembler includes (each becomes a -I option for the compiler and the assembler). The intermediate files folder is always searched too.',
  itemTitle: 'Folder',
  help: 'Folders relative to the project folder; "." is the project folder itself. Use [MSX_LIB_PATH] for shared folders.',
};
const SYMBOLS = {
  file: 'Symbols.txt', title: 'Symbols', category: 'Linking', kind: 'symbols',
  blurb: 'Which symbols of this module are exported for others (an overlay\'s parent, the ZOO tools, the debugger). Each line is a Python-style regular expression that selects symbols; optionally a search expression and a replacement rename them on export.',
  itemTitle: 'Symbol pattern',
  help: 'A regular expression matching symbol names. Optionally also a search expression and a replacement string, to rename the exported symbol (for instance s__AFTERHEAP s__A PARENT_A).',
};
const BUILD_EVENTS = {
  file: 'BuildEvents.txt', title: 'Build Events', category: 'Build configuration', kind: 'events',
  blurb: 'Commands run at fixed points of the build, for example to copy files or prepare data. Paths in the commands are relative to the project folder and use "/" as the separator. [PROFILE] stands for the configuration name and [SHELL_SCRIPT_EXTENSION] for the script extension of the operating system (BAT or sh).',
  fields: [
    { key: 'BUILD_START_ACTION', title: 'At the start of the build', kind: 'text', help: 'Always run when a build starts, whatever the action.' },
    { key: 'BEFORE_COMPILE_ACTION', title: 'Before compiling', kind: 'text', help: 'Run before the sources are compiled. Not run by a clean without "all".' },
    { key: 'AFTER_COMPILE_ACTION', title: 'After compiling', kind: 'text', help: 'Run after all sources are compiled and before linking. Not run by a clean without "all".' },
    { key: 'AFTER_BINARY_ACTION', title: 'After the binary is generated', kind: 'text', help: 'Run after the final file has been produced (the place for copying it to an emulator folder, say). Not run by a clean without "all".' },
    { key: 'BUILD_END_ACTION', title: 'At the end of the build', kind: 'text', help: 'Always run when a build ends.' },
  ],
  example: 'BUILD_START_ACTION   "MyStartScript.[SHELL_SCRIPT_EXTENSION]" [PROFILE]',
};

const PAGES = [APPLICATION_SETTINGS, MDO_SETTINGS, TARGET_CONFIG, APPLICATION_SOURCES, LIBRARY_SOURCES, LIBRARIES, INCLUDE_DIRECTORIES, SYMBOLS, BUILD_EVENTS];

/**
 * The pages of the dialog for one project type, in index order. TargetConfig is one page per profile. With
 * `expected` (the project may lack files its template defines) the pages of the missing files are included too, marked
 * `missing`: Debug and Release are always expected.
 */
function pagesFor(type, files, expected = false) {
  const present = new Set(files.map((f) => f.toLowerCase()));
  const out = [];
  for (const p of PAGES) {
    if (p.types && !p.types.includes(type)) continue;
    if (p === TARGET_CONFIG) {
      const profiles = new Set(files.filter((x) => /^targetconfig_.+\.txt$/i.test(x)).map((x) => /^targetconfig_(.+)\.txt$/i.exec(x)[1]));
      if (expected) { profiles.add('Debug'); profiles.add('Release'); }
      const have = new Map([...profiles].map((pr) => [pr.toLowerCase(), pr]));
      for (const pr of [...have.values()].sort()) {
        const file = `TargetConfig_${pr}.txt`;
        out.push({ ...p, file, profile: pr, title: `Target Configuration - ${pr}`, ...(present.has(file.toLowerCase()) ? {} : { missing: true }) });
      }
    } else if (present.has(p.file.toLowerCase())) {
      out.push(p);
    } else if (expected) {
      out.push({ ...p, missing: true });
    }
  }
  return out;
}

const appliesTo = (item, type) => !item.types || item.types.includes(type);

module.exports = { ALL, ON_OFF, PAGES, pagesFor, appliesTo, APPLICATION_SETTINGS, MDO_SETTINGS, TARGET_CONFIG, ZOO_LEVELS, DBG_LEVELS };
