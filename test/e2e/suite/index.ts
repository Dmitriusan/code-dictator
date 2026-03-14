import * as assert from 'assert';
import * as vscode from 'vscode';

/**
 * E2E smoke test suite for Code Dictator.
 * Runs inside the VS Code extension host via @vscode/test-electron.
 *
 * Verifies:
 *   1. Extension activates successfully
 *   2. Core commands are registered: toggleRecording, cancelRecording, transcribeFile
 */
export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension('irrationalways.code-dictator');
  assert.ok(ext, 'Extension irrationalways.code-dictator not found in extension host');

  // Activate explicitly — activationEvents: onStartupFinished may not fire in test host
  if (!ext.isActive) {
    await ext.activate();
  }

  const results: { name: string; pass: boolean; error?: string }[] = [];

  function check(condition: boolean, name: string, detail?: string): void {
    results.push({ name, pass: condition, error: condition ? undefined : detail });
  }

  // 1. Extension activates
  check(ext.isActive, 'Extension activates successfully');

  // 2. Core commands registered
  const allCommands = await vscode.commands.getCommands(true);
  check(
    allCommands.includes('codeDictator.toggleRecording'),
    'codeDictator.toggleRecording registered',
  );
  check(
    allCommands.includes('codeDictator.cancelRecording'),
    'codeDictator.cancelRecording registered',
  );
  check(
    allCommands.includes('codeDictator.transcribeFile'),
    'codeDictator.transcribeFile registered',
  );

  // Print results
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;

  console.log('\nCode Dictator — E2E Smoke Tests');
  console.log('='.repeat(44));
  for (const r of results) {
    const icon = r.pass ? '✓' : '✗';
    console.log(`  ${icon} ${r.name}${r.error ? ` — ${r.error}` : ''}`);
  }
  console.log('='.repeat(44));
  console.log(`  ${passed} passed, ${failed} failed\n`);

  if (failed > 0) {
    throw new Error(`${failed} of ${results.length} E2E test(s) failed`);
  }
}
