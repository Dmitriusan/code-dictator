import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { MockStt } from './mockStt';
import {
  CommandSpy,
  DiagnosticSpy,
  PanelSpy,
  StatusBarSpy,
  TabWatch,
  UiStubs,
  allTabs,
  isRecorderTab,
  tabInfos,
  type Responders,
} from './observe';
import { FakeRecorders, FetchTripwire, checkIsolation, type SuiteEnv } from './safety';
import { EXTENSION_ID, SafetyAbort, stopIfAbandoned, waitFor } from './util';

/**
 * Everything a scenario works with in one VS Code window: the stubs and spies
 * (installed before the extension activates), the fake recorders, the mock
 * speech-to-text server, and helpers to reset the window between scenarios.
 */
export class Harness {
  readonly ui = new UiStubs();
  readonly statusBar = new StatusBarSpy();
  readonly commands = new CommandSpy();
  readonly panels = new PanelSpy();
  readonly stt = new MockStt();
  readonly diag: DiagnosticSpy;
  readonly net: FetchTripwire;
  readonly tabs: TabWatch;
  readonly isolation: Record<string, unknown>;
  /** What the first-run setup wizard did, for harness-guards. */
  readonly onboarding: Record<string, unknown> = {};
  readonly workspaceDir: string;
  readonly failedRecordingsDir: string;
  private readonly fakeRecorders: FakeRecorders | undefined;
  /** Settings a scenario changed, as "section\u0000key", reset after it. */
  private readonly changedSettings = new Set<string>();

  /** Synchronous on purpose: the extension cannot activate in between. */
  constructor(readonly env: SuiteEnv, readonly extension: vscode.Extension<unknown>) {
    this.isolation = checkIsolation(env);
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      throw new Error('VS Code was started without the run workspace folder');
    }
    this.workspaceDir = workspace.uri.fsPath;
    this.failedRecordingsDir = path.join(env.userDataDir, 'User', 'globalStorage', EXTENSION_ID, 'failed-recordings');

