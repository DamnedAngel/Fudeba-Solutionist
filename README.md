# Fudeba Solutionist

A Visual Studio-style Solution Explorer for VS Code. It is meant to support **generic Microsoft Visual Studio solutions**
(`.sln` / `.slnx`), but it has **specialized MSX features**, and it works in pair with the author's own
[MSX templates for Visual Studio](https://github.com/DamnedAngel/MSX-Templates-for-VisualStudio) and [ZOO framework](https://github.com/DamnedAngel/Zoo).
Windows and Linux.

> **Note:** the ZOO repository is currently private; it will eventually be made public.

- **Generic**: any `.sln` / `.slnx` solution: projects, filters, per-project build actions, dependencies, new projects
  from Visual Studio project templates, source control marks.
- **MSX**: project icons by type (ROM, COM, BIN, MDO), an MSX settings dialog for the Config files of the templates, build
  output and error explanations for SDCC, SDAS and ZOO.


- **Projects** under the solution (solution folders too), each with its own **filters** (`.vcxproj.filters`
  virtual folders) or its folder structure; files open on click; drag a file onto a filter to move it.
- **Per-project build actions**: a *Build Actions* node under each project lists Build / Rebuild / Clean and
  the command each runs for the active configuration. For Makefile projects (the MSX templates) these are the
  project's own `NMakeBuildCommandLine`, `NMakeCleanCommandLine` and `NMakeReBuildCommandLine`; click one to
  edit it (only that line of the project file changes). C# projects use `dotnet`; C++ projects use MSBuild
  (Windows only).
- **Project dependencies**: read from the solution and from `ProjectReference`; edited with a multi-select
  picker (writes the solution like VS's *Project Dependencies* dialog, or a `ProjectReference`, see
  `fudebaSolutionist.dependencyStorage`). They drive the build order; cycles are refused.
- **Problems and explanations**: errors and warnings from SDCC, SDAS, the linker and ZOO appear in the Problems panel (paths resolved per project), `file:line` in the build output is clickable, and a lightbulb offers *Explain* (SDAS codes, linker messages, every numbered SDCC message), *Search the web*, and for a silently crashing `sdasz80` *Find the line that crashes*.
- **Icons**: Visual Studio style icons (light/dark). Switch to VS Code icons or to icons from a folder you provide (for example your own copy of the Visual Studio Image Library), or override single icons, with `fudebaSolutionist.iconTheme`, `iconFolder` and `icons`, or the *Choose Icon Theme* and *Set Icon* commands. Changes apply immediately.
- **Build**: project (with its dependencies, or without), solution, rebuild, clean, cancel; configuration picker in
  the status bar. Each step runs as a VS Code task.
- **New projects from Visual Studio project templates**: finds the templates installed for Visual Studio
  (`Documents\Visual Studio *\Templates\ProjectTemplates`), plus folders from `fudebaSolutionist.templateFolders` and
  templates imported with *Import Project Template*. Creates the project with VS's template parameters
  (`$projectname$`, `$guid1$`, ...), adds it to the open solution (or creates a new one) with the right
  configuration mapping. Built for the MSX templates.

## Linux

Solutions and projects written on Windows (backslash paths, case-insensitive names) work on Linux: paths are
resolved case-insensitively, and NMake command lines are run with `sh` after converting `Make\make.py` to
`Make/make.py` (and `python` to `python3` where only that exists). Visual Studio's template folders do not exist
there: use *Import Project Template* or `fudebaSolutionist.templateFolders`.

## Develop

```
npm install
npm test               # parsers, editing, build planning, templates (node:test)
npm run test:vscode    # drives the real commands inside a real VS Code
npm run package
```

