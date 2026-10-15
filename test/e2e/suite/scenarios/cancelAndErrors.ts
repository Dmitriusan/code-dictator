import * as vscode from 'vscode';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { field, filePart, sha1, transcript } from '../mockStt';
import {
  MIC_CANCELLED,
  MIC_IDLE,
  MIC_STARTING,
  RECORDING_SAVED_NOTE,
  RETRY,
  WHISPER_PROMPT,
  cancel,
  clipboard,
  dictate,
  notes,
  openFile,
  setText,
  settleRecorderTimers,
  startRecording,
  toggle,
  useMockProvider,
  type Scenario,
} from '../steps';
import { check, clock, isAlive, show, sleep, waitFor } from '../util';

/** Escape while recording kills the recorder and keeps nothing; Escape while idle does nothing. */
export const cancelMidRecording: Scenario = async (ctx) => {
  const { h, expect, observe } = ctx;
  await useMockProvider(h, { 'output.target': 'editor' });
  const editor = await openFile(ctx, 'cancel.txt', '');
  await clipboard('sentinel');
  const t0 = clock();

  const start = await startRecording(h);
  await sleep(500);
  const t1 = clock();
  await cancel();
  await waitFor('the recorder to be killed', () => !isAlive(start.pid), 2000);
  observe('recorderGoneAfterCancelMs', Math.round(Date.now() - t1));
  await sleep(300); // room for a late upload
  expect(h.fakes.signalsOf(start.pid).length === 0, `the recorder got ${show(h.fakes.signalsOf(start.pid))}; Escape must kill it, not stop it for transcription`);
  expect(!fs.existsSync(start.output ?? ''), 'the temporary recording was not deleted');
  expect(h.stt.requests.length === 0, 'the cancelled recording was uploaded');
  expect(editor.document.getText() === '' && (await clipboard()) === 'sentinel', 'the cancelled recording produced text');
  expect(h.listFailedRecordings().length === 0, 'the cancelled recording was kept for retry');
  expect(h.statusBar.micTexts(t1).includes(MIC_CANCELLED), `mic texts after Escape ${show(h.statusBar.micTexts(t1))}`);
  expect(h.commands.context('isRecording') === false, 'codeDictator.isRecording is still true');
  expect(h.ui.notifications(t0).length === 0, `notifications ${show(notes(h.ui.notifications(t0)))}`);

  h.stt.reply(transcript('after cancel'));
  const next = await dictate(h, 400);
  expect(next.start.pid !== start.pid, 'the next recording reused the cancelled recorder');
  expect(editor.document.getText() === 'After cancel', `the next recording produced ${show(editor.document.getText())}`);

  const t2 = clock();
  await cancel();
  await sleep(100);
  expect(h.ui.notifications(t2).length === 0, `Escape while idle raised ${show(notes(h.ui.notifications(t2)))}`);
  expect(h.statusBar.micText() === MIC_IDLE, `mic after Escape while idle: ${show(h.statusBar.micText())}`);
  expect(h.commands.context('isRecording') === false && h.commands.context('isProcessing') === false, 'context keys not reset by Escape while idle');
};

/** Escape while the upload waits for an answer aborts it; nothing is inserted or kept. */
export const escapeDuringTranscription: Scenario = async (ctx) => {
  const { h, expect, observe } = ctx;
  await useMockProvider(h, { 'output.target': 'editor' });
  const editor = await openFile(ctx, 'escape.txt', '');
  const start = await startRecording(h);
  await sleep(500);
  h.stt.reply(transcript('this must not be inserted', 3000));
  const t0 = clock();

  const stopping = toggle();
  const request = await waitFor('the upload to reach the mock', () => h.stt.requests[0], 4000);
  await sleep(200);
  const t1 = clock();
  await cancel();
  await Promise.race([stopping, sleep(4000)]);
  observe('pipelineEndedAfterCancelMs', Math.round(Date.now() - t1));
  await waitFor('the upload to be aborted', () => request.clientAborted, 2000).catch(() => undefined);
  await sleep(300);

  expect(request.clientAborted, 'Escape did not abort the speech-to-text request');
  expect(editor.document.getText() === '', `inserted after Escape: ${show(editor.document.getText())}`);
  expect(h.ui.notifications(t0).length === 0, `notifications ${show(notes(h.ui.notifications(t0)))}`);
  expect(h.listFailedRecordings().length === 0, 'the cancelled recording was kept for retry');
  expect(h.statusBar.micTexts(t1).includes(MIC_CANCELLED), `mic texts after Escape ${show(h.statusBar.micTexts(t1))}`);
  expect(h.commands.context('isProcessing') === false, 'codeDictator.isProcessing is still true');
  expect(h.diag.since(t1).some((l) => l.includes('Pipeline cancelled by user')), 'no "Pipeline cancelled by user" diagnostic line');

  const next = await startRecording(h);
  expect(next.pid !== start.pid, 'no new recorder after the cancelled transcription');
  await cancel();
};

