import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ScenarioUnit } from '../catalog';
import type { Harness } from './harness';
import { field, filePart, sha1, type RecordedRequest } from './mockStt';
import type { UiCall } from './observe';
import type { Marker } from './safety';
import { SafetyAbort, check, show, sleep, stopIfAbandoned, waitFor } from './util';

/** What a scenario gets. */
export interface Ctx {
  h: Harness;
  unit: ScenarioUnit;
  startedAt: number;
  /** A soft assertion: the scenario goes on, and fails at the end with every message collected. */
  expect(condition: unknown, message: string): void;
  /** Extra facts for results.json (timings, what was seen). */
  observe(key: string, value: unknown): void;
}

export type Scenario = (ctx: Ctx) => Promise<void>;

export const TOGGLE = 'codeDictator.toggleRecording';
export const CANCEL = 'codeDictator.cancelRecording';
export const RETRY = 'codeDictator.retryTranscription';

export const MIC_IDLE = '$(mic) Dictator';
export const MIC_STARTING = '$(loading~spin) Starting...';
export const MIC_RECORDING = '$(mic-filled) 0:00';
export const MIC_TRANSCRIBING = '$(loading~spin) Transcribing...';
export const MIC_CANCELLED = '$(x) Cancelled';
export const WHISPER_PROMPT = 'Software development discussion. Technical terms, API names, function names, and code-related vocabulary.';
export const RECORDING_SAVED_NOTE = 'Your recording is saved: press Retry, or run "Code Dictator: Retry Failed Transcription" later.';
/** parecord's arguments in file mode, before the output file. */
export const PARECORD_FILE_ARGS = ['--latency-msec=100', '--format=s16le', '--rate=16000', '--channels=1', '--file-format=wav'];

/** Throws at once, not through the promise, in an abandoned unit: `void toggle()` loops stop too. */
export function toggle(): Promise<unknown> {
  stopIfAbandoned();
  return Promise.resolve(vscode.commands.executeCommand(TOGGLE));
}

export function cancel(): Promise<unknown> {
  stopIfAbandoned();
  return Promise.resolve(vscode.commands.executeCommand(CANCEL));
}

/** Use the mock as a custom endpoint, AI cleanup off, plus the scenario's settings. */
export async function useMockProvider(h: Harness, overrides: Record<string, unknown> = {}): Promise<void> {
  await h.configure({ provider: 'custom', customApiUrl: h.stt.transcriptionUrl, 'textProcessing.aiCleanup': false, ...overrides });
  const config = vscode.workspace.getConfiguration('codeDictator');
  if (config.get('textProcessing.aiCleanup') !== false) {
    throw new SafetyAbort('AI cleanup is on; it would call OpenAI');
  }
  if (config.get('provider') === 'custom' && !String(config.get('customApiUrl')).startsWith('http://127.0.0.1:')) {
    throw new SafetyAbort(`the custom endpoint ${config.get('customApiUrl')} is not the local mock`);
  }
}

/** RecorderManager's webview timers: the "ready" fallback and the permission-probe window. */
const WEBVIEW_TIMER_MS = 5000;

/**
 * Releases up to 1.1.19 probe the webview recorder before every native start,
 * and leave two 5 s timers running after each probe. Neither is cleared when
 * the probe finishes early, so either can fire into a later start:
 * - the panel's "ready" fallback swallows the ready signal of a newer panel or
 *   ping: the start hangs, or the panel is recreated with a false "Recording
 *   panel was closed" error;
 * - the permission window's timer clears the newer start's error handler: the
 *   webview's "Microphone permission denied" reaches the user as an error, no
 *   native fallback runs, and the start "succeeds" with nothing recording.
 * Starts are placed so that no old timer fires while a probe waits. Windows
 * that never created a webview panel (a native-first build) never wait.
 */
export async function settleRecorderTimers(h: Harness): Promise<void> {
  const last = h.panels.last();
  if (!last) {
    return;
  }
  // A ping takes milliseconds; a new panel waits for its webview to load
  const panelDeadline = last.t + WEBVIEW_TIMER_MS + 200;
  const pingWillDoIt = last.disposedAt === undefined && Date.now() < last.t + WEBVIEW_TIMER_MS - 300;
  if (Date.now() < panelDeadline && !pingWillDoIt) {
    await sleep(panelDeadline - Date.now());
  }
  // A probe opens its permission window just after the mic shows "Starting..."
  // and gets its answer within a few hundred ms
  const starts = h.statusBar.mic.texts.filter((x) => x.value === MIC_STARTING).map((x) => x.t);
  for (;;) {
    const now = Date.now();
    const clash = starts.find((s) => now >= s + WEBVIEW_TIMER_MS - 400 && now <= s + WEBVIEW_TIMER_MS + 150);
    if (clash === undefined) {
      return;
    }
    await sleep(clash + WEBVIEW_TIMER_MS + 150 - now + 1);
  }
}

/** Toggle to start and return the fake recorder that started. */
export async function startRecording(h: Harness): Promise<Marker> {
  await settleRecorderTimers(h);
  const index = h.fakes.count();
  await toggle();
  return waitFor('a fake recorder to start', () => h.fakes.startsSince(index)[0], 5000).catch(() => {
    throw new Error(`no recorder started after toggleRecording returned; the mic shows ${show(h.statusBar.micText())}`);
  });
}

