import type { Scenario } from '../steps';
import {
  cancelMidRecording,
  escapeDuringStartup,
  escapeDuringTranscription,
  holdOverlapEscape,
  notConfiguredGuard,
  recorderExitErrors,
  sttFailureKeepRetry,
} from './cancelAndErrors';
import {
  audioGuards,
  dictateClipboardDefault,
  dictateInsertEditor,
  harnessGuards,
  holdModePressRelease,
  maxDurationAutostop,
  postprocessPipeline,
} from './core';
import {
  firstRecordingEmptyEditorArea,
  firstRecordingFileOpen,
  layoutEditorLimit1,
  layoutOpenPositioningFirst,
  noRecorderAvailable,
  orphanRecorderOnClose,
  recorderTabCancel,
  recorderTabRepeatAndErrors,
} from './recorderTab';

/** Implementation of every unit in ../../catalog.ts, by unit id. */
export const IMPLEMENTATIONS: Record<string, Scenario> = {
  'harness-guards': harnessGuards,
  'dictate-insert-editor': dictateInsertEditor,
  'dictate-clipboard-default': dictateClipboardDefault,
  'cancel-mid-recording': cancelMidRecording,
  'audio-guards': audioGuards,
  'stt-failure-keep-retry': sttFailureKeepRetry,
  'not-configured-guard': notConfiguredGuard,
  'postprocess-pipeline': postprocessPipeline,
  'maxduration-autostop': maxDurationAutostop,
  'escape-during-transcription': escapeDuringTranscription,
  'hold-mode-press-release': holdModePressRelease,
  'recorder-exit-errors': recorderExitErrors,
  'hold-overlap-escape': holdOverlapEscape,
  'escape-during-startup': escapeDuringStartup,
  'recorder-tab-first-recording:file-open': firstRecordingFileOpen,
  'recorder-tab-first-recording:empty-editor-area': firstRecordingEmptyEditorArea,
  'recorder-tab-cancel': recorderTabCancel,
  'recorder-tab-repeat-and-errors': recorderTabRepeatAndErrors,
  'no-recorder-available': noRecorderAvailable,
  'orphan-recorder-on-close': orphanRecorderOnClose,
  'editor-layout-guard:open-positioning-first': layoutOpenPositioningFirst,
  'editor-layout-guard:editor-limit-1': layoutEditorLimit1,
};
