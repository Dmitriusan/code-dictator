import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type VscodeMock = typeof import('./__mocks__/vscode').default;
type StatusItem = ReturnType<typeof import('./__mocks__/vscode').createMockStatusBarItem>;

const mocks = vi.hoisted(() => ({
  isRecording: false,
  providerId: 'elevenlabs',
  transcribe: async () => ({ text: 'hello world', language: 'en', cost: 0.0042 }) as { text: string; language?: string; cost?: number },
}));

vi.mock('vscode', () => import('./__mocks__/vscode').then((m) => m.default));

vi.mock('../../src/recorder/RecorderManager', () => ({
  RecorderManager: class {
    get isRecording() { return mocks.isRecording; }
    stopRecording() { mocks.isRecording = false; return Promise.resolve({ buffer: speechWav(), mimeType: 'audio/wav', durationMs: 60_000 }); }
    startRecording() { return Promise.resolve(); }
    cancelRecording() { /* no-op */ }
    onError() { return { dispose() { /* no-op */ } }; }
    onRecordingStarted() { return { dispose() { /* no-op */ } }; }
    onRecordingStopped() { return { dispose() { /* no-op */ } }; }
    onSilenceDetected() { return { dispose() { /* no-op */ } }; }
    onTrackEnded() { return { dispose() { /* no-op */ } }; }
    dispose() { /* no-op */ }
  },
}));

vi.mock('../../src/providers/ProviderFactory', () => ({
  createProvider: () => ({
    name: 'Fake STT',
    id: mocks.providerId,
    transcribe: () => mocks.transcribe(),
    validateConfig: async () => true,
    estimateCost: () => 0,
  }),
}));

/** One second of a 440 Hz tone as 16-bit mono 16 kHz WAV — passes the silence guard. */
function speechWav(): Buffer {
  const samples = 16000;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + samples * 2, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    wav.writeInt16LE(Math.round(3000 * Math.sin(2 * Math.PI * 440 * i / 16000)), 44 + i * 2);
  }
  return wav;
}

const SUBSCRIPTION_URL = 'https://api.elevenlabs.io/v1/user/subscription';
const KEY = 'codeDictator.elevenlabs.apiKey';

function subscription(used: number) {
  return { tier: 'creator', character_count: used, character_limit: 121_000, status: 'active', next_character_count_reset_unix: 1_796_083_200 };
}

