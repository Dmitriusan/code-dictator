import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as child_process from 'child_process';

vi.mock('vscode', () => import('../__mocks__/vscode').then(m => m.default));

import { NativeRecorder, type AudioDiagnostics } from '../../../src/recorder/NativeRecorder';

// We need to mock execSync for diagnosePulseAudioSource tests
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof child_process>('child_process');
  return {
    ...actual,
    execSync: vi.fn(actual.execSync),
  };
});

const mockExecSync = vi.mocked(child_process.execSync);

describe('NativeRecorder.diagnosePulseAudioSource', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('returns generic message on non-Linux platforms', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });

    const diag = NativeRecorder.diagnosePulseAudioSource();

    expect(diag.reason).toBe('No audio data from microphone');
    expect(diag.suggestion).toContain('OS sound settings');
  });

  it('detects missing default source', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    mockExecSync.mockReturnValueOnce(''); // pactl get-default-source returns empty

    const diag = NativeRecorder.diagnosePulseAudioSource();

    expect(diag.reason).toBe('No default audio source configured');
    expect(diag.suggestion).toContain('Set a default microphone');
  });

  it('detects monitor source (output loopback)', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    mockExecSync.mockReturnValueOnce('alsa_output.pci-0000_00_1f.3.monitor');

    const diag = NativeRecorder.diagnosePulseAudioSource();

    expect(diag.reason).toContain('output monitor');
    expect(diag.suggestion).toContain('actual microphone');
  });

  it('detects PipeWire error state', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });

    // pactl get-default-source
    mockExecSync.mockReturnValueOnce('alsa_input.pci-0000_00_1f.3-platform-sof_sdw.HiFi__hw_sofsoundwire_4__source');
    // pw-cli info <source-name>
    mockExecSync.mockReturnValueOnce('  state: "error" "Start error: Invalid argument"\n  node.pause-on-idle = "false"');

    const diag = NativeRecorder.diagnosePulseAudioSource();

    expect(diag.reason).toContain('error state');
    expect(diag.reason).toContain('Invalid argument');
    expect(diag.suggestion).toContain('systemctl');
    expect(diag.suggestion).toContain('pipewire');
  });

  it('detects suspended source', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });

    mockExecSync.mockReturnValueOnce('alsa_input.usb-device');
    // pw-cli info <source-name>
    mockExecSync.mockReturnValueOnce('  state: "suspended" ""');

    const diag = NativeRecorder.diagnosePulseAudioSource();

    expect(diag.reason).toContain('suspended');
    expect(diag.suggestion).toContain('microphone is connected');
  });

  it('returns generic message when pactl/pw-cli not available', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    mockExecSync.mockImplementation(() => { throw new Error('command not found'); });

    const diag = NativeRecorder.diagnosePulseAudioSource();

    expect(diag.reason).toBe('Microphone is not producing audio');
    expect(diag.suggestion).toContain('Bluetooth');
  });

  it('returns generic message when source is in running state', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });

    mockExecSync.mockReturnValueOnce('alsa_input.some-source');
    // pw-cli info <source-name>
    mockExecSync.mockReturnValueOnce('  state: "running" ""');

    const diag = NativeRecorder.diagnosePulseAudioSource();

    // Source appears healthy — generic fallback
    expect(diag.reason).toBe('Microphone is not producing audio');
  });
});
