import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFile, unlink } from 'fs/promises';
import { execFile } from 'child_process';

vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('../../../src/DiagnosticLog', () => ({
  diagLog: vi.fn(),
}));

describe('SoundPlayer', () => {
  const mockExecFile = vi.mocked(execFile);
  const mockWriteFile = vi.mocked(writeFile);
  const mockUnlink = vi.mocked(unlink);

  beforeEach(() => {
    vi.resetModules();
    mockWriteFile.mockResolvedValue(undefined);
    mockUnlink.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes a WAV file and calls OS audio player', async () => {
    // Simulate successful execFile
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(null, '', '');
      return {} as any;
    });

    const { playCompletionChime } = await import('../../../src/ui/SoundPlayer');
    await playCompletionChime();

    // Should write a temp WAV file
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const [filePath, buffer] = mockWriteFile.mock.calls[0];
    expect(String(filePath)).toContain('code-dictator-chime');
    expect(String(filePath)).toMatch(/\.wav$/);
    expect(buffer).toBeInstanceOf(Buffer);

    // WAV file should start with RIFF header
    const wavBuf = buffer as Buffer;
    expect(wavBuf.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wavBuf.toString('ascii', 8, 12)).toBe('WAVE');

    // Should call OS audio command
    expect(mockExecFile).toHaveBeenCalledTimes(1);

    // Should clean up temp file
    expect(mockUnlink).toHaveBeenCalledTimes(1);
  });

  it('cleans up temp file even on playback failure', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(new Error('aplay not found'), '', '');
      return {} as any;
    });

    const { playCompletionChime } = await import('../../../src/ui/SoundPlayer');
    await playCompletionChime();

    // Should still attempt cleanup (once in execFile callback, once in catch)
    expect(mockUnlink).toHaveBeenCalled();
  });

  it('generates valid 16-bit mono WAV data', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(null, '', '');
      return {} as any;
    });

    const { playCompletionChime } = await import('../../../src/ui/SoundPlayer');
    await playCompletionChime();

    const wavBuf = mockWriteFile.mock.calls[0][1] as Buffer;

    // Check WAV header fields
    expect(wavBuf.readUInt16LE(20)).toBe(1);      // PCM format
    expect(wavBuf.readUInt16LE(22)).toBe(1);      // mono
    expect(wavBuf.readUInt32LE(24)).toBe(22050);  // sample rate
    expect(wavBuf.readUInt16LE(34)).toBe(16);     // 16-bit
  });
});
