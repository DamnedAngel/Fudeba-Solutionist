# Fudeba Solutionist - decision log and open topics

Separate from Alchemia Z (its own folder, its own repo-to-be). Nothing here is committed.

## Open topics to discuss with the user

1. **"Replace the VC find/replace mechanics with the one from VS"** (user, mid-build; "we can discuss this later").
   Recorded verbatim, not yet interpreted. Candidate readings to settle in the discussion:
   - the template parameter substitution (`$projectname$`, `$guid1$` ...): today implemented in
     `src/core/vstemplate.js` (`replaceParams`) following the VS template-parameter rules, and the project
     layout is taken from the generated `.vcxproj` Include paths, because the .vstemplate files flatten
     `MAKE\make.py` to `make.py`;
   - or the editor's Find/Replace (VS's Find in Files / Replace in Files semantics, scope = solution/project);
   - or how the MSX templates themselves do find/replace of settings.
   Ask which one before building anything for it.

## Decisions taken so far

- **Scope**: general `.sln`/`.slnx` explorer; must fully support the user's MSX templates (NMake/Makefile
  `.vcxproj` + `.vcxproj.filters`, e.g. `My Game with Overlays`).
- **Build actions are per project** (not per file). For Makefile projects they are the project's own
  `NMakeBuildCommandLine` / `NMakeCleanCommandLine` / `NMakeReBuildCommandLine` for the active configuration
  (what VS shows in the project properties). Other project kinds get an MSBuild / `dotnet` default.
- **Dependencies** are read from the solution (`ProjectSection(ProjectDependencies)`, `.slnx` `BuildDependency`)
  and from `ProjectReference`; they drive the build order. Edited through a multi-select picker that writes the
  solution, as VS's "Project Dependencies" dialog does.
