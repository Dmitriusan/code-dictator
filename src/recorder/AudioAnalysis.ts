import { parseWavLayout, wavDataEnd } from './Wav';

/** Quieter than any live microphone; real speech and ambient noise sit far above it. */
const SILENCE_DBFS = -80;
/** Loudness is judged per window, the same 100 ms granularity as the native recorder's VAD. */
const WINDOW_MS = 100;
/** Below this much sample data there is too little audio to tell. */
const MIN_DATA_BYTES = 200;

/**
 * Check if a WAV audio buffer contains only silence (near-zero samples).
 * Returns true only if every 100 ms window is below -80 dBFS, which indicates
 * the microphone is producing zero samples (e.g. PipeWire lost hardware,
 * default source is a null monitor).
 *
 * The whole recording is scanned, not just its start: mics with noise
 * suppression emit near-digital silence until the speaker begins, so a quiet
 * opening says nothing about the minutes that follow.
 *
 * Returns false whenever it can't tell (too short, or not 16-bit PCM WAV —
 * e.g. webm from the webview recorder), so audio is never discarded on a guess.
 */
export function isAudioSilent(buffer: Buffer): boolean {
  const pcm = findPcm16Data(buffer);
  if (!pcm || pcm.end - pcm.start < MIN_DATA_BYTES) return false;

  const windowBytes = Math.max(1, Math.round(pcm.samplesPerSecond * WINDOW_MS / 1000)) * 2;
  for (let windowStart = pcm.start; windowStart < pcm.end; windowStart += windowBytes) {
    const windowEnd = Math.min(windowStart + windowBytes, pcm.end);
    let sumSquares = 0;
    let sampleCount = 0;
    for (let i = windowStart; i < windowEnd - 1; i += 2) {
      const sample = buffer.readInt16LE(i);
      sumSquares += sample * sample;
      sampleCount++;
    }
    if (sampleCount === 0) continue;

    const rms = Math.sqrt(sumSquares / sampleCount);
    const dbfs = rms > 0 ? 20 * Math.log10(rms / 32768) : -96;
    if (dbfs >= SILENCE_DBFS) return false; // any audible stretch means the mic is live
  }
  return true;
}

interface Pcm16Data {
  /** Byte offset of the first sample. */
  start: number;
  /** Byte offset just past the last sample. */
  end: number;
  /** Interleaved samples per second (sample rate × channels). */
  samplesPerSecond: number;
}

/**
 * Locate the samples of a 16-bit PCM WAV (see parseWavLayout: they don't
 * always start at byte 44). Returns null for anything else, including
 * compressed webm/ogg.
 */
function findPcm16Data(buffer: Buffer): Pcm16Data | null {
  const layout = parseWavLayout(buffer);
  // 1 = PCM; 0xFFFE = WAVE_FORMAT_EXTENSIBLE, which at 16 bits is integer PCM too
  if (!layout || (layout.format !== 1 && layout.format !== 0xFFFE) || layout.bitsPerSample !== 16) return null;
  const samplesPerSecond = layout.sampleRate * layout.channels;
  if (samplesPerSecond === 0) return null;
  // A header written before recording started (or never finalized) can
  // declare 0 or a placeholder maximum — the bytes actually present count.
  return { start: layout.dataStart, end: wavDataEnd(layout, buffer.length), samplesPerSecond };
}
