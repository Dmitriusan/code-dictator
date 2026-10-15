import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { clock } from './util';

/*
 * Stubs and spies on the vscode API object. The extension host hands one API
 * object to all code inside an extension's folder, and this suite is compiled
 * into the extension's own folder, so what is installed here also sees the
 * extension's calls. Everything is installed before the extension activates.
 *
 * UiStubs replace the dialogs (a headless window has nobody to click them, and
 * an awaited notification would hang the extension). The spies only record:
 * status bar items, transient status messages, setContext and other commands,
 * webview panels, the diagnostic output channel and editor tabs.
 */

type AnyFunction = (...args: unknown[]) => unknown;

/** Replace a function property and prove the replacement took. */
function replace(target: object, name: string, make: (original: AnyFunction) => AnyFunction): void {
  const record = target as Record<string, unknown>;
  const original = record[name];
  if (typeof original !== 'function') {
    throw new Error(`cannot install the e2e hook: ${name} is not a function`);
  }
  const wrapper = make(original as AnyFunction);
  record[name] = wrapper;
  if (record[name] !== wrapper) {
    throw new Error(`cannot install the e2e hook: ${name} is read-only`);
  }
}

// ---------------------------------------------------------------------------
// Dialog stubs
// ---------------------------------------------------------------------------

export type MessageKind = 'error' | 'warning' | 'info';

export interface UiCall {
  t: number;
  api: 'message' | 'quickPick' | 'inputBox' | 'openDialog' | 'saveDialog' | 'openExternal';
  kind?: MessageKind;
  /** Message text, or title/placeholder/prompt of a picker. */
  text: string;
  /** Buttons of a message, labels of picker items. */
  items: string[];
  modal?: boolean;
  /** Raw picker items, for scenarios that inspect descriptions. */
  pickItems?: readonly vscode.QuickPickItem[];
  answer?: string;
  /** Set when an InputBox answer failed the caller's validateInput. */
  rejectedBy?: string;
}

/**
 * A plain value is handed back on a later tick, like a click would be; a
 * promise is handed back as it is (Promise.resolve(x) answers "instantly").
 */
type Answer<T> = T | undefined | Promise<T | undefined>;

export interface Responders {
  message?(kind: MessageKind, text: string, items: string[]): Answer<string>;
  quickPick?(items: readonly vscode.QuickPickItem[], options: vscode.QuickPickOptions | undefined): Answer<vscode.QuickPickItem>;
  inputBox?(options: vscode.InputBoxOptions | undefined): Answer<string>;
  openDialog?(options: vscode.OpenDialogOptions | undefined): Answer<vscode.Uri[]>;
}

function deliver<T>(answer: Answer<T>): Promise<T | undefined> {
  if (answer instanceof Promise) {
    return answer;
  }
  return new Promise((resolve) => setTimeout(() => resolve(answer), 0));
}

function itemLabel(item: string | vscode.QuickPickItem): string {
  return typeof item === 'string' ? item : item.label;
}

export class UiStubs {
  readonly calls: UiCall[] = [];
  responders: Responders = {};

  install(): void {
    const w = vscode.window as unknown as Record<string, unknown>;
    for (const [name, kind] of [['showErrorMessage', 'error'], ['showWarningMessage', 'warning'], ['showInformationMessage', 'info']] as const) {
      replace(w, name, () => (...args: unknown[]) => this.message(kind, args));
    }
    replace(w, 'showQuickPick', () => (items: unknown, options: unknown) =>
      this.quickPick(items as vscode.QuickPickItem[] | Thenable<vscode.QuickPickItem[]>, options as vscode.QuickPickOptions | undefined));
    replace(w, 'showInputBox', () => (options: unknown) => this.inputBox(options as vscode.InputBoxOptions | undefined));
    replace(w, 'showOpenDialog', () => (options: unknown) => {
      const call: UiCall = { t: clock(), api: 'openDialog', text: (options as vscode.OpenDialogOptions | undefined)?.title ?? '', items: [] };
      this.calls.push(call);
      return deliver(this.responders.openDialog?.(options as vscode.OpenDialogOptions | undefined));
    });
    replace(w, 'showSaveDialog', () => () => {
      this.calls.push({ t: clock(), api: 'saveDialog', text: '', items: [] });
      return deliver(undefined);
    });
    // The setup wizard can open a browser; the suite must never do that
    replace(vscode.env, 'openExternal', () => (target: unknown) => {
      this.calls.push({ t: clock(), api: 'openExternal', text: String(target), items: [] });
      return deliver(false);
    });
  }

  since(t: number, api?: UiCall['api']): UiCall[] {
    return this.calls.filter((c) => c.t >= t && (!api || c.api === api));
  }

