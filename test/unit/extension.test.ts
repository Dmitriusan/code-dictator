import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
    stopRecording() { mocks.isRecording = false; return mocks.stopRecording(); }
    startRecording() { return Promise.resolve(); }
    cancelRecording() { /* no-op */ }
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
function speechWav(amplitude = 3000): Buffer {
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
    wav.writeInt16LE(Math.round(amplitude * Math.sin(2 * Math.PI * 440 * i / 16000)), 44 + i * 2);
  }
  return wav;
}

const RATE_LIMITED = 'ElevenLabs rate limit reached. Please wait a moment and try again.';

describe('failed transcriptions are kept for retry', () => {
  let storageRoot: string;
  let failedDir: string;
  let vscode: VscodeMock;
  let commands: Map<string, (...args: unknown[]) => Promise<void> | void>;

  /** Stop a recording holding `audio` through the Alt+D toggle, as the user does. */
  async function stopRecordingWith(audio: Buffer): Promise<void> {
    mocks.isRecording = true;
    mocks.stopRecording = async () => ({ buffer: audio, mimeType: 'audio/wav', durationMs: 1000 });
    await commands.get('codeDictator.toggleRecording')!();
  }

  const savedFiles = () => (fs.existsSync(failedDir) ? fs.readdirSync(failedDir) : []);

  beforeEach(async () => {
    vi.resetModules(); // fresh extension state; the mocked modules themselves are shared
    vi.clearAllMocks();
    storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-dictator-ext-test-'));
    failedDir = path.join(storageRoot, 'failed-recordings');
    mocks.isRecording = false;

    vscode = (await import('vscode')) as unknown as VscodeMock;
    const { createMockExtensionContext } = await import('./__mocks__/vscode');
    commands = new Map();
    vi.mocked(vscode.commands.registerCommand).mockImplementation(((id: string, handler: () => void) => {
      commands.set(id, handler);
      return { dispose() { /* no-op */ } };
    }) as never);
    // Toasts stay open (never clicked) unless a test says otherwise
    vi.mocked(vscode.window.showErrorMessage).mockReturnValue(new Promise(() => { /* never settles */ }) as never);

    const context = { ...createMockExtensionContext(), globalStorageUri: { fsPath: storageRoot } };
    await context.globalState.update('codeDictator.onboarded', true); // skip the setup wizard
    const extension = await import('../../src/extension');
    extension.activate(context as never);
  });

  afterEach(() => {
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });

  it('saves the recording when transcription fails and offers Retry', async () => {
    const audio = speechWav();
    mocks.transcribe = () => Promise.reject(new Error(RATE_LIMITED));

    await stopRecordingWith(audio);

    const files = savedFiles();
    expect(files).toHaveLength(1);
    expect(fs.readFileSync(path.join(failedDir, files[0])).equals(audio)).toBe(true);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
    const [message, action] = vi.mocked(vscode.window.showErrorMessage).mock.calls[0] as unknown as [string, string];
    expect(message).toContain(RATE_LIMITED);
    expect(message).toContain('Your recording is saved');
    expect(action).toBe('Retry');
  });

  it('Retry sends the same audio again, inserts the text and deletes the saved file', async () => {
    const audio = speechWav();
    let clickRetry!: (choice: string) => void;
    vi.mocked(vscode.window.showErrorMessage).mockReturnValueOnce(new Promise((resolve) => { clickRetry = resolve; }) as never);
    mocks.transcribe = () => Promise.reject(new Error(RATE_LIMITED));
    await stopRecordingWith(audio);
    expect(savedFiles()).toHaveLength(1);

    const retried = vi.fn(async (_audio: Buffer) => ({ text: 'hello world', language: 'en' }));
    mocks.transcribe = retried;
    clickRetry('Retry');

    await vi.waitFor(() => expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(expect.stringMatching(/hello world/i)));
    expect(retried.mock.calls[0][0].equals(audio)).toBe(true);
    await vi.waitFor(() => expect(savedFiles()).toEqual([]));
  });

  it('keeps the recording through a failed retry, and the command retries it later', async () => {
    const audio = speechWav();
    mocks.transcribe = () => Promise.reject(new Error(RATE_LIMITED));
    await stopRecordingWith(audio);

    // Still rate-limited: the error comes back with Retry, and nothing is duplicated
    await commands.get('codeDictator.retryTranscription')!();
    expect(savedFiles()).toHaveLength(1);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(vscode.window.showErrorMessage).mock.calls[1][1]).toBe('Retry');

    mocks.transcribe = async () => ({ text: 'second try works', language: 'en' });
    await commands.get('codeDictator.retryTranscription')!();
    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(expect.stringMatching(/second try works/i));
    expect(savedFiles()).toEqual([]);
  });

  it('lets the user pick which recording to retry when several failed', async () => {
    const older = speechWav(2000);
    const newer = speechWav(4000);
    mocks.transcribe = () => Promise.reject(new Error(RATE_LIMITED));
    await stopRecordingWith(older);
    await stopRecordingWith(newer);
    expect(savedFiles()).toHaveLength(2);

    vi.mocked(vscode.window.showQuickPick).mockImplementationOnce((async (items: Array<{ recording: unknown }>) => items[1]) as never);
    const retried = vi.fn(async (_audio: Buffer) => ({ text: 'the older one', language: 'en' }));
    mocks.transcribe = retried;
    await commands.get('codeDictator.retryTranscription')!();

    expect(retried).toHaveBeenCalledTimes(1);
    expect(retried.mock.calls[0][0].equals(older)).toBe(true);
    expect(savedFiles()).toHaveLength(1);
  });

  it('does not retry while another recording is in progress', async () => {
    mocks.transcribe = () => Promise.reject(new Error(RATE_LIMITED));
    await stopRecordingWith(speechWav());
    const retried = vi.fn(async () => ({ text: 'too early' }));
    mocks.transcribe = retried;

    mocks.isRecording = true;
    await commands.get('codeDictator.retryTranscription')!();

    expect(retried).not.toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('The failed one stays saved'));
    expect(savedFiles()).toHaveLength(1);
  });

  it('does not keep a recording the user cancelled with Escape', async () => {
    mocks.transcribe = () => Promise.reject(new DOMException('This operation was aborted', 'AbortError'));

    await stopRecordingWith(speechWav());

    expect(savedFiles()).toEqual([]);
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('says so when there is nothing to retry', async () => {
    await commands.get('codeDictator.retryTranscription')!();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Code Dictator: No failed recordings to retry.');
  });
});
