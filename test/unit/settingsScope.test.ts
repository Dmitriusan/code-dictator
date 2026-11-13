import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// A repository's .vscode/settings.json is read as workspace settings. A setting
// that decides where recordings go, with which saved API key, must not be read
// from there: a repository you open could send your next dictation, and the key
// saved for your own endpoint, to a server of its choosing. The provider may
// still come from a workspace: it only picks among the user's own endpoints.

const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
const properties: Record<string, { scope?: string }> = Object.fromEntries(
  manifest.contributes.configuration.flatMap((section: { properties: object }) => Object.entries(section.properties)),
);

describe('settings a workspace cannot set', () => {
  it('reads the custom endpoint from user settings only', () => {
    // "application": the user settings of the default profile, never workspace, folder or remote settings
    expect(properties['codeDictator.customApiUrl'].scope).toBe('application');
  });
});
