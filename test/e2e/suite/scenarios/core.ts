import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { filePart, transcript } from '../mockStt';
import {
  MIC_IDLE,
  MIC_RECORDING,
  MIC_STARTING,
  MIC_TRANSCRIBING,
  PARECORD_FILE_ARGS,
  RETRY,
  checkUpload,
  clipboard,
  dictate,
  inOrder,
  leftoverTempRecordings,
  notes,
  openFile,
  setText,
  settleRecorderTimers,
  startRecording,
  toggle,
  useMockProvider,
  type Ctx,
  type Scenario,
} from '../steps';
import { check, clock, isAlive, show, sleep, waitFor } from '../util';

/** The harness itself: isolation, the safety guards, and that every hook sees the extension. */
export const harnessGuards: Scenario = async ({ h, expect, observe }) => {
  observe('isolation', h.isolation);
  observe('onboarding', h.onboarding);
  if (process.platform === 'linux') {
    observe('which', h.fakes.resolution());
    h.fakes.assertPath();
  }

  // Captured because the hooks were installed before the extension activated
  const items = h.statusBar.items.map((r) => r.name);
  expect(show(items) === show(['Code Dictator: Mic', 'Code Dictator: Language', 'Code Dictator: Cost']), `status bar items captured: ${show(items)}`);
  const mic = h.statusBar.named('Code Dictator: Mic');
  expect(mic?.item.text === MIC_IDLE && mic.visible, `mic item ${show({ text: mic?.item.text, visible: mic?.visible })}`);
  expect(h.statusBar.named('Code Dictator: Language')?.visible === false, 'the language item is visible although the language is auto-detected');
  expect(h.statusBar.named('Code Dictator: Cost')?.visible === false, 'the cost item is visible before any transcription');
  expect(h.commands.contextValues('isRecording')[0] === false && h.commands.contextValues('isProcessing')[0] === false,
    `context keys at activation: ${show(h.commands.contexts)}`);

  const contributed = (h.extension.packageJSON.contributes.commands as { command: string }[]).map((c) => c.command);
  const registered = new Set(await vscode.commands.getCommands(true));
  const missing = contributed.filter((c) => !registered.has(c));
  expect(missing.length === 0, `commands not registered: ${missing.join(', ')}`);
  observe('commands', contributed.length);

  // The first-run wizard ran through the dialog stubs and configured the mock
  const dialogs = (h.onboarding.dialogs ?? []) as string[];
  expect(dialogs.some((d) => d.startsWith('quickPick: Code Dictator Setup | Choose your speech-to-text provider -> $(server) Custom API')),
    `setup wizard dialogs: ${show(dialogs)}`);
  expect((h.onboarding.statusMessages as string[]).includes('$(check) Code Dictator: Setup complete! Press Alt+D to start dictating.'),
    `status messages: ${show(h.onboarding.statusMessages)}`);
  expect(h.onboarding.provider === 'custom' && h.onboarding.customApiUrl === h.stt.transcriptionUrl,
    `the wizard left provider=${show(h.onboarding.provider)} customApiUrl=${show(h.onboarding.customApiUrl)}`);
  expect(h.commands.since(0, 'workbench.action.openWalkthrough').length === 1, 'the walkthrough was not opened after the wizard');

  // A call the extension makes on its own reaches the stubs
  const t0 = clock();
  await vscode.commands.executeCommand(RETRY);
  const seen = notes(await waitFor('the retry notice', () => h.ui.notifications(t0).length > 0 && h.ui.notifications(t0), 2000));
  expect(show(seen) === show(['info: Code Dictator: No failed recordings to retry.']), `notifications: ${show(seen)}`);

  // The clipboard is the headless instance's own
  await clipboard('e2e-clipboard-probe');
  expect((await clipboard()) === 'e2e-clipboard-probe', 'the clipboard does not round-trip');

  // Network: provider hosts go to the mock, everything else is blocked
  const blockedBefore = h.net.blocked.length;
  expect(blockedBefore === 0, `something reached for the network during startup: ${show(h.net.blocked)}`);
  const outside = await fetch('https://example.com/').then(() => 'reached', (e: unknown) => String(e));
  expect(outside.includes('e2e network tripwire'), `a request to example.com was not blocked: ${outside}`);
  const redirected = await fetch('https://api.elevenlabs.io/v1/e2e-probe', { method: 'POST', body: 'probe' });
  expect(redirected.status === 200 && h.stt.requests.some((r) => r.path === '/__el/v1/e2e-probe'), 'the ElevenLabs host was not redirected to the mock');
  h.net.blocked.length = 0;

  expect(h.panels.panels.length === 0, `webview panels created during startup: ${show(h.panels.panels)}`);
};

