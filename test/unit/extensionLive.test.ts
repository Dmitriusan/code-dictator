import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The pipeline with a recording that was transcribed while it was recorded:
// the extension uses what the live transcription returns, falls back to one
// request for the whole recording when it returns nothing or fails, and lets
// Escape cancel it. RecorderManager, the provider and LiveTranscription are faked.

type VscodeMock = typeof import('./__mocks__/vscode').default;
type Result = { text: string; language?: string; cost?: number; duration?: number };
type FakeLive = {
  segmentCount: number;
  finish: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
};

const mocks = vi.hoisted(() => ({
  isRecording: false,
  providerId: 'fake',
  live: undefined as FakeLive | undefined,
  factory: undefined as ((file: string) => unknown) | undefined,
  started: [] as Array<{ file: string; options: Record<string, unknown> }>,
  transcribe: vi.fn(async (_audio: Buffer, _options: Record<string, unknown>) => ({ text: 'whole recording' }) as Result),
}));

vi.mock('vscode', () => import('./__mocks__/vscode').then((m) => m.default));

vi.mock('../../src/recorder/RecorderManager', () => ({
  RecorderManager: class {
    setLiveTranscription(factory: (file: string) => unknown) { mocks.factory = factory; }
    get isRecording() { return mocks.isRecording; }
    stopRecording() {
      mocks.isRecording = false;
      return Promise.resolve({ buffer: speechWav(), mimeType: 'audio/wav', durationMs: 90_000, live: mocks.live });
    }
    startRecording() { mocks.isRecording = true; return Promise.resolve(); }
    cancelRecording() { mocks.isRecording = false; }
    onError() { return { dispose() { /* no-op */ } }; }
    onRecordingStarted() { return { dispose() { /* no-op */ } }; }
    onRecordingStopped() { return { dispose() { /* no-op */ } }; }
    onSilenceDetected() { return { dispose() { /* no-op */ } }; }
    onTrackEnded() { return { dispose() { /* no-op */ } }; }
    dispose() { /* no-op */ }
  },
}));

vi.mock('../../src/transcription/LiveTranscription', () => ({
  LiveTranscription: {
    start: (file: string, options: Record<string, unknown>) => {
      mocks.started.push({ file, options });
      return { file };
    },
  },
}));