function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** Failed uploads keep the audio; Retry (button or command) sends the same bytes again. */
export const sttFailureKeepRetry: Scenario = async (ctx) => {
  const { h, expect } = ctx;
  await useMockProvider(h, { 'output.target': 'editor' });
  const editor = await openFile(ctx, 'retry.txt', '');
  const failure = (message: string) => `Code Dictator: Transcription failed — ${message} ${RECORDING_SAVED_NOTE}`;

  // A 500: the error offers Retry and the recording is kept
  h.stt.reply({ status: 500, body: { error: 'boom' } });
  let t = clock();
  await dictate(h, 500);
  let errors = h.ui.notifications(t, 'error');
  expect(show(errors.map((e) => e.text)) === show([failure('Custom API service is temporarily unavailable. Please try again later.')]), `errors ${show(notes(errors))}`);
  expect(show(errors[0]?.items) === show(['Retry']), `error buttons ${show(errors[0]?.items)}`);
  const kept = h.listFailedRecordings();
  check(kept.length === 1 && /^\d+-\d+\.wav$/.test(kept[0]), `kept recordings ${show(kept)}`);
  const uploaded = filePart(h.stt.requests[0]);
  check(uploaded !== undefined, 'the failed upload had no file');
  expect(sha1(fs.readFileSync(path.join(h.failedRecordingsDir, kept[0]))) === sha1(uploaded.data), 'the kept recording differs from what was uploaded');
  expect(editor.document.getText() === '', 'a failed transcription inserted text');

  // The retry command sends the same audio and prompt again
  h.stt.reply(transcript('retried words here'));
  await vscode.commands.executeCommand(RETRY);
  check(h.stt.requests.length === 2, `${h.stt.requests.length} uploads after the retry`);
  const retried = filePart(h.stt.requests[1]);
  expect(retried !== undefined && sha1(retried.data) === sha1(uploaded.data), 'the retry uploaded different audio');
  expect(field(h.stt.requests[1], 'prompt') === WHISPER_PROMPT, 'the retry lost the prompt');
  expect(editor.document.getText() === 'Retried words here', `after the retry: ${show(editor.document.getText())}`);
  expect(h.listFailedRecordings().length === 0, `still kept after a successful retry: ${show(h.listFailedRecordings())}`);

  // Retry clicked in the notification a moment later
  await setText(editor, '');
  h.stt.reply({ status: 500, body: {} }, transcript('late retry ok'));
  h.ui.responders.message = (_kind, text) => (text.includes(RECORDING_SAVED_NOTE) ? sleep(400).then(() => 'Retry') : undefined);
  await dictate(h, 400);
  await waitFor('the transcript of the Retry button', () => editor.document.getText() === 'Late retry ok', 5000)
    .catch(() => expect(false, `after clicking Retry: ${show(editor.document.getText())}`));
  await waitFor('the retried recording to be removed', () => h.listFailedRecordings().length === 0, 2000)
    .catch(() => expect(false, `still kept after Retry: ${show(h.listFailedRecordings())}`));
  // The Retry button runs outside any command the test awaits. Until its pipeline ends the
  // extension ignores Alt+D, so the next dictation must wait for it.
  await waitFor('the retry to finish', () => h.commands.context('isProcessing') === false, 2000)
    .catch(() => expect(false, 'codeDictator.isProcessing stayed true after Retry'));
  h.ui.responders = {};

  // A retry while a recording runs is refused and the failed one stays
  h.stt.reply({ status: 500, body: {} });
  await dictate(h, 300);
  check(h.listFailedRecordings().length === 1, `kept recordings ${show(h.listFailedRecordings())}`);
  await startRecording(h);
  t = clock();
  await vscode.commands.executeCommand(RETRY);
  const refused = h.ui.notifications(t).map((c) => `${c.kind}: ${c.text}`);
  expect(show(refused) === show(['warning: Code Dictator: Another recording is in progress — retry when it is done. The failed one stays saved.']),
    `retry during a recording: ${show(refused)}`);
  expect(h.listFailedRecordings().length === 1, 'the refused retry removed the saved recording');
  await cancel();

  // Rate limit and an unreachable endpoint: their own messages, recording kept
  h.stt.reply({ status: 429, body: {} });
  t = clock();
  await dictate(h, 300);
  errors = h.ui.notifications(t, 'error');
  expect(show(errors.map((e) => e.text)) === show([failure('Custom API rate limit reached. Please wait and try again.')]), `429: ${show(notes(errors))}`);

  const port = await closedPort();
  const unreachable = `http://127.0.0.1:${port}/v1/audio/transcriptions`;
  h.net.allowPort(port);
  await h.configure({ customApiUrl: unreachable });
  t = clock();
  await dictate(h, 300);
  errors = h.ui.notifications(t, 'error');
  expect(show(errors.map((e) => e.text)) === show([failure(`Unable to reach custom API at ${unreachable} — check the URL and your network connection.`)]),
    `unreachable endpoint: ${show(notes(errors))}`);
  expect(h.listFailedRecordings().length === 3, `kept recordings ${show(h.listFailedRecordings())}, expected 3`);
};

