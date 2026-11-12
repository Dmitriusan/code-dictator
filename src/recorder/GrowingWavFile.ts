import * as fs from 'fs';
import type { FileHandle } from 'fs/promises';
import { isPcm16, parseWavLayout, type WavLayout } from './Wav';

/** How far into the file the `data` chunk may start. */
const MAX_HEADER_BYTES = 64 * 1024;
/** The most bytes one read takes: 32 s of 16 kHz mono 16-bit audio. */
const MAX_READ_BYTES = 1024 * 1024;

const EMPTY = Buffer.alloc(0);

/**
 * A WAV file that a recorder is still writing. Its header is read once it is
 * complete, and each read() then returns the whole sample frames appended
 * since the last one. The size in the header is never used: recorders fill it
 * in only when they close the file.
 */
export class GrowingWavFile {
  private layout: WavLayout | undefined;
  /** Byte offset of the next byte to read. */
  private position = 0;
  /** The start of a frame whose last bytes have not arrived yet. */
  private partial = EMPTY;

  private constructor(private readonly handle: FileHandle) {}

  static async open(file: string): Promise<GrowingWavFile> {
    return new GrowingWavFile(await fs.promises.open(file, 'r'));
  }

  /** The samples' layout, once the header is complete. */
  get format(): WavLayout | undefined {
    return this.layout;
  }

  /**
   * The whole frames appended since the last call: empty while nothing new has
   * arrived or the header is still incomplete. Throws for a file that is not
   * 16-bit PCM WAV.
   */
  async read(): Promise<Buffer> {
    const { size } = await this.handle.stat();
    if (!this.layout) {
      const head = await this.readAt(0, Math.min(size, MAX_HEADER_BYTES));
      const layout = parseWavLayout(head);
      if (!layout) {
        if (head.length >= MAX_HEADER_BYTES) {
          throw new Error(`no WAV data chunk in the first ${MAX_HEADER_BYTES} bytes`);
        }
        return EMPTY;
      }
      if (!isPcm16(layout)) {
        throw new Error(`not 16-bit PCM (format ${layout.format}, ${layout.bitsPerSample} bits, ${layout.channels} channels)`);
      }
      this.layout = layout;
      this.position = layout.dataStart;
    }
    if (size <= this.position) {
      return EMPTY;
    }

    const bytes = await this.readAt(this.position, Math.min(size - this.position, MAX_READ_BYTES));
    this.position += bytes.length;
    const all = this.partial.length > 0 ? Buffer.concat([this.partial, bytes]) : bytes;
    const whole = all.length - (all.length % this.layout.blockAlign);
    this.partial = Buffer.from(all.subarray(whole));
    return all.subarray(0, whole);
  }

  async close(): Promise<void> {
    await this.handle.close().catch(() => undefined);
  }

  private async readAt(position: number, length: number): Promise<Buffer> {
    const buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await this.handle.read(buffer, filled, length - filled, position + filled);
      if (bytesRead === 0) {
        break;
      }
      filled += bytesRead;
    }
    return filled === length ? buffer : buffer.subarray(0, filled);
  }
}
