import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Recordings whose start or stop overlaps another one. In hold mode the
// release stops a recording without waiting for anything, so the next press
// can start a new recording while the previous recorder process is still
// stopping. NativeRecorder is faked; its start() and stop() can be held.
type FakeRecorder = {
  isRecording: boolean;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  setSilenceHandler: ReturnType<typeof vi.fn>;
  setNoAudioDataHandler: ReturnType<typeof vi.fn>;
};

const native = vi.hoisted(() => ({
  holdStart: false,
  holdStop: false,
  audioArrived: true,
  /** Finish a held start() / stop(), oldest first. */
  pendingStarts: [] as Array<() => void>,
  pendingStops: [] as Array<() => void>,
  instances: [] as FakeRecorder[],
}));

vi.mock('vscode', () => import('../__mocks__/vscode').then(m => m.default));

vi.mock('../../../src/recorder/NativeRecorder', () => ({
  NativeRecorder: class {
    static isAvailable = vi.fn(() => true);
    isRecording = false;
    start = vi.fn(() => {
      const started = () => { this.isRecording = true; };
      if (!native.holdStart) {
        started();
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => native.pendingStarts.push(() => { started(); resolve(); }));
    });
    // Like the real recorder, isRecording stays true until the process has exited and the file is read
    stop = vi.fn(() => {
      const stopped = () => {
        this.isRecording = false;
        return { buffer: Buffer.alloc(2000), mimeType: 'audio/wav', durationMs: 1000 };
      };
      if (!native.holdStop) {
        return Promise.resolve(stopped());
      }
      return new Promise((resolve) => native.pendingStops.push(() => resolve(stopped())));
    });
    cancel = vi.fn(() => { this.isRecording = false; });
    hasReceivedAudio = vi.fn(() => native.audioArrived);
    setUnexpectedExitHandler = vi.fn();
    setSilenceHandler = vi.fn();
    setNoAudioDataHandler = vi.fn();
    constructor() {
      native.instances.push(this as unknown as FakeRecorder);
    }
  },
}));

import { RecorderManager } from '../../../src/recorder/RecorderManager';
import type { AudioDataPayload } from '../../../src/types';

const NO_AUDIO = { reason: 'No audio data from microphone', suggestion: 'Check your microphone in OS sound settings.' };

/** Let pending promise callbacks run, without advancing the fake clock. */
const flush = async () => {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
};

describe('RecorderManager: starts and stops that overlap', () => {
  let manager: RecorderManager;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    native.holdStart = false;
    native.holdStop = false;
    native.audioArrived = true;
    native.pendingStarts.length = 0;
    native.pendingStops.length = 0;
    native.instances.length = 0;
    manager = new RecorderManager({ fsPath: '/mock/extension' } as never);
  });

  afterEach(() => {
    manager.dispose();
    vi.useRealTimers();
  });

  /** Record, release (the stop is held), and press again before that stop has finished. */
  async function startDuringStop(): Promise<{ first: FakeRecorder; second: FakeRecorder; firstStop: Promise<AudioDataPayload> }> {
    await manager.startRecording('basic', 5, 300);
    native.holdStop = true;
    const firstStop = manager.stopRecording();
    await flush();
    expect(manager.isRecording).toBe(false); // so the next press starts a recording
    native.holdStop = false;
    await manager.startRecording('basic', 5, 300);
    expect(native.instances).toHaveLength(2);
    return { first: native.instances[0], second: native.instances[1], firstStop };
  }

  it('holds the recording claim while the native recorder starts, so a second start starts nothing', async () => {
    native.holdStart = true;
    const first = manager.startRecording('basic', 5, 300);
    await flush();
    expect(manager.isRecording).toBe(true);

    await manager.startRecording('basic', 5, 300);
    expect(native.instances).toHaveLength(1);

    native.pendingStarts[0]();
    await first;
    expect(native.instances).toHaveLength(1);
    expect(manager.isRecording).toBe(true);
  });

  it('a recording started while the previous one was stopping can still be stopped', async () => {
    const { second, firstStop } = await startDuringStop();
    native.pendingStops[0]();
    await expect(firstStop).resolves.toMatchObject({ mimeType: 'audio/wav' });

    expect(manager.isRecording).toBe(true);
    await expect(manager.stopRecording()).resolves.toMatchObject({ mimeType: 'audio/wav' });
    expect(second.stop).toHaveBeenCalledTimes(1);
    expect(manager.isRecording).toBe(false);

    await manager.startRecording('basic', 5, 300);
    expect(native.instances).toHaveLength(3);
    expect(manager.isRecording).toBe(true);
  });

  it('Escape and dispose still reach a recording started while the previous one was stopping', async () => {
    const { second, firstStop } = await startDuringStop();
    native.pendingStops[0]();
    await firstStop;

    manager.cancelRecording();
    expect(second.cancel).toHaveBeenCalledTimes(1);
    expect(manager.isRecording).toBe(false);

    await manager.startRecording('basic', 5, 300);
    const third = native.instances[2];
    manager.dispose();
    expect(third.cancel).toHaveBeenCalled();
  });

  it('a silence signal from the recorder that is stopping does not stop the next recording', async () => {
    const onSilence = vi.fn();
    manager.onSilenceDetected(onSilence);
    const { first, second, firstStop } = await startDuringStop();

    first.setSilenceHandler.mock.calls[0][0](); // its last audio chunk arrives while it stops
    expect(onSilence).not.toHaveBeenCalled();

    second.setSilenceHandler.mock.calls[0][0]();
    expect(onSilence).toHaveBeenCalledTimes(1);
    native.pendingStops[0]();
    await firstStop;
  });

  it("the previous recording's no-audio check does not cancel the next recording", async () => {
    await manager.startRecording('basic', 5, 300);
    const first = native.instances[0];
    const onTrackEnded = vi.fn();
    manager.onTrackEnded(onTrackEnded);
    native.audioArrived = false;
    first.setNoAudioDataHandler.mock.calls[0][0](NO_AUDIO); // nothing from the mic for 2 s; cancels 2 s later
    await manager.stopRecording();
    await manager.startRecording('basic', 5, 300);
    const second = native.instances[1];

    await vi.advanceTimersByTimeAsync(2000);

    expect(second.cancel).not.toHaveBeenCalled();
    expect(onTrackEnded).not.toHaveBeenCalled();
    expect(manager.isRecording).toBe(true);
  });

  it('the no-audio check still cancels its own recording', async () => {
    await manager.startRecording('basic', 5, 300);
    const first = native.instances[0];
    const onTrackEnded = vi.fn();
    manager.onTrackEnded(onTrackEnded);
    native.audioArrived = false;
    first.setNoAudioDataHandler.mock.calls[0][0](NO_AUDIO);

    await vi.advanceTimersByTimeAsync(2000);

    expect(first.cancel).toHaveBeenCalledTimes(1);
    expect(onTrackEnded).toHaveBeenCalledWith(NO_AUDIO);
    expect(manager.isRecording).toBe(false);
  });
});
