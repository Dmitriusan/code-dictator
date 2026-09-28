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
 * Locate the samples of a 16-bit PCM WAV by walking its RIFF chunks — they
 * don't always start at byte 44 (ffmpeg writes a LIST chunk before `data`).
 * Returns null for anything else, including compressed webm/ogg.
 */
function findPcm16Data(buffer: Buffer): Pcm16Data | null {
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }

  let samplesPerSecond = 0;
  for (let pos = 12; pos + 8 <= buffer.length;) {
    const chunkId = buffer.toString('ascii', pos, pos + 4);
    const chunkSize = buffer.readUInt32LE(pos + 4);
    const body = pos + 8;

    if (chunkId === 'fmt ') {
      if (body + 16 > buffer.length) return null;
      const audioFormat = buffer.readUInt16LE(body);
      const bitsPerSample = buffer.readUInt16LE(body + 14);
      // 1 = PCM; 0xFFFE = WAVE_FORMAT_EXTENSIBLE, which at 16 bits is integer PCM too
      if ((audioFormat !== 1 && audioFormat !== 0xFFFE) || bitsPerSample !== 16) return null;
      samplesPerSecond = buffer.readUInt32LE(body + 4) * buffer.readUInt16LE(body + 2);
    } else if (chunkId === 'data') {
      if (samplesPerSecond === 0) return null;
      // A header written before recording started (or never finalized) can
      // declare 0 or a placeholder maximum — the bytes actually present count.
      const declaredEnd = body + chunkSize;
      const end = chunkSize > 0 && declaredEnd <= buffer.length ? declaredEnd : buffer.length;
      return { start: body, end, samplesPerSecond };
    }

    pos = body + chunkSize + (chunkSize % 2); // chunks are word-aligned
  }
  return null;
}
