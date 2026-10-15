/** Small helpers shared by the suite. No vscode API here. */
import { AsyncLocalStorage } from 'async_hooks';
import * as fs from 'fs';

export const EXTENSION_ID = 'irrationalways.code-dictator';

/** The unit a piece of scenario code runs for, and why the suite gave up on it. */
interface UnitScope {
  id: string;
  abandoned?: string;
}

const unitScope = new AsyncLocalStorage<UnitScope>();

/**
 * Runs a unit's code in its own async scope. A unit that times out cannot be
 * cancelled; abandon() makes its next step throw instead (see stopIfAbandoned),
 * so it stops before it can act on the units after it.
 */
export function runAsUnit(id: string, body: () => Promise<void>): { done: Promise<void>; abandon(reason: string): void } {
  const scope: UnitScope = { id };
  return {
    done: unitScope.run(scope, async () => body()),
    abandon: (reason) => {
      scope.abandoned = reason;
    },
  };
}

/** Steps that act on the window call this: it throws in the code of a unit the suite has abandoned. */
export function stopIfAbandoned(): void {
  const scope = unitScope.getStore();
  if (scope?.abandoned) {
    throw new Error(`${scope.id} was abandoned (${scope.abandoned}); its remaining steps are skipped`);
  }
}

/** Thrown when a run could reach a real microphone, sound server or network: it stops the whole window. */
export class SafetyAbort extends Error {
  constructor(message: string) {
    super(`SAFETY ABORT: ${message}`);
    this.name = 'SafetyAbort';
  }
}

let lastTick = 0;

/**
 * Date.now() made strictly increasing. Spies stamp what they record with it and
 * scenarios take their "since" marks with it, so an event recorded just before
 * a mark never shares its millisecond and leaks into the next step.
 */
export function clock(): number {
  const now = Date.now();
  lastTick = now > lastTick ? now : lastTick + 0.001;
  return lastTick;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** Poll until probe returns something other than undefined/false/null. */
export async function waitFor<T>(
  what: string,
  probe: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  timeoutMs = 5000,
  intervalMs = 20,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    stopIfAbandoned();
    const value = await probe();
    if (value !== undefined && value !== null && value !== false) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    }
    await sleep(intervalMs);
  }
}

export function check(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export function checkEqual<T>(actual: T, expected: T, what: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/** True while the process runs; a killed child its parent has not reaped yet (a zombie) counts as gone. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return !/^[ZX]/.test(stat.slice(stat.lastIndexOf(')') + 2));
  } catch {
    return true; // no /proc (macOS): trust kill(0)
  }
}

/** Short JSON for failure messages. */
export function show(value: unknown, max = 600): string {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text.length > max ? `${text.slice(0, max)}…` : text;
}
