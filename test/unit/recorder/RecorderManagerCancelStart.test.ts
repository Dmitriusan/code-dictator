import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

// Escape (cancelRecording) while the native recorder is still starting. Its
// start takes about 150 ms, and until it resolves there is no running recorder
// to cancel. NativeRecorder is faked; its start() is held until the test
// finishes it, or fails it.
type FakeRecorder = {
  isRecording: boolean;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
};

const native = vi.hoisted(() => ({
  holdStart: true,
  /** Finish a held start(), oldest first; given an error, it fails instead. */
  pendingStarts: [] as Array<(error?: Error) => void>,
  instances: [] as FakeRecorder[],
}));

vi.mock('vscode', () => import('../__mocks__/vscode').then(m => m.default));

vi.mock('../../../src/recorder/NativeRecorder', () => ({
  NativeRecorder: class {
    static isAvailable = vi.fn(() => true);
    isRecording = false;
    start = vi.fn(() => {
      if (!native.holdStart) {
        this.isRecording = true;
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => native.pendingStarts.push((error) => {
        if (error) {
          reject(error);
          return;
        }
        this.isRecording = true;
        resolve();
      }));
    });
    stop = vi.fn(async () => {
      this.isRecording = false;
      return { buffer: Buffer.alloc(2000), mimeType: 'audio/wav', durationMs: 1000 };
    });
    cancel = vi.fn(() => { this.isRecording = false; });
    hasReceivedAudio = vi.fn(() => true);
    setUnexpectedExitHandler = vi.fn();
    setSilenceHandler = vi.fn();
    setNoAudioDataHandler = vi.fn();
    constructor() {
      native.instances.push(this as unknown as FakeRecorder);
    }
  },
}));

import { RecorderManager } from '../../../src/recorder/RecorderManager';

/** Let pending promise callbacks run, without advancing the fake clock. */
const flush = async () => {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
};

describe('RecorderManager: Escape while the native recorder starts', () => {
  let manager: RecorderManager;
  let onStarted: Mock<() => void>;
  let onError: Mock<(message: string) => void>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    native.holdStart = true;
    native.pendingStarts.length = 0;
    native.instances.length = 0;
    manager = new RecorderManager({ fsPath: '/mock/extension' } as never);
    onStarted = vi.fn<() => void>();
    onError = vi.fn<(message: string) => void>();
    manager.onRecordingStarted(onStarted);
    manager.onError(onError);
  });

  afterEach(() => {
    manager.dispose();
    vi.useRealTimers();
  });

  /** Start a recording, and press Escape while its recorder is still starting. */
  async function escapeWhileStarting(): Promise<{ recorder: FakeRecorder; started: Promise<void> }> {
    const started = manager.startRecording('basic', 0, 300);
    started.catch(() => { /* asserted by the caller */ });
    await flush();
    expect(native.pendingStarts).toHaveLength(1);
    expect(manager.isRecording).toBe(true);
    manager.cancelRecording();
    return { recorder: native.instances[0], started };
  }

  it('cancels the recorder as soon as it has started, and reports no recording', async () => {
    const { recorder, started } = await escapeWhileStarting();

    native.pendingStarts[0]();
    await expect(started).resolves.toBeUndefined();

    expect(recorder.cancel).toHaveBeenCalledTimes(1);
    expect(recorder.stop).not.toHaveBeenCalled();
    expect(onStarted).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(manager.isRecording).toBe(false);
    expect((manager as unknown as { nativeRecorder: unknown }).nativeRecorder).toBeNull();
    expect(vi.getTimerCount()).toBe(0); // no max-duration timer for a recording that never was
  });

  it('records with a new recorder on the next start', async () => {
    const { started } = await escapeWhileStarting();
    native.pendingStarts[0]();
    await started;

    native.holdStart = false;
    await manager.startRecording('basic', 0, 300);

    expect(native.instances).toHaveLength(2);
    expect(native.instances[1].cancel).not.toHaveBeenCalled();
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(manager.isRecording).toBe(true);
    await expect(manager.stopRecording()).resolves.toMatchObject({ mimeType: 'audio/wav' });
  });

  it('wins when it lands just as the recorder has started', async () => {
    const started = manager.startRecording('basic', 0, 300);
    await flush();
    native.pendingStarts[0](); // the recorder runs; the start has not seen it yet
    manager.cancelRecording();
    await started;

    expect(native.instances[0].cancel).toHaveBeenCalledTimes(1);
    expect(onStarted).not.toHaveBeenCalled();
    expect(manager.isRecording).toBe(false);
  });

  it('still cancels a recording that has started at once', async () => {
    native.holdStart = false;
    await manager.startRecording('basic', 0, 300);

    manager.cancelRecording();

    expect(native.instances[0].cancel).toHaveBeenCalledTimes(1);
    expect(manager.isRecording).toBe(false);
  });

  it('keeps the recorder, and starts no second one, when the key is pressed again before the start completes', async () => {
    // Hold mode: Escape, then Alt+D again within the ~150 ms start
    const { recorder, started } = await escapeWhileStarting();
    await manager.startRecording('basic', 0, 300);
    expect(native.instances).toHaveLength(1);

    native.pendingStarts[0]();
    await started;

    expect(recorder.cancel).not.toHaveBeenCalled();
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(manager.isRecording).toBe(true);
    await expect(manager.stopRecording()).resolves.toMatchObject({ mimeType: 'audio/wav' });
    expect(recorder.stop).toHaveBeenCalledTimes(1);
  });

  it('reports a start that fails after Escape as before, and does not cancel the next start', async () => {
    const failure = new Error('Recording process exited immediately (code=1). Connection refused');
    const { started } = await escapeWhileStarting();

    native.pendingStarts[0](failure);

    await expect(started).rejects.toBe(failure);
    expect(manager.isRecording).toBe(false);
    expect(onStarted).not.toHaveBeenCalled();
    expect((manager as unknown as { nativeStart: unknown }).nativeStart).toBeUndefined();

    native.holdStart = false;
    await manager.startRecording('basic', 0, 300);
    expect(native.instances[1].cancel).not.toHaveBeenCalled();
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(manager.isRecording).toBe(true);
  });

  it('dispose kills a recorder that is still starting without waiting for it', async () => {
    const started = manager.startRecording('basic', 0, 300);
    started.catch(() => { /* the killed recorder fails its start */ });
    await flush();

    manager.dispose();

    expect(native.instances[0].cancel).toHaveBeenCalledTimes(1);
    native.pendingStarts[0](new Error('Recording process exited immediately (code=null). '));
    await flush();
    expect(manager.isRecording).toBe(false);
  });
});