/** No usable provider: an error with two buttons, and no recorder, panel or recording state. */
export const notConfiguredGuard: Scenario = async (ctx) => {
  const { h, expect } = ctx;
  await useMockProvider(h, { 'output.target': 'editor' });
  await openFile(ctx, 'guard.txt', '');
  const variants: { settings: Record<string, unknown>; name: string }[] = [
    { settings: { provider: 'openai' }, name: 'OpenAI whisper-1' },
    { settings: { provider: 'elevenlabs' }, name: 'ElevenLabs scribe_v2' },
    { settings: { provider: 'custom', customApiUrl: '' }, name: 'Custom Whisper-Compatible' },
    { settings: { provider: 'custom', customApiUrl: 'ftp://x' }, name: 'Custom Whisper-Compatible' },
  ];
  for (const v of variants) {
    await h.configure(v.settings);
    await settleRecorderTimers(h);
    const t = clock();
    const m0 = h.fakes.count();
    await toggle();
    await sleep(100);
    const errors = notes(h.ui.notifications(t));
    const label = show(v.settings);
    expect(show(errors) === show([`error: Code Dictator: ${v.name} is not configured. Please set your API key. [Set API Key, Open Settings]`]), `${label}: ${show(errors)}`);
    expect(h.fakes.startsSince(m0).length === 0, `${label}: a recorder started`);
    expect(h.panels.since(t).length === 0, `${label}: a recorder webview panel was created`);
    expect(!h.statusBar.micTexts(t).includes(MIC_STARTING), `${label}: the mic showed ${MIC_STARTING}`);
    expect(!h.commands.contextValues('isRecording', t).includes(true), `${label}: codeDictator.isRecording was set`);
  }

  // "Set API Key" opens the setup wizard
  await h.configure({ provider: 'openai' });
  h.ui.responders.message = (_kind, text) => (text.includes('is not configured') ? 'Set API Key' : undefined);
  const t = clock();
  await toggle();
  await waitFor('the setup wizard', () => h.ui.since(t, 'quickPick').find((c) => c.text.includes('Choose your speech-to-text provider')), 3000)
    .catch(() => expect(false, '"Set API Key" did not open the setup wizard'));
};

/** The recorder dies mid-recording, or right at startup (known issue: its stderr is dropped from the message). */
export const recorderExitErrors: Scenario = async (ctx) => {
  const { h, expect } = ctx;
  await useMockProvider(h, { 'output.target': 'editor' });
  await openFile(ctx, 'exits.txt', '');

  h.fakes.setMode('exit-later');
  let t = clock();
  const dying = await startRecording(h);
  await waitFor('the unexpected-exit error', () => h.ui.notifications(t, 'error')[0], 4000);
  await sleep(100);
  expect(show(notes(h.ui.notifications(t))) === show(['error: Code Dictator: Recording process exited unexpectedly. Enable diagnostic logging in settings for details.']),
    `mid-recording exit: ${show(notes(h.ui.notifications(t)))}`);
  expect(!isAlive(dying.pid), 'the recorder that exited is still alive');
  expect(h.commands.context('isRecording') === false, 'codeDictator.isRecording is still true after the recorder died');
  expect(h.statusBar.micText() === MIC_IDLE, `mic after the recorder died: ${show(h.statusBar.micText())}`);
  h.fakes.setMode('tone');
  const next = await startRecording(h);
  expect(next.pid !== dying.pid, 'no new recorder after the one that died');
  await cancel();

  h.fakes.setMode('exit-immediately');
  await settleRecorderTimers(h);
  t = clock();
  const m0 = h.fakes.count();
  await toggle();
  const error = await waitFor('the startup error', () => h.ui.notifications(t, 'error')[0], 3000);
  expect(h.fakes.startsSince(m0).length === 1, `${h.fakes.startsSince(m0).length} recorder starts`);
  expect(error.text.startsWith('Code Dictator: Failed to start recording — Recording process exited immediately (code=1).'), `startup exit: ${show(error.text)}`);
  expect(h.commands.context('isRecording') === false, 'codeDictator.isRecording is still true after the failed start');
  expect(h.statusBar.micText() === MIC_IDLE, `mic after the failed start: ${show(h.statusBar.micText())}`);
  expect(error.text.includes('Connection failure: Connection refused'), `startup-exit error lacks the recorder's stderr: ${show(error.text)}`);
};

