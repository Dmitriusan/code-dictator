import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FailedRecordings } from '../../../src/storage/FailedRecordings';

describe('FailedRecordings', () => {
  let root: string;
  let dir: string;
  let store: FailedRecordings;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'failed-recordings-test-'));
    dir = path.join(root, 'failed-recordings'); // created lazily on first save
    store = new FailedRecordings(dir);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps a recording that can be read back byte for byte', async () => {
    const buffer = Buffer.from('RIFF....WAVEfmt audio bytes');
    const saved = await store.save({ buffer, mimeType: 'audio/wav', durationMs: 72000 });

    expect(saved.mimeType).toBe('audio/wav');
    expect(saved.durationMs).toBe(72000);
    expect(path.dirname(saved.file)).toBe(dir);

    const audio = await store.read(saved);
    expect(audio?.buffer.equals(buffer)).toBe(true);
    expect(audio?.mimeType).toBe('audio/wav');
    expect(audio?.durationMs).toBe(72000);
  });

  it('lists saved recordings newest first, with their metadata', async () => {
    const first = await store.save({ buffer: Buffer.from('a'), mimeType: 'audio/wav', durationMs: 1000 });
    const second = await store.save({ buffer: Buffer.from('b'), mimeType: 'audio/wav', durationMs: 1000 });

    const listed = await store.list();
    expect(listed).toEqual([second, first]);
  });

  it('survives a restart: a new store over the same folder sees the recordings', async () => {
    const saved = await store.save({ buffer: Buffer.from('audio'), mimeType: 'audio/wav', durationMs: 5000 });
    expect(await new FailedRecordings(dir).list()).toEqual([saved]);
  });

  it('keeps webm/ogg audio from the webview recorder retryable', async () => {
    const webm = await store.save({ buffer: Buffer.from('webm'), mimeType: 'audio/webm;codecs=opus', durationMs: 3000 });
    const ogg = await store.save({ buffer: Buffer.from('ogg'), mimeType: 'audio/ogg;codecs=opus', durationMs: 3000 });

    expect(webm.file.endsWith('.webm')).toBe(true);
    expect(webm.mimeType).toBe('audio/webm');
    expect(ogg.file.endsWith('.ogg')).toBe(true);
    expect(ogg.mimeType).toBe('audio/ogg');
  });

  it('removes a recording once it is no longer needed', async () => {
    const saved = await store.save({ buffer: Buffer.from('audio'), mimeType: 'audio/wav', durationMs: 1000 });
    await store.remove(saved);

    expect(await store.list()).toEqual([]);
    expect(await store.read(saved)).toBeUndefined();
    await expect(store.remove(saved)).resolves.toBeUndefined(); // already gone is fine
  });

  it('keeps only the 10 most recent recordings', async () => {
    const saved = [];
    for (let i = 0; i < 12; i++) {
      saved.push(await store.save({ buffer: Buffer.from(`take ${i}`), mimeType: 'audio/wav', durationMs: 1000 }));
    }

    const listed = await store.list();
    expect(listed).toHaveLength(10);
    expect(listed).toEqual(saved.slice(2).reverse());
    expect(fs.readdirSync(dir)).toHaveLength(10);
  });

  it('ignores files it did not write, including interrupted saves', async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '1790000000000-5000.wav.partial'), 'truncated');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello');
    fs.writeFileSync(path.join(dir, '1790000000000-5000.flac'), 'unknown format');

    expect(await store.list()).toEqual([]);
  });

  it('lists nothing before anything was saved', async () => {
    expect(await store.list()).toEqual([]);
  });
});
