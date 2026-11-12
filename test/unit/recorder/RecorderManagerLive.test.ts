import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Who owns the live transcription of a native recording: RecorderManager
// starts one when the recording has started, hands it over with the audio on
// stop (after it has stopped reading the file), and cancels it whenever the
// recording ends without being transcribed. NativeRecorder is faked.
type FakeRecorder = {
  isRecording: boolean;
  outputFile: string | null;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  exit: () => void;
  noAudio: () => void;
};

const native = vi.hoisted(() => ({
  holdStart: false,
  pendingStarts: [] as Array<() => void>,
  stopError: undefined as Error | undefined,
  audioArrived: true,
  order: [] as string[],
  instances: [] as FakeRecorder[],
}));

vi.mock('vscode', () => import('../__mocks__/vscode').then(m => m.default));

vi.mock('../../../src/recorder/NativeRecorder', () => ({
  NativeRecorder: class {
    static isAvailable = vi.fn(() => true);
    isRecording = false;
    private exitHandler: (() => void) | undefined;
    private noAudioHandler: ((d: unknown) => void) | undefined;
    readonly file = `/tmp/code-dictator-${native.instances.length + 1}.wav`;
    get outputFile() { return this.isRecording ? this.file : null; }
    start = vi.fn(() => {
      const started = () => { this.isRecording = true; };
      if (!native.holdStart) {
        started();
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => native.pendingStarts.push(() => { started(); resolve(); }));
    });
    stop = vi.fn(async () => {
      native.order.push('recorder.stop');
      this.isRecording = false;
      if (native.stopError) {
        throw native.stopError;
      }
      return { buffer: Buffer.alloc(2000), mimeType: 'audio/wav', durationMs: 1000 };
    });
    cancel = vi.fn(() => { this.isRecording = false; });
    hasReceivedAudio = vi.fn(() => native.audioArrived);
    setUnexpectedExitHandler = vi.fn((handler: () => void) => { this.exitHandler = handler; });
    setSilenceHandler = vi.fn();
    setNoAudioDataHandler = vi.fn((handler: (d: unknown) => void) => { this.noAudioHandler = handler; });
    exit() { this.isRecording = false; this.exitHandler?.(); }
    noAudio() { this.noAudioHandler?.({ reason: 'No audio', suggestion: 'Check the mic' }); }
    constructor() {
      native.instances.push(this as unknown as FakeRecorder);
    }
  },
}));

import { RecorderManager } from '../../../src/recorder/RecorderManager';
import type { LiveTranscription } from '../../../src/transcription/LiveTranscription';

/** A stand-in live transcription that records what was done to it. */
function fakeSession(file: string) {
  return {
    file,
    detach: vi.fn((_signal?: AbortSignal) => { native.order.push(`detach ${file}`); }),
    cancel: vi.fn(() => { native.order.push(`cancel ${file}`); }),
  };
}
type FakeSession = ReturnType<typeof fakeSession>;

const flush = async () => {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
};

describe('RecorderManager: live transcription of native recordings', () => {
  let manager: RecorderManager;
  let sessions: FakeSession[];
  let factory: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    native.holdStart = false;
    native.pendingStarts = [];
    native.stopError = undefined;
    native.audioArrived = true;
    native.order = [];
    native.instances = [];
    sessions = [];
    factory = vi.fn((file: string) => {
      const session = fakeSession(file);
      sessions.push(session);
      return session as unknown as LiveTranscription;
    });
    manager = new RecorderManager({ fsPath: '/ext' } as never);
    manager.setLiveTranscription(factory as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    manager.dispose();
  });

  it('starts one for the file the recorder writes, and hands it over on stop, with the pipeline signal, before stopping the recorder', async () => {
    await manager.startRecording('off', 0, 0);
    expect(factory).toHaveBeenCalledWith('/tmp/code-dictator-1.wav');

    const pipeline = new AbortController();
    const audio = await manager.stopRecording(pipeline.signal);
    expect(audio.live).toBe(sessions[0]);
    expect(sessions[0].detach).toHaveBeenCalledWith(pipeline.signal);
    expect(native.order).toEqual(['detach /tmp/code-dictator-1.wav', 'recorder.stop']);
    expect(sessions[0].cancel).not.toHaveBeenCalled();
  });

  it('records without one when the factory declines or fails', async () => {
    factory.mockReturnValueOnce(undefined);
    await manager.startRecording('off', 0, 0);
    expect((await manager.stopRecording()).live).toBeUndefined();

    factory.mockImplementationOnce(() => { throw new Error('boom'); });
    await manager.startRecording('off', 0, 0);
    expect(manager.isRecording).toBe(true);
    expect((await manager.stopRecording()).live).toBeUndefined();
  });

  it('cancels it with the recording (Escape), and on dispose', async () => {
    await manager.startRecording('off', 0, 0);
    manager.cancelRecording();
    expect(sessions[0].cancel).toHaveBeenCalledTimes(1);

    await manager.startRecording('off', 0, 0);
    manager.dispose();
    expect(sessions[1].cancel).toHaveBeenCalledTimes(1);
  });

  it('cancels it when the recorder exits on its own, or never delivers audio', async () => {
    vi.useFakeTimers();
    await manager.startRecording('off', 0, 0);
    native.instances[0].exit();
    expect(sessions[0].cancel).toHaveBeenCalledTimes(1);

    native.audioArrived = false;
    await manager.startRecording('off', 0, 0);
    native.instances[1].noAudio();
    await vi.advanceTimersByTimeAsync(2000);
    expect(sessions[1].cancel).toHaveBeenCalledTimes(1);
    expect(manager.isRecording).toBe(false);
  });

  it('cancels it when stopping the recorder fails, and only that recording\'s', async () => {
    await manager.startRecording('off', 0, 0);
    let failStop!: () => void;
    native.instances[0].stop.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      failStop = () => reject(new Error('Recording file not found'));
    }));
    const firstStop = manager.stopRecording();
    await flush();
    await manager.startRecording('off', 0, 0); // the next recording starts meanwhile
    failStop();
    await expect(firstStop).rejects.toThrow('Recording file not found');
    expect(sessions[0].cancel).toHaveBeenCalledTimes(1);
    expect(sessions[1].cancel).not.toHaveBeenCalled();
    expect((await manager.stopRecording()).live).toBe(sessions[1]);
  });

  it('starts none for a recording cancelled while the recorder was starting', async () => {
    native.holdStart = true;
    const starting = manager.startRecording('off', 0, 0);
    await flush();
    manager.cancelRecording();
    native.pendingStarts.shift()!();
    await starting;
    expect(factory).not.toHaveBeenCalled();
  });

  it('gives each of two overlapping recordings its own', async () => {
    await manager.startRecording('off', 0, 0);
    let releaseStop!: () => void;
    native.instances[0].stop.mockImplementationOnce(() => new Promise((resolve) => {
      releaseStop = () => resolve({ buffer: Buffer.alloc(2000), mimeType: 'audio/wav', durationMs: 1000 });
    }));
    const firstStop = manager.stopRecording();
    await flush();
    await manager.startRecording('off', 0, 0); // hold mode: pressed again while the first one stops
    releaseStop();
    expect((await firstStop).live).toBe(sessions[0]);
    expect((await manager.stopRecording()).live).toBe(sessions[1]);
    expect(sessions.every((s) => s.cancel.mock.calls.length === 0)).toBe(true);
  });
});
