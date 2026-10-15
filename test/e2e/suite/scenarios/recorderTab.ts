import * as vscode from 'vscode';
import * as fs from 'fs';
import { transcript } from '../mockStt';
import { activeEditorName, allTabs, describeRecorderTab, isRecorderTab, tabInfos } from '../observe';
import {
  MIC_CANCELLED,
  MIC_IDLE,
  RETRY,
  baseName,
  cancel,
  clipboard,
  dictate,
  notes,
  openFile,
  settleRecorderTimers,
  startRecording,
  toggle,
  useMockProvider,
  type Ctx,
  type Scenario,
} from '../steps';
import { check, clock, isAlive, show, sleep, waitFor } from '../util';

/*
 * VS Code never grants an extension webview the microphone, so the webview
 * recorder cannot work on desktop; its "Code Dictator: Recorder" editor tab
 * must not appear while a native recorder exists. These scenarios run first
 * in a fresh window, so their first recording is the window's first.
 */

function recorderTabsOpen(): vscode.Tab[] {
  return allTabs().filter((tab) => isRecorderTab({ label: tab.label, viewType: tab.input instanceof vscode.TabInputWebview ? tab.input.viewType : undefined }));
}

/** Fails the scenario when a Recorder tab existed at any moment since `from`. */
function expectNoRecorderTab(ctx: Ctx, from: number, when: string): void {
  const sightings = ctx.h.tabs.recorderSightings(from);
  ctx.observe(`recorderTab ${when}`, describeRecorderTab(ctx.h.tabs, from));
  ctx.expect(sightings.length === 0, `a "Code Dictator: Recorder" tab appeared ${when}: ${describeRecorderTab(ctx.h.tabs, from)}`);
}

function checkFreshWindow(ctx: Ctx): void {
  check(ctx.h.panels.panels.length === 0 && ctx.h.fakes.count() === 0, 'this scenario needs a window in which nothing has been recorded yet');
}

export const firstRecordingFileOpen: Scenario = async (ctx) => {
  const { h, expect } = ctx;
  checkFreshWindow(ctx);
  await useMockProvider(h, { 'output.target': 'editor' });
  const editor = await openFile(ctx, 'sample.txt', 'line one\n');
  const name = baseName(editor);
  h.stt.reply(transcript('first words'));
  const t0 = clock();

  const run = await dictate(h, 1000);
  await sleep(300);
  ctx.observe('startCommandMs', run.startMs);

  expectNoRecorderTab(ctx, t0, 'on the first recording of the window');
  const editors = h.tabs.activeEditors(t0);
  expect(show(editors) === show([name]), `the active editor changed during the dictation: ${show(editors)}`);
  expect(editor.document.getText() === 'line one\nFirst words', `document ${show(editor.document.getText())}`);
};

export const firstRecordingEmptyEditorArea: Scenario = async (ctx) => {
  const { h, expect } = ctx;
  checkFreshWindow(ctx);
  await useMockProvider(h, { 'output.target': 'editor' });
  await h.closeEditors(false);
  await clipboard('sentinel');
  h.stt.reply(transcript('no editor here'));
  const t0 = clock();

  await dictate(h, 1000);
  await sleep(300);

  expectNoRecorderTab(ctx, t0, 'on the first recording of a window with no editor open');
  const strips = h.tabs.window(t0).map((s) => s.tabs.map((tab) => tab.label));
  expect(strips.every((labels) => labels.length === 0), `tabs opened in an empty editor area: ${show(strips.filter((l) => l.length > 0))}`);
  expect((await clipboard()) === 'No editor here', `clipboard ${show(await clipboard())}`);
  expect(h.statusBar.micTexts(t0).some((t) => /^\$\(check\) 14 chars, \d+s → clipboard$/.test(t)), `mic texts ${show(h.statusBar.micTexts(t0))}`);
};

export const recorderTabCancel: Scenario = async (ctx) => {
  const { h, expect } = ctx;
  checkFreshWindow(ctx);
  await useMockProvider(h, { 'output.target': 'editor' });
  const editor = await openFile(ctx, 'cancel.txt', '');
  const t0 = clock();

  for (const attempt of [1, 2]) {
    const start = await startRecording(h);
    await sleep(500);
    const t = clock();
    await cancel();
    await waitFor(`recorder ${attempt} to be killed`, () => !isAlive(start.pid), 2000);
    expect(h.fakes.signalsOf(start.pid).length === 0, `attempt ${attempt}: the recorder got ${show(h.fakes.signalsOf(start.pid))}, expected a kill`);
    expect(!fs.existsSync(start.output ?? ''), `attempt ${attempt}: the temporary recording was not deleted`);
    expect(h.statusBar.micTexts(t).includes(MIC_CANCELLED), `attempt ${attempt}: mic texts ${show(h.statusBar.micTexts(t))}`);
    await sleep(300);
  }

  expectNoRecorderTab(ctx, t0, 'when the first recordings of the window were cancelled');
  expect(h.stt.requests.length === 0, `${h.stt.requests.length} uploads of cancelled recordings`);
  expect(editor.document.getText() === '', `document ${show(editor.document.getText())}`);
  expect(h.commands.context('isRecording') === false, 'codeDictator.isRecording is still true');
  expect(h.ui.notifications(t0).length === 0, `notifications ${show(notes(h.ui.notifications(t0)))}`);
  expect(h.listFailedRecordings().length === 0, 'a cancelled recording was kept for retry');
};