vi.mock('../../src/providers/ProviderFactory', () => ({
  createProvider: () => ({
    name: 'Fake STT',
    id: mocks.providerId,
    transcribe: (audio: Buffer, options: Record<string, unknown>) => mocks.transcribe(audio, options),
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

function fakeLive(finish: (audio: unknown, signal: AbortSignal) => Promise<Result | undefined>): FakeLive {
  return { segmentCount: 3, finish: vi.fn(finish), cancel: vi.fn(), detach: vi.fn(async () => undefined) };
}

const METER_KEY = 'codeDictator.elevenlabs.creditMeter';

describe('a recording transcribed while it was recorded', () => {
  let storageRoot: string;
  let vscode: VscodeMock;
  let commands: Map<string, (...args: unknown[]) => Promise<void> | void>;
  let settings: Record<string, unknown>;
  let context: ReturnType<typeof import('./__mocks__/vscode').createMockExtensionContext>;

  const pasted = () => vi.mocked(vscode.env.clipboard.writeText).mock.calls.map(([text]) => text);
  const history = () => (context.globalState.get('codeDictator.history', []) as Array<{ text: string; estimatedCost: number }>);

  async function stop(): Promise<void> {
    mocks.isRecording = true;
    await commands.get('codeDictator.toggleRecording')!();
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-dictator-live-ext-test-'));
    mocks.isRecording = false;
    mocks.providerId = 'fake';
    mocks.live = undefined;
    mocks.factory = undefined;
    mocks.started = [];
    mocks.transcribe.mockImplementation(async () => ({ text: 'whole recording' }));
    settings = {};
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));

    vscode = (await import('vscode')) as unknown as VscodeMock;
    const { createMockConfiguration, createMockExtensionContext } = await import('./__mocks__/vscode');
    vi.mocked(vscode.workspace.getConfiguration).mockImplementation((() => createMockConfiguration(settings)) as never);
    commands = new Map();
    vi.mocked(vscode.commands.registerCommand).mockImplementation(((id: string, handler: () => void) => {
      commands.set(id, handler);
      return { dispose() { /* no-op */ } };
    }) as never);
    vi.mocked(vscode.window.showErrorMessage).mockReturnValue(new Promise(() => { /* never settles */ }) as never);
    context = createMockExtensionContext();
    await context.globalState.update('codeDictator.onboarded', true);
    const extension = await import('../../src/extension');
    extension.activate({ ...context, globalStorageUri: { fsPath: storageRoot } } as never);
  });

  afterEach(() => {
    vi.mocked(vscode.workspace.getConfiguration).mockReset();
    vi.unstubAllGlobals();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });

  it('uses the live result instead of sending the whole recording, and records it once', async () => {
    mocks.live = fakeLive(async () => ({ text: 'um, three parts. joined together', language: 'en', cost: 0.03 }));
    await stop();

    expect(mocks.transcribe).not.toHaveBeenCalled();
    expect(pasted()).toEqual(['Three parts. Joined together']);
    expect(history()).toHaveLength(1);
    expect(history()[0]).toMatchObject({ text: 'um, three parts. joined together', estimatedCost: 0.03 });
    expect(mocks.live.cancel).toHaveBeenCalled(); // nothing more may be sent for it
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('counts the recording its parts covered in the usage, at the cost of every part, overlaps included', async () => {
    // 90 s recorded, of which 5 s of silence were let go unsent
    mocks.live = fakeLive(async () => ({ text: 'three parts', cost: 0.03, duration: 85 }));
    await stop();
    expect(pasted()).toEqual(['Three parts']);
    expect(history()[0]).toMatchObject({ duration: 90_000, estimatedCost: 0.03 });
    await vi.waitFor(() => expect(context.globalState.get('codeDictator.usage')).toMatchObject({
      totalTranscriptions: 1, totalDurationMs: 85_000, totalEstimatedCost: 0.03,
    }));
  });

  it('sends the whole recording when the live transcription gives nothing back', async () => {
    mocks.live = fakeLive(async () => undefined);
    await stop();
    expect(mocks.transcribe).toHaveBeenCalledTimes(1);
    expect(mocks.transcribe.mock.calls[0][0].equals(speechWav())).toBe(true);
    expect(pasted()).toEqual(['Whole recording']);
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('reports a rest that failed like any failed transcription, and keeps the whole recording for Retry', async () => {
    mocks.live = fakeLive(async () => { throw new Error('ElevenLabs quota exceeded.'); });
    await stop();
    expect(mocks.transcribe).not.toHaveBeenCalled();
    expect(pasted()).toEqual([]);
    const [message, button] = vi.mocked(vscode.window.showErrorMessage).mock.calls[0] as unknown as [string, string];
    expect(message).toMatch(/^Code Dictator: Transcription failed — ElevenLabs quota exceeded\. Your recording is saved/);
    expect(button).toBe('Retry');
    const kept = fs.readdirSync(path.join(storageRoot, 'failed-recordings'));
    expect(kept).toHaveLength(1);
    expect(fs.readFileSync(path.join(storageRoot, 'failed-recordings', kept[0])).equals(speechWav())).toBe(true);
  });

  it('hands the pipeline signal to the recorder, so Escape reaches the live transcription before it is finished', async () => {
    let stopSignal: AbortSignal | undefined;
    let releaseStop!: () => void;
    const { RecorderManager } = await import('../../src/recorder/RecorderManager');
    const stopRecording = vi.spyOn(RecorderManager.prototype, 'stopRecording').mockImplementationOnce((signal?: AbortSignal) => {
      stopSignal = signal;
      mocks.isRecording = false;
      return new Promise((resolve) => {
        releaseStop = () => resolve({ buffer: speechWav(), mimeType: 'audio/wav', durationMs: 90_000, live: mocks.live } as never);
      });
    });
    mocks.live = fakeLive(async (_audio, signal) => {
      if (signal.aborted) {
        const error = new Error('Transcription cancelled');
        error.name = 'AbortError';
        throw error;
      }
      return { text: 'never' };
    });
    mocks.isRecording = true;
    const stopping = commands.get('codeDictator.toggleRecording')!();
    await vi.waitFor(() => expect(stopSignal).toBeDefined());
    await commands.get('codeDictator.cancelRecording')!(); // the recorder is still stopping
    expect(stopSignal!.aborted).toBe(true);
    releaseStop();
    await stopping;
    stopRecording.mockRestore();
    expect(pasted()).toEqual([]);
    expect(mocks.transcribe).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('Escape while the last part is transcribed cancels the dictation', async () => {
    let seenSignal: AbortSignal | undefined;
    mocks.live = fakeLive((_audio, signal) => new Promise((_resolve, reject) => {
      seenSignal = signal;
      signal.addEventListener('abort', () => {
        const error = new Error('Transcription cancelled');
        error.name = 'AbortError';
        reject(error);
      });
    }));
    mocks.isRecording = true;
    const stopping = commands.get('codeDictator.toggleRecording')!();
    await vi.waitFor(() => expect(seenSignal).toBeDefined());
    await commands.get('codeDictator.cancelRecording')!();
    await stopping;

    expect(seenSignal!.aborted).toBe(true);
    expect(mocks.transcribe).not.toHaveBeenCalled();
    expect(pasted()).toEqual([]);
    expect(history()).toHaveLength(0);
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(mocks.live.cancel).toHaveBeenCalled();
  });

  it('counts billed audio that inserted nothing (no speech) in the usage, but not as a transcription', async () => {
    mocks.live = fakeLive(async () => ({ text: '', duration: 61.5, cost: 0.004 }));
    await stop();
    expect(pasted()).toEqual([]);
    await vi.waitFor(() => expect(context.globalState.get('codeDictator.usage')).toMatchObject({
      totalTranscriptions: 0, totalDurationMs: 61_500, totalEstimatedCost: 0.004,
    }));

    mocks.live = undefined;
    mocks.transcribe.mockImplementationOnce(async () => ({ text: '', cost: 0.001 }));
    await stop();
    await vi.waitFor(() => expect(context.globalState.get('codeDictator.usage')).toMatchObject({
      totalTranscriptions: 0, totalDurationMs: 61_500 + 90_000,
    }));
    expect(history()).toHaveLength(0);
  });

  it('cancels it without using it when the recording is dead air', async () => {
    mocks.live = fakeLive(async () => ({ text: 'never' }));
    vi.spyOn(await import('../../src/recorder/AudioAnalysis'), 'isAudioSilent').mockReturnValueOnce(true);
    await stop();
    expect(mocks.live.finish).not.toHaveBeenCalled();
    expect(mocks.live.cancel).toHaveBeenCalled();
    expect(pasted()).toEqual([]);
  });

  it('with ElevenLabs, does not count the audio a second time for the credit meter', async () => {
    mocks.providerId = 'elevenlabs';
    mocks.live = fakeLive(async () => ({ text: 'counted as it went' }));
    await stop();
    expect(context.globalState.get(METER_KEY)).toBeUndefined();

    mocks.live = fakeLive(async () => undefined); // the whole recording goes too: charged again
    await stop();
    expect((context.globalState.get(METER_KEY) as { audioSeconds: number }).audioSeconds).toBe(90);
  });

  describe('the live transcription it starts for each native recording', () => {
    const on = { 'recording.transcribeWhileSpeaking': true };

    it('is off by default and when the setting is off: the whole recording is sent at the stop', () => {
      expect(mocks.factory!('/tmp/code-dictator-1.wav')).toBeUndefined();
      settings = { 'recording.transcribeWhileSpeaking': false };
      expect(mocks.factory!('/tmp/code-dictator-1.wav')).toBeUndefined();
      expect(mocks.started).toHaveLength(0);
    });

    type Options = {
      holdSpeechSeconds: number;
      transcribe: (wav: Buffer, signal: AbortSignal, prompt: string | undefined) => Promise<Result>;
      prompt?: string;
      invalidated: () => string | undefined;
      onDiscarded: (billed: { requests: number; seconds: number; recordingSeconds: number; cost: number }) => void;
    };

    it('sends its parts as a whole recording would be sent, and holds them only when the language is auto-detected', async () => {
      settings = { ...on };
      expect(mocks.factory!('/tmp/code-dictator-1.wav')).toEqual({ file: '/tmp/code-dictator-1.wav' });
      const options = mocks.started[0].options as Options;
      expect(options.holdSpeechSeconds).toBe(6);
      const signal = new AbortController().signal;
      const wav = speechWav();
      await options.transcribe(wav, signal, 'the prompt');
      expect(mocks.transcribe).toHaveBeenCalledWith(wav, expect.objectContaining({ language: undefined, mimeType: 'audio/wav', signal, prompt: 'the prompt' }));

      settings = { ...on, language: 'uk' };
      mocks.factory!('/tmp/code-dictator-2.wav');
      const second = mocks.started[1].options as Options;
      expect(second.holdSpeechSeconds).toBe(0);
      await second.transcribe(wav, signal, undefined);
      expect(mocks.transcribe.mock.calls[1][1]).toMatchObject({ language: 'uk' });
    });

    it('sends every part with the vocabulary hint a whole recording gets, and ElevenLabs none', () => {
      settings = { ...on };
      mocks.factory!('/tmp/code-dictator-1.wav');
      expect((mocks.started[0].options as Options).prompt)
        .toBe('Software development discussion. Technical terms, API names, function names, and code-related vocabulary.');
      mocks.providerId = 'elevenlabs';
      mocks.factory!('/tmp/code-dictator-2.wav');
      expect((mocks.started[1].options as Options).prompt).toBeUndefined(); // so no part is dropped as the prompt read back
    });

    it('stops when the language, the provider or an API key changes during the recording', async () => {
      settings = { ...on, language: 'en' };
      mocks.factory!('/tmp/code-dictator-1.wav');
      const { invalidated } = mocks.started[0].options as Options;
      expect(invalidated()).toBeUndefined();
      settings = { ...on, language: 'uk' };
      expect(invalidated()).toMatch(/settings or API key changed/);

      settings = { ...on, language: 'en', provider: 'openai' };
      mocks.factory!('/tmp/code-dictator-2.wav');
      const second = mocks.started[1].options as Options;
      expect(second.invalidated()).toBeUndefined();
      const onSecretChange = vi.mocked(context.secrets.onDidChange).mock.calls[0][0] as unknown as (e: { key: string }) => void;
      onSecretChange({ key: 'codeDictator.openai-cleanup.apiKey' }); // the AI cleanup's key: not what the parts were sent with
      onSecretChange({ key: 'codeDictator.elevenlabs.apiKey' });
      expect(second.invalidated()).toBeUndefined();
      onSecretChange({ key: 'codeDictator.openai.apiKey' });
      expect(second.invalidated()).toMatch(/settings or API key changed/);
    });

    it('counts the recording and cost of parts that were billed but never used, but not as a transcription', async () => {
      settings = { ...on };
      mocks.factory!('/tmp/code-dictator-1.wav');
      const { onDiscarded } = mocks.started[0].options as Options;
      onDiscarded({ requests: 2, seconds: 45, recordingSeconds: 40, cost: 0.0025 });
      await vi.waitFor(() => expect(context.globalState.get('codeDictator.usage')).toBeDefined());
      expect(context.globalState.get('codeDictator.usage')).toMatchObject({ totalTranscriptions: 0, totalDurationMs: 40_000, totalEstimatedCost: 0.0025 });
      expect(history()).toHaveLength(0);
    });

    it('with ElevenLabs, counts every part transcribed for the credit meter', async () => {
      mocks.providerId = 'elevenlabs';
      settings = { ...on };
      mocks.factory!('/tmp/code-dictator-1.wav');
      const { onTranscribed } = mocks.started[0].options as { onTranscribed: (seconds: number, result: Result) => void };
      onTranscribed(21.5, { text: 'a' });
      onTranscribed(8.5, { text: 'b' });
      await vi.waitFor(() => expect((context.globalState.get(METER_KEY) as { audioSeconds: number } | undefined)?.audioSeconds).toBe(30));
    });
  });
});
