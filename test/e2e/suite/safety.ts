import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { SafetyAbort, isAlive } from './util';

/*
 * What keeps the suite away from the real microphone, sound server, desktop
 * and network:
 * - FakeRecorders: a private directory becomes the extension host's whole
 *   PATH. It holds `which` and stand-ins for the recorders and the chime
 *   player; every lookup is proven before a recording command runs.
 * - FetchTripwire: global fetch only reaches the local mock server; the
 *   providers' hard-coded hosts are redirected to it, anything else throws.
 * - checkIsolation: the extension host must have been started by runTests.ts
 *   with a private home, temp dir and runtime dir, and no display.
 */

/** Every tool NativeRecorder.detectTool can pick on Linux, in its lookup order. */
export const RECORDER_TOOLS = ['parecord', 'pw-record', 'arecord', 'ffmpeg', 'rec', 'sox'] as const;
export type RecorderTool = (typeof RECORDER_TOOLS)[number];
/** The completion chime's players, in SoundPlayer's order. Only the first is faked. */
const PLAYERS = ['pw-play', 'paplay', 'aplay'] as const;

export type FakeMode = 'tone' | 'silence' | 'quiet-start' | 'short' | 'no-data' | 'exit-immediately' | 'exit-later';

/** One line of the fake recorders' marker log. */
export interface Marker {
  t?: number;
  pid: number;
  tool: string;
  event: 'start' | 'wrote' | 'signal' | 'exit' | 'play';
  mode?: string;
  args?: string[];
  output?: string;
  bytes?: number;
  sha1?: string;
  signal?: string;
  code?: number;
  reason?: string;
  file?: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export class FakeRecorders {
  /** The extension host's entire PATH while the suite runs. */
  readonly binDir: string;
  /** mode, markers.jsonl and the fake recorder program. */
  readonly dataDir: string;
  private readonly markersFile: string;
  private tools: RecorderTool[] = [];

  /** program: the compiled fakeRecorder/main.js; execPath: the editor binary that runs it in Node mode. */
  constructor(workDir: string, program: string, private readonly execPath: string) {
    if (process.platform !== 'linux') {
      // detectTool also probes fixed install paths on macOS and Windows, which a PATH swap cannot intercept
      throw new SafetyAbort(`recording scenarios run on Linux only (platform: ${process.platform})`);
    }
    this.binDir = path.join(workDir, 'fakebin');
    this.dataDir = path.join(workDir, 'fake-recorder');
    this.markersFile = path.join(this.dataDir, 'markers.jsonl');
    fs.mkdirSync(this.binDir, { recursive: true });
    fs.mkdirSync(this.dataDir, { recursive: true });
    // A copy inside the run directory, so a leftover process is found by its command line
    fs.copyFileSync(program, path.join(this.dataDir, 'main.js'));
    fs.writeFileSync(this.markersFile, '');
    this.setMode('tone');

    // NativeRecorder runs `which <tool>` through /bin/sh
    const which = ['/usr/bin/which', '/bin/which'].find((p) => fs.existsSync(p));
    if (!which) {
      throw new SafetyAbort('no system `which` to put on the fake PATH');
    }
    fs.symlinkSync(which, path.join(this.binDir, 'which'));
    fs.writeFileSync(path.join(this.binDir, 'pw-play'), [
      '#!/bin/sh',
      '# Code Dictator e2e stand-in for pw-play: logs the chime, plays nothing',
      `printf '{"pid":%s,"tool":"pw-play","event":"play","file":"%s"}\\n' "$$" "$1" >> ${shellQuote(this.markersFile)}`,
      '',
    ].join('\n'), { mode: 0o755 });
  }

  /** Make exactly these recorders available on the fake PATH. */
  use(tools: RecorderTool[]): void {
    for (const tool of RECORDER_TOOLS) {
      const file = path.join(this.binDir, tool);
      if (tools.includes(tool)) {
        fs.writeFileSync(file, this.wrapper(tool), { mode: 0o755 });
      } else {
        fs.rmSync(file, { force: true });
      }
    }
    this.tools = [...tools];
    if (process.env.PATH === this.binDir) {
      this.assertPath();
    }
  }

  setMode(mode: FakeMode): void {
    fs.writeFileSync(path.join(this.dataDir, 'mode'), `${mode}\n`);
  }

  /** Replace PATH in this extension host, then prove what NativeRecorder and SoundPlayer will find. */
  activate(): void {
    process.env.PATH = this.binDir;
    this.assertPath();
  }

  /** `which <tool>` exactly as NativeRecorder.detectTool runs it. */
  resolve(tool: string): string | null {
    try {
      return execSync(`which ${tool}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    } catch {
      return null;
    }
  }

  resolution(): Record<string, string | null> {
    return Object.fromEntries([...RECORDER_TOOLS, ...PLAYERS].map((tool) => [tool, this.resolve(tool)]));
  }

  /** Throws SafetyAbort unless every recorder and player lookup lands where it should. */
  assertPath(): void {
    if (process.env.PATH !== this.binDir) {
      throw new SafetyAbort(`PATH is ${process.env.PATH}, not the fake toolchain`);
    }
    for (const tool of [...RECORDER_TOOLS, ...PLAYERS]) {
      const resolved = this.resolve(tool);
      const expected = tool === 'pw-play' || this.tools.includes(tool as RecorderTool);
      if (resolved !== null && path.dirname(resolved) !== this.binDir) {
        throw new SafetyAbort(`'which ${tool}' resolves to ${resolved}, outside the fake toolchain`);
      }
      if ((resolved !== null) !== expected) {
        throw new SafetyAbort(`'which ${tool}' resolves to ${resolved ?? 'nothing'}; the fake toolchain should ${expected ? '' : 'not '}provide it`);
      }
    }
  }

  markers(): Marker[] {
    return fs
      .readFileSync(this.markersFile, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Marker];
        } catch {
          return [];
        }
      });
  }

  /** Position in the marker log; pass it to startsSince() to see what a step started. */
  count(): number {
    return this.markers().length;
  }

  startsSince(index: number): Marker[] {
    return this.markers().slice(index).filter((m) => m.event === 'start');
  }

  eventsOf(pid: number): Marker[] {
    return this.markers().filter((m) => m.pid === pid);
  }

  /** Signals a recorder received (SIGTERM, SIGINT, stdin-q); a SIGKILL leaves no trace. */
  signalsOf(pid: number): string[] {
    return this.eventsOf(pid).filter((m) => m.event === 'signal').map((m) => m.signal ?? '?');
  }

  wroteOf(pid: number): Marker | undefined {
    return this.eventsOf(pid).find((m) => m.event === 'wrote');
  }

  plays(): Marker[] {
    return this.markers().filter((m) => m.event === 'play');
  }

  alive(): number[] {
    return [...new Set(this.markers().filter((m) => m.event === 'start').map((m) => m.pid))].filter(isAlive);
  }

  /** SIGKILL whatever is still running; returns the pids that had to be killed. */
  killAll(): number[] {
    const leftovers = this.alive();
    for (const pid of leftovers) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    return leftovers;
  }

  /**
   * The shell answers exit-immediately itself, well inside NativeRecorder's
   * 150 ms startup window; everything else runs the Node fake.
   */
  private wrapper(tool: RecorderTool): string {
    const markers = shellQuote(this.markersFile);
    return [
      '#!/bin/sh',
      `# Code Dictator e2e stand-in for ${tool}: synthesises audio, never opens a device`,
      `CD_FAKE_TOOL=${tool}`,
      `CD_FAKE_DIR=${shellQuote(this.dataDir)}`,
      'export CD_FAKE_TOOL CD_FAKE_DIR',
      'mode=tone',
      'read -r mode < "$CD_FAKE_DIR/mode"',
      'if [ "$mode" = exit-immediately ]; then',
      `  printf '{"pid":%s,"tool":"%s","event":"start","mode":"%s"}\\n' "$$" "$CD_FAKE_TOOL" "$mode" >> ${markers}`,
      "  echo 'Connection failure: Connection refused' >&2",
      `  printf '{"pid":%s,"tool":"%s","event":"exit","code":1,"reason":"exit-immediately"}\\n' "$$" "$CD_FAKE_TOOL" >> ${markers}`,
      '  exit 1',
      'fi',
      'ELECTRON_RUN_AS_NODE=1',
      'export ELECTRON_RUN_AS_NODE',
      `exec ${shellQuote(this.execPath)} "$CD_FAKE_DIR/main.js" "$@"`,
      '',
    ].join('\n');
  }
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/** Hard-coded provider endpoints and where the mock serves them. */
const REDIRECTS: [string, string][] = [
  ['https://api.elevenlabs.io/', '/__el/'],
  ['https://api.openai.com/', '/__oa/'],
];

export class FetchTripwire {
  readonly blocked: { t: number; url: string }[] = [];
  readonly redirected: { t: number; from: string; to: string }[] = [];
  private readonly allowedPorts = new Set<number>();
  private origin: string | undefined;
  private readonly realFetch: typeof fetch;

  constructor() {
    this.realFetch = globalThis.fetch;
    const tripwire = (input: string | URL | Request, init?: RequestInit): Promise<Response> => this.fetch(input, init);
    globalThis.fetch = tripwire as typeof fetch;
    if (globalThis.fetch !== tripwire) {
      throw new SafetyAbort('could not replace global fetch');
    }
  }

  /** Only this server is reachable: http://127.0.0.1:<port>/ */
  setMock(origin: string, port: number): void {
    this.origin = origin;
    this.allowedPorts.clear();
    this.allowedPorts.add(port);
  }

  /** Also allow a local port, e.g. a closed one for a connection-refused check. */
  allowPort(port: number): void {
    this.allowedPorts.add(port);
  }

  private fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const original = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let url = original;
    for (const [from, to] of REDIRECTS) {
      if (this.origin && url.startsWith(from)) {
        url = `${this.origin}${to}${url.slice(from.length)}`;
        this.redirected.push({ t: Date.now(), from: original, to: url });
      }
    }
    const match = /^http:\/\/127\.0\.0\.1:(\d+)\//.exec(url);
    if (!match || !this.allowedPorts.has(Number(match[1]))) {
      this.blocked.push({ t: Date.now(), url: original });
      return Promise.reject(new TypeError(`e2e network tripwire: blocked ${original}`));
    }
    const target = input instanceof Request && url !== original ? new Request(url, input) : url === original ? input : url;
    return this.realFetch(target, init);
  }
}

// ---------------------------------------------------------------------------
// Process environment
// ---------------------------------------------------------------------------

export interface SuiteEnv {
  launchName: string;
  /** Root of this VS Code launch; every private directory lives under it. */
  launchDir: string;
  /** Scratch space of the suite (fake toolchain, markers, diagnostic log). */
  workDir: string;
  resultsFile: string;
  userDataDir: string;
  runtimeDir: string;
  units: string[];
}

/** The variables runTests.ts sets; without them the suite was not started in an isolated VS Code. */
export function readSuiteEnv(): SuiteEnv {
  const get = (name: string): string => {
    const value = process.env[name];
    if (!value) {
      throw new SafetyAbort(`${name} is not set. Run the suite with "npm run test:e2e": it isolates VS Code from your desktop, microphone and profile.`);
    }
    return value;
  };
  return {
    launchName: get('E2E_LAUNCH_NAME'),
    launchDir: get('E2E_LAUNCH_DIR'),
    workDir: get('E2E_WORK_DIR'),
    resultsFile: get('E2E_RESULTS_FILE'),
    userDataDir: get('E2E_USER_DATA_DIR'),
    runtimeDir: get('E2E_RUNTIME_DIR'),
    units: get('E2E_SCENARIOS').split(',').filter(Boolean),
  };
}

function inside(child: string | undefined, parent: string): boolean {
  if (!child) {
    return false;
  }
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Throws SafetyAbort when the extension host could reach the desktop session or the user's profile. */
export function checkIsolation(env: SuiteEnv): Record<string, unknown> {
  const e = process.env;
  const report: Record<string, unknown> = {
    HOME: e.HOME,
    TMPDIR: os.tmpdir(),
    XDG_RUNTIME_DIR: e.XDG_RUNTIME_DIR,
    DISPLAY: e.DISPLAY ?? null,
    WAYLAND_DISPLAY: e.WAYLAND_DISPLAY ?? null,
    PULSE_SERVER: e.PULSE_SERVER,
    PIPEWIRE_REMOTE: e.PIPEWIRE_REMOTE,
    DBUS_SESSION_BUS_ADDRESS: e.DBUS_SESSION_BUS_ADDRESS ?? null,
    ipcHooks: Object.keys(e).filter((k) => k.startsWith('VSCODE_IPC_HOOK')).map((k) => `${k}=${e[k]}`),
  };
  if (process.platform !== 'linux') {
    return report;
  }
  const problems: string[] = [];
  for (const name of ['DISPLAY', 'WAYLAND_DISPLAY']) {
    if (e[name]) {
      problems.push(`${name} is set: a window would open on the desktop and the clipboard would be the desktop's`);
    }
  }
  if (!inside(e.HOME, env.launchDir)) {
    problems.push(`HOME ${e.HOME} is outside the run directory`);
  }
  if (!inside(os.tmpdir(), env.launchDir)) {
    problems.push(`the temp dir ${os.tmpdir()} is outside the run directory`);
  }
  if (e.XDG_RUNTIME_DIR !== env.runtimeDir) {
    problems.push(`XDG_RUNTIME_DIR ${e.XDG_RUNTIME_DIR} is not the run's own`);
  }
  for (const name of ['PULSE_SERVER', 'PIPEWIRE_REMOTE']) {
    if (!(e[name] ?? '').includes('/dev/null/')) {
      problems.push(`${name}=${e[name]} could reach a sound server`);
    }
  }
  const bus = e.DBUS_SESSION_BUS_ADDRESS;
  if (bus && bus !== 'disabled:' && !bus.includes('/dev/null/')) {
    problems.push(`DBUS_SESSION_BUS_ADDRESS=${bus} reaches a session bus`);
  }
  for (const key of Object.keys(e).filter((k) => k.startsWith('VSCODE_IPC_HOOK'))) {
    if (!inside(e[key], env.runtimeDir) && !inside(e[key], env.launchDir)) {
      problems.push(`${key}=${e[key]} points at another VS Code`);
    }
  }
  if (problems.length > 0) {
    throw new SafetyAbort(`the extension host is not isolated: ${problems.join('; ')}`);
  }
  return report;
}
