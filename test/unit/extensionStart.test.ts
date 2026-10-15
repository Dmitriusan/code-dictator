import { describe, it, expect, vi, beforeEach } from 'vitest';

type VscodeMock = typeof import('./__mocks__/vscode').default;
type NoRecorderErrorClass = typeof import('../../src/recorder/NoRecorderError').NoRecorderError;

const mocks = vi.hoisted(() => ({
  startRecording: (() => Promise.resolve()) as () => Promise<void>,
}));

vi.mock('vscode', () => import('./__mocks__/vscode').then((m) => m.default));

vi.mock('../../src/recorder/RecorderManager', () => ({
  RecorderManager: class {
    get isRecording() { return false; }
    startRecording() { return mocks.startRecording(); }
    stopRecording() { return Promise.reject(new Error('not recording')); }
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
    transcribe: () => Promise.reject(new Error('transcribe not stubbed')),
    validateConfig: async () => true,
    estimateCost: () => 0,
  }),
}));

const COPY = 'Copy Install Command';

describe('a recording that cannot start', () => {
  let vscode: VscodeMock;
  let NoRecorderError: NoRecorderErrorClass;
  let toggle: () => Promise<void>;
  /** Answer the notification the way a click does; undefined is a dismissal. */
  let click: (choice: string | undefined) => void;

  beforeEach(async () => {
    vi.resetModules(); // fresh extension state; the mocked modules themselves are shared
    vi.clearAllMocks();
    mocks.startRecording = () => Promise.resolve();

    vscode = (await import('vscode')) as unknown as VscodeMock;
    const { createMockExtensionContext } = await import('./__mocks__/vscode');
    const commands = new Map<string, () => Promise<void>>();
    vi.mocked(vscode.commands.registerCommand).mockImplementation(((id: string, handler: () => Promise<void>) => {
      commands.set(id, handler);
      return { dispose() { /* no-op */ } };
    }) as never);
    click = () => { throw new Error('no notification is waiting for a click'); };
    vi.mocked(vscode.window.showErrorMessage).mockImplementation((() =>
      new Promise((resolve) => { click = resolve; })) as never);

    // Loaded after the reset, so the extension and this test see one class
    ({ NoRecorderError } = await import('../../src/recorder/NoRecorderError'));
    const context = createMockExtensionContext();
    await context.globalState.update('codeDictator.onboarded', true); // skip the setup wizard
    const extension = await import('../../src/extension');
    extension.activate({ ...context, globalStorageUri: { fsPath: '/mock/storage' } } as never);
    toggle = () => commands.get('codeDictator.toggleRecording')!();
  });

  it('on macOS names SoX, and the button copies the install command', async () => {
    mocks.startRecording = () => Promise.reject(new NoRecorderError('darwin'));

    await toggle();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Code Dictator needs SoX to record. Install it with: brew install sox — then press Alt+D again.',
      COPY,
    );
    expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();

    click(COPY);

    await vi.waitFor(() => expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('brew install sox'));
    expect(vscode.window.setStatusBarMessage).toHaveBeenCalledWith(expect.stringContaining('brew install sox'), expect.any(Number));
  });

  it('on Windows names ffmpeg, and the button copies the winget command', async () => {
    mocks.startRecording = () => Promise.reject(new NoRecorderError('win32'));

    await toggle();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Code Dictator needs ffmpeg to record. Install it with: winget install Gyan.FFmpeg — then press Alt+D again.',
      COPY,
    );
    click(COPY);

    await vi.waitFor(() => expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('winget install Gyan.FFmpeg'));
  });

  it('copies nothing when the notification is dismissed', async () => {
    mocks.startRecording = () => Promise.reject(new NoRecorderError('darwin'));

    await toggle();
    click(undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
    expect(vscode.window.setStatusBarMessage).not.toHaveBeenCalled();
  });

  it('on Linux names the packages and has no button, because no single command fits every distribution', async () => {
    mocks.startRecording = () => Promise.reject(new NoRecorderError('linux'));

    await toggle();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
    // Exactly the message: any button would be a second argument
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Code Dictator needs a recording tool. Install pulseaudio-utils (parecord), pipewire-bin (pw-record) or alsa-utils (arecord) — then press Alt+D again.',
    );
  });

  it('leaves the recording state idle, and does not keep Alt+D waiting for the notification', async () => {
    const attempts = vi.fn(() => Promise.reject(new NoRecorderError('darwin')));
    mocks.startRecording = attempts;

    await toggle();
    // Nobody has answered the first notification, and the next press still starts a recording
    await toggle();

    expect(attempts).toHaveBeenCalledTimes(2);
    const recordingFlag = vi.mocked(vscode.commands.executeCommand).mock.calls
      .filter(([command, key]) => command === 'setContext' && key === 'codeDictator.isRecording')
      .map(([, , value]) => value);
    expect(recordingFlag).toEqual([false, true, false, true, false]); // activation, then set and cleared by each press
  });

  it('leaves the wording of every other start failure as it was', async () => {
    mocks.startRecording = () => Promise.reject(new Error('Recording process exited immediately (code=1). Connection refused'));

    await toggle();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Code Dictator: Failed to start recording — Recording process exited immediately (code=1). Connection refused',
    );
  });
});