export const recorderTabRepeatAndErrors: Scenario = async (ctx) => {
  const { h, expect } = ctx;
  checkFreshWindow(ctx);
  await useMockProvider(h, { 'output.target': 'editor' });
  const editor = await openFile(ctx, 'repeat.txt', '');
  const name = baseName(editor);
  const t0 = clock();
  const stepEditors: string[] = [];
  const step = (label: string) => stepEditors.push(`${label}: ${activeEditorName() ?? 'none'}`);

  for (const word of ['one', 'two', 'three']) {
    h.stt.reply(transcript(word));
    await dictate(h, 300);
    step(word);
  }

  h.stt.reply({ status: 500, body: {} });
  let t = clock();
  await dictate(h, 300);
  const failed = notes(h.ui.notifications(t));
  expect(failed.length === 1 && failed[0].startsWith('error: Code Dictator: Transcription failed — ') && failed[0].endsWith('[Retry]'), `failed upload: ${show(failed)}`);
  step('failed upload');
  h.stt.reply(transcript('retried'));
  await vscode.commands.executeCommand(RETRY);
  step('retry');
  expect(h.listFailedRecordings().length === 0, `kept after the retry: ${show(h.listFailedRecordings())}`);

  // No recorder at all: the webview is the last resort, so a tab may open, but it must close again
  h.fakes.use([]);
  await settleRecorderTimers(h);
  const tNoRecorder = clock();
  await toggle();
  const noRecorder = notes(h.ui.notifications(tNoRecorder));
  expect(noRecorder.length === 1 && noRecorder[0].startsWith('error: Code Dictator: Failed to start recording — Microphone unavailable:'), `no recorder: ${show(noRecorder)}`);
  await sleep(300);
  const tNoRecorderEnd = clock();
  step('no recorder');
  h.fakes.use(['parecord']);

  await h.configure({ provider: 'openai' });
  t = clock();
  await settleRecorderTimers(h);
  await toggle();
  await sleep(100);
  const unconfigured = notes(h.ui.notifications(t));
  expect(show(unconfigured) === show(['error: Code Dictator: OpenAI whisper-1 is not configured. Please set your API key. [Set API Key, Open Settings]']), `no API key: ${show(unconfigured)}`);
  step('no API key');
  await h.configure({ provider: 'custom' });

  const sightings = h.tabs.recorderSightings(t0).filter((s) => s.t < tNoRecorder || s.t > tNoRecorderEnd);
  ctx.observe('recorderTab', describeRecorderTab(h.tabs, t0));
  expect(sightings.length === 0, `a "Code Dictator: Recorder" tab appeared across repeated recordings and errors: ${sightings.length > 0 ? describeRecorderTab(h.tabs, sightings[0].t, t0) : ''}`);
  expect(recorderTabsOpen().length === 0, 'a "Code Dictator: Recorder" tab is still open at the end');
  expect(stepEditors.every((s) => s.endsWith(`: ${name}`)), `active editor after each step: ${show(stepEditors)}`);
  expect(editor.document.getText() === 'OneTwoThreeRetried', `document ${show(editor.document.getText())}`);
};

export const noRecorderAvailable: Scenario = async (ctx) => {
  const { h, expect } = ctx;
  checkFreshWindow(ctx);
  await useMockProvider(h, { 'output.target': 'editor' });
  await openFile(ctx, 'norecorder.txt', '');
  h.fakes.use([]); // proves that no recorder resolves on PATH
  const tabsLeftOpen: string[] = [];

  for (const attempt of [1, 2]) {
    await settleRecorderTimers(h);
    const t = clock();
    await toggle();
    const error = await waitFor(`attempt ${attempt}: the error`, () => h.ui.notifications(t, 'error')[0], 6000).catch(() => undefined);
    expect(error?.text.startsWith('Code Dictator: Failed to start recording — Microphone unavailable:'), `attempt ${attempt}: ${show(notes(h.ui.notifications(t)))}`);
    expect(show(h.commands.contextValues('isRecording', t)) === show([true, false]), `attempt ${attempt}: isRecording ${show(h.commands.contextValues('isRecording', t))}`);
    expect(h.statusBar.micText() === MIC_IDLE, `attempt ${attempt}: mic ${show(h.statusBar.micText())}`);
    await sleep(300);
    if (recorderTabsOpen().length > 0) {
      tabsLeftOpen.push(`attempt ${attempt}: ${show(tabInfos().filter(isRecorderTab))}`);
    }
  }
  expect(h.fakes.count() === 0, 'a recorder process started');
  expect(h.stt.requests.length === 0, 'something was uploaded');
  ctx.observe('recorderTab', describeRecorderTab(h.tabs, ctx.startedAt));
  expect(tabsLeftOpen.length === 0, `a "Code Dictator: Recorder" tab is still open after the failed start: ${tabsLeftOpen.join('; ')}`);
};

