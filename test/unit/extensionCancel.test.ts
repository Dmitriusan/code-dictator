import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Escape (codeDictator.cancelRecording) while transcriptions are in flight: it
// cancels all of them, and a cancelled one inserts and keeps nothing. In hold
// mode the release starts a transcription without waiting for anything, so the
// next tap can be released while the previous recording is still being
// transcribed: two pipelines run at once. RecorderManager and the provider are
// faked; each transcription waits until the test answers it.

type VscodeMock = typeof import('./__mocks__/vscode').default;
type Transcribe = (audio: Buffer, options: { signal?: AbortSignal }) => Promise<{ text: string; language?: string }>;

const mocks = vi.hoisted(() => ({
  isRecording: false,
  stopRecording: (() => Promise.reject(new Error('not recording'))) as () => Promise<unknown>,
  transcribe: (() => Promise.reject(new Error('transcribe not stubbed'))) as Transcribe,
}));

vi.mock('vscode', () => import('./__mocks__/vscode').then((m) => m.default));

vi.mock('../../src/recorder/RecorderManager', () => ({
  RecorderManager: class {
    get isRecording() { return mocks.isRecording; }
    startRecording() { mocks.isRecording = true; return Promise.resolve(); }
    stopRecording() { mocks.isRecording = false; return mocks.stopRecording(); }
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
    transcribe: (audio: Buffer, options: { signal?: AbortSignal }) => mocks.transcribe(audio, options),
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

const UNAVAILABLE = 'Custom API service is temporarily unavailable. Please try again later.';

describe('Escape while transcriptions are in flight (hold mode)', () => {
  const originalFetch = globalThis.fetch;
  let storageRoot: string;
  let failedDir: string;
  let vscode: VscodeMock;
  let commands: Map<string, (...args: unknown[]) => Promise<void> | void>;
  let settings: Record<string, unknown>;
  let secrets: Map<string, string>;
  /** Transcriptions the provider was asked for, oldest first; each waits for answer() or fail(). */
  let requests: { signal?: AbortSignal; answer(text: string): void; fail(error: Error): void }[];

  const savedFiles = () => (fs.existsSync(failedDir) ? fs.readdirSync(failedDir) : []);
  const inserted = () => vi.mocked(vscode.env.clipboard.writeText).mock.calls.map((c) => c[0]);
  /** The mic button: StatusBar creates it first. */
  const micText = () => (vi.mocked(vscode.window.createStatusBarItem).mock.results[0].value as { text: string }).text;

  /** The value the extension last set for codeDictator.<key>. */
  function contextValue(key: string): unknown {
    const values = vi.mocked(vscode.commands.executeCommand).mock.calls
      .filter((c) => c[0] === 'setContext' && c[1] === `codeDictator.${key}`)
      .map((c) => c[2]);
    return values[values.length - 1];
  }

  /** Tap Alt+D in hold mode: no key repeat follows, so the recording stops 800 ms later and is transcribed. */
  async function tap(): Promise<void> {
    const before = requests.length;
    await commands.get('codeDictator.toggleRecording')!();
    await vi.advanceTimersByTimeAsync(800);
    await vi.waitFor(() => expect(requests).toHaveLength(before + 1));
  }

  const escape = () => commands.get('codeDictator.cancelRecording')!();

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules(); // fresh extension state; the mocked modules themselves are shared
    vi.clearAllMocks();
    storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-dictator-cancel-test-'));
    failedDir = path.join(storageRoot, 'failed-recordings');
    mocks.isRecording = false;
    mocks.stopRecording = async () => ({ buffer: speechWav(), mimeType: 'audio/wav', durationMs: 1000 });
    requests = [];
    // Like fetch: the request fails with an AbortError once its signal is aborted
    mocks.transcribe = (_audio, options) => new Promise((resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
      requests.push({ signal: options.signal, answer: (text) => resolve({ text, language: 'en' }), fail: reject });
    });

    vscode = (await import('vscode')) as unknown as VscodeMock;
    const { createMockConfiguration, createMockExtensionContext } = await import('./__mocks__/vscode');
    settings = { 'recording.mode': 'hold' };
    vi.mocked(vscode.workspace.getConfiguration).mockImplementation((() => createMockConfiguration(settings)) as never);
    commands = new Map();
    vi.mocked(vscode.commands.registerCommand).mockImplementation(((id: string, handler: () => void) => {
      commands.set(id, handler);
      return { dispose() { /* no-op */ } };
    }) as never);
    // Toasts stay open (never clicked)
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
    vi.useRealTimers();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });

  it('cancels a second transcription that overlaps the first, after the first is done', async () => {
    await tap();
    await tap(); // released while the first recording is still being transcribed
    requests[0].answer('first words');
    await vi.waitFor(() => expect(micText()).toMatch(/^\$\(check\)/));
    expect(contextValue('isProcessing')).toBe(true); // the second still runs, so Escape stays bound

    await escape();

    expect(requests[1].signal?.aborted).toBe(true);
    await vi.waitFor(() => expect(contextValue('isProcessing')).toBe(false));
    expect(inserted()).toEqual([expect.stringMatching(/first words/i)]);
    expect(micText()).toBe('$(x) Cancelled');
    expect(savedFiles()).toEqual([]);
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('cancels both transcriptions when they are both in flight', async () => {
    await tap();
    await tap();

    await escape();

    expect(requests.map((r) => r.signal?.aborted)).toEqual([true, true]);
    await vi.waitFor(() => expect(contextValue('isProcessing')).toBe(false));
    expect(inserted()).toEqual([]);
    expect(savedFiles()).toEqual([]);
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('keeps Escape bound until the last overlapping transcription is done', async () => {
    await tap();
    await tap();

    requests[1].answer('second words'); // the later one can answer first
    await vi.waitFor(() => expect(micText()).toMatch(/^\$\(check\)/));
    expect(contextValue('isProcessing')).toBe(true);
    requests[0].answer('first words');
    await vi.waitFor(() => expect(contextValue('isProcessing')).toBe(false));

    expect(inserted()).toEqual([expect.stringMatching(/second words/i), expect.stringMatching(/first words/i)]);
  });

  it('cancels the transcription still in flight when Escape cancels the next recording', async () => {
    await tap();
    await commands.get('codeDictator.toggleRecording')!(); // the next recording, still held
    await vi.waitFor(() => expect(mocks.isRecording).toBe(true));

    await escape();

    expect(mocks.isRecording).toBe(false);
    expect(requests[0].signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1000); // the cancelled hold is never released into a transcription
    expect(requests).toHaveLength(1);
    await vi.waitFor(() => expect(contextValue('isProcessing')).toBe(false));
    expect(inserted()).toEqual([]);
    expect(savedFiles()).toEqual([]);
  });

  it('inserts nothing when Escape comes during AI cleanup', async () => {
    settings['textProcessing.aiCleanup'] = true;
    secrets.set('codeDictator.openai-cleanup.apiKey', 'sk-test');
    // The cleanup request waits; aborted, it fails like fetch does, and cleanup() falls back to the raw text
    const cleanupRequest = vi.fn((_url: unknown, init: { signal: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    }));
    globalThis.fetch = cleanupRequest as never;
    vi.spyOn(console, 'warn').mockImplementation(() => { /* cleanup() reports the aborted request */ });
    await tap();
    requests[0].answer('raw words');
    await vi.waitFor(() => expect(cleanupRequest).toHaveBeenCalledTimes(1));

    await escape();

    await vi.waitFor(() => expect(contextValue('isProcessing')).toBe(false));
    expect(inserted()).toEqual([]);
    expect(micText()).toBe('$(x) Cancelled');
  });

  it('keeps nothing when a cancelled request fails with an error of its own', async () => {
    // A provider can turn an interrupted read of the answer into an error of its own
    mocks.transcribe = (_audio, options) => new Promise((resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error(UNAVAILABLE)), { once: true });
      requests.push({ signal: options.signal, answer: (text) => resolve({ text }), fail: reject });
    });
    await tap();

    await escape();

    await vi.waitFor(() => expect(contextValue('isProcessing')).toBe(false));
    expect(savedFiles()).toEqual([]);
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(micText()).toBe('$(x) Cancelled');
  });

  it('does not retry a failed recording while a hold-mode transcription runs', async () => {
    await tap();
    requests[0].fail(new Error(UNAVAILABLE));
    await vi.waitFor(() => expect(savedFiles()).toHaveLength(1));
    await vi.waitFor(() => expect(contextValue('isProcessing')).toBe(false));
    await tap(); // in flight, outside the toggle-mode transition lock

    await commands.get('codeDictator.retryTranscription')!();

    expect(requests).toHaveLength(2);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('The failed one stays saved'));
    expect(savedFiles()).toHaveLength(1);
  });
});
