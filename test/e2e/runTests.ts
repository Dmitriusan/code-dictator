import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { Writable } from 'stream';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';
import { selectUnits, type ScenarioUnit } from './catalog';
import type { UnitResult, WindowResults } from './suite/index';

/*
 * Runs the e2e scenarios in throwaway VS Code windows.
 *
 * On Linux the editor runs on Chromium's headless Ozone platform: no window,
 * no X server. Each window gets fresh private directories (profile,
 * extensions, shared storage, logs, HOME, TMPDIR, XDG_RUNTIME_DIR) and an
 * environment reduced to PATH, LANG, LC_* and TZ. That keeps it away from a
 * VS Code this script may run inside (ELECTRON_RUN_AS_NODE, VSCODE_IPC_HOOK),
 * from the desktop (DISPLAY: a window, and the desktop clipboard), from the
 * sound server and the session bus, and from ~/.vscode and ~/.vscode-shared.
 * Inside the window the suite swaps PATH for fake recorders and replaces
 * fetch, so the extension reaches only the local mock speech-to-text server.
 * The editor's own requests (Marketplace, updates, spell-check dictionaries)
 * fail before they leave the machine: no host name except localhost resolves.
 *
 * Scenarios that need the first recording of a window get a window of their
 * own; the others share one. A window that does not start the suite, or stops
 * reporting progress, is killed long before its overall time limit.
 *
 * Environment:
 *   E2E_VSCODE_EXECUTABLE  editor binary to test with (not the `code` CLI script).
 *                          Default: /usr/share/code/code outside CI on Linux when it
 *                          exists, else E2E_VSCODE_VERSION (default "stable") is
 *                          downloaded into .vscode-test/.
 *   E2E_EXTENSION_PATH     extension folder to test instead of this repository, e.g. an
 *                          unpacked VSIX (its "extension" folder, or the folder above it).
 *   E2E_SCENARIOS          comma-separated scenario ids (or "scenario:variant") to run.
 *   E2E_ARTIFACTS_DIR      where results.json, the VS Code logs and the suite's
 *                          diagnostic logs are copied.
 *   E2E_RUN_ROOT           parent of the run directory (default: the OS temp dir).
 *   E2E_KEEP=1             keep the run directory.
 *   E2E_ALLOW_WINDOW=1     allow a run with a visible window where there is no headless
 *                          mode (macOS, Windows); recording scenarios are skipped there.
 */

const REPO_ROOT = path.resolve(__dirname, '..');
const COMPILED_DIR = __dirname; // dist-test: this launcher, the suite and the fake recorder
const LINUX_SYSTEM_EXECUTABLE = '/usr/share/code/code';
/** Variables the editor keeps; everything else is dropped. */
const KEPT_VARIABLE = /^(PATH|LANG|LANGUAGE|LC_[A-Z_]+|TZ)$/;
/** Longest unix socket path on Linux (sun_path minus its NUL), and VS Code's longest socket name. */
const MAX_SOCKET_PATH = 107;
const LONGEST_SOCKET_NAME = 'vscode-ipc-00000000-0000-0000-0000-000000000000.sock';
/** From launch until the suite first writes its results file: VS Code start-up and loading the suite. */
const SUITE_START_LIMIT_MS = 120_000;
/** Silence allowed beyond a unit's own time limit: its clean-up, and the grace a timed-out unit gets. */
const UNIT_SLACK_MS = 60_000;

/** A quiet, offline profile with no first-run UI. */
const PROFILE_SETTINGS = {
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none',
  'extensions.autoCheckUpdates': false,
  'extensions.autoUpdate': false,
  'extensions.ignoreRecommendations': true,
  'workbench.enableExperiments': false,
  'workbench.startupEditor': 'none',
  'workbench.tips.enabled': false,
  'chat.disableAIFeatures': true,
  'git.enabled': false,
  'security.workspace.trust.enabled': false,
  'window.restoreWindows': 'none',
  'window.dialogStyle': 'custom',
  'files.autoSave': 'off',
};

interface Window {
  name: string;
  units: ScenarioUnit[];
}

