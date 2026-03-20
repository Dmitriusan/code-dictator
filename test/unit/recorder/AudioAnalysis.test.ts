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

/** Create a WAV buffer with silence (all zeros). */
function createSilentWav(durationMs: number): Buffer {
  const samples = Math.floor(16000 * (durationMs / 1000));
  const dataSize = samples * 2;
  const header = createWavHeader(dataSize);
  const data = Buffer.alloc(dataSize, 0); // all zeros
  return Buffer.concat([header, data]);
}

/** Create a WAV buffer with a tone at the given amplitude. */
function createToneWav(durationMs: number, amplitude: number): Buffer {
  const samples = Math.floor(16000 * (durationMs / 1000));
  const dataSize = samples * 2;
  const header = createWavHeader(dataSize);
  const data = Buffer.alloc(dataSize);
  const freq = 440; // Hz
  for (let i = 0; i < samples; i++) {
    const value = Math.round(amplitude * Math.sin(2 * Math.PI * freq * i / 16000));
    data.writeInt16LE(Math.max(-32768, Math.min(32767, value)), i * 2);
  }
  return Buffer.concat([header, data]);
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
