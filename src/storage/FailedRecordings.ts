import * as fs from 'fs';
import * as path from 'path';
import type { AudioDataPayload } from '../types';

/** A recording whose transcription failed, kept on disk so it can be sent again. */
export interface FailedRecording {
  /** Absolute path of the saved audio. */
  file: string;
  mimeType: string;
  durationMs: number;
  /** When the recording was saved, in ms since the epoch. */
  savedAt: number;
}

/** Older recordings beyond this many are deleted; at the 5-minute cap each is ~10 MB. */
const MAX_KEPT = 10;

const EXTENSION_BY_MIME: Record<string, string> = {
  'audio/wav': 'wav',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
};
const MIME_BY_EXTENSION = Object.fromEntries(
  Object.entries(EXTENSION_BY_MIME).map(([mime, ext]) => [ext, mime]),
);

/**
 * Keeps recordings whose transcription failed (quota, rate limit, network) so
 * they can be retried instead of dictated again. Files are named
 * `<savedAt>-<durationMs>.<ext>`, which is all the metadata a retry needs.
 */
export class FailedRecordings {
  private lastSavedAt = 0;

  constructor(private readonly dir: string) {}

  async save(audio: AudioDataPayload): Promise<FailedRecording> {
    await fs.promises.mkdir(this.dir, { recursive: true });

    // Strictly increasing, so two saves never share a file name
    const savedAt = Math.max(Date.now(), this.lastSavedAt + 1);
    this.lastSavedAt = savedAt;
    const baseMime = audio.mimeType.split(';')[0].trim();
    const ext = EXTENSION_BY_MIME[baseMime] ?? 'webm'; // the webview's MediaRecorder default
    const durationMs = Math.round(audio.durationMs);
    const file = path.join(this.dir, `${savedAt}-${durationMs}.${ext}`);

    // Write under a temporary name so a crash can't leave a truncated file to retry
    const partial = `${file}.partial`;
    await fs.promises.writeFile(partial, audio.buffer);
    await fs.promises.rename(partial, file);

    for (const stale of (await this.list()).slice(MAX_KEPT)) {
      await this.remove(stale);
    }
    return { file, mimeType: MIME_BY_EXTENSION[ext], durationMs, savedAt };
  }

  /** Saved recordings, newest first. */
  async list(): Promise<FailedRecording[]> {
    let names: string[];
    try {
      names = await fs.promises.readdir(this.dir);
    } catch {
      return []; // nothing has been saved yet
    }

    const recordings: FailedRecording[] = [];
    for (const name of names) {
      const match = /^(\d+)-(\d+)\.(\w+)$/.exec(name);
      const mimeType = match ? MIME_BY_EXTENSION[match[3]] : undefined;
      if (match && mimeType) {
        recordings.push({
          file: path.join(this.dir, name),
          mimeType,
          durationMs: Number(match[2]),
          savedAt: Number(match[1]),
        });
      }
    }
    return recordings.sort((a, b) => b.savedAt - a.savedAt);
  }

  /** The saved audio, or undefined once the recording has been retried or removed. */
  async read(recording: FailedRecording): Promise<AudioDataPayload | undefined> {
    try {
      const buffer = await fs.promises.readFile(recording.file);
      return { buffer, mimeType: recording.mimeType, durationMs: recording.durationMs };
    } catch {
      return undefined;
    }
  }

  async remove(recording: FailedRecording): Promise<void> {
    await fs.promises.rm(recording.file, { force: true });
  }
}
