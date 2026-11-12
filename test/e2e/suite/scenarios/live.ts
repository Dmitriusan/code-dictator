import type { Harness } from '../harness';
import { filePart, sha1, transcript, type RecordedRequest } from '../mockStt';
import {
  MIC_CANCELLED,
  WHISPER_PROMPT,
  cancel,
  clipboard,
  leftoverTempRecordings,
  notes,
  openFile,
  setText,
  startRecording,
  toggle,
  useMockProvider,
  type Scenario,
} from '../steps';
import type { Marker } from '../safety';
import { check, clock, isAlive, show, sleep, waitFor } from '../util';

/** The samples of an uploaded part, after checking that its WAV header describes exactly them. */
function uploadedPcm(request: RecordedRequest): Buffer {
  const file = filePart(request);
  check(file?.filename === 'recording.wav' && file.contentType === 'audio/wav', `file part ${show({ filename: file?.filename, type: file?.contentType })}`);
  const wav = file.data;
  check(wav.length >= 44 && wav.toString('latin1', 0, 4) === 'RIFF' && wav.toString('latin1', 36, 40) === 'data', 'an upload is not a plain 44-byte-header WAV');
  check(wav.readUInt16LE(20) === 1 && wav.readUInt16LE(22) === 1 && wav.readUInt32LE(24) === 16000 && wav.readUInt16LE(34) === 16,
    `an upload is not 16 kHz mono 16-bit PCM: ${show([...wav.subarray(20, 36)])}`);
  check(wav.readUInt32LE(40) === wav.length - 44 && wav.readUInt32LE(4) === wav.length - 8, 'an upload declares the wrong sizes');
  return wav.subarray(44);
}

/** Seconds of 16 kHz mono 16-bit audio. */
const seconds = (pcm: Buffer) => pcm.length / 32000;

/** What neighbouring uploads share: 2.5 s of audio on either side of the cut between them. */
const OVERLAP_BYTES = 5 * 32000;

/** The recording put back together from uploads that overlap by 5 s, after checking that each overlap is the same audio. */
function rejoin(parts: Buffer[]): Buffer | undefined {
  let joined = parts[0];
  for (const part of parts.slice(1)) {
    if (joined.length < OVERLAP_BYTES || part.length < OVERLAP_BYTES
      || !joined.subarray(joined.length - OVERLAP_BYTES).equals(part.subarray(0, OVERLAP_BYTES))) {
      return undefined;
    }
    joined = Buffer.concat([joined, part.subarray(OVERLAP_BYTES)]);
  }
  return joined;
}

/** The file the dictation recorder wrote, once it has been stopped and has filled in its header. */
async function wrote(h: Harness, start: Marker): Promise<Marker> {
  return waitFor('the recorder to finish its file', () => h.fakes.wroteOf(start.pid), 4000);
}

/** The prompt field of an upload. */
function prompt(request: RecordedRequest): string | undefined {
  return request.parts.find((p) => p.name === 'prompt')?.data.toString('utf8');
}

/**
 * With the setting on (it is off by default), long dictations are cut at a
 * pause and transcribed in parts while the recorder still runs; the rest goes
 * after the stop. Neighbouring uploads share the 5 s around their cut (2.5 s
 * on either side) and leave nothing out, and their texts arrive joined, the
 * words both heard once. Also:
 * the setting off; a part that fails twice and goes again with the next one;
 * parts that all fail (the whole recording goes instead); Escape with a part
 * in flight, and with the rest in flight. The fake recorder streams a
 * dictation at 8× real time, with 1.2 s pauses at 41 s, 63 s, 85 s... of
 * audio. The language is auto-detected, so a part waits until 6 s of speech
 * follow it.
 */
