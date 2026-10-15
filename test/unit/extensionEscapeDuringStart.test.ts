import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Escape while the native recorder starts, through the extension's commands:
// the real RecorderManager, hold-mode controller and status bar. Only
// NativeRecorder (its start() is held until the test finishes it) and the
// speech-to-text provider are faked.
type VscodeMock = typeof import('./__mocks__/vscode').default;
type StatusItem = ReturnType<typeof import('./__mocks__/vscode').createMockStatusBarItem>;
type FakeRecorder = {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
};

const fakes = vi.hoisted(() => ({
  holdStart: true,
  /** Finish a held start(), oldest first. */
  pendingStarts: [] as Array<() => void>,
  recorders: [] as FakeRecorder[],
  /** What a stopped recording contains. */
  audio: Buffer.alloc(0) as Buffer,
  transcribe: vi.fn(),
}));

vi.mock('vscode', () => import('./__mocks__/vscode').then((m) => m.default));

vi.mock('../../src/recorder/NativeRecorder', () => ({
  NativeRecorder: class {
    static isAvailable = vi.fn(() => true);
    isRecording = false;
    start = vi.fn(() => {
      if (!fakes.holdStart) {
        this.isRecording = true;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => fakes.pendingStarts.push(() => {
        this.isRecording = true;
        resolve();
      }));
    });
    stop = vi.fn(async () => {
      this.isRecording = false;
      return { buffer: fakes.audio, mimeType: 'audio/wav', durationMs: 1000 };
    });
    cancel = vi.fn(() => { this.isRecording = false; });
    hasReceivedAudio = vi.fn(() => true);
    setUnexpectedExitHandler = vi.fn();
    setSilenceHandler = vi.fn();
    setNoAudioDataHandler = vi.fn();
    constructor() {
      fakes.recorders.push(this as unknown as FakeRecorder);
    }
  },
}));

vi.mock('../../src/providers/ProviderFactory', () => ({
  createProvider: () => ({
    name: 'Fake STT',
    id: 'fake',
    transcribe: (audio: Buffer, options: unknown) => fakes.transcribe(audio, options),
    validateConfig: async () => true,
    estimateCost: () => 0,
  }),
}));

const MIC_IDLE = '$(mic) Dictator';
const MIC_STARTING = '$(loading~spin) Starting...';
const MIC_RECORDING = '$(mic-filled) 0:00';
const MIC_CANCELLED = '$(x) Cancelled';

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

/** Let pending promise callbacks run, without advancing the fake clock. */
const flush = async () => {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
};

