/**
 * The e2e scenarios, shared by the launcher (runTests.ts) and the suite that
 * runs inside VS Code. Keep this file free of the vscode API: the launcher
 * runs in plain Node.
 *
 * A unit is one scenario or one variant of it ("scenario:variant"). Units that
 * need the first recording of a VS Code window run first in a window of their
 * own; the rest share one window.
 */

export type ScenarioKind = 'regular' | 'known-issue';

export interface ScenarioUnit {
  /** "scenario" or "scenario:variant"; E2E_SCENARIOS accepts either form. */
  id: string;
  scenario: string;
  title: string;
  kind: ScenarioKind;
  /** Needs a VS Code window in which nothing has been recorded yet. */
  freshWindow?: boolean;
  /**
   * Drives the fake recorders. Linux only: on macOS and Windows NativeRecorder
   * also probes fixed install paths that a PATH swap cannot intercept.
   */
  records: boolean;
  /** Generous upper bound; the suite fails the unit when it runs longer. */
  timeoutMs: number;
  /**
   * Known-issue units only: a product bug the unit reproduces today. The unit
   * counts as "known issue" only when its failure matches `signature`; any other
   * failure is a regular failure, so the bug cannot hide a new regression.
   */
  knownIssue?: { summary: string; signature: string };
}