interface WindowDirs {
  root: string;
  home: string;
  userData: string;
  extensions: string;
  sharedData: string;
  logs: string;
  tmp: string;
  workspace: string;
  suite: string;
  results: string;
  runtime: string;
}

interface WindowOutcome {
  window: Window;
  dirs: WindowDirs;
  attempts: number;
  exitCode?: number | string;
  ms: number;
  results?: WindowResults;
  problems: string[];
}

function log(line: string): void {
  console.log(`[e2e] ${line}`);
}

function vscodeExecutable(): string | undefined {
  const configured = process.env.E2E_VSCODE_EXECUTABLE;
  const candidate = configured
    || (process.platform === 'linux' && !process.env.CI && fs.existsSync(LINUX_SYSTEM_EXECUTABLE) ? LINUX_SYSTEM_EXECUTABLE : undefined);
  if (!candidate) {
    return undefined;
  }
  if (!fs.existsSync(candidate)) {
    throw new Error(`E2E_VSCODE_EXECUTABLE does not exist: ${candidate}`);
  }
  // The `code` CLI is a shell script that hands the launch to an editor that is already running
  if (fs.readFileSync(candidate).subarray(0, 2).toString() === '#!') {
    throw new Error(`${candidate} is a launcher script, not the editor binary; point E2E_VSCODE_EXECUTABLE at the binary itself`);
  }
  return candidate;
}

/** The extension under test, with the compiled suite inside it (the suite must share the extension's vscode API object). */
function extensionUnderTest(runRoot: string): string {
  const configured = process.env.E2E_EXTENSION_PATH;
  if (!configured) {
    if (!fs.existsSync(path.join(REPO_ROOT, 'dist', 'extension.js'))) {
      throw new Error('dist/extension.js is missing: run "npm run compile" first');
    }
    return REPO_ROOT;
  }
  let source = path.resolve(configured);
  if (!fs.existsSync(path.join(source, 'package.json')) && fs.existsSync(path.join(source, 'extension', 'package.json'))) {
    source = path.join(source, 'extension'); // the root of an unpacked VSIX
  }
  if (!fs.existsSync(path.join(source, 'package.json'))) {
    throw new Error(`E2E_EXTENSION_PATH has no package.json: ${source}`);
  }
  const copy = path.join(runRoot, 'extension');
  const skipped = new Set(['.git', '.vscode-test', 'dist-test']);
  fs.cpSync(source, copy, { recursive: true, filter: (from) => !skipped.has(path.basename(from)) });
  fs.cpSync(COMPILED_DIR, path.join(copy, 'dist-test'), { recursive: true });
  return copy;
}

/** Units that need a window's first recording get their own window; the rest share one, in catalogue order. */
function planWindows(units: ScenarioUnit[]): Window[] {
  const shared = units.filter((u) => !u.freshWindow);
  return [
    ...(shared.length > 0 ? [{ name: 'shared', units: shared }] : []),
    ...units.filter((u) => u.freshWindow).map((u) => ({ name: u.id, units: [u] })),
  ];
}

function createDirs(runRoot: string, label: string): WindowDirs {
  const root = path.join(runRoot, label);
  const dirs: WindowDirs = {
    root,
    home: path.join(root, 'home'),
    userData: path.join(root, 'user-data'),
    extensions: path.join(root, 'extensions'),
    sharedData: path.join(root, 'shared-data'),
    logs: path.join(root, 'logs'),
    tmp: path.join(root, 'tmp'),
    workspace: path.join(root, 'workspace'),
    suite: path.join(root, 'suite'),
    results: path.join(root, 'results.json'),
    runtime: path.join(root, 'r'),
  };
  for (const dir of [dirs.home, path.join(dirs.userData, 'User'), dirs.extensions, dirs.sharedData, dirs.logs, dirs.tmp, dirs.workspace, dirs.suite]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  if (dirs.runtime.length + 1 + LONGEST_SOCKET_NAME.length > MAX_SOCKET_PATH) {
    // VS Code puts its sockets here, and a deep run directory would not fit
    dirs.runtime = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'cde2e-'));
  } else {
    fs.mkdirSync(dirs.runtime, { mode: 0o700 });
  }
  fs.writeFileSync(path.join(dirs.userData, 'User', 'settings.json'), JSON.stringify(PROFILE_SETTINGS, null, 2));
  fs.writeFileSync(path.join(dirs.workspace, 'README.txt'), 'Workspace of a Code Dictator e2e run.\n');
  return dirs;
}