export const orphanRecorderOnClose: Scenario = async (ctx) => {
  const { h, expect, observe } = ctx;
  checkFreshWindow(ctx);
  await useMockProvider(h, { 'output.target': 'editor' });
  await openFile(ctx, 'orphan.txt', '');
  const t0 = clock();
  let mostAlive = 0;
  const sample = () => (mostAlive = Math.max(mostAlive, h.fakes.alive().length));

  const first = await startRecording(h);
  await sleep(300);
  await vscode.workspace.saveAll(false);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await sleep(600);
  sample();
  const aliveAfterClose = isAlive(first.pid);
  await cancel();
  await waitFor('the recorder to stop', () => !isAlive(first.pid), 1500).catch(() => undefined);
  sample();
  const aliveAfterCancel = isAlive(first.pid);
  observe('aliveAfterCloseAll', aliveAfterClose);
  observe('aliveAfterEscape', aliveAfterCancel);

  h.stt.reply(transcript('after close all'));
  const second = await startRecording(h);
  sample();
  await sleep(400);
  await toggle();
  sample();
  await sleep(1200); // a late "exited unexpectedly" from the first recorder would show up here

  const errors = notes(h.ui.notifications(t0, 'error'));
  observe('errors', errors);
  expect(!aliveAfterCancel, `recorder ${first.pid} kept capturing after Close All Editors and Escape (alive after Close All: ${aliveAfterClose}; errors: ${show(errors)})`);
  expect(mostAlive <= 1, `${mostAlive} recorders were capturing at the same time`);
  expect(!errors.some((e) => e.includes('Recording panel was closed')), `closing editors reported ${show(errors)}`);
  expect(!errors.some((e) => e.includes('exited unexpectedly')), `a spurious recorder error: ${show(errors)}`);
  expect(!isAlive(second.pid), 'the next recording kept running after it was stopped');
  expect(h.stt.requests.length === 1 && (await clipboard()) === 'After close all', `the next recording: ${h.stt.requests.length} uploads, clipboard ${show(await clipboard())}`);
};

/** Two files, the second one active, dictated into twice under a non-default editor layout. */
async function dictateUnderLayout(ctx: Ctx, layout: Record<string, unknown>): Promise<void> {
  const { h, expect } = ctx;
  checkFreshWindow(ctx);
  await h.configure(layout, 'workbench.editor');
  await useMockProvider(h, { 'output.target': 'editor' });
  const other = await openFile(ctx, 'b.txt', 'b\n');
  const target = await openFile(ctx, 'a.txt', 'a\n');
  const name = baseName(target);
  const tabsBefore = tabInfos().map((t) => t.label);
  const t0 = clock();

  h.stt.reply(transcript('layout one'), transcript('layout two'));
  await dictate(h, 400);
  await dictate(h, 400);
  await sleep(300);

  const editors = h.tabs.activeEditors(t0);
  const tabsAfter = tabInfos().filter((t) => !isRecorderTab(t)).map((t) => t.label);
  expect(show(editors) === show([name]), `the active editor changed while dictating: ${show(editors)}`);
  expect(target.document.getText() === 'a\nLayout oneLayout two', `${name} holds ${show(target.document.getText())}`);
  expect(other.document.getText() === 'b\n', `${baseName(other)} changed to ${show(other.document.getText())}`);
  expect(show(tabsAfter) === show(tabsBefore), `editor tabs went from ${show(tabsBefore)} to ${show(tabsAfter)}`);
  expectNoRecorderTab(ctx, t0, 'while dictating');
}

export const layoutOpenPositioningFirst: Scenario = (ctx) => dictateUnderLayout(ctx, { openPositioning: 'first' });

/** limit.value=1 keeps a single editor open, so b.txt is closed when a.txt opens. */
export const layoutEditorLimit1: Scenario = (ctx) => dictateUnderLayout(ctx, { 'limit.enabled': true, 'limit.value': 1 });