describe('Escape while the recorder is still starting', () => {
  let storageRoot: string;
  let vscode: VscodeMock;
  let settings: Record<string, unknown>;
  let commands: Map<string, (...args: unknown[]) => Promise<void> | void>;
  let subscriptions: { dispose(): void }[];

  /** Alt+D. In hold mode the command returns at once; the release comes 800 ms later. */
  const altD = () => commands.get('codeDictator.toggleRecording')!();
  const escape = () => commands.get('codeDictator.cancelRecording')!();

  function mic(): StatusItem {
    return vi.mocked(vscode.window.createStatusBarItem).mock.results
      .map((r) => r.value as StatusItem)
      .find((item) => item.name === 'Code Dictator: Mic')!;
  }

  /** The value the extension gave codeDictator.<key> last. */
  function context(key: string): unknown {
    return vi.mocked(vscode.commands.executeCommand).mock.calls
      .filter((call) => call[0] === 'setContext' && call[1] === `codeDictator.${key}`)
      .at(-1)?.[2];
  }

  beforeEach(async () => {
    vi.resetModules(); // fresh extension state; the mocked modules themselves are shared
    vi.clearAllMocks();
    storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-dictator-ext-test-'));
    fakes.holdStart = true;
    fakes.pendingStarts.length = 0;
    fakes.recorders.length = 0;
    fakes.audio = speechWav();
    fakes.transcribe.mockResolvedValue({ text: 'after escape', language: 'en' });
    settings = {};

    vscode = (await import('vscode')) as unknown as VscodeMock;
    const { createMockConfiguration, createMockExtensionContext } = await import('./__mocks__/vscode');
    vi.mocked(vscode.workspace.getConfiguration).mockImplementation((() => createMockConfiguration(settings)) as never);
    commands = new Map();
    vi.mocked(vscode.commands.registerCommand).mockImplementation(((id: string, handler: () => void) => {
      commands.set(id, handler);
      return { dispose() { /* no-op */ } };
    }) as never);

    const context = { ...createMockExtensionContext(), globalStorageUri: { fsPath: storageRoot } };
    await context.globalState.update('codeDictator.onboarded', true); // skip the setup wizard
    const extension = await import('../../src/extension');
    extension.activate(context as never);
    subscriptions = context.subscriptions;
    vi.useFakeTimers();
  });

  afterEach(() => {
    // The recorder, status bar and timers of this activation (the mocked
    // onDidChangeConfiguration returns no disposable)
    for (const subscription of subscriptions) {
      subscription?.dispose();
    }
    vi.useRealTimers();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });

  it('toggle mode: the recorder is cancelled once it has started, nothing records, and the next Alt+D does', async () => {
    const pressed = altD();
    await flush();
    expect(fakes.pendingStarts).toHaveLength(1);
    expect(mic().text).toBe(MIC_STARTING);

    escape();
    fakes.pendingStarts[0]();
    await pressed;

    const [first] = fakes.recorders;
    expect(first.cancel).toHaveBeenCalledTimes(1);
    expect(first.stop).not.toHaveBeenCalled();
    expect(mic().text).toBe(MIC_CANCELLED);
    expect(context('isRecording')).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(mic().text).toBe(MIC_IDLE); // a recording would show its timer here
    expect(fakes.transcribe).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();

    fakes.holdStart = false;
    await altD();
    expect(fakes.recorders).toHaveLength(2);
    expect(mic().text).toBe(MIC_RECORDING);
    await altD();
    expect(fakes.transcribe).toHaveBeenCalledTimes(1);
    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('After escape');
  });

  it('hold mode: the recorder is cancelled once it has started, nothing records, and the next press does', async () => {
    settings['recording.mode'] = 'hold';
    altD();
    await flush();
    expect(fakes.pendingStarts).toHaveLength(1);

    escape();
    fakes.pendingStarts[0]();
    await vi.advanceTimersByTimeAsync(2000); // past the 800 ms release and the "Cancelled" message

    const [first] = fakes.recorders;
    expect(first.cancel).toHaveBeenCalledTimes(1);
    expect(first.stop).not.toHaveBeenCalled();
    expect(mic().text).toBe(MIC_IDLE);
    expect(context('isRecording')).toBe(false);
    expect(fakes.transcribe).not.toHaveBeenCalled();

    fakes.holdStart = false;
    altD(); // a tap: released after 800 ms
    await flush();
    expect(mic().text).toBe(MIC_RECORDING);
    await vi.advanceTimersByTimeAsync(800);
    await vi.waitFor(() => expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('After escape'));
    expect(fakes.recorders[1].stop).toHaveBeenCalledTimes(1);
  });

  it('hold mode: a press that comes before the cancelled start completes records with its recorder', async () => {
    settings['recording.mode'] = 'hold';
    altD();
    await flush();
    escape();
    altD(); // pressed again within the ~150 ms start
    await flush();
    fakes.pendingStarts[0]();
    await flush();

    expect(fakes.recorders).toHaveLength(1);
    expect(mic().text).toBe(MIC_RECORDING);
    await vi.advanceTimersByTimeAsync(800);
    await vi.waitFor(() => expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('After escape'));
    expect(fakes.recorders[0].cancel).not.toHaveBeenCalled();
    expect(fakes.recorders[0].stop).toHaveBeenCalledTimes(1);
  });
});
