import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { NoRecorderError } from '../../src/recorder/NoRecorderError';

// What users read before they install (Marketplace description, README, walkthrough)
// has to match what the extension does: recording always uses a tool on their system,
// because VS Code never gives an extension's web view the microphone.

const root = path.resolve(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

const manifest = JSON.parse(read('package.json'));
const readme = read('README.md');
const walkthrough = ['provider', 'apikey', 'record', 'customize'].map((name) => read(`resources/walkthrough/${name}.md`)).join('\n');

describe('the text users read before installing', () => {
  it('does not promise that nothing needs installing, or that a hidden WebView records', () => {
    const claims = /zero (local |native )?dependenc|no dependencies|no sox|no ffmpeg|hidden webview|native fallback|just install and go/i;

    expect(manifest.description).not.toMatch(claims);
    expect(readme).not.toMatch(claims);
    expect(walkthrough).not.toMatch(claims);
  });

  it('quotes the install commands that the missing-tool error offers, and no other', () => {
    const commands = [new NoRecorderError('darwin').installCommand!, new NoRecorderError('win32').installCommand!];
    expect(commands).toEqual(['brew install sox', 'winget install Gyan.FFmpeg']);

    for (const command of commands) {
      const installer = command.split(' ').slice(0, 2).join(' ');
      for (const text of [readme, walkthrough]) {
        const quoted = text.match(new RegExp(`${installer} [\\w.-]+`, 'g')) ?? [];
        expect(quoted.length).toBeGreaterThan(0);
        expect(new Set(quoted)).toEqual(new Set([command]));
      }
    }
  });

  it('no longer offers audio isolation, which never had an effect, and marks its setting deprecated', () => {
    const properties = manifest.contributes.configuration.flatMap((section: { properties: object }) => Object.entries(section.properties));
    const isolation = Object.fromEntries(properties)['codeDictator.recording.audioIsolation'];

    expect(isolation.deprecationMessage).toMatch(/no effect/);
    expect(isolation.markdownDeprecationMessage).toMatch(/no effect/);
    expect(isolation.enumDescriptions).toBeUndefined();
    expect(readme).not.toMatch(/audio ?isolation|noise reduction/i);
    expect(walkthrough).not.toMatch(/audio ?isolation|noise reduction/i);
  });
});
