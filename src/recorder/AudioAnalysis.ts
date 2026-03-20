/**
 * Check if a WAV audio buffer contains only silence (near-zero samples).
 * Returns true if the RMS level is below -80 dBFS, which indicates the
 * microphone is producing zero samples (e.g. PipeWire lost hardware,
 * default source is a null monitor).
 */
export function isAudioSilent(buffer: Buffer): boolean {
  // WAV header is 44 bytes; PCM data follows as 16-bit signed LE samples
  const headerSize = 44;
  if (buffer.length <= headerSize + 200) return false; // too small to tell

  // Sample a portion of the audio (up to 32KB ≈ 1 second at 16kHz mono 16-bit)
  const sampleEnd = Math.min(buffer.length, headerSize + 32000);
  let sumSquares = 0;
  let sampleCount = 0;
  for (let i = headerSize; i < sampleEnd - 1; i += 2) {
    const sample = buffer.readInt16LE(i);
    sumSquares += sample * sample;
    sampleCount++;
  }
  if (sampleCount === 0) return false;

  const rms = Math.sqrt(sumSquares / sampleCount);
  const dbfs = rms > 0 ? 20 * Math.log10(rms / 32768) : -96;

  // -80 dBFS is well below any real speech or ambient noise
  return dbfs < -80;
}