export const SCENARIOS: readonly ScenarioUnit[] = [
  {
    id: 'harness-guards',
    scenario: 'harness-guards',
    title: 'Harness self-check: isolation, safety guards and observation hooks',
    kind: 'regular',
    records: false,
    timeoutMs: 20_000,
  },
  {
    id: 'dictate-insert-editor',
    scenario: 'dictate-insert-editor',
    title: 'Dictate and insert at the cursor (editor target)',
    kind: 'regular',
    records: true,
    timeoutMs: 30_000,
  },
  {
    id: 'dictate-clipboard-default',
    scenario: 'dictate-clipboard-default',
    title: 'Dictate with the default output (clipboard)',
    kind: 'regular',
    records: true,
    timeoutMs: 30_000,
  },
  {
    id: 'cancel-mid-recording',
    scenario: 'cancel-mid-recording',
    title: 'Escape (cancelRecording) while recording in toggle mode, and while idle',
    kind: 'regular',
    records: true,
    timeoutMs: 30_000,
  },
  {
    id: 'audio-guards',
    scenario: 'audio-guards',
    title: 'Silent, quiet-start and too-short recordings',
    kind: 'regular',
    records: true,
    timeoutMs: 30_000,
  },
  {
    id: 'stt-failure-keep-retry',
    scenario: 'stt-failure-keep-retry',
    title: 'A failed transcription keeps the recording; Retry and the retry command send it again',
    kind: 'regular',
    records: true,
    timeoutMs: 45_000,
  },
  {
    id: 'not-configured-guard',
    scenario: 'not-configured-guard',
    title: 'An unconfigured provider is reported before any recorder starts',
    kind: 'regular',
    records: true,
    timeoutMs: 20_000,
  },
  {
    id: 'postprocess-pipeline',
    scenario: 'postprocess-pipeline',
    title: 'Code-aware symbols, formatting and filler settings through the real pipeline',
    kind: 'regular',
    records: true,
    timeoutMs: 45_000,
  },
  {
    id: 'maxduration-autostop',
    scenario: 'maxduration-autostop',
    title: 'Max-duration auto-stop, and no stale timer from the previous recording',
    kind: 'regular',
    records: true,
    timeoutMs: 30_000,
  },
  {
    id: 'escape-during-transcription',
    scenario: 'escape-during-transcription',
    title: 'Escape while the speech-to-text request is in flight',
    kind: 'regular',
    records: true,
    timeoutMs: 30_000,
  },
  {
    id: 'hold-mode-press-release',
    scenario: 'hold-mode-press-release',
    title: 'Hold mode: key repeat, release and a single tap',
    kind: 'regular',
    records: true,
    timeoutMs: 30_000,
  },
  {
    id: 'recorder-exit-errors',
    scenario: 'recorder-exit-errors',
    title: 'The recorder process exits mid-recording or right at startup',
    kind: 'known-issue',
    records: true,
    timeoutMs: 30_000,
    knownIssue: {
      summary: "the 'Recording process exited immediately' error drops the recorder's stderr: NativeRecorder.cleanup() clears it before the message is built",
      signature: "startup-exit error lacks the recorder's stderr",
    },
  },
  {
    id: 'hold-overlap-escape',
    scenario: 'hold-overlap-escape',
    title: 'Hold mode: Escape cancels a second transcription that overlaps the first',
    kind: 'known-issue',
    records: true,
    timeoutMs: 30_000,
    knownIssue: {
      summary: "the first pipeline's finally clears pipelineAbort and isProcessing while the second still runs, so Escape cannot cancel the second one and both texts are inserted",
      signature: 'Escape did not cancel the overlapping second transcription',
    },
  },
  {
    id: 'escape-during-startup',
    scenario: 'escape-during-startup',
    title: 'Escape while the recorder is still starting',
    kind: 'known-issue',
    records: true,
    timeoutMs: 30_000,
    knownIssue: {
      summary: 'Escape pressed while the recorder starts is lost: the start goes on, the recorder keeps capturing, the status bar shows recording and the Escape keybinding is already off',
      signature: 'although Escape was pressed during startup',
    },
  },
  {
    id: 'recorder-tab-first-recording:file-open',
    scenario: 'recorder-tab-first-recording',
    title: 'No "Code Dictator: Recorder" tab on the first recording of a window, with a file open',
    kind: 'regular',
    freshWindow: true,
    records: true,
    timeoutMs: 30_000,
  },
  {
    id: 'recorder-tab-first-recording:empty-editor-area',
    scenario: 'recorder-tab-first-recording',
    title: 'No "Code Dictator: Recorder" tab on the first recording of a window, with no editor open',
    kind: 'regular',
    freshWindow: true,
    records: true,
    timeoutMs: 30_000,
  },
  {
    id: 'recorder-tab-cancel',
    scenario: 'recorder-tab-cancel',
    title: 'No Recorder tab when the first recordings of a window are cancelled',
    kind: 'regular',
    freshWindow: true,
    records: true,
    timeoutMs: 30_000,
  },
  {
    id: 'recorder-tab-repeat-and-errors',
    scenario: 'recorder-tab-repeat-and-errors',
    title: 'No Recorder tab across repeated recordings, a failed transcription, retry and start errors',
    kind: 'regular',
    freshWindow: true,
    records: true,
    timeoutMs: 60_000,
  },
  {
    id: 'no-recorder-available',
    scenario: 'no-recorder-available',
    title: 'No recorder installed: a clear error, a clean state and no Recorder tab left open',
    kind: 'regular',
    freshWindow: true,
    records: true,
    timeoutMs: 30_000,
  },
  {
    id: 'orphan-recorder-on-close',
    scenario: 'orphan-recorder-on-close',
    title: 'Closing all editors mid-recording never leaves a recorder running',
    kind: 'regular',
    freshWindow: true,
    records: true,
    timeoutMs: 30_000,
  },
  {
    id: 'editor-layout-guard:open-positioning-first',
    scenario: 'editor-layout-guard',
    title: 'Dictation keeps focus and text in the active file (workbench.editor.openPositioning=first)',
    kind: 'regular',
    freshWindow: true,
    records: true,
    timeoutMs: 30_000,
  },
  {
    id: 'editor-layout-guard:editor-limit-1',
    scenario: 'editor-layout-guard',
    title: 'Dictation closes no editor (workbench.editor.limit.value=1)',
    kind: 'regular',
    freshWindow: true,
    records: true,
    timeoutMs: 30_000,
  },
];

/** Units matching E2E_SCENARIOS ("id" or "scenario", comma separated); all units when it is empty. */
export function selectUnits(filter: string | undefined): ScenarioUnit[] {
  const wanted = (filter ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (wanted.length === 0) {
    return [...SCENARIOS];
  }
  const unknown = wanted.filter((w) => !SCENARIOS.some((u) => u.id === w || u.scenario === w));
  if (unknown.length > 0) {
    const known = [...new Set(SCENARIOS.flatMap((u) => (u.id === u.scenario ? [u.id] : [u.scenario, u.id])))];
    throw new Error(`Unknown scenario(s): ${unknown.join(', ')}. Known: ${known.join(', ')}`);
  }
  return SCENARIOS.filter((u) => wanted.includes(u.id) || wanted.includes(u.scenario));
}