/** The core path: record, upload, post-process, insert at the cursor, copy. */
export const dictateInsertEditor: Scenario = async (ctx) => {
  const { h, expect, observe } = ctx;
  await useMockProvider(h, { 'output.target': 'editor' });
  h.stt.reply(transcript('um, so the, result equals open paren a plus b close paren semicolon'));
  const editor = await openFile(ctx, 'sample.txt', 'line one\n');
  await clipboard('sentinel');
  const t0 = clock();
  const m0 = h.fakes.count();

  const run = await dictate(h, 1000);
  observe('startCommandMs', run.startMs);
  observe('stopCommandMs', run.stopMs);
  const inserted = 'So the result = ( a + b ) ;';

  const starts = h.fakes.startsSince(m0);
  check(starts.length === 1, `${starts.length} recorders started for one dictation`);
  const [start] = starts;
  const args = start.args ?? [];
  const output = args[args.length - 1] ?? '';
  expect(start.tool === 'parecord', `recorder ${start.tool}`);
  expect(show(args.slice(0, -1)) === show(PARECORD_FILE_ARGS) && /^code-dictator-\d+\.wav$/.test(path.basename(output)) && path.dirname(output) === os.tmpdir(),
    `parecord arguments ${show(args)}`);
  await waitFor('the recorder to exit', () => !isAlive(start.pid), 3000);
  expect(show(h.fakes.signalsOf(start.pid)) === show(['SIGTERM']), `the recorder got ${show(h.fakes.signalsOf(start.pid))}, expected one SIGTERM`);

  check(h.stt.requests.length === 1, `${h.stt.requests.length} uploads`);
  checkUpload(h.stt.requests[0], start, h.fakes.wroteOf(start.pid));
  expect(editor.document.getText() === `line one\n${inserted}`, `document ${show(editor.document.getText())}`);
  expect((await clipboard()) === inserted, `clipboard ${show(await clipboard())} (output.autoCopy)`);

  const texts = h.statusBar.micTexts(t0);
  expect(inOrder(texts, [MIC_STARTING, MIC_RECORDING, MIC_TRANSCRIBING, /^\$\(check\) 27 chars, \d+s → editor$/]), `mic texts ${show(texts)}`);
  expect(show(h.commands.contextValues('isRecording', t0)) === show([true, false]), `isRecording ${show(h.commands.contextValues('isRecording', t0))}`);
  expect(show(h.commands.contextValues('isProcessing', t0)) === show([true, false]), `isProcessing ${show(h.commands.contextValues('isProcessing', t0))}`);
  expect(h.ui.notifications(t0).length === 0, `notifications ${show(notes(h.ui.notifications(t0)))}`);
  expect(leftoverTempRecordings().length === 0, `temporary recordings left: ${show(leftoverTempRecordings())}`);
  expect(h.listFailedRecordings().length === 0, `recordings kept for retry: ${show(h.listFailedRecordings())}`);
};

/** The history picker's entries (empty when the extension says there is no history). */
async function historyEntries(ctx: Ctx): Promise<vscode.QuickPickItem[]> {
  const t = clock();
  await vscode.commands.executeCommand('codeDictator.showHistory');
  const call = await waitFor('the history picker or its empty notice', () => ctx.h.ui.since(t).find((c) =>
    (c.api === 'quickPick' && c.text.includes('Select a transcription')) || (c.api === 'message' && c.text.includes('No transcription history yet'))), 2000);
  return call.api === 'quickPick' ? (call.pickItems ?? []).filter((i) => i.kind !== vscode.QuickPickItemKind.Separator && i.description) : [];
}

/** The default output: the clipboard, with the editor left alone. */
export const dictateClipboardDefault: Scenario = async (ctx) => {
  const { h, expect } = ctx;
  await useMockProvider(h);
  const historyBefore = (await historyEntries(ctx)).length;
  h.stt.reply(transcript('to the clipboard'));
  const editor = await openFile(ctx, 'notes.txt', 'editor content\n');
  await clipboard('sentinel');
  const t0 = clock();

  await dictate(h, 500);

  expect(editor.document.getText() === 'editor content\n', `the editor changed: ${show(editor.document.getText())}`);
  expect((await clipboard()) === 'To the clipboard', `clipboard ${show(await clipboard())}`);
  const texts = h.statusBar.micTexts(t0);
  expect(texts.some((t) => /^\$\(check\) 16 chars, \d+s → clipboard$/.test(t)), `mic texts ${show(texts)}`);
  expect(h.stt.requests.length === 1, `${h.stt.requests.length} uploads`);
  expect(h.ui.notifications(t0).length === 0, `notifications ${show(notes(h.ui.notifications(t0)))}`);

  const history = await historyEntries(ctx);
  expect(history.length === historyBefore + 1, `history went from ${historyBefore} to ${history.length} entries`);
  expect(history[0]?.label === 'to the clipboard' && /^\d+s \| custom$/.test(history[0]?.description ?? ''), `newest history entry ${show(history[0])}`);
};