  /** Error, warning and info notifications since t. */
  notifications(t: number, kind?: MessageKind): UiCall[] {
    return this.since(t, 'message').filter((c) => !kind || c.kind === kind);
  }

  private message(kind: MessageKind, args: unknown[]): Promise<unknown> {
    const [text, ...rest] = args;
    let modal = false;
    const buttons: (string | vscode.MessageItem)[] = [];
    for (const arg of rest) {
      if (typeof arg === 'string') {
        buttons.push(arg);
      } else if (arg && typeof arg === 'object' && 'title' in arg) {
        buttons.push(arg as vscode.MessageItem);
      } else if (arg && typeof arg === 'object') {
        modal = Boolean((arg as vscode.MessageOptions).modal);
      }
    }
    const items = buttons.map((b) => (typeof b === 'string' ? b : b.title));
    const call: UiCall = { t: clock(), api: 'message', kind, text: String(text), items, modal };
    this.calls.push(call);
    return deliver(this.responders.message?.(kind, call.text, items)).then((answer) => {
      call.answer = answer;
      return answer === undefined ? undefined : buttons.find((b) => (typeof b === 'string' ? b : b.title) === answer);
    });
  }

  private async quickPick(
    items: vscode.QuickPickItem[] | string[] | Thenable<vscode.QuickPickItem[] | string[]>,
    options: vscode.QuickPickOptions | undefined,
  ): Promise<unknown> {
    const list = await items;
    const pickItems = list.map((i) => (typeof i === 'string' ? { label: i } : i));
    const call: UiCall = {
      t: clock(),
      api: 'quickPick',
      text: [options?.title, options?.placeHolder].filter(Boolean).join(' | '),
      items: list.map(itemLabel),
      pickItems,
    };
    this.calls.push(call);
    const answer = await deliver(this.responders.quickPick?.(pickItems, options));
    call.answer = answer?.label;
    // Hand back the caller's own object (string or item), as VS Code does
    return answer === undefined ? undefined : list[pickItems.indexOf(answer)] ?? answer;
  }

  private async inputBox(options: vscode.InputBoxOptions | undefined): Promise<string | undefined> {
    const call: UiCall = {
      t: clock(),
      api: 'inputBox',
      text: [options?.title, options?.prompt].filter(Boolean).join(' | '),
      items: [],
    };
    this.calls.push(call);
    const answer = await deliver(this.responders.inputBox?.(options));
    if (answer !== undefined && options?.validateInput) {
      const verdict = await options.validateInput(answer);
      const problem = typeof verdict === 'string' ? verdict : verdict?.message;
      if (problem) {
        // A user could not submit this value either
        call.rejectedBy = problem;
        return undefined;
      }
    }
    call.answer = answer;
    return answer;
  }
}

// ---------------------------------------------------------------------------
// Spies
// ---------------------------------------------------------------------------

export interface StatusItemRecord {
  name?: string;
  item: vscode.StatusBarItem;
  texts: { t: number; value: string }[];
  visible: boolean;
}

/** Records what the extension writes into its status bar items. */
export class StatusBarSpy {
  readonly items: StatusItemRecord[] = [];
  readonly messages: { t: number; text: string }[] = [];