describe('the status bar usage item', () => {
  let storageRoot: string;
  let vscode: VscodeMock;
  let commands: Map<string, (...args: unknown[]) => Promise<void> | void>;
  let settings: Record<string, unknown>;
  let context: ReturnType<typeof import('./__mocks__/vscode').createMockExtensionContext>;
  /** Answers to the balance requests, oldest first; an unanswered request fails like a network error. */
  let answers: Array<() => Response>;
  let fetchMock: ReturnType<typeof vi.fn>;

  const usageItem = () => vi.mocked(vscode.window.createStatusBarItem).mock.results[2].value as StatusItem;
  const tooltip = () => (usageItem().tooltip as { value: string }).value;
  const balanceRequests = () => fetchMock.mock.calls.filter(([url]) => url === SUBSCRIPTION_URL);
  const answer = (status: number, body: unknown) => answers.push(() => new Response(JSON.stringify(body), { status }));

  async function activate(): Promise<void> {
    const { createMockConfiguration, createMockExtensionContext } = await import('./__mocks__/vscode');
    vi.mocked(vscode.workspace.getConfiguration).mockImplementation((() => createMockConfiguration(settings)) as never);
    context = createMockExtensionContext();
    if (settings.provider === 'elevenlabs') {
      context._secretStore.set(KEY, 'xi-test-key-1234');
    }
    await context.globalState.update('codeDictator.onboarded', true); // skip the setup wizard
    const extension = await import('../../src/extension');
    extension.activate({ ...context, globalStorageUri: { fsPath: storageRoot } } as never);
  }

  /** Dictate one minute through Alt+D and wait for the text. */
  async function dictate(): Promise<void> {
    mocks.isRecording = true;
    const pasted = vi.mocked(vscode.env.clipboard.writeText).mock.calls.length;
    await commands.get('codeDictator.toggleRecording')!();
    await vi.waitFor(() => expect(vi.mocked(vscode.env.clipboard.writeText).mock.calls.length).toBeGreaterThan(pasted));
  }

  beforeEach(async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 5, 12, 0, 0) });
    vi.resetModules(); // fresh extension state; the mocked modules themselves are shared
    vi.clearAllMocks();
    storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-dictator-balance-test-'));
    mocks.isRecording = false;
    mocks.providerId = 'elevenlabs';
    settings = { provider: 'elevenlabs' };
    answers = [];
    fetchMock = vi.fn(async () => {
      const next = answers.shift();
      if (!next) {
        throw new TypeError('fetch failed');
      }
      return next();
    });
    vi.stubGlobal('fetch', fetchMock);

    vscode = (await import('vscode')) as unknown as VscodeMock;
    commands = new Map();
    vi.mocked(vscode.commands.registerCommand).mockImplementation(((id: string, handler: () => void) => {
      commands.set(id, handler);
      return { dispose() { /* no-op */ } };
    }) as never);
  });

  afterEach(() => {
    vi.mocked(vscode.workspace.getConfiguration).mockReset(); // back to the default settings
    vi.mocked(vscode.window.showQuickPick).mockReset();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });

  it('shows the ElevenLabs credits left as soon as VS Code starts', async () => {
    answer(200, subscription(24_588));

    await activate();

    // 96,412 credits at ElevenLabs' price, 21 credits a minute: 76 hours
    await vi.waitFor(() => expect(usageItem().text).toBe('$(credit-card) 96.4K · ~76h'));
    expect(balanceRequests()).toHaveLength(1);
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ 'xi-api-key': 'xi-test-key-1234' });
    expect(tooltip()).toContain('**ElevenLabs credits left: 96,412** of 121,000');
    expect(usageItem().show).toHaveBeenCalled();
  });

  it('reads the balance again after a dictation, and learns what dictation costs', async () => {
    answer(200, subscription(24_588));
    await activate();
    await vi.waitFor(() => expect(usageItem().text).toBe('$(credit-card) 96.4K · ~76h'));

    answer(200, subscription(24_608)); // 20 credits for the minute
    await dictate();
    expect(balanceRequests()).toHaveLength(1); // the charge may not show at once
    await vi.advanceTimersByTimeAsync(2000);

    await vi.waitFor(() => expect(balanceRequests()).toHaveLength(2));
    // 96,392 credits at (60 × 20 + 30 × 21) / 90 = 20.3 credits a minute: 79 hours
    await vi.waitFor(() => expect(usageItem().text).toBe('$(credit-card) 96.4K · ~79h'));
    expect(tooltip()).toContain('what your dictation has cost so far');
  });

  it("falls back to today's cost, and says how to show the credits, when the key may not read the account", async () => {
    answer(401, { detail: { status: 'missing_permissions', message: 'The API key you used is missing the permission user_read to execute this operation.' } });
    await activate();
    await vi.waitFor(() => expect(balanceRequests()).toHaveLength(1));
    expect(usageItem().hide).toHaveBeenCalled(); // nothing dictated today yet

    answer(401, { detail: { status: 'missing_permissions', message: 'The API key you used is missing the permission user_read to execute this operation.' } });
    await dictate();

    expect(usageItem().text).toBe('$(credit-card) $0.0042');
    expect(tooltip()).toContain('**Speech-to-text cost today: about $0.0042**');
    expect(tooltip()).toContain('set **User** to **Read**');
  });

  it('with OpenAI shows the speech-to-text cost and never asks ElevenLabs', async () => {
    settings = { provider: 'openai' };
    mocks.providerId = 'openai';
    await activate();

    await dictate();
    await vi.advanceTimersByTimeAsync(5000);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(usageItem().text).toBe('$(credit-card) $0.0042');
    expect(tooltip()).toContain("**Speech-to-text cost today: about $0.0042**");
    expect(tooltip()).toContain("OpenAI's price for transcription");
  });

  it('reads nothing when the item is turned off', async () => {
    settings = { provider: 'elevenlabs', 'feedback.showCost': false };
    await activate();

    await dictate();
    await vi.advanceTimersByTimeAsync(5000);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(usageItem().show).not.toHaveBeenCalled();
  });

  it('reads the balance again when the window comes back after a while, or the key changes', async () => {
    answer(200, subscription(24_588));
    await activate();
    await vi.waitFor(() => expect(balanceRequests()).toHaveLength(1));
    const onFocus = vi.mocked(vscode.window.onDidChangeWindowState).mock.calls[0][0] as (state: { focused: boolean }) => void;
    const onSecret = vi.mocked(context.secrets.onDidChange).mock.calls[0][0] as (e: { key: string }) => void;

    onFocus({ focused: true }); // just read: no request
    expect(balanceRequests()).toHaveLength(1);

    answer(200, subscription(30_000));
    vi.setSystemTime(Date.now() + 11 * 60_000);
    onFocus({ focused: true });
    await vi.waitFor(() => expect(usageItem().text).toBe('$(credit-card) 91K · ~72h'));

    onSecret({ key: 'codeDictator.openai.apiKey' });
    expect(balanceRequests()).toHaveLength(2);
    answer(200, { ...subscription(500), tier: 'free', status: 'free', character_limit: 10_000 });
    context._secretStore.set(KEY, 'xi-another-account');
    onSecret({ key: KEY });
    // 9,500 credits on the Free plan, 37 credits a minute: 4.2 hours
    await vi.waitFor(() => expect(usageItem().text).toBe('$(credit-card) 9.5K · ~4.2h'));
    expect(fetchMock.mock.calls[2][1].headers).toEqual({ 'xi-api-key': 'xi-another-account' });
  });

  it('opens the usage QuickPick with the balance, and can check it again', async () => {
    answer(200, subscription(24_588));
    await activate();
    await vi.waitFor(() => expect(balanceRequests()).toHaveLength(1));

    answer(200, subscription(25_000));
    const picked: string[][] = [];
    vi.mocked(vscode.window.showQuickPick).mockImplementation((async (items: { label: string }[]) => {
      picked.push(items.map((i) => i.label));
      return picked.length === 1 ? items.find((i) => i.label === '$(refresh) Check the balance again') : undefined;
    }) as never);

    await commands.get('codeDictator.showUsage')!();

    await vi.waitFor(() => expect(picked).toHaveLength(2));
    expect(picked[0]).toContain('$(credit-card) 96,412 credits left');
    expect(picked[1]).toContain('$(credit-card) 96,000 credits left');
    expect(usageItem().text).toBe('$(credit-card) 96K · ~76h');
  });
});