/**
 * Overrides that runTests merges over this process's environment: an
 * undefined value removes the variable (child_process skips it).
 */
function childEnvironment(dirs: WindowDirs, window: Window): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const key of Object.keys(process.env)) {
    const keep = process.platform === 'linux' ? KEPT_VARIABLE.test(key) : !/^(ELECTRON_|VSCODE_)/.test(key);
    env[key] = keep ? process.env[key] : undefined;
  }
  Object.assign(env, {
    // What the `code` CLI sets: VS Code then never runs a login shell to read its
    // environment. --force-disable-user-env does not reach the terminal host's
    // lookup, which otherwise runs `$SHELL -i -l` (/etc/profile and friends) per window.
    VSCODE_CLI: '1',
    HOME: dirs.home,
    TMPDIR: dirs.tmp,
    XDG_RUNTIME_DIR: dirs.runtime,
    // Nothing to connect to: /dev/null is not a directory, so these paths can never exist
    PULSE_SERVER: 'unix:/dev/null/no-pulse-server',
    PIPEWIRE_REMOTE: '/dev/null/no-pipewire',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/dev/null/no-session-bus',
    E2E_LAUNCH_NAME: window.name,
    E2E_LAUNCH_DIR: dirs.root,
    E2E_WORK_DIR: dirs.suite,
    E2E_RESULTS_FILE: dirs.results,
    E2E_USER_DATA_DIR: dirs.userData,
    E2E_RUNTIME_DIR: dirs.runtime,
    E2E_SCENARIOS: window.units.map((u) => u.id).join(','),
  });
  return env;
}

function launchArgs(dirs: WindowDirs): string[] {
  return [
    dirs.workspace,
    ...(process.platform === 'linux' ? ['--ozone-platform=headless'] : []),
    `--user-data-dir=${dirs.userData}`,
    `--extensions-dir=${dirs.extensions}`,
    `--shared-data-dir=${dirs.sharedData}`,
    `--logsPath=${dirs.logs}`,
    '--disable-gpu',
    '--no-sandbox',
    '--force-disable-user-env', // the main process's login-shell lookup (VSCODE_CLI covers the rest)
    // Background requests (Marketplace, CDN, dictionaries) fail at name resolution
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost',
    '--password-store=basic',
    '--use-inmemory-secretstorage', // API keys never reach the OS keyring
    '--skip-welcome',
    '--skip-release-notes',
    '--skip-add-to-recently-opened',
    '--disable-workspace-trust',
    '--disable-telemetry',
    '--disable-updates',
    '--disable-experiments',
    '--disable-crash-reporter',
    '--disable-extension=GitHub.copilot-chat',
    // VS Code denies webviews the microphone anyway; if that ever changes, capture a fake device
    '--use-fake-device-for-media-stream',
    '--mute-audio',
  ];
}

/** Processes whose command line mentions dir (Linux and macOS). */
function processesUnder(dir: string): { pid: number; command: string }[] {
  if (process.platform === 'win32') {
    return [];
  }
  const found: { pid: number; command: string }[] = [];
  if (process.platform === 'linux') {
    for (const entry of fs.readdirSync('/proc')) {
      const pid = Number(entry);
      if (!Number.isInteger(pid) || pid === process.pid) {
        continue;
      }
      try {
        const command = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim();
        if (command.includes(dir)) {
          found.push({ pid, command });
        }
      } catch {
        // exited meanwhile, or not ours to read
      }
    }
    return found;
  }
  for (const line of execFileSync('/bin/ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' }).split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match && match[2].includes(dir) && Number(match[1]) !== process.pid) {
      found.push({ pid: Number(match[1]), command: match[2] });
    }
  }
  return found;
}

