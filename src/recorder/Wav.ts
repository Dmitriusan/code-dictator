/** Where the samples of a WAV file are, and what they are. */
export interface WavLayout {
  /** 1 for integer PCM; WAVE_FORMAT_EXTENSIBLE files report their sub-format here. */
  format: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  /** Bytes of one sample frame: one sample of every channel. */
  blockAlign: number;
  /** Byte offset of the first sample. */
  dataStart: number;
  /**
   * The size the `data` chunk declares. A recorder that is still writing leaves
   * 0 or a placeholder here and puts the real size in when it closes the file.
   */
  declaredDataSize: number;
}

/** WAVE_FORMAT_PCM. */
export const WAV_FORMAT_PCM = 1;
const WAV_FORMAT_EXTENSIBLE = 0xFFFE;

/**
 * Read the layout of a WAV by walking its RIFF chunks: the samples don't
 * always start at byte 44 (ffmpeg writes a LIST chunk before `data`, and a
 * header can carry other chunks too). Returns null for anything else,
 * including compressed webm/ogg, and for a header that is not complete yet.
 */
export function parseWavLayout(buffer: Buffer): WavLayout | null {
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }

  let fmt: Omit<WavLayout, 'dataStart' | 'declaredDataSize'> | undefined;
  for (let pos = 12; pos + 8 <= buffer.length;) {
    const chunkId = buffer.toString('ascii', pos, pos + 4);
    const chunkSize = buffer.readUInt32LE(pos + 4);
    const body = pos + 8;

    if (chunkId === 'fmt ') {
      if (chunkSize < 16 || body + 16 > buffer.length) {
        return null;
      }
      let format = buffer.readUInt16LE(body);
      if (format === WAV_FORMAT_EXTENSIBLE && chunkSize >= 40 && body + 26 <= buffer.length) {
        format = buffer.readUInt16LE(body + 24); // the first two bytes of the sub-format GUID
      }
      fmt = {
        format,
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        blockAlign: buffer.readUInt16LE(body + 12),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (chunkId === 'data') {
      return fmt ? { ...fmt, dataStart: body, declaredDataSize: chunkSize } : null;
    }

    pos = body + chunkSize + (chunkSize % 2); // chunks are word-aligned
  }
  return null;
}

/**
 * Byte offset just past the last sample of a complete WAV file: the declared
 * end, or the end of the file when the header was never finalized (it then
 * declares 0 or a placeholder larger than the file).
 */
export function wavDataEnd(layout: WavLayout, fileLength: number): number {
  const declaredEnd = layout.dataStart + layout.declaredDataSize;
  return layout.declaredDataSize > 0 && declaredEnd <= fileLength ? declaredEnd : fileLength;
}

/** 16-bit integer PCM, the format every native recorder is asked for. */
export function isPcm16(layout: WavLayout): boolean {
  return layout.format === WAV_FORMAT_PCM && layout.bitsPerSample === 16 && layout.channels > 0
    && layout.sampleRate > 0 && layout.blockAlign === layout.channels * 2;
}

/** A WAV file of PCM samples in the given layout, with a plain 44-byte header. */
export function buildWav(layout: Pick<WavLayout, 'channels' | 'sampleRate' | 'bitsPerSample' | 'blockAlign'>, pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(WAV_FORMAT_PCM, 20);
  header.writeUInt16LE(layout.channels, 22);
  header.writeUInt32LE(layout.sampleRate, 24);
  header.writeUInt32LE(layout.sampleRate * layout.blockAlign, 28);
  header.writeUInt16LE(layout.blockAlign, 32);
  header.writeUInt16LE(layout.bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
