import { describe, it, expect, vi, afterEach } from 'vitest';

// NativeRecorder.start() is run with its tool detection faked, so nothing is
// looked up on the machine and no recorder process is ever spawned.
const spawn = vi.hoisted(() => vi.fn());

vi.mock('vscode', () => import('../__mocks__/vscode').then(m => m.default));

vi.mock('child_process', async () => ({
  ...(await vi.importActual<typeof import('child_process')>('child_process')),
  spawn,
}));

import { NoRecorderError } from '../../../src/recorder/NoRecorderError';
import { NativeRecorder } from '../../../src/recorder/NativeRecorder';

describe('NoRecorderError', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    vi.restoreAllMocks();
    spawn.mockClear();
  });

  it('on macOS names SoX and carries the Homebrew command', () => {
    const error = new NoRecorderError('darwin');

    expect(error.message).toBe('Code Dictator needs SoX to record. Install it with: brew install sox — then press Alt+D again.');
    expect(error.installCommand).toBe('brew install sox');
  });

  it('on Windows names ffmpeg and carries the winget command', () => {
    const error = new NoRecorderError('win32');

    expect(error.message).toBe('Code Dictator needs ffmpeg to record. Install it with: winget install Gyan.FFmpeg — then press Alt+D again.');
    expect(error.installCommand).toBe('winget install Gyan.FFmpeg');
  });

  it('on Linux names the three recorders and carries no command, because the package depends on the distribution', () => {
    const error = new NoRecorderError('linux');

    expect(error.message).toBe('Code Dictator needs a recording tool. Install pulseaudio-utils (parecord), pipewire-bin (pw-record) or alsa-utils (arecord) — then press Alt+D again.');
    expect(error.installCommand).toBeUndefined();
  });

  it('gives any other platform the Linux advice', () => {
    expect(new NoRecorderError('freebsd').message).toBe(new NoRecorderError('linux').message);
    expect(new NoRecorderError('freebsd').installCommand).toBeUndefined();
  });

  it('uses the platform it runs on by default', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    expect(new NoRecorderError().installCommand).toBe('brew install sox');

    Object.defineProperty(process, 'platform', { value: 'win32' });
    expect(new NoRecorderError().installCommand).toBe('winget install Gyan.FFmpeg');

    Object.defineProperty(process, 'platform', { value: 'linux' });
    expect(new NoRecorderError().installCommand).toBeUndefined();
  });

  it('is an Error that can be told apart from other start failures', () => {
    const error = new NoRecorderError('linux');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(NoRecorderError);
    expect(error.name).toBe('NoRecorderError');
    expect(new Error('Recording process exited immediately (code=1).')).not.toBeInstanceOf(NoRecorderError);
  });

  it('is what NativeRecorder.start() rejects with when no tool is found', async () => {
    vi.spyOn(NativeRecorder, 'detectTool').mockReturnValue(null);

    await expect(new NativeRecorder().start(0)).rejects.toBeInstanceOf(NoRecorderError);

    expect(spawn).not.toHaveBeenCalled();
  });
});