function killAll(processes: { pid: number }[]): void {
  for (const { pid } of processes) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

/** Wait for everything started from dir to exit; kill and return what is still there after graceMs. */
async function reapUnder(dir: string, graceMs: number): Promise<{ pid: number; command: string }[]> {
  const deadline = Date.now() + graceMs;
  let left = processesUnder(dir);
  while (left.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    left = processesUnder(dir);
  }
  killAll(left);
  return left;
}

/** Captures the editor's own output to a file and echoes the suite's "[e2e]" lines. */
class OutputSink extends Writable {
  private pending = '';

  constructor(private readonly file: string) {
    super();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    fs.appendFileSync(this.file, chunk);
    const lines = (this.pending + chunk.toString()).split('\n');
    this.pending = lines.pop() ?? '';
    for (const line of lines) {
      const at = line.indexOf('[e2e]');
      if (at !== -1) {
        console.log(`  ${line.slice(at + 6)}`);
      }
    }
    done();
  }
}

/** When the suite last wrote its results file (it does after start-up and after every unit). */
function lastReport(file: string): number | undefined {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

async function launchOnce(window: Window, dirs: WindowDirs, executable: string, extensionPath: string): Promise<Omit<WindowOutcome, 'attempts'>> {
  const started = Date.now();
  const problems: string[] = [];
  const timeoutMs = 60_000 + window.units.reduce((sum, u) => sum + u.timeoutMs + 10_000, 0);
  const quietLimitMs = Math.max(...window.units.map((u) => u.timeoutMs)) + UNIT_SLACK_MS;
  const output = path.join(dirs.root, 'vscode-output.log');
  let killedBecause: string | undefined;
  const watchdog = setInterval(() => {
    if (killedBecause === undefined) {
      const now = Date.now();
      const reportedAt = lastReport(dirs.results);
      if (now - started > timeoutMs) {
        killedBecause = `the window did not finish within ${timeoutMs / 1000} s and was killed`;
      } else if (reportedAt === undefined && now - started > SUITE_START_LIMIT_MS) {
        killedBecause = `the suite did not start within ${SUITE_START_LIMIT_MS / 1000} s; the window was killed`;
      } else if (reportedAt !== undefined && now - reportedAt > quietLimitMs) {
        killedBecause = `the suite reported nothing for ${quietLimitMs / 1000} s; the window was killed`;
      }
    }
    if (killedBecause !== undefined) {
      killAll(processesUnder(dirs.root)); // again every second until VS Code is gone
    }
  }, 1000);
  let exitCode: number | string | undefined;
  try {
    exitCode = await runTests({
      vscodeExecutablePath: executable,
      extensionDevelopmentPath: extensionPath,
      extensionTestsPath: path.join(extensionPath, 'dist-test', 'suite', 'index'),
      extensionTestsEnv: childEnvironment(dirs, window),
      launchArgs: launchArgs(dirs),
      stdout: new OutputSink(output),
      stderr: new OutputSink(output),
    });
  } catch (error) {
    const failed = error as { code?: number; signal?: string; message?: string };
    exitCode = failed.code ?? failed.signal ?? String(failed.message ?? error);
  } finally {
    clearInterval(watchdog);
  }
  if (killedBecause !== undefined) {
    problems.push(killedBecause);
  }
  const leftovers = await reapUnder(dirs.root, 5000);
  if (leftovers.length > 0) {
    problems.push(`processes still running after VS Code exited (killed): ${leftovers.map((p) => `${p.pid} ${p.command.slice(0, 120)}`).join('; ')}`);
  }
  let results: WindowResults | undefined;
  try {
    results = JSON.parse(fs.readFileSync(dirs.results, 'utf8')) as WindowResults;
  } catch {
    problems.push(`no results from the suite (VS Code exit: ${exitCode}); see ${output}`);
  }
  return { window, dirs, exitCode, ms: Date.now() - started, results, problems };
}

async function runWindow(window: Window, index: number, runRoot: string, executable: string, extensionPath: string): Promise<WindowOutcome> {
  for (let attempt = 1; ; attempt++) {
    const dirs = createDirs(runRoot, `${index}${attempt > 1 ? `-${attempt}` : ''}`);
    log(`window ${index} "${window.name}"${attempt > 1 ? ` (attempt ${attempt})` : ''}: ${window.units.map((u) => u.id).join(', ')}`);
    const outcome = await launchOnce(window, dirs, executable, extensionPath);
    if (outcome.results?.activatedBeforeHarness && attempt < 3) {
      // The extension won the race against the suite's hooks; nothing ran, so try a new window
      log('the extension activated before the suite installed its hooks; starting a new window');
      continue;
    }
    return { ...outcome, attempts: attempt };
  }
}

/** Every unit of the window with its result, or a failure when the window never reported it. */
function unitResults(outcome: WindowOutcome): (UnitResult & { window: string })[] {
  return outcome.window.units.map((unit) => {
    const reported = outcome.results?.units.find((r) => r.id === unit.id);
    if (reported) {
      return { ...reported, window: outcome.window.name };
    }
    const why = outcome.results?.harnessError ?? outcome.problems[0] ?? `VS Code exited with ${outcome.exitCode}`;
    const running = outcome.results?.finishedAt === undefined && outcome.results?.running === unit.id;
    return { id: unit.id, scenario: unit.scenario, kind: unit.kind, status: 'fail' as const, ms: 0, failures: [`${running ? 'did not finish' : 'not run'}: ${why}`], window: outcome.window.name };
  });
}

function copyArtifacts(outcome: WindowOutcome, index: number, artifacts: string): void {
  const target = path.join(artifacts, `${index}-${outcome.window.name.replace(/[^a-z0-9-]+/gi, '_')}`);
  fs.mkdirSync(target, { recursive: true });
  const copies: [string, string][] = [
    [outcome.dirs.results, 'results.json'],
    [path.join(outcome.dirs.root, 'vscode-output.log'), 'vscode-output.log'],
    [outcome.dirs.logs, 'vscode-logs'],
    [path.join(outcome.dirs.suite, 'diagnostic.log'), 'code-dictator-diagnostic.log'],
    [path.join(outcome.dirs.suite, 'fake-recorder', 'markers.jsonl'), 'fake-recorder-markers.jsonl'],
  ];
  for (const [from, to] of copies) {
    if (fs.existsSync(from)) {
      fs.cpSync(from, path.join(target, to), { recursive: true });
    }
  }
}

const LABELS: Record<UnitResult['status'], string> = {
  pass: 'PASS',
  fail: 'FAIL',
  'known-issue': 'KNOWN-ISSUE',
  'now-passing': 'NOW-PASSING',
  skip: 'SKIP',
  blocked: 'BLOCKED',
};

async function main(): Promise<void> {
  if (process.platform !== 'linux' && !process.env.E2E_ALLOW_WINDOW) {
    throw new Error('headless runs need Linux; set E2E_ALLOW_WINDOW=1 to run with a visible window (recording scenarios are skipped there)');
  }
  const units = selectUnits(process.env.E2E_SCENARIOS);
  const executable = vscodeExecutable() ?? (await downloadAndUnzipVSCode(process.env.E2E_VSCODE_VERSION || 'stable'));
  const parent = process.env.E2E_RUN_ROOT || os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  const runRoot = fs.mkdtempSync(path.join(parent, 'cde2e-'));
  const extensionPath = extensionUnderTest(runRoot);
  const windows = planWindows(units);
  const startedAt = Date.now();
  log(`VS Code ${executable}`);
  log(`extension ${extensionPath}`);
  log(`run directory ${runRoot}; ${units.length} scenario(s) in ${windows.length} window(s)`);

  const artifacts = process.env.E2E_ARTIFACTS_DIR;
  if (artifacts) {
    fs.mkdirSync(artifacts, { recursive: true });
  }
  const outcomes: WindowOutcome[] = [];
  /** Why the remaining windows were not started. */
  let stoppedBecause: string | undefined;

  /** The results so far; once complete, the units of windows never started count as failures. */
  const summarize = (complete: boolean) => {
    const results = outcomes.flatMap(unitResults);
    if (complete) {
      for (const unit of units.filter((u) => !results.some((r) => r.id === u.id))) {
        const why = stoppedBecause ?? 'an earlier window aborted the run';
        results.push({ id: unit.id, scenario: unit.scenario, kind: unit.kind, status: 'fail', ms: 0, failures: [`not run: ${why}`], window: '-' });
      }
    }
    const problems = outcomes.flatMap((o) => o.problems.map((p) => `${o.window.name}: ${p}`));
    const count = (status: UnitResult['status']) => results.filter((r) => r.status === status).length;
    const ok = complete && count('fail') === 0 && count('blocked') === 0 && problems.length === 0;
    return { results, problems, count, ok };
  };

  /** Rewritten after every window, so a run cancelled midway (a CI time limit) still leaves its results. */
  const writeArtifacts = (complete: boolean) => {
    if (!artifacts) {
      return;
    }
    const { results, ok } = summarize(complete);
    fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify({
      ok,
      complete,
      startedAt,
      finishedAt: complete ? Date.now() : undefined,
      vscode: { executable, version: outcomes.find((o) => o.results)?.results?.vscodeVersion },
      extensionPath: process.env.E2E_EXTENSION_PATH ?? '.',
      windows: outcomes.map((o) => ({ name: o.window.name, attempts: o.attempts, exitCode: o.exitCode, ms: o.ms, harnessError: o.results?.harnessError, problems: o.problems })),
      scenarios: results,
    }, null, 2));
  };

  let windowsWithoutResults = 0;
  try {
    for (const [i, window] of windows.entries()) {
      const outcome = await runWindow(window, i + 1, runRoot, executable, extensionPath);
      outcomes.push(outcome);
      for (const problem of outcome.problems) {
        log(`window "${window.name}": ${problem}`);
      }
      if (artifacts) {
        copyArtifacts(outcome, i + 1, artifacts);
        writeArtifacts(false);
      }
      if (outcome.results?.harnessError?.startsWith('SAFETY ABORT')) {
        stoppedBecause = 'an earlier window aborted the run';
        log('safety abort: no further windows are started');
        break;
      }
      // Two windows in a row without a single result: the editor or the suite cannot
      // run here, and every further window would only wait for its own time limit
      windowsWithoutResults = (outcome.results?.units.length ?? 0) > 0 ? 0 : windowsWithoutResults + 1;
      if (windowsWithoutResults === 2 && i + 1 < windows.length) {
        stoppedBecause = 'two windows in a row reported no scenario result, so no further window was started';
        log(stoppedBecause);
        break;
      }
    }
  } finally {
    const stray = await reapUnder(runRoot, 3000);
    if (stray.length > 0 && outcomes.length > 0) {
      outcomes[outcomes.length - 1].problems.push(`stray processes killed at the end: ${stray.map((p) => p.pid).join(', ')}`);
    }
  }

  const { results, problems, count, ok } = summarize(true);
  writeArtifacts(true);

  console.log('\nCode Dictator e2e');
  for (const r of results) {
    console.log(`  ${LABELS[r.status].padEnd(11)} ${r.id.padEnd(48)} ${String(r.ms).padStart(6)} ms`);
    const unit = units.find((u) => u.id === r.id);
    if (r.status === 'known-issue' && unit?.knownIssue) {
      console.log(`              known issue: ${unit.knownIssue.summary}`);
    } else if (r.status === 'now-passing') {
      console.log('              this known issue no longer reproduces: make the scenario regular');
    } else {
      for (const failure of r.failures ?? []) {
        console.log(`              ${failure}`);
      }
    }
  }
  for (const problem of problems) {
    console.log(`  PROBLEM     ${problem}`);
  }
  console.log(`\n  ${count('pass')} passed, ${count('fail')} failed, ${count('known-issue')} known issues, ${count('now-passing')} now passing, ` +
    `${count('skip')} skipped, ${count('blocked')} blocked in ${Math.round((Date.now() - startedAt) / 1000)} s${artifacts ? `; artifacts in ${artifacts}` : ''}\n`);

  for (const outcome of outcomes) {
    if (outcome.dirs.runtime !== path.join(outcome.dirs.root, 'r')) {
      fs.rmSync(outcome.dirs.runtime, { recursive: true, force: true });
    }
  }
  if (process.env.E2E_KEEP === '1') {
    log(`kept ${runRoot}`);
  } else {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  console.error('E2E test run failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
