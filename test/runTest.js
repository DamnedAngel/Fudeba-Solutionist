'use strict';
// Launches a real VS Code with the extension loaded and runs test/suite inside it.
const path = require('path');
const os = require('os');
const fs = require('fs');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const extensionDevelopmentPath = process.env.SLNX_EXT_PATH || path.resolve(__dirname, '..');
  const extensionTestsPath = path.resolve(__dirname, 'suite', 'index.js');

  // the extension edits solution/project files, so the tests work on a copy of the fixture
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'slnx-ws-'));
  fs.cpSync(path.resolve(__dirname, 'fixtures', 'msx-overlays'), workspace, { recursive: true });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'slnx-ud-'));
  const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slnx-ext-'));

  const win = process.platform === 'win32';
  const installed = process.env.VSCODE_EXE || (win ? 'C:\\Program Files\\Microsoft VS Code\\Code.exe' : undefined);

  try {
    await runTests({
      vscodeExecutablePath: installed && fs.existsSync(installed) ? installed : undefined,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust', '--user-data-dir', userData, '--extensions-dir', extDir, '--skip-welcome', '--skip-release-notes'],
      extensionTestsEnv: { SLNX_TEST_WORKSPACE: workspace, SLNX_TEMPLATE_ROOTS: process.env.SLNX_TEMPLATE_ROOTS || '' },
    });
  } catch (e) {
    console.error('Test run failed:', (e && e.message) || e);
    process.exit(1);
  }
}

main();
