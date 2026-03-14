import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  // Use locally installed VS Code to avoid downloading (~100MB)
  const vscodeExecutablePath = '/usr/share/code/code';

  // Root of the extension under test
  const extensionDevelopmentPath = path.resolve(__dirname, '..');

  // Compiled test suite entry point
  const extensionTestsPath = path.resolve(__dirname, 'suite', 'index');

  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: ['--no-sandbox', '--disable-gpu'],
  });
}

main().catch((err) => {
  console.error('E2E test run failed:', err);
  process.exit(1);
});
