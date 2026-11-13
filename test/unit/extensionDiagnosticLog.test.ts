import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Diagnostic logging (codeDictator.diagnosticLogging) is for recording
// trouble, and its output is what users paste into bug reports: it says how
// long a transcription was, never what was said. VS Code also keeps output
// channels in its log files. RecorderManager and the provider are faked; AI
// cleanup runs against a faked fetch.

type VscodeMock = typeof import('./__mocks__/vscode').default;

const mocks = vi.hoisted(() => ({
  isRecording: false,
  transcript: '',
}));

vi.mock('vscode', () => import('./__mocks__/vscode').then((m) => m.default));

vi.mock('../../src/recorder/RecorderManager', () => ({
  RecorderManager: class {
    setLiveTranscription() { /* no-op */ }
    get isRecording() { return mocks.isRecording; }
    startRecording() { mocks.isRecording = true; return Promise.resolve(); }
    stopRecording() { mocks.isRecording = false; return Promise.resolve({ buffer: speechWav(), mimeType: 'audio/wav', durationMs: 1000 }); }
    cancelRecording() { mocks.isRecording = false; }
    onError() { return { dispose() { /* no-op */ } }; }
    onRecordingStarted() { return { dispose() { /* no-op */ } }; }
    onRecordingStopped() { return { dispose() { /* no-op */ } }; }
    onSilenceDetected() { return { dispose() { /* no-op */ } }; }
    onTrackEnded() { return { dispose() { /* no-op */ } }; }
    dispose() { /* no-op */ }
  },
}));

vi.mock('../../src/providers/ProviderFactory', () => ({
  createProvider: () => ({
    name: 'Fake STT',
    id: 'fake',
    transcribe: async () => ({ text: mocks.transcript, language: 'en' }),
    validateConfig: async () => true,
    estimateCost: () => 0,
  }),
}));

/** One second of a 440 Hz tone as 16-bit mono 16 kHz WAV — passes the silence guard. */
function speechWav(): Buffer {
  const samples = 16000;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + samples * 2, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    wav.writeInt16LE(Math.round(3000 * Math.sin(2 * Math.PI * 440 * i / 16000)), 44 + i * 2);
  }
  return wav;
}

describe('the diagnostic log of a dictation', () => {
  const originalFetch = globalThis.fetch;
  let storageRoot: string;
  let vscode: VscodeMock;
  let commands: Map<string, (...args: unknown[]) => Promise<void> | void>;
  let settings: Record<string, unknown>;
  let secrets: Map<string, string>;

  const inserted = () => vi.mocked(vscode.env.clipboard.writeText).mock.calls.map((c) => c[0]);
  /** Every line written to the "Code Dictator" output channel. */
  const logged = () => vi.mocked(vscode.window.createOutputChannel).mock.results
    .flatMap((r) => (r.value as { appendLine: ReturnType<typeof vi.fn> }).appendLine.mock.calls.map((c) => String(c[0])));

  /** Alt+D twice (toggle mode): record, then stop, transcribe and insert. */
  async function dictate(): Promise<void> {
    await commands.get('codeDictator.toggleRecording')!();
    await commands.get('codeDictator.toggleRecording')!();
  }

  beforeEach(async () => {
    vi.resetModules(); // fresh extension and log state; the mocked modules themselves are shared
    vi.clearAllMocks();
    storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-dictator-diaglog-test-'));
    mocks.isRecording = false;

    vscode = (await import('vscode')) as unknown as VscodeMock;
    const { createMockConfiguration, createMockExtensionContext } = await import('./__mocks__/vscode');
    settings = { 'recording.mode': 'toggle', diagnosticLogging: true };
    vi.mocked(vscode.workspace.getConfiguration).mockImplementation((() => createMockConfiguration(settings)) as never);
    commands = new Map();
    vi.mocked(vscode.commands.registerCommand).mockImplementation(((id: string, handler: () => void) => {
      commands.set(id, handler);
      return { dispose() { /* no-op */ } };
    }) as never);
    vi.mocked(vscode.window.showErrorMessage).mockReturnValue(new Promise(() => { /* never settles */ }) as never);

    const context = { ...createMockExtensionContext(), globalStorageUri: { fsPath: storageRoot } };
    secrets = context._secretStore;
    await context.globalState.update('codeDictator.onboarded', true); // skip the setup wizard
    const extension = await import('../../src/extension');
    extension.activate(context as never);
  });

  afterEach(() => {
    vi.mocked(vscode.workspace.getConfiguration).mockReset(); // back to the default settings
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });

  it('gives the length of the transcript and of the AI cleanup, not their words', async () => {
    settings['textProcessing.aiCleanup'] = true;
    secrets.set('codeDictator.openai-cleanup.apiKey', 'sk-test');
    mocks.transcript = 'um the staging password is purple giraffe';
    const cleaned = 'The staging password is purple giraffe.';
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: cleaned } }] }),
    })) as never;

    await dictate();

    expect(inserted()).toEqual([cleaned]); // the dictation itself is untouched
    const lines = logged();
    expect(lines.filter((line) => /purple|giraffe|password/i.test(line))).toEqual([]);
    expect(lines).toContainEqual(expect.stringContaining(`[STT] Result: ${mocks.transcript.length} chars, language=en`));
    // Cleanup gets the transcript after formatting and filler removal
    expect(lines).toContainEqual(expect.stringMatching(/\[LLMCleanup\] Input: \d+ chars \| model=gpt-6-luna, lang=en$/));
    expect(lines).toContainEqual(expect.stringContaining(`[LLMCleanup] Output: ${cleaned.length} chars`));
  });

  it('does not quote a transcript it drops as made up', async () => {
    mocks.transcript = 'Thank you.';

    await dictate();

    expect(inserted()).toEqual([]);
    const lines = logged();
    expect(lines.filter((line) => /thank you/i.test(line))).toEqual([]);
    expect(lines).toContainEqual(expect.stringContaining(`[STT] Hallucination filtered: ${mocks.transcript.length} chars`));
  });
});
