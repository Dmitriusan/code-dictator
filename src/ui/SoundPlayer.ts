import { execFile } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFile, unlink } from 'fs/promises';
import { diagLog } from '../DiagnosticLog';

/**
 * Generates a tiny WAV buffer containing a two-note ascending chime (E5 → G5).
 * Pure sine tones, 16-bit mono 22050 Hz — about 8 KB total.
 */
function generateChimeWav(): Buffer {
  const sampleRate = 22050;
  const noteDuration = 0.12;
  const gap = 0.06;
  const frequencies = [659.25, 783.99]; // E5, G5
  const amplitude = 0.3;

  const totalDuration = frequencies.length * noteDuration + (frequencies.length - 1) * gap;
  const numSamples = Math.ceil(sampleRate * totalDuration);
  const dataSize = numSamples * 2; // 16-bit = 2 bytes per sample

  // WAV header (44 bytes)
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);      // PCM subchunk size
  header.writeUInt16LE(1, 20);       // PCM format
  header.writeUInt16LE(1, 22);       // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32);       // block align
  header.writeUInt16LE(16, 34);      // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  // PCM data
  const data = Buffer.alloc(dataSize);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    let sample = 0;

    for (let n = 0; n < frequencies.length; n++) {
      const noteStart = n * (noteDuration + gap);
      const noteEnd = noteStart + noteDuration;
      if (t >= noteStart && t < noteEnd) {
        const noteT = t - noteStart;
        // Quick fade-in (10ms) and exponential fade-out
        const fadeIn = Math.min(1, noteT / 0.01);
        const fadeOut = Math.exp(-noteT * 15);
        const envelope = fadeIn * fadeOut * amplitude;
        sample += Math.sin(2 * Math.PI * frequencies[n] * noteT) * envelope;
      }
    }

    const int16 = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
    data.writeInt16LE(int16, i * 2);
  }

  return Buffer.concat([header, data]);
}

/** Cached WAV buffer — generated once, reused. */
let cachedWav: Buffer | null = null;

/**
 * Plays a short completion chime using OS-native audio playback.
 * Works cross-platform: aplay (Linux), afplay (macOS), PowerShell (Windows).
 */
export async function playCompletionChime(): Promise<void> {
  if (!cachedWav) {
    cachedWav = generateChimeWav();
  }

  const tmpPath = join(tmpdir(), `code-dictator-chime-${process.pid}.wav`);

  try {
    await writeFile(tmpPath, cachedWav);

    const cmd = process.platform === 'darwin'
      ? 'afplay'
      : process.platform === 'win32'
        ? 'powershell'
        : 'aplay';

    const args = process.platform === 'win32'
      ? ['-c', `(New-Object Media.SoundPlayer '${tmpPath}').PlaySync()`]
      : [tmpPath];

    await new Promise<void>((resolve, reject) => {
      execFile(cmd, args, { timeout: 5000 }, (error) => {
        // Clean up temp file regardless of outcome
        unlink(tmpPath).catch(() => {});
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  } catch (err) {
    diagLog('SoundPlayer', `Completion chime failed: ${err instanceof Error ? err.message : String(err)}`);
    // Clean up on error
    unlink(tmpPath).catch(() => {});
  }
}
