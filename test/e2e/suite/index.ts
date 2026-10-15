import * as vscode from 'vscode';
import * as fs from 'fs';
import { SCENARIOS, type ScenarioKind, type ScenarioUnit } from '../catalog';
import { Harness } from './harness';
import { readSuiteEnv } from './safety';
import { IMPLEMENTATIONS } from './scenarios';
import { takeLeftoverTempRecordings, type Ctx } from './steps';
import { EXTENSION_ID, SafetyAbort, clock, runAsUnit } from './util';

/*
 * Entry point that @vscode/test-electron loads inside the extension host. A
 * plain runner: the units runTests.ts picked for this window run one after
 * another, each from an idle window, and the results go to E2E_RESULTS_FILE
 * for the launcher to report. The file is rewritten as each unit starts and
 * ends: the launcher takes those writes as signs of life. Lines starting with
 * "[e2e]" are echoed by it.
 */

export type UnitStatus = 'pass' | 'fail' | 'known-issue' | 'now-passing' | 'skip' | 'blocked';

export interface UnitResult {
  id: string;
  scenario: string;
  kind: ScenarioKind;
  status: UnitStatus;
  ms: number;
  failures?: string[];
  observations?: Record<string, unknown>;
  cleanup?: string[];
}

export interface WindowResults {
  launch: string;
  vscodeVersion: string;
  platform: string;
  /** The extension activated before the hooks were installed; the launcher retries the window. */
  activatedBeforeHarness: boolean;
  harnessError?: string;
  /** The unit in progress at the last write. */
  running?: string;
  startedAt: number;
  finishedAt?: number;
  units: UnitResult[];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** How long a unit that timed out gets to reach its next step, which then throws. */
const ABANDON_GRACE_MS = 10_000;
const TIMED_OUT = Symbol('timed out');

/** The promise's result, or TIMED_OUT after ms; the promise itself keeps running. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** A known issue counts as reproduced only when every failure is the known one. */
function classify(unit: ScenarioUnit, failures: string[]): UnitStatus {
  if (failures.length === 0) {
    return unit.kind === 'known-issue' ? 'now-passing' : 'pass';
  }
  const signature = unit.knownIssue?.signature;
  if (unit.kind === 'known-issue' && signature && failures.every((f) => f.includes(signature))) {
    return 'known-issue';
  }
  return 'fail';
}

/** runaway: the unit timed out and its code was still running after ABANDON_GRACE_MS. */
async function runUnit(h: Harness, unit: ScenarioUnit): Promise<{ result: UnitResult; runaway: boolean }> {
  const startedAt = clock();
  const result: UnitResult = { id: unit.id, scenario: unit.scenario, kind: unit.kind, status: 'pass', ms: 0 };
  const failures: string[] = [];
  const observations: Record<string, unknown> = {};
  const ctx: Ctx = {
    h,
    unit,
    startedAt,
    expect: (condition, message) => {
      if (!condition) {
        failures.push(message);
      }
    },
    observe: (key, value) => {
      observations[key] = value;
    },
  };
  let runaway = false;
  try {
    await h.beforeScenario();
    const scenario = runAsUnit(unit.id, () => IMPLEMENTATIONS[unit.id](ctx));
    if ((await within(scenario.done, unit.timeoutMs)) === TIMED_OUT) {
      // Its code is still running: stop it at its next step, before the
      // clean-up and the next unit, which it would otherwise act on
      failures.push(`timed out after ${unit.timeoutMs} ms`);
      scenario.abandon(`timed out after ${unit.timeoutMs} ms`);
      const late = await within(scenario.done.then(() => undefined, (error: unknown) => error), ABANDON_GRACE_MS);
      if (late instanceof SafetyAbort) {
        throw late;
      }
      runaway = late === TIMED_OUT;
    }
  } catch (error) {
    if (error instanceof SafetyAbort) {
      await h.afterScenario().catch(() => undefined);
      throw error;
    }
    failures.push(errorText(error));
  }
  if (failures.length > 0) {
    // Before the cleanup cancels anything: what was still pending is part of the story
    observations.activity = h.activitySince(startedAt);
  }
  result.cleanup = await h.afterScenario();
  // With the window idle again: a recording still in the temp dir would be left on a user's disk
  const leftover = await takeLeftoverTempRecordings();
  if (leftover.length > 0) {
    failures.push(`temporary recording(s) left in the temp directory: ${leftover.join(', ')}`);
  }
  result.status = classify(unit, failures);
  result.failures = failures.length > 0 ? failures : undefined;
  result.observations = Object.keys(observations).length > 0 ? observations : undefined;
  if (result.cleanup.length === 0) {
    delete result.cleanup;
  }
  result.ms = Math.round(Date.now() - startedAt);
  return { result, runaway };
}

/** Atomic, so the launcher never reads half a file. */
function writeResults(file: string, results: WindowResults): void {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(results, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

const LABELS: Record<UnitStatus, string> = {
  pass: 'PASS',
  fail: 'FAIL',
  'known-issue': 'KNOWN-ISSUE',
  'now-passing': 'NOW-PASSING',
  skip: 'SKIP',
  blocked: 'BLOCKED',
};

function log(line: string): void {
  console.log(`[e2e] ${line}`);
}

export async function run(): Promise<void> {
  // First of all: was the extension already active, i.e. could it have run before the hooks?
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  const activatedBeforeHarness = extension?.isActive ?? false;
  const env = readSuiteEnv();
  const results: WindowResults = {
    launch: env.launchName,
    vscodeVersion: vscode.version,
    platform: process.platform,
    activatedBeforeHarness,
    startedAt: Date.now(),
    units: [],
  };
  let harness: Harness | undefined;
  let fatal: unknown;
  writeResults(env.resultsFile, results);
  try {
    if (!extension) {
      throw new Error(`${EXTENSION_ID} is not loaded in this window`);
    }
    harness = new Harness(env, extension);
    if (activatedBeforeHarness) {
      throw new Error('the extension activated before the suite could install its hooks');
    }
    const unknown = env.units.filter((id) => !IMPLEMENTATIONS[id] || !SCENARIOS.some((u) => u.id === id));
    if (unknown.length > 0) {
      throw new Error(`no such scenario in the suite: ${unknown.join(', ')}`);
    }
    await harness.start();
    log(`window "${env.launchName}": VS Code ${vscode.version}, ${env.units.length} scenario(s)`);
    writeResults(env.resultsFile, results);

    /** Set when a unit left toggleRecording hanging: the extension ignores Alt+D from then on. */
    let wedgedBy: string | undefined;
    /** Set when a unit timed out and kept running: its steps could act on any unit after it. */
    let runaway: string | undefined;
    for (const id of env.units) {
      const unit = SCENARIOS.find((u) => u.id === id) as ScenarioUnit;
      let result: UnitResult;
      if (unit.records && process.platform !== 'linux') {
        result = { id, scenario: unit.scenario, kind: unit.kind, status: 'skip', ms: 0, failures: ['records audio: Linux only'] };
      } else if (runaway) {
        result = { id, scenario: unit.scenario, kind: unit.kind, status: 'blocked', ms: 0, failures: [`not run: ${runaway} timed out and was still running ${ABANDON_GRACE_MS / 1000} s later`] };
      } else if (unit.records && wedgedBy) {
        result = { id, scenario: unit.scenario, kind: unit.kind, status: 'blocked', ms: 0, failures: [`not run: ${wedgedBy} left codeDictator.toggleRecording hanging`] };
      } else {
        results.running = id;
        writeResults(env.resultsFile, results);
        const run = await runUnit(harness, unit);
        result = run.result;
        if (run.runaway) {
          runaway = id;
        }
        if (harness.commands.pending('codeDictator.toggleRecording').length > 0) {
          wedgedBy = id;
        }
      }
      results.running = undefined;
      results.units.push(result);
      writeResults(env.resultsFile, results);
      log(`${LABELS[result.status].padEnd(11)} ${id} (${result.ms} ms)`);
      for (const failure of result.failures ?? []) {
        log(`            ${failure}`);
      }
    }
  } catch (error) {
    fatal = error;
    results.harnessError = errorText(error);
    log(`HARNESS ERROR ${results.harnessError}`);
  } finally {
    await harness?.dispose().catch(() => undefined);
    results.finishedAt = Date.now();
    writeResults(env.resultsFile, results);
  }
  if (fatal) {
    throw fatal;
  }
}
