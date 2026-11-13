import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// A speech-to-text request that never answers (a stalled connection, a custom
// server that takes the upload and says nothing) fails after a deadline that
// grows with the audio, and the recording is kept for Retry, as when the
// provider answers with an error. Escape still cancels at any time and keeps
// nothing. A file transcription can be cancelled with Escape too.
// RecorderManager and the provider are faked; each transcription waits until
// the test answers it or its signal is aborted.

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
    setLiveTranscription() { /* no-op */ }
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

/** The deadline for one second of audio: 60 s, and 3 s per second of audio. */
const ONE_SECOND_DEADLINE_MS = 63_000;

describe('a speech-to-text request', () => {
  let storageRoot: string;
  let failedDir: string;
  let vscode: VscodeMock;
  let commands: Map<string, (...args: unknown[]) => Promise<void> | void>;
  /** Transcriptions the provider was asked for, oldest first; each waits for answer() or its signal. */
  let requests: { audio: Buffer; signal?: AbortSignal; answer(text: string): void }[];

  const savedFiles = () => (fs.existsSync(failedDir) ? fs.readdirSync(failedDir) : []);
  const inserted = () => vi.mocked(vscode.env.clipboard.writeText).mock.calls.map((c) => c[0]);
  /** The mic button: StatusBar creates it first. */
  const micText = () => (vi.mocked(vscode.window.createStatusBarItem).mock.results[0].value as { text: string }).text;
  const errors = () => vi.mocked(vscode.window.showErrorMessage).mock.calls.map((c) => c[0]);

  /** The value the extension last set for codeDictator.<key>. */
  function contextValue(key: string): unknown {
    const values = vi.mocked(vscode.commands.executeCommand).mock.calls
      .filter((c) => c[0] === 'setContext' && c[1] === `codeDictator.${key}`)
      .map((c) => c[2]);
    return values[values.length - 1];
  }

  /**
   * Until the request is out, without moving the fake clock (vi.waitFor would,
   * and the deadline counts from the request): nothing before it waits on a timer.
   */
  async function requestSent(): Promise<void> {
    for (let i = 0; i < 100 && requests.length === 0; i++) {
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(requests).toHaveLength(1);
  }

  /** Alt+D twice (toggle mode): record, then stop and send. Resolves once the request is out, not when it ends. */
  async function dictate(): Promise<void> {
    await commands.get('codeDictator.toggleRecording')!();
    void commands.get('codeDictator.toggleRecording')!(); // ends when the transcription does
    await requestSent();
  }

  /** "Code Dictator: Transcribe Audio File" on a one-second WAV. */
  async function transcribeFile(): Promise<void> {
    const file = path.join(storageRoot, 'speech.wav');
    fs.writeFileSync(file, speechWav());
    vi.mocked(vscode.window.showOpenDialog).mockResolvedValue([{ fsPath: file }] as never);
    await commands.get('codeDictator.transcribeFile')!();
    await requestSent();
  }

  const escape = () => commands.get('codeDictator.cancelRecording')!();

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules(); // fresh extension state; the mocked modules themselves are shared
    vi.clearAllMocks();
    storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-dictator-deadline-test-'));
    failedDir = path.join(storageRoot, 'failed-recordings');
    mocks.isRecording = false;
    mocks.stopRecording = async () => ({ buffer: speechWav(), mimeType: 'audio/wav', durationMs: 1000 });
    requests = [];
    // Like fetch: the request fails with an AbortError once its signal is aborted
    mocks.transcribe = (audio, options) => new Promise((resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
      requests.push({ audio, signal: options.signal, answer: (text) => resolve({ text, language: 'en' }) });
    });

    vscode = (await import('vscode')) as unknown as VscodeMock;
    const { createMockConfiguration, createMockExtensionContext } = await import('./__mocks__/vscode');
    const settings = { 'recording.mode': 'toggle' };
    vi.mocked(vscode.workspace.getConfiguration).mockImplementation((() => createMockConfiguration(settings)) as never);
    commands = new Map();
    vi.mocked(vscode.commands.registerCommand).mockImplementation(((id: string, handler: () => void) => {
      commands.set(id, handler);
      return { dispose() { /* no-op */ } };
    }) as never);
    // Toasts stay open (never clicked)
    vi.mocked(vscode.window.showErrorMessage).mockReturnValue(new Promise(() => { /* never settles */ }) as never);

    const context = { ...createMockExtensionContext(), globalStorageUri: { fsPath: storageRoot } };
    await context.globalState.update('codeDictator.onboarded', true); // skip the setup wizard
    const extension = await import('../../src/extension');
    extension.activate(context as never);
  });

  afterEach(() => {
    vi.mocked(vscode.workspace.getConfiguration).mockReset(); // back to the default settings
    vi.mocked(vscode.window.showOpenDialog).mockReset();
    vi.restoreAllMocks();
    vi.useRealTimers();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });

  it('fails once the deadline for its audio has passed, and keeps the recording for Retry', async () => {
    await dictate();

    await vi.advanceTimersByTimeAsync(ONE_SECOND_DEADLINE_MS - 1);
    expect(requests[0].signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(requests[0].signal?.aborted).toBe(true);
    await vi.waitFor(() => expect(savedFiles()).toHaveLength(1));
    expect(errors()).toEqual([
      'Code Dictator: Transcription failed — Fake STT did not answer within 63 s. Your recording is saved: press Retry, or run "Code Dictator: Retry Failed Transcription" later.',
    ]);
    expect(vi.mocked(vscode.window.showErrorMessage).mock.calls[0][1]).toBe('Retry');
    await vi.waitFor(() => expect(contextValue('isProcessing')).toBe(false));
    expect(inserted()).toEqual([]);
  });

  it('is inserted as usual when it answers before the deadline', async () => {
    await dictate();
    await vi.advanceTimersByTimeAsync(ONE_SECOND_DEADLINE_MS - 1);

    requests[0].answer('slow words');

    await vi.waitFor(() => expect(inserted()).toEqual([expect.stringMatching(/slow words/i)]));
    await vi.advanceTimersByTimeAsync(ONE_SECOND_DEADLINE_MS); // a deadline left running would now fire
    expect(errors()).toEqual([]);
    expect(savedFiles()).toEqual([]);
  });

  it('is still cancelled by Escape before the deadline, keeping nothing', async () => {
    await dictate();
    await vi.advanceTimersByTimeAsync(10_000);

    await escape();

    expect(requests[0].signal?.aborted).toBe(true);
    await vi.waitFor(() => expect(contextValue('isProcessing')).toBe(false));
    expect(micText()).toBe('$(x) Cancelled');
    expect(savedFiles()).toEqual([]);
    expect(errors()).toEqual([]);
  });

  it('of a file transcription can be cancelled with Escape', async () => {
    await transcribeFile();
    expect(contextValue('isProcessing')).toBe(true); // Escape is bound

    await escape();

    expect(requests[0].signal?.aborted).toBe(true);
    await vi.waitFor(() => expect(contextValue('isProcessing')).toBe(false));
    expect(micText()).toBe('$(x) Cancelled');
    expect(inserted()).toEqual([]);
    expect(errors()).toEqual([]);
  });

  it('of a file transcription fails once the deadline for its size has passed', async () => {
    await transcribeFile();

    await vi.advanceTimersByTimeAsync(ONE_SECOND_DEADLINE_MS + 100); // the header makes the file a little over a second

    expect(requests[0].signal?.aborted).toBe(true);
    await vi.waitFor(() => expect(errors()).toEqual(['Code Dictator: File transcription failed — Fake STT did not answer within 63 s']));
    await vi.waitFor(() => expect(contextValue('isProcessing')).toBe(false));
    expect(inserted()).toEqual([]);
  });

  it('of a file transcription carries the bytes read from the file, not a copy of them', async () => {
    // A long recording imported from a file is held in memory once, and once more in the request's body
    const read = vi.spyOn(fs.promises, 'readFile');

    await transcribeFile();

    expect(read).toHaveBeenCalledTimes(1);
    expect(requests[0].audio).toBe(await read.mock.results[0].value);
  });

  it('of a file transcription that answers is inserted as before', async () => {
    await transcribeFile();

    requests[0].answer('words from a file');

    await vi.waitFor(() => expect(inserted()).toEqual([expect.stringMatching(/words from a file/i)]));
    await vi.waitFor(() => expect(contextValue('isProcessing')).toBe(false));
    expect(errors()).toEqual([]);
  });
});