  install(): void {
    const items = this.items;
    replace(vscode.window, 'createStatusBarItem', (original) => function (this: unknown, ...args: unknown[]) {
      const real = original.apply(this, args) as vscode.StatusBarItem;
      const record: StatusItemRecord = { item: real, texts: [], visible: false };
      items.push(record);
      return new Proxy(real, {
        set(target, prop, value) {
          if (prop === 'text') {
            record.texts.push({ t: clock(), value: String(value) });
          } else if (prop === 'name') {
            record.name = String(value);
          }
          return Reflect.set(target, prop, value, target);
        },
        get(target, prop) {
          if (prop === 'show' || prop === 'hide') {
            return () => {
              record.visible = prop === 'show';
              return prop === 'show' ? target.show() : target.hide();
            };
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });
    const messages = this.messages;
    replace(vscode.window, 'setStatusBarMessage', (original) => function (this: unknown, ...args: unknown[]) {
      messages.push({ t: clock(), text: String(args[0]) });
      return original.apply(this, args);
    });
  }

  named(name: string): StatusItemRecord | undefined {
    return this.items.find((r) => r.name === name);
  }

  get mic(): StatusItemRecord {
    const mic = this.named('Code Dictator: Mic');
    if (!mic) {
      throw new Error('the Code Dictator mic status bar item was not captured');
    }
    return mic;
  }

  /** Every text the mic item showed since t, in order. */
  micTexts(t: number): string[] {
    return this.mic.texts.filter((x) => x.t >= t).map((x) => x.value);
  }

  micText(): string {
    return this.mic.item.text;
  }
}

export interface CommandCall {
  t: number;
  command: string;
  settledAt?: number;
  error?: string;
}

/** Records executeCommand calls, and setContext values in particular. */
export class CommandSpy {
  readonly calls: CommandCall[] = [];
  readonly contexts: { t: number; key: string; value: unknown }[] = [];

  install(): void {
    const { calls, contexts } = this;
    replace(vscode.commands, 'executeCommand', (original) => function (this: unknown, ...args: unknown[]) {
      const call: CommandCall = { t: clock(), command: String(args[0]) };
      calls.push(call);
      if (call.command === 'setContext' && String(args[1]).startsWith('codeDictator.')) {
        contexts.push({ t: call.t, key: String(args[1]), value: args[2] });
      }
      const result = original.apply(this, args) as Thenable<unknown>;
      Promise.resolve(result).then(
        () => (call.settledAt = clock()),
        (error: unknown) => {
          call.settledAt = clock();
          call.error = String(error);
        },
      );
      return result;
    });
  }

  since(t: number, command?: string): CommandCall[] {
    return this.calls.filter((c) => c.t >= t && (!command || c.command === command));
  }

  /** Values set for one context key since t, in order ("isRecording" means codeDictator.isRecording). */
  contextValues(key: string, t = 0): unknown[] {
    return this.contexts.filter((c) => c.t >= t && c.key === `codeDictator.${key}`).map((c) => c.value);
  }

  /** The value the extension set last, or undefined when it never set the key. */
  context(key: string): unknown {
    const values = this.contextValues(key);
    return values[values.length - 1];
  }

  pending(command: string): CommandCall[] {
    return this.calls.filter((c) => c.command === command && c.settledAt === undefined);
  }
}

export interface PanelRecord {
  t: number;
  viewType: string;
  title: string;
  disposedAt?: number;
}

/** Records webview panels the extension creates (the Recorder tab is one). */
export class PanelSpy {
  readonly panels: PanelRecord[] = [];

  install(): void {
    const panels = this.panels;
    replace(vscode.window, 'createWebviewPanel', (original) => function (this: unknown, ...args: unknown[]) {
      const record: PanelRecord = { t: clock(), viewType: String(args[0]), title: String(args[1]) };
      panels.push(record);
      const panel = original.apply(this, args) as vscode.WebviewPanel;
      panel.onDidDispose(() => (record.disposedAt = clock()));
      return panel;
    });
  }

  last(): PanelRecord | undefined {
    return this.panels[this.panels.length - 1];
  }

  since(t: number): PanelRecord[] {
    return this.panels.filter((p) => p.t >= t);
  }
}

/** Copies the lines of the extension's "Code Dictator" output channel (diagnostic logging). */
export class DiagnosticSpy {
  readonly lines: { t: number; line: string }[] = [];

  constructor(private readonly file: string) {}

  install(): void {
    const { lines, file } = this;
    replace(vscode.window, 'createOutputChannel', (original) => function (this: unknown, ...args: unknown[]) {
      const channel = original.apply(this, args) as vscode.OutputChannel;
      if (args[0] !== 'Code Dictator') {
        return channel;
      }
      return new Proxy(channel, {
        get(target, prop) {
          if (prop === 'appendLine') {
            return (line: string) => {
              lines.push({ t: clock(), line });
              fs.appendFileSync(file, line + '\n');
              return target.appendLine(line);
            };
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });
  }

  since(t: number): string[] {
    return this.lines.filter((l) => l.t >= t).map((l) => l.line);
  }
}

// ---------------------------------------------------------------------------
// Editor tabs
// ---------------------------------------------------------------------------

export const RECORDER_TAB_LABEL = 'Code Dictator: Recorder';
const RECORDER_VIEW_TYPE = 'codeDictatorRecorder';

export interface TabInfo {
  group: number;
  label: string;
  kind: string;
  viewType?: string;
  active: boolean;
  groupActive: boolean;
}

export interface TabSnapshot {
  t: number;
  why: string;
  tabs: TabInfo[];
  activeEditor?: string;
}

function inputKind(input: unknown): string {
  if (input instanceof vscode.TabInputText) {
    return 'text';
  }
  if (input instanceof vscode.TabInputWebview) {
    return 'webview';
  }
  if (input instanceof vscode.TabInputCustom) {
    return 'custom';
  }
  return input === undefined ? 'other' : (input as object).constructor?.name ?? typeof input;
}

function tabInfo(tab: vscode.Tab): TabInfo {
  return {
    group: tab.group.viewColumn,
    label: tab.label,
    kind: inputKind(tab.input),
    viewType: tab.input instanceof vscode.TabInputWebview ? tab.input.viewType : undefined,
    active: tab.isActive,
    groupActive: tab.group.isActive,
  };
}

export function isRecorderTab(tab: Pick<TabInfo, 'label' | 'viewType'>): boolean {
  return tab.label === RECORDER_TAB_LABEL || (tab.viewType ?? '').includes(RECORDER_VIEW_TYPE);
}

export function allTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs);
}

export function tabInfos(): TabInfo[] {
  return allTabs().map(tabInfo);
}

/** The file name of the active text editor ("untitled:…" for unsaved ones). */
export function activeEditorName(): string | undefined {
  const uri = vscode.window.activeTextEditor?.document.uri;
  if (!uri) {
    return undefined;
  }
  return uri.scheme === 'file' ? path.basename(uri.fsPath) : `${uri.scheme}:${path.basename(uri.path)}`;
}

/**
 * Keeps a timeline of the tab strip and the active editor for the whole
 * window: every tab event plus a 25 ms poll, so even a tab that is open for a
 * moment is seen.
 */
export class TabWatch implements vscode.Disposable {
  readonly snapshots: TabSnapshot[] = [];
  readonly opened: { t: number; tab: TabInfo }[] = [];
  private lastKey = '';
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly timer: ReturnType<typeof setInterval>;

  constructor() {
    this.capture('start');
    this.subscriptions.push(
      vscode.window.tabGroups.onDidChangeTabs((e) => {
        for (const tab of [...e.opened, ...e.changed]) {
          this.opened.push({ t: clock(), tab: tabInfo(tab) });
        }
        this.capture('tabs');
      }),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.capture('groups')),
      vscode.window.onDidChangeActiveTextEditor(() => this.capture('active-editor')),
    );
    this.timer = setInterval(() => this.capture('poll'), 25);
  }

  capture(why: string): void {
    const snapshot = { tabs: tabInfos(), activeEditor: activeEditorName() };
    const key = JSON.stringify(snapshot);
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.snapshots.push({ t: clock(), why, ...snapshot });
    }
  }

  /** Snapshots taken in [from, to], plus the one in force at `from`. */
  window(from: number, to = Infinity): TabSnapshot[] {
    this.capture('query');
    const before = this.snapshots.filter((s) => s.t < from).pop();
    return [...(before ? [{ ...before, t: from }] : []), ...this.snapshots.filter((s) => s.t >= from && s.t <= to)];
  }

  /** Every moment in [from, to] at which a recorder tab existed, with what it looked like. */
  recorderSightings(from: number, to = Infinity): { t: number; tab: TabInfo; activeEditor?: string }[] {
    const seen = this.window(from, to).flatMap((s) => s.tabs.filter(isRecorderTab).map((tab) => ({ t: s.t, tab, activeEditor: s.activeEditor })));
    const events = this.opened
      .filter((o) => o.t >= from && o.t <= to && isRecorderTab(o.tab))
      .map((o) => ({ t: o.t, tab: o.tab, activeEditor: undefined }));
    return [...seen, ...events].sort((a, b) => a.t - b.t);
  }

  /** Active text editors seen in [from, to], in order, without repeats ("(none)" while no text editor is active). */
  activeEditors(from: number, to = Infinity): string[] {
    const names: string[] = [];
    for (const s of this.window(from, to)) {
      const name = s.activeEditor ?? '(none)';
      if (names[names.length - 1] !== name) {
        names.push(name);
      }
    }
    return names;
  }

  dispose(): void {
    clearInterval(this.timer);
    for (const s of this.subscriptions) {
      s.dispose();
    }
  }
}

/**
 * The first recorder tab seen since `from`: when it opened, whether it became
 * the active tab, and when it closed; times relative to `origin`.
 */
export function describeRecorderTab(watch: TabWatch, from: number, origin = from): string {
  const sightings = watch.recorderSightings(from);
  if (sightings.length === 0) {
    return 'none';
  }
  const first = sightings[0];
  const closedAt = watch.window(first.t).find((s) => s.t > first.t && !s.tabs.some(isRecorderTab))?.t;
  const activeAt = sightings.find((s) => s.tab.active && s.tab.groupActive && (closedAt === undefined || s.t < closedAt))?.t;
  return `"${first.tab.label}" (${first.tab.kind}${first.tab.viewType ? ` ${first.tab.viewType}` : ''}) opened at +${Math.round(first.t - origin)} ms` +
    `${activeAt !== undefined ? `, the active tab from +${Math.round(activeAt - origin)} ms` : ''}` +
    `${closedAt !== undefined ? `, closed at +${Math.round(closedAt - origin)} ms` : ', still open at the end'}`;
}
