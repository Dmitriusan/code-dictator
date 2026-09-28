import { describe, it, expect } from 'vitest';
import { isAudioSilent } from '../../../src/recorder/AudioAnalysis';

/** Create a minimal WAV header for 16-bit mono 16kHz PCM. */
function createWavHeader(dataSize: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(dataSize + 36, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);       // PCM
  header.writeUInt16LE(1, 22);       // mono
  header.writeUInt32LE(16000, 24);   // sample rate
  header.writeUInt32LE(32000, 28);   // byte rate
  header.writeUInt16LE(2, 32);       // block align
  header.writeUInt16LE(16, 34);      // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return header;
}

/** Raw 16-bit PCM of a 440 Hz tone at the given amplitude (0 = digital silence). */
function createTonePcm(durationMs: number, amplitude: number): Buffer {
  const samples = Math.floor(16000 * (durationMs / 1000));
  const data = Buffer.alloc(samples * 2);
  const freq = 440; // Hz
  for (let i = 0; i < samples; i++) {
    const value = Math.round(amplitude * Math.sin(2 * Math.PI * freq * i / 16000));
    data.writeInt16LE(Math.max(-32768, Math.min(32767, value)), i * 2);
  }
  return data;
}

/** Wrap PCM segments, played back to back, in a WAV file. */
function createWav(...segments: Buffer[]): Buffer {
  const data = Buffer.concat(segments);
  return Buffer.concat([createWavHeader(data.length), data]);
}

/** Create a WAV buffer with silence (all zeros). */
function createSilentWav(durationMs: number): Buffer {
  return createWav(createTonePcm(durationMs, 0));
}

/** Create a WAV buffer with a tone at the given amplitude. */
function createToneWav(durationMs: number, amplitude: number): Buffer {
  return createWav(createTonePcm(durationMs, amplitude));
}

describe('isAudioSilent', () => {
  it('returns true for all-zero samples (digital silence)', () => {
    const wav = createSilentWav(500); // 500ms of silence
    expect(isAudioSilent(wav)).toBe(true);
  });

  it('returns true for very low noise (-90 dBFS)', () => {
    // amplitude ~1 out of 32768 → about -90 dBFS
    const wav = createToneWav(500, 1);
    expect(isAudioSilent(wav)).toBe(true);
  });

  it('returns false for normal speech-level audio (-30 dBFS)', () => {
    // amplitude ~1000 → about -30 dBFS
    const wav = createToneWav(500, 1000);
    expect(isAudioSilent(wav)).toBe(false);
  });

  it('returns false for quiet but audible audio (-60 dBFS)', () => {
    // amplitude ~33 → about -60 dBFS (well above -80 threshold)
    const wav = createToneWav(500, 33);
    expect(isAudioSilent(wav)).toBe(false);
  });

  it('returns false when speech starts after a near-silent opening', () => {
    // Noise-suppressed mics emit near-digital silence until the speaker starts.
    // Regression: only the first second was checked, so a long dictation whose
    // speech began ~1s in was discarded as "microphone is producing silence".
    const wav = createWav(
      createTonePcm(2000, 1),     // ~-93 dBFS before the speaker starts
      createTonePcm(5000, 3000),  // speech at ~-21 dBFS
    );
    expect(isAudioSilent(wav)).toBe(false);
  });

  it('returns false when the only speech is a short burst late in a long recording', () => {
    const wav = createWav(
      createTonePcm(30_000, 0),
      createTonePcm(300, 1000),
    );
    expect(isAudioSilent(wav)).toBe(false);
  });

  it('returns true for a long recording that is silent throughout', () => {
    const wav = createToneWav(30_000, 1);
    expect(isAudioSilent(wav)).toBe(true);
  });

  it('finds the samples when extra chunks precede the data chunk', () => {
    // ffmpeg writes a LIST/INFO chunk between fmt and data, so the samples
    // don't start at byte 44 — its text must not be read as audio.
    const info = Buffer.from('INFOISFT\x0e\x00\x00\x00Lavf61.7.100\x00\x00', 'latin1');
    const list = Buffer.concat([Buffer.from('LIST'), Buffer.alloc(4), info]);
    list.writeUInt32LE(info.length, 4);
    const withList = (pcm: Buffer): Buffer => {
      const header = createWavHeader(pcm.length);
      header.writeUInt32LE(pcm.length + 36 + list.length, 4);
      return Buffer.concat([header.subarray(0, 36), list, header.subarray(36), pcm]);
    };

    expect(isAudioSilent(withList(createTonePcm(1000, 0)))).toBe(true);
    expect(isAudioSilent(withList(createTonePcm(1000, 1000)))).toBe(false);
  });

  it('reads to the end of the buffer when the data size is a placeholder', () => {
    // A header written before recording started may still carry the maximum size
    const silent = createSilentWav(1000);
    silent.writeUInt32LE(0x7FFFFFFF - 36, 40);
    expect(isAudioSilent(silent)).toBe(true);

    const speech = createWav(createTonePcm(1000, 0), createTonePcm(500, 1000));
    speech.writeUInt32LE(0x7FFFFFFF - 36, 40);
    expect(isAudioSilent(speech)).toBe(false);
  });

  it('returns false for compressed audio it cannot analyze (webm)', () => {
    const webm = Buffer.alloc(40_000);
    webm.writeUInt32BE(0x1A45DFA3, 0); // EBML magic
    expect(isAudioSilent(webm)).toBe(false);
  });

  it('returns false for buffer too small to analyze', () => {
    const header = createWavHeader(100);
    const data = Buffer.alloc(100, 0);
    const wav = Buffer.concat([header, data]);
    expect(isAudioSilent(wav)).toBe(false);
  });

  it('returns false for empty buffer', () => {
    expect(isAudioSilent(Buffer.alloc(0))).toBe(false);
  });

  it('returns false for header-only buffer', () => {
    expect(isAudioSilent(createWavHeader(0))).toBe(false);
  });
});
