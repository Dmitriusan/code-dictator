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

interface PlayerCommand {
  cmd: string;
  args: string[];
}

/**
 * OS audio-player commands to try, in priority order, for the given file.
 * On Linux we prefer PipeWire/PulseAudio players (which route to the user's
 * default sink, including Bluetooth) before raw-ALSA `aplay` — mirroring the
 * recorder's tool preference. macOS and Windows each have one reliable built-in.
 */
function playerCandidates(tmpPath: string): PlayerCommand[] {
  if (process.platform === 'darwin') {
    return [{ cmd: 'afplay', args: [tmpPath] }];
  }
  if (process.platform === 'win32') {
    return [{ cmd: 'powershell', args: ['-c', `(New-Object Media.SoundPlayer '${tmpPath}').PlaySync()`] }];
  }
  // Linux: PipeWire → PulseAudio → ALSA.
  return [
    { cmd: 'pw-play', args: [tmpPath] },
    { cmd: 'paplay', args: [tmpPath] },
    { cmd: 'aplay', args: [tmpPath] },
  ];
}

/**
 * Plays a short completion chime using OS-native audio playback.
 * Cross-platform: pw-play/paplay/aplay (Linux), afplay (macOS), PowerShell (Windows).
 */
export async function playCompletionChime(): Promise<void> {
  if (!cachedWav) {
    cachedWav = generateChimeWav();
  }

  const tmpPath = join(tmpdir(), `code-dictator-chime-${process.pid}.wav`);

  try {
    await writeFile(tmpPath, cachedWav);

    // Try each candidate until one plays successfully. A missing command
    // (ENOENT) or playback error falls through to the next candidate.
    let lastError: Error | undefined;
    for (const { cmd, args } of playerCandidates(tmpPath)) {
      try {
        await new Promise<void>((resolve, reject) => {
          execFile(cmd, args, { timeout: 5000 }, (error) => {
            if (error) { reject(error); } else { resolve(); }
          });
        });
        lastError = undefined;
        break; // played successfully
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    if (lastError) {
      diagLog('SoundPlayer', `Completion chime failed: ${lastError.message}`);
    }
  } catch (err) {
    diagLog('SoundPlayer', `Completion chime failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    // Clean up the temp file regardless of outcome.
    unlink(tmpPath).catch(() => {});
  }
}
