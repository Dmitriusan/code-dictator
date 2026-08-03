import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('vscode', () => import('../__mocks__/vscode').then(m => m.default));

import { NativeRecorder } from '../../../src/recorder/NativeRecorder';

/**
 * Build one 100 ms chunk of 16-bit mono 16 kHz PCM at a target level.
 * Alternating +A/-A samples give an RMS of exactly A, so the resulting
 * dBFS is 20*log10(A / 32768).
 */
function chunkAtDbfs(dbfs: number): Buffer {
  const samples = 1600; // 100 ms @ 16 kHz — matches what parecord delivers
  const buf = Buffer.alloc(samples * 2);
  if (dbfs <= -96) return buf; // all zeros = digital silence
  const amplitude = Math.round(32768 * Math.pow(10, dbfs / 20));
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, i * 2);
  }
  return buf;
}

/** Drive the private VAD directly — it is the unit under test. */
function feed(recorder: NativeRecorder, chunk: Buffer): void {
  (recorder as unknown as { analyzeChunkForSilence(c: Buffer): void }).analyzeChunkForSilence(chunk);
}

function makeRecorder(silenceTimeoutSec: number) {
  const recorder = new NativeRecorder();
  const onSilence = vi.fn();
  Object.assign(recorder as unknown as Record<string, unknown>, {
    silenceTimeout: silenceTimeoutSec,
    onSilenceDetected: onSilence,
  });
  return { recorder, onSilence };
}

function noiseFloorOf(recorder: NativeRecorder): number {
  return (recorder as unknown as { noiseFloorEma: number }).noiseFloorEma;
}

const SPEECH_DBFS = -35;
const AMBIENT_DBFS = -60;

describe('NativeRecorder adaptive VAD', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('seeds the noise floor from real audio, not the dead chunks at stream start', () => {
    const { recorder } = makeRecorder(5);

    // parecord emits all-zero chunks while the capture device spins up
    feed(recorder, chunkAtDbfs(-96));
    feed(recorder, chunkAtDbfs(-96));
    expect(noiseFloorOf(recorder)).not.toBeCloseTo(-96, 0);

    // First chunk with actual signal seeds the floor
    feed(recorder, chunkAtDbfs(AMBIENT_DBFS));
    expect(noiseFloorOf(recorder)).toBeCloseTo(AMBIENT_DBFS, 0);
  });

  it('detects silence after a dead first chunk (regression: floor latched at -96 dBFS)', () => {
    // Reproduces a real recording: the stream opened with digital silence, which
    // pinned the noise floor at -96 dBFS. Ambient room noise then scored as
    // "speech" (36 dB above the digital floor), so the floor never adapted, the
    // threshold settled ~16 dB below ambient, and silence auto-stop never fired
    // for the entire 127 s recording.
    const { recorder, onSilence } = makeRecorder(5);

    feed(recorder, chunkAtDbfs(-96)); // device not ready yet

    // 1 s of room tone before the speaker starts
    for (let i = 0; i < 10; i++) {
      feed(recorder, chunkAtDbfs(AMBIENT_DBFS));
      vi.advanceTimersByTime(100);
    }
    // The floor must track ambient, not the digital floor
    expect(noiseFloorOf(recorder)).toBeCloseTo(AMBIENT_DBFS, 0);

    // 3 s of speech
    for (let i = 0; i < 30; i++) {
      feed(recorder, chunkAtDbfs(SPEECH_DBFS));
      vi.advanceTimersByTime(100);
    }
    expect(onSilence).not.toHaveBeenCalled();

    // 6 s of room tone — past the 5 s silence timeout
    for (let i = 0; i < 60; i++) {
      feed(recorder, chunkAtDbfs(AMBIENT_DBFS));
      vi.advanceTimersByTime(100);
    }

    expect(onSilence).toHaveBeenCalled();
  });

  it('recovers when the speaker starts talking the instant recording opens', () => {
    // Nothing quiet to seed from, so the floor starts at speech level and has to
    // fall once the speaker pauses.
    const { recorder, onSilence } = makeRecorder(5);

    feed(recorder, chunkAtDbfs(-96));
    for (let i = 0; i < 20; i++) {
      feed(recorder, chunkAtDbfs(SPEECH_DBFS));
      vi.advanceTimersByTime(100);
    }

    // Pause, more speech, then a long trailing pause
    for (let i = 0; i < 20; i++) {
      feed(recorder, chunkAtDbfs(AMBIENT_DBFS));
      vi.advanceTimersByTime(100);
    }
    expect(noiseFloorOf(recorder)).toBeLessThan(SPEECH_DBFS - 10);

    for (let i = 0; i < 20; i++) {
      feed(recorder, chunkAtDbfs(SPEECH_DBFS));
      vi.advanceTimersByTime(100);
    }
    for (let i = 0; i < 60; i++) {
      feed(recorder, chunkAtDbfs(AMBIENT_DBFS));
      vi.advanceTimersByTime(100);
    }

    expect(onSilence).toHaveBeenCalled();
  });

  it('does not fire while the speaker is still talking', () => {
    const { recorder, onSilence } = makeRecorder(5);

    feed(recorder, chunkAtDbfs(-96));
    // 20 s of continuous speech with short sub-second gaps between words
    for (let i = 0; i < 200; i++) {
      feed(recorder, chunkAtDbfs(i % 10 === 0 ? AMBIENT_DBFS : SPEECH_DBFS));
      vi.advanceTimersByTime(100);
    }

    expect(onSilence).not.toHaveBeenCalled();
  });

  it('drifts a stale noise floor upward so it cannot latch below ambient', () => {
    const { recorder, onSilence } = makeRecorder(5);

    // Seed just above the dead-chunk cutoff, then feed only louder audio so the
    // floor never gets a non-speech chunk to adapt on. Without the drift it stays
    // pinned near -84 and silence is never detected.
    feed(recorder, chunkAtDbfs(-84));
    expect(noiseFloorOf(recorder)).toBeLessThan(-80);

    for (let i = 0; i < 30; i++) {
      feed(recorder, chunkAtDbfs(SPEECH_DBFS));
      vi.advanceTimersByTime(100);
    }

    // 30 s of ambient — long enough for the drift to re-engage the floor
    for (let i = 0; i < 300; i++) {
      feed(recorder, chunkAtDbfs(AMBIENT_DBFS));
      vi.advanceTimersByTime(100);
    }

    expect(noiseFloorOf(recorder)).toBeGreaterThan(-80);
    expect(onSilence).toHaveBeenCalled();
  });

  it('stays inert when silence auto-stop is disabled', () => {
    const { recorder, onSilence } = makeRecorder(0);

    feed(recorder, chunkAtDbfs(-96));
    for (let i = 0; i < 200; i++) {
      feed(recorder, chunkAtDbfs(AMBIENT_DBFS));
      vi.advanceTimersByTime(100);
    }

    expect(onSilence).not.toHaveBeenCalled();
  });
});