- **No dependencies on npm packages at runtime**: own position-preserving XML reader (edits are text splices so
  the user's project files keep their formatting), own zip reader (templates are plain deflate zips).
- **New project from templates**: templates are discovered from the user's installed VS templates
  (`Documents\Visual Studio *\Templates\ProjectTemplates`, zips with a root `.vstemplate`, or unzipped
  folders) plus a setting for extra folders. The project is instantiated with VS's parameter rules
  (`$projectname$`, `$safeprojectname$`, `$guid1$`..`$guid10$`, `$solutionname$`, ...), written next to the
  solution (or a new solution is created), registered in the `.sln` with its configuration mapping.
- **Template file layout**: an item whose `TargetFileName` is a bare name is placed at the path the generated
  project file declares for it (so `Make\make.py`, `Config\*.txt`, `MSX\BIOS\*` come out as in projects VS
  creates from the same templates). Verified against the user's installed 00.07.00alpha templates.
- Where several copies of one template are installed (several VS versions), the newest wins.

## Windows + Linux (user requirement)

- All platform differences live in small pure functions that are unit-tested with an injected platform:
  `portableCommand` (`Make\make.py` -> `Make/make.py`, escaped spaces untouched), `pythonFallback`
  (`python` -> `python3` when only that is on PATH), `fsx.resolveInsensitive` (case-insensitive path
  resolution on case-sensitive file systems), `fsx.native`.
- Build steps run through `cmd.exe /d /s /c` on Windows and `/bin/sh -c` elsewhere (NMake lines are written
  for cmd; `&&` and redirection work in both).
- C++ (non-Makefile) projects need MSBuild: reported as Windows-only on Linux instead of failing obscurely.
- **Not executed on Linux here** (no WSL/Docker on this machine). `.github/workflows/ci.yml` runs both
  suites on `ubuntu-latest` (xvfb) and `windows-latest`; first Linux run is still to be seen.

## Other decisions

- **Build output mimics VS's Output window** (user request after first use): one terminal per build (a task
  with a custom execution), header `N>------ Build started: Project: X, Configuration: Debug Win32 ------`,
  every output line prefixed `N>` with the project's number (numbering = order projects actually start),
  `N>Done building project "X" -- FAILED.` on failure, and the closing
  `========== Build: S succeeded, F failed, U up-to-date, K skipped ==========` /
  `========== Build completed at <time> and took <ss.mmm> seconds ==========` (Rebuild All / Clean variants
  without the up-to-date count). Implemented in `src/core/buildrun.js` (pure Node, tested with real processes).
  - "up-to-date" is always 0: NMake projects don't tell us; "skipped" = not built in this configuration,
    or not reached after a failure/cancel (as VS counts them).
  - stdout and stderr are merged line by line; `PYTHONUNBUFFERED=1` is set so make.py output streams live.
    Non-ASCII output from cmd.exe tools uses the OEM code page and may show wrong characters.
  - Command line is echoed under each header (`slnExplorer.echoCommand`, default on; VS doesn't, but it helps).
  - Problem matchers (`slnExplorer.problemMatchers`) now see lines with the `N>` prefix, so a matcher's regex
    has to allow an optional `^\d+>`; no matcher is bundled yet (open: SDCC/SDAS patterns).
  - Cancel = Ctrl+C in the terminal, the Cancel Build button, or closing the terminal; the process tree is killed.
- **Problems panel + error explanations** (user request: SDAS "mystery errors with only a huge error code",
  ZOO errors too; "statically or searching the web"). Not a VS Code problem matcher: tool paths are relative to
  each project's own folder, which a matcher (one fixed base folder) cannot resolve, so `src/core/diagnostics.js`
  reads the lines itself while the build runs. Built from real material, not memory:
  - real lines from the user's build logs (`msxromapp.c:70: error 20: ...`, `printf.c:144: warning 196: ...`,
    `?ASxxxx-Error-<cannot open> : "..."`, `?ASlink-Warning-Undefined Global ...`);
  - output of the installed SDCC 4.3.0 tools run on deliberately broken input (SDAS 4.3 prints
    `file.s:5: Error: <a> Branching Range Exceeded.`; the `?ASxxxx-Error-<x> in line N of file` form of the manual
    is the old one and is parsed too);
  - ZOO's own source (`ERROR: <file>:<line>: <msg>`, `ERROR: <file>: <msg>`, `ERROR: <msg>`, `[time] WARNING: ...`);
  - make.py's context lines (`Processing C file x.c...`, `## <command>`, `### Error N executing`) give the file for
    messages that carry none.
  Diagnostics with no source location (linker messages, ZOO errors without a file) go on the project file.
  Terminal output: `file:line` in the build output is a clickable link (resolved per project number).
  - **The "huge error code" is a crash.** `sdasz80` 4.3.0 exits with -1073741784 (0xC0000028, STATUS_BAD_STACK) and
    prints nothing on some inputs; make.py then only says `### Error -1073741784 executing`. Reproduced triggers:
    an operand cut short (`ld a,(`, `call (`), `.org` in a relocatable area, and a lone word on a line (a label
    missing its `:`). The problem is reported on the file being processed, and the quick fix **Find the crashing
    line** bisects the file (assembles growing prefixes with the same command until it crashes) and marks the line.
    Tested against the real assembler (finds the right line in all three cases).
  - **Explain** (lightbulb on a problem): SDAS codes `. a b d i m n o p q r s u z` (text from the ASxxxx manual
    shipped in SDCC's `doc/sdas`, plus practical hints verified against the real assembler, e.g. the #1 cause of
    `<a>` is a missing `#` on an immediate), the linker messages (Undefined Global with a checklist for the MSX
    templates and ZOO, Byte PCR relocation = jr/djnz range, cannot open/create ...), all 293 SDCC 4.3.0 numbered
    messages (`src/core/data/sdcc-messages.json`, generated by `scripts/gen-sdcc-messages.js` from SDCC's
    SDCCerr.h/.c at svn r14184; SDCC renumbers between releases, so regenerate for another version), and crash
    exit-code decoding. The explanation opens as a Markdown preview.
  - **Search the web** (lightbulb): opens the browser on `slnExplorer.searchUrl` with a generic query (tool,
    code, message with the user's identifiers stripped). The extension never fetches anything itself.
  - Linker-hint caveats: statements marked "Hint" in the explanation text are experience, not manual text.
    The manual covers only part of ASlink's messages; the others are described from observed output.
  - Not done: parsing multi-line ZOO messages (only the first line is a problem), a bundled problem matcher,
    other SDAS variants' (sdas8051 ...) specific crash behaviour.
- `slnExplorer.stopOnError` (default true) halts a solution build at the first failure.
- A project that does not build in the active solution configuration is skipped in solution builds, built
  when asked for explicitly.
- Rebuild of a project also rebuilds its dependencies; Clean of a project cleans only that project; solution
  Clean runs dependents first.
- Filters/drag-and-drop/add/remove file apply to C++-style projects (explicit item lists). SDK-style projects
  include files by glob, so their tree is the folder content (read-only).
- New project, solution open: written to `<solutionDir>/<name>/` (template CreateNewFolder) and registered.
  No solution: asks for location + solution name + layout, like VS (`<loc>/<solution>/<project>/`, or both in
  one folder). Name rules follow VS (no illegal file-name chars, no trailing dot/space).
- Placeholder icon (`media/icon.png`) generated by script; replace with real artwork.
- No licence declared in `package.json`: the user's choice.
- Not done: solution-folder management (create/move), NuGet/package nodes, property pages, `.vcxproj.user`
  creation, multi-project templates (`.vstemplate` with several projects), item templates, wizard extensions
  (`<WizardExtension>` is ignored), Find/Replace (see the open topic).

## Verification so far (Windows)

- `npm test`: 20 tests (real MSX solution + the four installed MSX templates; temp copies only).
- `npm run test:vscode`: 9 tests in the installed VS Code: tree, edit a build action, dependency dialog,
  dependency-ordered build through real tasks, failing build, filters with drag-and-drop, configuration switch,
  new project from the installed MSX-DOS Overlay template.
- Packaged: `fudeba-solutionist-0.0.1.vsix`.
- Never run: Linux; the real MSX `make.py` build (tests substitute `echo` commands so no toolchain is needed).

## Icons (user request: VS-style icons, customizable at run time)

- Microsoft's Visual Studio Image Library is licensed with conditions and unclear for a VS Code extension
  (see the licence discussion in the conversation), so nothing from it is bundled.
- **Built-in set**: 17 original SVGs, light and dark, generated by `scripts/gen-icons.js` (media/icons/). Checked
  visually at 16 px and 48 px on both backgrounds.
- **Customization, all effective immediately without reload** (`src/core/icons.js` resolves, `src/icons.js` applies):
  1. `slnExplorer.icons` overrides single icons: a codicon name, a file path, or `{light, dark}`;
  2. `slnExplorer.iconTheme` = `vs` (default) | `codicons` | `folder`;
  3. `slnExplorer.iconFolder`: icons found by name, recursively (case-insensitive, `_16x`/`_color` etc. ignored,
     SVG beats PNG, `light`/`dark` sub-folders give theme variants). Anything not found there falls back to the
     built-in set. Adding/removing a file in that folder is noticed within about half a second (Node's recursive
     `fs.watch`; VS Code's own watcher did not fire for folders outside the workspace);
  4. `slnExplorer.fileIcons` = `fileTheme` (default, the user's file icon theme) | `vs`;
  5. commands: *Choose Icon Theme...*, *Set Icon...* (also on any tree node's context menu), *Reload Icons*.
- **Unverified**: the alias table that maps our icon keys to likely Image Library file names (`Solution_16x.svg`,
  `CPPProjectNode_16x.svg`, ...) is a best guess; no copy of the library was available. After choosing a folder
  the extension reports how many of the 17 icons it found, and any miss is fixed with `slnExplorer.icons`.

## Icon art decisions (later sessions)

- Built-in set is now mostly "glass" style (dark fill, lighter outline): MSX project types are drawn as what they are
  (COM = floppy, ROM = MSX cartridge, BIN = Z80 chip on its side, MDO = puzzle piece), driven by `PROJECT_TYPE` in
  `Config/ApplicationSettings.txt` (DOS is shown as COM); no file/unknown type = the generic Makefile icon.
  Source files: C/H/A(.asm,.s)/I(.inc) on white sheets, `.zml` = upright "ZOO" letters. Solution = the Aleste player ship when the solution has an MSX project, else the plain purple bars (see below).
- Replaced designs are kept in `scripts/icon-backups/` (solid floppy, wrench, purple bars).
- The solution icon is the player ship of the MSX game Aleste (16x16 sprite taken from the user's own ROM analysis in
  `projects/Aleste/_analysis/render`, stored as `scripts/art/aleste-ship.svg`, on a dark tile so its white parts show on light
  themes). It is Compile's artwork; it ships inside the extension at the owner's explicit decision (the extension is his and
  personal). Anyone distributing the extension publicly should replace it (the original pixel-art ship and the purple bars
  are in `scripts/icon-backups/`).
- The solution icon depends on the content: if any project has a recognised `PROJECT_TYPE` (ROM, COM/DOS, BIN, MDO) the
  solution shows the Aleste ship (`solution.msx`), otherwise the plain purple-bars icon (`solution`). Icon keys:
  `solution` and `solution.msx` (both overridable with `slnExplorer.icons`).

## Source control marks (user request: "mark the file as checked in and changed, as VS does, with an icon left of the file")

- Status comes from VS Code's built-in git extension API (`vscode.git`, `getAPI(1)`), so it works for any git repository
  (GitHub, GitLab, local); other version control systems are not covered. `src/scm.js` keeps a cache from the repository
  state (working tree, index, merge and untracked changes) and refreshes the tree when a repository changes.
- Marks as in Visual Studio, at the bottom left of the file icon: padlock = checked in (tracked, unchanged), red check =
  changed (modified, staged, deleted, renamed, conflict), green plus = new (untracked/added). Ignored files and files
  outside any repository get no mark (ignored files are found lazily with `repo.checkIgnore`).
- A tree icon is one 16 px image, so the mark is drawn INTO the icon (`<key>+in|mod|add.svg`, generated for the generic
  sheet and the C/H/A/I/ZOO icons). Consequence: a file under source control uses our own icon (dedicated or generic
  sheet), not the user's file icon theme; `fileIcons: fileTheme` or `sourceControl.icons: false` switches the marks off.
  The git extension's own letter badge/colour decoration of the file is still shown by VS Code (the nodes carry a resourceUri).
- Not done: marks on projects/filters/solution (roll-up), other VCS (SVN, Perforce), a "pending changes" view.

## MSX project settings dialog (user request: Project-Properties-like dialog for the Config files of the templates)

- A gear button (inline, right end of the row; also in the context menu as "MSX Project Settings...") appears on MSX
  projects only (contextValue `project.msx`; a project with no recognised PROJECT_TYPE has no button). VS Code shows
  inline buttons while the row is hovered or selected; there is no always-visible button in a tree.
- The dialog is a webview (`media/properties`, host side `src/propertiesPanel.js`). Left index = one entry per
  configuration file, grouped General / Build configuration / Sources / Linking (TargetConfig_Debug and _Release are
  separate entries, as the files are). Right = the page of that file. Below = an explanation pane (the help of the
  setting under the mouse or focus). OK / Cancel / Apply as in Visual Studio; Apply and OK are disabled while the
  context checks report errors (warnings never block).
- The dialog is specific to the project type (ROM, COM, BIN, MDO): `src/core/msxconfig/schema.js` says which pages and
  which settings apply to each type, with an explanation of every option written from the template comments and from
  Make\make.py (what the build does with the value). MDOSettings.txt exists only for COM and MDO projects.
- What the files hold (from the templates + make.py): ApplicationSettings.txt (project type, crt0 features per type,
  ZOO, SDCCCALL, ROM/BIN settings, CALL statements, devices, BASIC USR table, code/data/heap layout, any other KEY VALUE =
  a macro), MDOSettings.txt (hierarchy, load address, name, hooks, hook implementations, children), TargetConfig_<profile>.txt
  (.BUILD, .APPLICATION macros, .FILESYSTEM), ApplicationSources/LibrarySources/Libraries/IncludeDirectories (entry lists
  where a ';' line is a switched-off entry), Symbols.txt (regexes), BuildEvents.txt (five commands).
- Files are edited by line (`src/core/msxconfig/textfile.js`): only the changed value, a ';' that switches a line on or off,
  or a new line is touched; comments, spacing, CRLF and BOM stay. All 38 real template files round-trip byte for byte (tested).
  Optional settings (";CODE_LOC ...") show as "automatic" until ticked.
- Context checks (`src/core/msxconfig/validate.js`): numbers and names; settings against each other (STACK_HIMEM with
  RETURN_TO_BASIC, ROM_SIZE vs FILESTART, CALL/DEVICE expansion vs their lists, MDO_SUPPORT); one file against another
  (ZOO_SUPPORT vs ZOO_PATH in each TargetConfig, .zml sources vs ZOO_SUPPORT, hook implementations vs the hooks the parent
  declares - read from the parent's MDOSettings.txt); references on disk (sources, libraries, folders, parent project);
  the template rules (crt0 stays first, one of each .c/.s pair); regexes of Symbols.txt; unbalanced quotes in build events.
  Errors are what the build cannot work with (make.py stops or fails); warnings are suspicious. The unmodified templates
  produce no error and no warning (tested with the existence check stubbed).
- **Missing files** (user: "missing files should be created"): every file the template of the project's type defines gets its
  page, even when the project lacks it (Debug and Release always). The page is filled from the template: first the
  user's installed Visual Studio template of that type (so it is the current version), else the copy of the 00.07.00
  templates that ships in `media/msx-config-defaults`. The index marks it "(not created yet)" and the page offers
  "Create the file now". The file is also created when a missing page is edited and Apply/OK is pressed; an untouched missing
  page is never created and is not context-checked. New files are added to the project (`<Text Include="Config\X.txt">`)
  in the filter the other Config files use ("Project Config" in the templates).
- Not done: changing PROJECT_TYPE (read-only), editing the .vcxproj properties.

## About box (user request; "explicitly say it was created with Claude's aid")

- Command `slnExplorer.about` ("About Fudeba Solutionist"; also in the "..." menu of the view). `src/aboutPanel.js`: name, version
  (from package.json), a boxed statement "Created with Claude's aid" (designed and written by Danilo Angelo with the aid of
  Claude, an AI assistant made by Anthropic, via Claude Code), what it does, credits and notices (Aleste sprite belongs to its
  owners, SDCC/ZOO, MSX trademark, "Fudeba" slang), diagnostics for bug reports (Copy diagnostics, Open settings, Report an
  issue = GitHub issues of `repository` with the diagnostics prefilled). The author line "Danilo Angelo" comes from the
  template headers ("by Danilo Angelo"); change it in `src/aboutPanel.js` if wanted.

## Extension id

- The extension id is `damnedangel.fudeba-solutionist` (package.json `name`; it was `sln-explorer`). Only the id changed: the
  commands (`slnExplorer.*`), the settings (`slnExplorer.*`) and the view ids keep their names, so existing settings still apply.
  What the id change resets for an existing install: the extension's per-workspace memory (last solution, selected
  configuration, startup project). Uninstall the old `damnedangel.sln-explorer` when upgrading (two copies would clash).
