import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => import('../__mocks__/vscode').then(m => m.default));

import { NativeRecorder } from '../../../src/recorder/NativeRecorder';

const TMP = '/tmp/code-dictator-test.wav';

describe('NativeRecorder.buildArgs', () => {
  describe('parecord low-latency fix (tail-cutoff regression)', () => {
    // Regression guard: without --latency-msec, parecord buffers ~1-2s of audio
    // in the PulseAudio/PipeWire capture pipeline and drops it on stop, cutting
    // the last seconds of speech. These tests lock the flag in place.
    it('includes --latency-msec on the file-write path (default, silenceTimeout=0)', () => {
      const args = NativeRecorder.buildArgs('parecord', 'parecord', false, TMP);
      expect(args).toContain('--latency-msec=100');
      expect(args).toContain('--file-format=wav');
      expect(args).toContain(TMP);
    });

    it('includes --latency-msec on the raw stdout path (silence detection)', () => {
      const args = NativeRecorder.buildArgs('parecord', 'parecord', true, TMP);
      expect(args).toContain('--latency-msec=100');
      expect(args).toContain('--raw');
      expect(args).not.toContain(TMP); // raw mode streams to stdout, not a file
    });

    it('keeps 16 kHz mono s16le format on both paths', () => {
      for (const pipe of [true, false]) {
        const args = NativeRecorder.buildArgs('parecord', 'parecord', pipe, TMP);
        expect(args).toContain('--format=s16le');
        expect(args).toContain('--rate=16000');
        expect(args).toContain('--channels=1');
      }
    });
  });

  describe('other recorders are unaffected', () => {
    it('arecord does not get a latency flag (it flushes on signal)', () => {
      const file = NativeRecorder.buildArgs('arecord', 'arecord', false, TMP);
      const raw = NativeRecorder.buildArgs('arecord', 'arecord', true, TMP);
      expect(file.some(a => a.includes('latency'))).toBe(false);
      expect(file).toEqual(['-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'wav', TMP]);
      expect(raw).toEqual(['-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'raw', '-']);
    });

    it('pw-record writes to file with no latency flag', () => {
      const args = NativeRecorder.buildArgs('pw-record', 'pw-record', false, TMP);
      expect(args.some(a => a.includes('latency'))).toBe(false);
      expect(args).toEqual(['--format', 's16', '--rate', '16000', '--channels', '1', TMP]);
    });

    it('sox rec alias records from default input implicitly (no -d)', () => {
      const args = NativeRecorder.buildArgs('sox', '/usr/local/bin/rec', false, TMP);
      expect(args).toEqual(['-r', '16000', '-c', '1', '-b', '16', TMP]);
    });

    it('sox binary uses explicit default device (-d)', () => {
      const args = NativeRecorder.buildArgs('sox', 'sox', false, TMP);
      expect(args).toEqual(['-d', '-r', '16000', '-c', '1', '-b', '16', TMP]);
    });
  });
});