/** Each case is one dictation; the expected text comes from the shipped post-processing functions. */
const PIPELINE_CASES: { say: string; want: string; codeAware?: boolean; fillerRemoval?: boolean }[] = [
  { say: 'hello world open paren close paren', want: 'Hello world ( )' },
  { say: 'um, so the, result equals open paren a plus b close paren semicolon', want: 'So the result = ( a + b ) ;' },
  { say: 'if x triple equals y open brace return true close brace', want: 'If x === y { return true }' },
  { say: 'first line new line second line', want: 'First line \n second line' },
  { say: '[cough] the-- some value. next sentence', want: 'Some value. Next sentence' },
  { say: 'call foo dot bar open paren close paren', want: 'Call foo . bar ( )' },
  { say: 'const items equals open bracket close bracket semicolon', want: 'Const items equals open bracket close bracket semicolon', codeAware: false },
  { say: 'uh I think we should um refactor this', want: 'Uh I think we should um refactor this', fillerRemoval: false },
  { say: 'uh I think we should um refactor this', want: 'I think we should refactor this' },
];

/** Formatting, filler removal and code-aware symbols as wired in the extension, with their settings. */
export const postprocessPipeline: Scenario = async (ctx) => {
  const { h, expect } = ctx;
  await useMockProvider(h, { 'output.target': 'editor' });
  const editor = await openFile(ctx, 'pipeline.txt', '');
  for (const c of PIPELINE_CASES) {
    await h.configure({ 'textProcessing.codeAware': c.codeAware ?? true, 'textProcessing.fillerRemoval': c.fillerRemoval ?? true });
    await setText(editor, '');
    h.stt.reply(transcript(c.say));
    await dictate(h, 250);
    const got = editor.document.getText();
    const flags = `${c.codeAware === false ? ' (codeAware off)' : ''}${c.fillerRemoval === false ? ' (fillerRemoval off)' : ''}`;
    expect(got === c.want, `${show(c.say)}${flags} became ${show(got)}, expected ${show(c.want)}`);
  }
};

/** Digital silence is caught before upload, a quiet first second is not, a tiny file is skipped. */
export const audioGuards: Scenario = async (ctx) => {
  const { h, expect } = ctx;
  await useMockProvider(h, { 'output.target': 'editor' });
  const editor = await openFile(ctx, 'audio.txt', '');

  h.fakes.setMode('silence');
  let t = clock();
  await dictate(h, 600);
  expect(h.stt.requests.length === 0, 'digital silence was uploaded');
  const warnings = h.ui.notifications(t).map((c) => `${c.kind}: ${c.text}`);
  expect(show(warnings) === show(['warning: Code Dictator: Microphone is producing silence. Your audio device may have disconnected. Check your OS sound settings or restart your audio system.']),
    `silent recording notifications: ${show(warnings)}`);
  expect(h.listFailedRecordings().length === 0, 'the silent recording was kept for retry');
  expect(h.statusBar.micText() === MIC_IDLE, `mic after the silent recording: ${show(h.statusBar.micText())}`);

  h.fakes.setMode('quiet-start');
  h.stt.reply(transcript('quiet start'));
  t = clock();
  await dictate(h, 600);
  check(h.stt.requests.length === 1, 'a recording whose first 1.5 s are silent was not uploaded');
  const size = filePart(h.stt.requests[0])?.data.length;
  expect(size === 80044, `uploaded ${size} bytes, expected the whole 80044-byte WAV`);
  expect(editor.document.getText() === 'Quiet start', `document ${show(editor.document.getText())}`);
  expect(h.ui.notifications(t).length === 0, `quiet-start notifications: ${show(notes(h.ui.notifications(t)))}`);

  h.fakes.setMode('short');
  t = clock();
  await dictate(h, 600);
  expect(h.stt.requests.length === 1, 'a 364-byte recording was uploaded');
  expect(h.ui.notifications(t).length === 0, `too-short notifications: ${show(notes(h.ui.notifications(t)))}`);
  expect(h.statusBar.micTexts(t).includes('$(warning) Recording too short'), `mic texts ${show(h.statusBar.micTexts(t))}`);
  expect(h.diag.since(t).some((l) => l.includes('Audio too short')), 'no "Audio too short" diagnostic line');
};