    this.net = new FetchTripwire();
    if (process.platform === 'linux') {
      this.fakeRecorders = new FakeRecorders(env.workDir, path.resolve(__dirname, '..', 'fakeRecorder', 'main.js'), process.execPath);
      this.fakeRecorders.use(['parecord']);
      this.fakeRecorders.activate();
    }
    this.diag = new DiagnosticSpy(path.join(env.workDir, 'diagnostic.log'));
    this.ui.install();
    this.statusBar.install();
    this.commands.install();
    this.panels.install();
    this.diag.install();
    this.ui.responders = this.onboardingResponders();
    this.tabs = new TabWatch();
  }

  /** The fake recorder toolchain; only recording scenarios use it, and they run on Linux only. */
  get fakes(): FakeRecorders {
    if (!this.fakeRecorders) {
      throw new SafetyAbort('recording scenarios need the fake toolchain, which exists on Linux only');
    }
    return this.fakeRecorders;
  }

  /**
   * Start the mock, activate the extension and let its first-run wizard
   * configure the mock as a custom endpoint, then close the walkthrough.
   */
  async start(): Promise<void> {
    await this.stt.start();
    this.net.setMock(this.stt.origin, this.stt.port);
    const t0 = Date.now();
    if (!this.extension.isActive) {
      await this.extension.activate();
    }
    this.onboarding.activationMs = Date.now() - t0;
    await waitFor('the setup wizard to finish and open the walkthrough', () => this.commands.since(0, 'workbench.action.openWalkthrough')[0], 10_000);
    await waitFor('the walkthrough tab', () => allTabs().length > 0, 5000).catch(() => undefined);
    this.onboarding.dialogs = this.ui.calls.map((c) => `${c.api}: ${c.text} -> ${c.answer ?? '(none)'}`);
    this.onboarding.tabs = tabInfos().map((t) => t.label);
    this.onboarding.statusMessages = this.statusBar.messages.map((m) => m.text);
    const config = vscode.workspace.getConfiguration('codeDictator');
    this.onboarding.provider = config.get('provider');
    this.onboarding.customApiUrl = config.get('customApiUrl');
    this.ui.responders = {};
    await this.closeEditors(false);
    // The diagnostic channel is created now, through the spy
    await this.pin();
  }

  /** The baseline every scenario starts from: the mock as a custom endpoint, diagnostic logging on. */
  private async pin(): Promise<void> {
    const config = vscode.workspace.getConfiguration('codeDictator');
    await config.update('provider', 'custom', vscode.ConfigurationTarget.Global);
    await config.update('customApiUrl', this.stt.transcriptionUrl, vscode.ConfigurationTarget.Global);
    await config.update('diagnosticLogging', true, vscode.ConfigurationTarget.Global);
  }

  /** Answers the first-run wizard: Custom API, the mock's URL, no API key. */
  private onboardingResponders(): Responders {
    return {
      quickPick: (items, options) => {
        if (options?.placeHolder === 'Choose your speech-to-text provider') {
          return items.find((i) => (i as { providerId?: string }).providerId === 'custom');
        }
        if (options?.placeHolder === 'Does your endpoint require an API key?') {
          return items.find((i) => i.label === 'No authentication needed');
        }
        return undefined;
      },
      inputBox: (options) => (options?.title === 'Code Dictator — Custom API Endpoint' ? this.stt.whenListening() : undefined),
    };
  }

  /** User-scope settings, reset after the scenario. Keys without a section are codeDictator.*. */
  async configure(values: Record<string, unknown>, section = 'codeDictator'): Promise<void> {
    const config = vscode.workspace.getConfiguration(section);
    for (const [key, value] of Object.entries(values)) {
      stopIfAbandoned();
      this.changedSettings.add(`${section}\u0000${key}`);
      await config.update(key, value, vscode.ConfigurationTarget.Global);
    }
  }

  private async resetSettings(): Promise<void> {
    for (const entry of this.changedSettings) {
      const [section, key] = entry.split('\u0000');
      await vscode.workspace.getConfiguration(section).update(key, undefined, vscode.ConfigurationTarget.Global);
    }
    this.changedSettings.clear();
    await this.pin();
  }

  /** What the window did since t, attached to a failed scenario's results. */
  activitySince(t: number): Record<string, string[]> {
    const at = (x: number) => `+${Math.round(x - t)} ms`;
    const mic = this.statusBar.named('Code Dictator: Mic');
    return {
      notifications: this.ui.notifications(t).map((c) => `${at(c.t)} ${c.kind}: ${c.text}`),
      micTexts: (mic?.texts ?? []).filter((x) => x.t >= t).map((x) => `${at(x.t)} ${x.value}`).slice(-25),
      webviewPanels: this.panels.since(t).map((p) => `${at(p.t)} created${p.disposedAt ? `, disposed ${at(p.disposedAt)}` : ''}`),
      pendingCommands: this.commands.since(t).filter((c) => c.settledAt === undefined).map((c) => `${at(c.t)} ${c.command}`),
      recorders: (this.fakeRecorders?.markers() ?? [])
        .filter((m) => m.t === undefined || m.t >= t)
        .map((m) => `${m.t === undefined ? '' : `${at(m.t)} `}pid ${m.pid} ${m.event}${m.signal ? ` ${m.signal}` : ''}${m.mode && m.event === 'start' ? ` ${m.mode}` : ''}${m.code !== undefined ? ` code ${m.code}` : ''}`),
      diagnosticLog: this.diag.since(t).slice(-20).map((line) => line.slice(0, 220)),
    };
  }

  listFailedRecordings(): string[] {
    try {
      return fs.readdirSync(this.failedRecordingsDir).sort();
    } catch {
      return [];
    }
  }

  /** Back to an idle window before a scenario. */
  async beforeScenario(): Promise<void> {
    this.ui.responders = {};
    this.stt.reset();
    this.net.setMock(this.stt.origin, this.stt.port);
    if (this.fakeRecorders) {
      this.fakeRecorders.setMode('tone');
      this.fakeRecorders.use(['parecord']);
      this.fakeRecorders.assertPath();
    }
    fs.rmSync(this.failedRecordingsDir, { recursive: true, force: true });
    await vscode.env.clipboard.writeText('');
    await this.closeEditors(true);
  }

  /** Stop whatever a scenario left running; returns notes about what had to be cleaned up. */
  async afterScenario(): Promise<string[]> {
    const notes: string[] = [];
    this.ui.responders = {};
    await Promise.race([vscode.commands.executeCommand('codeDictator.cancelRecording'), new Promise((r) => setTimeout(r, 3000))]);
    if (this.fakeRecorders) {
      const killed = this.fakeRecorders.killAll();
      if (killed.length > 0) {
        notes.push(`killed leftover recorder process(es) ${killed.join(', ')}`);
      }
    }
    await waitFor('the transcription pipeline to finish', () => this.commands.context('isProcessing') !== true, 8000).catch(() => {
      notes.push('a transcription was still running after 8 s');
    });
    await this.resetSettings();
    await this.closeEditors(true);
    return notes;
  }

  /**
   * Close editors without save prompts (a dialog would hang a headless run).
   * keepRecorderTab leaves the "Code Dictator: Recorder" tab of a build that
   * tries the webview recorder first (up to 1.1.19) alone, so a shared window
   * does not re-create its webview panel for every scenario.
   */
  async closeEditors(keepRecorderTab: boolean): Promise<void> {
    await vscode.workspace.saveAll(false);
    for (const doc of vscode.workspace.textDocuments.filter((d) => d.isUntitled && d.isDirty)) {
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
    const closable = () => allTabs().filter((tab) => !(keepRecorderTab && isRecorderTab({ label: tab.label, viewType: tab.input instanceof vscode.TabInputWebview ? tab.input.viewType : undefined })));
    if (closable().length > 0) {
      await vscode.window.tabGroups.close(closable(), true);
    }
    if (vscode.window.tabGroups.all.length > 1) {
      await vscode.commands.executeCommand('workbench.action.joinAllGroups');
    }
    await waitFor('the editors to close', () => closable().length === 0, 5000);
  }

  async dispose(): Promise<void> {
    this.tabs.dispose();
    this.fakeRecorders?.killAll();
    await this.stt.stop();
  }
}