/** Hold mode, two overlapping transcriptions: Escape must cancel the second (known issue: it cannot). */
export const holdOverlapEscape: Scenario = async (ctx) => {
  const { h, expect } = ctx;
  await useMockProvider(h, { 'output.target': 'editor', 'recording.mode': 'hold' });
  const editor = await openFile(ctx, 'overlap.txt', '');
  const answerAfterMs = 4000;
  h.stt.respond((_request, index) => transcript(`pipeline ${index + 1}`, answerAfterMs));
  await settleRecorderTimers(h);
  const m0 = h.fakes.count();

  void toggle(); // tap 1: released after 800 ms, its upload waits 4 s for an answer
  await sleep(1500);
  void toggle(); // tap 2: a second recording while the first transcription runs
  const [first, second] = await waitFor('both uploads', () => h.stt.requests.length >= 2 && h.stt.requests, 6000);
  await waitFor('the first transcript', () => editor.document.getText() !== '', answerAfterMs + 2000);
  check(second.receivedAt < (first.repliedAt ?? Infinity), 'the two transcriptions did not overlap (machine too slow?); nothing to judge');
  const afterFirst = editor.document.getText();
  await sleep(200);
  await cancel();
  await sleep(second.receivedAt + answerAfterMs + 500 - Date.now()); // past the moment the second answer arrives

  expect(h.fakes.startsSince(m0).length === 2, `${h.fakes.startsSince(m0).length} recorders for two taps`);
  expect(afterFirst === 'Pipeline 1', `first transcript ${show(afterFirst)}`);
  const final = editor.document.getText();
  expect(final === 'Pipeline 1' && h.stt.requests[1]?.clientAborted === true,
    `Escape did not cancel the overlapping second transcription: the editor holds ${show(final)}, second request aborted: ${h.stt.requests[1]?.clientAborted}`);
};

/** Escape while the recorder starts must leave nothing recording (known issue: the start goes on). */
export const escapeDuringStartup: Scenario = async (ctx) => {
  const { h, expect, observe } = ctx;
  await useMockProvider(h, { 'output.target': 'editor' });
  const editor = await openFile(ctx, 'startup.txt', '');
  await settleRecorderTimers(h);
  const t0 = clock();
  const m0 = h.fakes.count();

  const starting = toggle();
  await waitFor('the starting state', () => h.statusBar.micTexts(t0).includes(MIC_STARTING), 2000, 2);
  const t1 = clock();
  await cancel();
  await Promise.race([starting, sleep(6000)]);
  await sleep(800); // past NativeRecorder's 150 ms startup window
  observe('startSettledAfterCancelMs', Math.round(Date.now() - t1));

  const recorders = h.fakes.startsSince(m0).map((m) => m.pid);
  const running = recorders.filter(isAlive);
  observe('recordersStarted', recorders.length);
  expect(h.ui.notifications(t0).length === 0, `notifications ${show(notes(h.ui.notifications(t0)))}`);
  expect(running.length === 0 && h.statusBar.micText() === MIC_IDLE,
    `recorder ${show(running)} kept capturing although Escape was pressed during startup; mic ${show(h.statusBar.micText())}, isRecording ${show(h.commands.context('isRecording'))}`);

  // Whatever happened, the next dictation works
  await cancel();
  h.fakes.killAll();
  h.stt.reply(transcript('after escape'));
  await setText(editor, '');
  await dictate(h, 300);
  expect(editor.document.getText() === 'After escape', `the dictation after Escape produced ${show(editor.document.getText())}`);
};