export interface Dictation {
  start: Marker;
  /** Start command, from invocation to resolution. */
  startMs: number;
  /** Stop command (stop, upload, post-process, insert). */
  stopMs: number;
}

/** Toggle, record for recordMs, toggle again; resolves once the transcript has been delivered. */
export async function dictate(h: Harness, recordMs = 400): Promise<Dictation> {
  const t0 = Date.now();
  const start = await startRecording(h);
  const startMs = Date.now() - t0;
  await sleep(recordMs);
  const t1 = Date.now();
  await toggle();
  return { start, startMs, stopMs: Date.now() - t1 };
}

/** Write a file into the workspace and focus it with the cursor at the end. Names are made unique per scenario. */
export async function openFile(ctx: Ctx, name: string, content: string): Promise<vscode.TextEditor> {
  stopIfAbandoned();
  const file = path.join(ctx.h.workspaceDir, `${ctx.unit.id.replace(/[^a-z0-9]+/gi, '-')}-${name}`);
  fs.writeFileSync(file, content);
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  const end = doc.lineAt(doc.lineCount - 1).range.end;
  editor.selection = new vscode.Selection(end, end);
  return editor;
}

export function baseName(editor: vscode.TextEditor): string {
  return path.basename(editor.document.uri.fsPath);
}

/** Replace the whole document, save it, and put the cursor at the end. */
export async function setText(editor: vscode.TextEditor, text: string): Promise<void> {
  stopIfAbandoned();
  const doc = editor.document;
  await editor.edit((b) => b.replace(new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text));
  await doc.save();
  const end = doc.positionAt(doc.getText().length);
  editor.selection = new vscode.Selection(end, end);
}

export async function clipboard(text?: string): Promise<string> {
  stopIfAbandoned();
  if (text !== undefined) {
    await vscode.env.clipboard.writeText(text);
  }
  return vscode.env.clipboard.readText();
}

/** Notifications as "kind: text [buttons]" lines. */
export function notes(calls: UiCall[]): string[] {
  return calls.map((c) => `${c.kind}: ${c.text}${c.items.length > 0 ? ` [${c.items.join(', ')}]` : ''}`);
}

/** Each expected entry appears in this order (other entries may sit in between). */
export function inOrder(actual: string[], expected: (string | RegExp)[]): boolean {
  let at = 0;
  for (const value of actual) {
    const want = expected[at];
    if (want !== undefined && (typeof want === 'string' ? value === want : want.test(value))) {
      at++;
    }
  }
  return at === expected.length;
}

/** The temporary recordings NativeRecorder left in the temp dir. */
export function leftoverTempRecordings(): string[] {
  return fs.readdirSync(os.tmpdir()).filter((f) => /^code-dictator-\d+\.wav$/.test(f));
}

/**
 * After a unit, with the window idle again: the temporary recordings still in
 * the temp dir, each one audio the extension would leave on a user's disk.
 * Waits up to graceMs for a stop or cancel that is still deleting one, then
 * deletes what is left, so the next unit starts clean.
 */
export async function takeLeftoverTempRecordings(graceMs = 2000): Promise<string[]> {
  await waitFor('the temporary recordings to be deleted', () => leftoverTempRecordings().length === 0, graceMs).catch(() => undefined);
  const left = leftoverTempRecordings();
  for (const file of left) {
    fs.rmSync(path.join(os.tmpdir(), file), { force: true });
  }
  return left;
}

/**
 * Checks one upload of a live recording to the custom endpoint: the multipart
 * fields and order, the WAV that the fake recorder wrote, and no credentials.
 */
export function checkUpload(request: RecordedRequest, recorder: Marker, wrote: Marker | undefined): void {
  check(request.method === 'POST' && request.path === '/v1/audio/transcriptions', `request ${request.method} ${request.path}`);
  check(String(request.headers['content-type']).startsWith('multipart/form-data; boundary='), `content-type ${request.headers['content-type']}`);
  check(request.headers.authorization === undefined, 'an Authorization header was sent although no custom API key is stored');
  const names = request.parts.map((p) => p.name);
  check(show(names) === show(['file', 'model', 'prompt']), `multipart fields ${show(names)}, expected file, model, prompt`);
  const file = filePart(request);
  check(file?.filename === 'recording.wav' && file.contentType === 'audio/wav', `file part ${show({ filename: file?.filename, type: file?.contentType })}`);
  check(file.data.subarray(0, 4).toString('latin1') === 'RIFF', 'the uploaded file is not a WAV');
  check(wrote !== undefined, `recorder pid ${recorder.pid} logged no file`);
  check(sha1(file.data) === wrote.sha1, `uploaded ${file.data.length} bytes differ from the ${wrote.bytes} bytes the recorder wrote`);
  check(field(request, 'model') === 'whisper-1', `model ${field(request, 'model')}`);
  check(field(request, 'prompt') === WHISPER_PROMPT, `prompt ${show(field(request, 'prompt'))}`);
}
