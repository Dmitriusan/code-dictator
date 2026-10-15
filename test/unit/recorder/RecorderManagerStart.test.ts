import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Which recorder startRecording() uses, and whether it opens the
// "Code Dictator: Recorder" editor tab. NativeRecorder is faked, so no
// recorder process (parecord, arecord, ffmpeg, sox) is ever spawned.
const native = vi.hoisted(() => ({
  available: true,
  startError: undefined as Error | undefined,
  instances: [] as Array<{
    isRecording: boolean;
    start: (silenceTimeout?: number) => Promise<void>;
    cancel: () => void;
  }>,
}));

vi.mock('vscode', () => import('../__mocks__/vscode').then(m => m.default));

vi.mock('../../../src/recorder/NativeRecorder', () => ({
  NativeRecorder: class {
    static isAvailable = vi.fn(() => native.available);
    isRecording = false;
    start = vi.fn(async () => {
      if (native.startError) {
        throw native.startError;
      }
      this.isRecording = true;
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
      native.instances.push(this);
    }
  },
}));

import vscode, { type createMockWebviewPanel } from '../__mocks__/vscode';
import { RecorderManager } from '../../../src/recorder/RecorderManager';
import { MIC_PERMISSION_DENIED } from '../../../src/recorder/RecorderWebviewContent';

type MockPanel = ReturnType<typeof createMockWebviewPanel>;

const NO_MICROPHONE = 'No microphone found. Please connect a microphone and try again.';

/** The error a start reports when no recorder can be used. */
const unavailable = (reason: string) =>
  `Microphone unavailable: ${reason}. Please check your audio devices, or install ffmpeg (Windows: winget install Gyan.FFmpeg) / arecord (Linux) / sox (macOS).`;

/** Let pending promise callbacks run, without advancing the fake clock. */
const flush = async () => {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
};

/** Every recorder tab opened so far, oldest first. */
function panels(): MockPanel[] {
  return vscode.window.createWebviewPanel.mock.results.map((r) => r.value as MockPanel);
}

/** The recorder tab that is still open, if any. */
function openPanel(): MockPanel | undefined {
  return panels().filter((p) => !p._disposed).at(-1);
}

/** 'started', the error message, or 'pending' once pending callbacks have run. */
async function outcome(started: Promise<void>): Promise<string> {
  let result = 'pending';
  started.then(() => { result = 'started'; }, (error: Error) => { result = error.message; });
  await flush();
  return result;
}

/**
 * Start a recording. If it opens a recorder tab, answer the way VS Code
 * desktop does: the page loads (or answers the ping), then getUserMedia fails
 * with `webviewError`.
 */
async function start(manager: RecorderManager, webviewError = MIC_PERMISSION_DENIED): Promise<void> {
  const started = manager.startRecording('basic', 5, 300);
  started.catch(() => { /* asserted by the caller */ });
  await flush();
  const panel = openPanel();
  if (panel) {
    panel._receive({ type: 'ready' });
    await flush();
    panel._receive({ type: 'recordingError', message: webviewError });
    await flush();
  }
  return started;
}

describe('RecorderManager.startRecording', () => {
  let manager: RecorderManager;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    native.available = true;
    native.startError = undefined;
    native.instances.length = 0;
    manager = new RecorderManager({ fsPath: '/mock/extension' } as never);
  });

  afterEach(() => {
    manager.dispose();
    vi.useRealTimers();
  });

  describe('with a native recorder installed', () => {
    it('records natively without opening the recorder tab', async () => {
      const onStarted = vi.fn();
      manager.onRecordingStarted(onStarted);

      await start(manager);

      expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled();
      expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith('workbench.action.previousEditor');
      expect(native.instances).toHaveLength(1);
      expect(native.instances[0].start).toHaveBeenCalledWith(5);
      expect(manager.isRecording).toBe(true);
      expect(onStarted).toHaveBeenCalledTimes(1);

      await expect(manager.stopRecording()).resolves.toMatchObject({ mimeType: 'audio/wav' });
      expect(manager.isRecording).toBe(false);
    });

    it('reports a native start failure unchanged, without trying the webview, and the next start records', async () => {
      const failure = new Error('Recording process exited immediately (code=1). Connection refused');
      native.startError = failure;

      await expect(start(manager)).rejects.toBe(failure);
      expect(manager.isRecording).toBe(false);
      expect((manager as unknown as { nativeRecorder: unknown }).nativeRecorder).toBeNull();
      expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled();

      native.startError = undefined;
      await start(manager);

      expect(native.instances).toHaveLength(2);
      expect(manager.isRecording).toBe(true);
    });
  });

  describe('without a native recorder', () => {
    beforeEach(() => {
      native.available = false;
    });

    it('closes the webview tab when the microphone is refused, with no "Recording panel was closed" error', async () => {
      const onError = vi.fn();
      manager.onError(onError);

      await expect(start(manager)).rejects.toHaveProperty('message', unavailable(MIC_PERMISSION_DENIED));

      expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
      expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
        'codeDictatorRecorder',
        'Code Dictator: Recorder',
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
        expect.objectContaining({ enableScripts: true, retainContextWhenHidden: true }),
      );
      const [panel] = panels();
      expect(panel.dispose).toHaveBeenCalledTimes(1);
      expect(panel.webview.postMessage).not.toHaveBeenCalledWith({ type: 'cancelRecording' });
      expect(onError).not.toHaveBeenCalled();
      expect(native.instances).toHaveLength(0);
      expect(manager.isRecording).toBe(false);
    });

    it('releases the recording claim before closing the tab of a failed attempt', async () => {
      // The webview's own error clears the claim before the attempt fails. A
      // failure inside the extension (here: hiding the tab) does not, so this is
      // the case where closing the tab first would report "Recording panel was closed".
      vscode.commands.executeCommand.mockRejectedValueOnce(new Error('command failed'));
      const onError = vi.fn();
      manager.onError(onError);

      await expect(start(manager)).rejects.toHaveProperty('message', unavailable('command failed'));

      expect(panels()[0].dispose).toHaveBeenCalledTimes(1);
      expect(onError).not.toHaveBeenCalled();
      expect(manager.isRecording).toBe(false);
    });

    it('after a refusal, fails later starts at once without opening the tab again', async () => {
      await expect(start(manager)).rejects.toHaveProperty('message', unavailable(MIC_PERMISSION_DENIED));
      // The page reports a refusal with exactly the text that is remembered
      expect(panels()[0].webview.html).toContain(JSON.stringify(MIC_PERMISSION_DENIED));

      const second = await outcome(manager.startRecording('basic', 5, 300));

      expect(second).toBe(unavailable(MIC_PERMISSION_DENIED));
      expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
      expect(panels()[0].webview.postMessage).toHaveBeenCalledTimes(1); // the first start's startRecording
      expect(vscode.commands.executeCommand).toHaveBeenCalledTimes(1); // previousEditor, first start only
      expect(manager.isRecording).toBe(false);
    });

    it('does not remember other webview failures, so the next start tries the webview again', async () => {
      await expect(start(manager, NO_MICROPHONE)).rejects.toHaveProperty('message', unavailable(NO_MICROPHONE));
      await expect(start(manager, NO_MICROPHONE)).rejects.toHaveProperty('message', unavailable(NO_MICROPHONE));

      expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(2);
      expect(panels().map((p) => p.dispose.mock.calls.length)).toEqual([1, 1]);
    });

    it('records natively, with no tab left open, once a native recorder is installed after a refusal', async () => {
      // e.g. the first Alt+D fails, then the user runs `brew install sox` and tries again
      await expect(start(manager)).rejects.toThrow('Microphone unavailable');

      native.available = true;
      await start(manager);

      expect(native.instances).toHaveLength(1);
      expect(manager.isRecording).toBe(true);
      expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
      expect(panels()[0]._disposed).toBe(true);
    });

    it('leaves no timer running after a failed attempt', async () => {
      await expect(start(manager, NO_MICROPHONE)).rejects.toThrow('Microphone unavailable');

      expect(vi.getTimerCount()).toBe(0);
    });

    it("a failed attempt cannot disarm the next attempt's error handling", async () => {
      const onError = vi.fn();
      manager.onError(onError);
      await expect(start(manager, NO_MICROPHONE)).rejects.toThrow('Microphone unavailable'); // t = 0

      await vi.advanceTimersByTimeAsync(3000);
      const second = manager.startRecording('basic', 5, 300);
      second.catch(() => { /* asserted below */ });
      await flush();
      const panel = openPanel()!;
      panel._receive({ type: 'ready' });
      await flush();
      await vi.advanceTimersByTimeAsync(2500); // past the end of the first attempt's 5 s window
      panel._receive({ type: 'recordingError', message: NO_MICROPHONE });

      expect(await outcome(second)).toBe(unavailable(NO_MICROPHONE));
      expect(onError).not.toHaveBeenCalled();
    });

    it("a failed attempt cannot hold up the next attempt's tab", async () => {
      await expect(start(manager, NO_MICROPHONE)).rejects.toThrow('Microphone unavailable'); // t = 0

      await vi.advanceTimersByTimeAsync(3000);
      const second = manager.startRecording('basic', 5, 300);
      second.catch(() => { /* not asserted */ });
      await vi.advanceTimersByTimeAsync(2500); // the new tab's page loads slowly, past the first attempt's 5 s
      expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(2);
      const panel = panels()[1];
      panel._receive({ type: 'ready' });
      await flush();

      expect(panel.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'startRecording' }));
    });

    it('keeps the tab open while the webview records, when it is given the microphone', async () => {
      const onError = vi.fn();
      manager.onError(onError);

      const started = manager.startRecording('basic', 5, 300);
      await flush();
      const [panel] = panels();
      panel._receive({ type: 'ready' });
      await flush();
      panel._receive({ type: 'recordingStarted' });
      await vi.advanceTimersByTimeAsync(5000);
      await started;

      expect(panel.dispose).not.toHaveBeenCalled();
      expect(manager.isRecording).toBe(true);
      expect(onError).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