export const liveTranscription: Scenario = async (ctx) => {
  const { h, expect, observe } = ctx;
  await useMockProvider(h, { 'output.target': 'editor', 'recording.transcribeWhileSpeaking': true });
  const editor = await openFile(ctx, 'live.txt', '');
  h.fakes.setMode('dictation');

  // 1. The first part is uploaded during the recording, the rest after the stop
  // Each heard the 5 s around the cut: the first up to "and then", the rest from "part," on
  h.stt.respond((_request, index) => transcript(index === 0 ? 'the first part, and then' : 'part, and then more'));
  let t = clock();
  let start = await startRecording(h);
  const first = await waitFor('a part uploaded while recording', () => h.stt.requests[0], 20_000);
  expect(isAlive(start.pid) && h.fakes.signalsOf(start.pid).length === 0, 'the recorder had already stopped when the first part was uploaded');
  await sleep(600);
  const stoppedAt = clock();
  await toggle();
  await waitFor('the joined transcript', () => editor.document.getText() !== '', 6000).catch(() => undefined);
  const file = await wrote(h, start);
  observe('liveUploads', h.stt.requests.map((r) => ({ receivedMs: Math.round(r.receivedAt - t), bytes: r.bodyBytes })));

  expect(editor.document.getText() === 'The first part, and then more', `document ${show(editor.document.getText())}`);
  expect(h.stt.requests.length === 2, `${h.stt.requests.length} uploads, expected the first part and the rest`);
  expect(first.receivedAt < stoppedAt, 'the first part was not uploaded before the stop');
  const parts = h.stt.requests.map(uploadedPcm);
  observe('livePartSeconds', parts.map((p) => Math.round(seconds(p) * 100) / 100));
  expect(seconds(parts[0]) >= 43.6 && seconds(parts[0]) <= 44.1,
    `the first upload holds ${seconds(parts[0])} s, expected a cut in the pause at 41–42.2 s and 2.5 s past it`);
  const joined = rejoin(parts);
  expect(joined !== undefined && joined.length === file.pcmBytes && sha1(joined) === file.pcmSha1,
    `the uploads (${parts.map((p) => p.length).join(' + ')} bytes) are not the recording (${file.pcmBytes} bytes) with 5 s shared at the cut`);
  expect(h.stt.requests.every((r) => prompt(r) === WHISPER_PROMPT), `the prompts ${show(h.stt.requests.map(prompt))}, expected the vocabulary hint for each part`);
  expect(h.diag.since(t).some((l) => l.includes('[Live] Part 1: cut at')), 'no "[Live] Part 1: cut at" diagnostic line');
  expect(h.ui.notifications(t).length === 0, `notifications ${show(notes(h.ui.notifications(t)))}`);
  expect(leftoverTempRecordings().length === 0, `temporary recordings left: ${show(leftoverTempRecordings())}`);

  // 2. Off: one upload of the whole recording after the stop, as before
  await h.configure({ 'recording.transcribeWhileSpeaking': false });
  await setText(editor, '');
  h.stt.reset();
  h.stt.reply(transcript('all at once'));
  start = await startRecording(h);
  await sleep(7500); // 60 s of audio, past the pause at 41 s
  await toggle();
  await waitFor('the transcript', () => editor.document.getText() === 'All at once', 6000).catch(() => undefined);
  const whole = await wrote(h, start);
  expect(editor.document.getText() === 'All at once', `document with the setting off ${show(editor.document.getText())}`);
  expect(h.stt.requests.length === 1 && sha1(filePart(h.stt.requests[0])!.data) === whole.sha1,
    `with the setting off: ${h.stt.requests.length} uploads, the first ${h.stt.requests[0] ? 'not ' : ''}the recorder's file`);
  await h.configure({ 'recording.transcribeWhileSpeaking': true });

  // 3. A part that fails twice goes again with the next part
  await setText(editor, '');
  h.stt.reset();
  h.stt.respond((_request, index) => index < 2 ? { status: 500, body: { error: 'boom' } } : transcript(index === 2 ? 'two parts in one, and the' : 'in one, and the rest'));
  t = clock();
  start = await startRecording(h);
  const merged = await waitFor('the two parts, sent again together', () => h.stt.requests[2], 25_000);
  await sleep(300);
  await toggle();
  await waitFor('the transcript', () => editor.document.getText() !== '', 6000).catch(() => undefined);
  const retried = await wrote(h, start);
  expect(editor.document.getText() === 'Two parts in one, and the rest', `document after a part failed twice ${show(editor.document.getText())}`);
  expect(h.stt.requests.length === 4, `${h.stt.requests.length} uploads after a part failed twice, expected 2 failed, the merged parts and the rest`);
  const sent = h.stt.requests.slice(2).map(uploadedPcm);
  expect(seconds(uploadedPcm(merged)) > 63 + 2.5, `the merged request holds ${seconds(uploadedPcm(merged))} s, expected both parts`);
  const rejoined = rejoin(sent);
  expect(rejoined !== undefined && sha1(rejoined) === retried.pcmSha1, 'what was transcribed after the failure is not the recording with 5 s shared at the cut');
  expect(h.ui.notifications(t).length === 0, `notifications after a part failed twice ${show(notes(h.ui.notifications(t)))}`);

  // 4. Nothing transcribed while recording: the whole recording is sent after the stop
  await setText(editor, '');
  h.stt.reset();
  let stopped = false; // every upload fails until the stop, however many go out before it
  h.stt.respond(() => stopped ? transcript('the whole recording') : { status: 500, body: { error: 'boom' } });
  t = clock();
  start = await startRecording(h);
  await waitFor('the part and its retry to fail', () => h.stt.requests.length >= 2 && h.stt.requests[1].repliedAt, 25_000);
  stopped = true;
  await toggle();
  await waitFor('the whole-recording transcript', () => editor.document.getText() !== '', 6000).catch(() => undefined);
  const fallback = await wrote(h, start);
  const lastUpload = h.stt.requests[h.stt.requests.length - 1];
  expect(editor.document.getText() === 'The whole recording', `document after every part failed ${show(editor.document.getText())}`);
  expect(lastUpload !== undefined && sha1(filePart(lastUpload)!.data) === fallback.sha1,
    `after every part failed: ${h.stt.requests.length} uploads; the last must be the recorder's whole file`);
  expect(h.stt.requests.filter((r) => filePart(r) && sha1(filePart(r)!.data) === fallback.sha1).length === 1, 'the whole recording was uploaded more than once');
  expect(h.ui.notifications(t).length === 0, `notifications after every part failed ${show(notes(h.ui.notifications(t)))}`);
  expect(h.listFailedRecordings().length === 0, 'a recording was kept for retry although it was transcribed');

  // 5. Escape while a part is in flight: the request is aborted, nothing is inserted
  await setText(editor, '');
  await clipboard('sentinel');
  h.stt.reset();
  h.stt.respond(() => transcript('must not be inserted', 10_000));
  t = clock();
  start = await startRecording(h);
  const inFlight = await waitFor('a part uploaded while recording', () => h.stt.requests[0], 20_000);
  await sleep(200);
  let t1 = clock();
  await cancel();
  await waitFor('the recorder to be killed', () => !isAlive(start.pid), 2000);
  await waitFor('the part to be aborted', () => inFlight.clientAborted, 3000).catch(() => undefined);
  await sleep(400);
  expect(inFlight.clientAborted, 'Escape did not abort the part in flight');
  expect(h.stt.requests.length === 1, `${h.stt.requests.length} uploads after Escape while recording`);
  expect(editor.document.getText() === '' && (await clipboard()) === 'sentinel', 'the dictation cancelled while recording produced text');
  expect(h.fakes.signalsOf(start.pid).length === 0, `the recorder got ${show(h.fakes.signalsOf(start.pid))}; Escape must kill it`);
  expect(h.statusBar.micTexts(t1).includes(MIC_CANCELLED), `mic texts after Escape ${show(h.statusBar.micTexts(t1))}`);
  expect(h.ui.notifications(t).length === 0, `notifications after Escape while recording ${show(notes(h.ui.notifications(t)))}`);

  // 6. Escape while the rest is in flight: aborted, and no whole-recording upload follows
  h.stt.reset();
  h.stt.respond((_request, index) => transcript(index === 0 ? 'sent while recording' : 'must not be inserted', index === 0 ? 0 : 10_000));
  t = clock();
  start = await startRecording(h);
  await waitFor('a part uploaded while recording', () => h.stt.requests[0]?.repliedAt, 20_000);
  await sleep(300);
  void toggle();
  const rest = await waitFor('the rest uploaded after the stop', () => h.stt.requests[1], 5000);
  await sleep(200);
  t1 = clock();
  await cancel();
  await waitFor('the rest to be aborted', () => rest.clientAborted, 3000).catch(() => undefined);
  await waitFor('the pipeline to end', () => h.commands.context('isProcessing') === false, 3000).catch(() => undefined);
  await sleep(400);
  expect(rest.clientAborted, 'Escape did not abort the rest in flight');
  expect(h.stt.requests.length === 2, `${h.stt.requests.length} uploads after Escape with the rest in flight`);
  expect(editor.document.getText() === '' && (await clipboard()) === 'sentinel', 'the dictation cancelled after the stop produced text');
  expect(h.statusBar.micTexts(t1).includes(MIC_CANCELLED), `mic texts after Escape with the rest in flight ${show(h.statusBar.micTexts(t1))}`);
  expect(h.commands.context('isRecording') === false && h.commands.context('isProcessing') === false, 'context keys not reset by Escape');
  expect(h.ui.notifications(t).length === 0, `notifications after Escape with the rest in flight ${show(notes(h.ui.notifications(t)))}`);
  expect(h.listFailedRecordings().length === 0, 'a cancelled dictation was kept for retry');

  // Nothing of these dictations is sent later
  const uploads = h.stt.requests.length;
  await sleep(2500);
  expect(h.stt.requests.length === uploads, `${h.stt.requests.length - uploads} upload(s) after every dictation had ended`);
  expect(leftoverTempRecordings().length === 0, `temporary recordings left: ${show(leftoverTempRecordings())}`);
};