/** recording.maxDuration stops on its own, and an old timer never stops the next recording. */
export const maxDurationAutostop: Scenario = async (ctx) => {
  const { h, expect, observe } = ctx;
  // The schema minimum is 10 s; the configuration API accepts 2
  await useMockProvider(h, { 'output.target': 'editor', 'recording.maxDuration': 2 });
  check(vscode.workspace.getConfiguration('codeDictator').get('recording.maxDuration') === 2, 'recording.maxDuration=2 was not accepted');
  const editor = await openFile(ctx, 'maxduration.txt', '');
  h.stt.reply(transcript('auto stopped'));

  const first = await startRecording(h);
  const upload = await waitFor('the max-duration auto-stop upload', () => h.stt.requests[0], 7000);
  const afterMs = upload.receivedAt - (first.t ?? 0);
  observe('uploadAfterRecorderStartMs', afterMs);
  expect(afterMs >= 1900 && afterMs <= 3500, `uploaded ${afterMs} ms after the recorder started, expected about 2 s`);
  await waitFor('the auto-stopped transcript', () => editor.document.getText() === 'Auto stopped', 3000);
  expect(show(h.fakes.signalsOf(first.pid)) === show(['SIGTERM']), `the auto-stopped recorder got ${show(h.fakes.signalsOf(first.pid))}`);
  await waitFor('the pipeline to finish', () => h.commands.context('isProcessing') === false, 3000);

  // Recording #1 arms a 3 s timer and is stopped by hand; #2 must outlive that timer
  await h.configure({ 'recording.maxDuration': 3 });
  h.stt.reply(transcript('first'), transcript('second'));
  const one = await startRecording(h);
  await sleep(700);
  await toggle();
  await h.configure({ 'recording.maxDuration': 60 });
  const two = await startRecording(h);
  const uploadsBefore = h.stt.requests.length;
  await sleep((one.t ?? Date.now()) + 4300 - Date.now());
  expect(isAlive(two.pid) && h.fakes.signalsOf(two.pid).length === 0,
    `the second recording was stopped (${show(h.fakes.signalsOf(two.pid))}) by the first one's 3 s timer`);
  await toggle();
  expect(show(h.fakes.signalsOf(two.pid)) === show(['SIGTERM']), `the second recorder got ${show(h.fakes.signalsOf(two.pid))}`);
  expect(h.stt.requests.length === uploadsBefore + 1, `${h.stt.requests.length - uploadsBefore} uploads after stopping the second recording`);
  expect(editor.document.getText() === 'Auto stoppedFirstSecond', `document ${show(editor.document.getText())}`);
};

/** Hold mode: key repeat holds, the release (no repeats for 300 ms) stops; a tap stops after 800 ms. */
export const holdModePressRelease: Scenario = async (ctx) => {
  const { h, expect, observe } = ctx;
  await useMockProvider(h, { 'output.target': 'editor', 'recording.mode': 'hold' });
  const editor = await openFile(ctx, 'hold.txt', '');

  h.stt.reply(transcript('held words'));
  await settleRecorderTimers(h);
  let m0 = h.fakes.count();
  const held = Date.now();
  while (Date.now() - held < 1500) {
    void toggle();
    await sleep(40);
  }
  const released = Date.now();
  const upload = await waitFor('the upload after the key is released', () => h.stt.requests[0], 3000);
  observe('uploadAfterReleaseMs', upload.receivedAt - released);
  expect(upload.receivedAt - released >= 250 && upload.receivedAt - released <= 1200,
    `uploaded ${upload.receivedAt - released} ms after the last key repeat, expected the 300 ms release debounce plus the stop`);
  await waitFor('the held transcript', () => editor.document.getText() === 'Held words', 3000);
  await sleep(400);
  expect(h.fakes.startsSince(m0).length === 1, `${h.fakes.startsSince(m0).length} recorders started for one hold`);
  expect(h.stt.requests.length === 1, `${h.stt.requests.length} uploads for one hold`);

  h.stt.reply(transcript('tapped'));
  await settleRecorderTimers(h);
  m0 = h.fakes.count();
  const tapped = Date.now();
  void toggle();
  const tapUpload = await waitFor('the upload after a tap', () => h.stt.requests[1], 3000);
  observe('uploadAfterTapMs', tapUpload.receivedAt - tapped);
  expect(tapUpload.receivedAt - tapped >= 750 && tapUpload.receivedAt - tapped <= 2000,
    `uploaded ${tapUpload.receivedAt - tapped} ms after a tap, expected the 800 ms first-repeat debounce plus the stop`);
  await waitFor('the tapped transcript', () => editor.document.getText() === 'Held wordsTapped', 3000);
  await sleep(300);
  expect(h.fakes.startsSince(m0).length === 1, `${h.fakes.startsSince(m0).length} recorders started for one tap`);
  expect(h.stt.requests.length === 2, `${h.stt.requests.length} uploads after the tap`);
};
