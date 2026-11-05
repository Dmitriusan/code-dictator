import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { QuickPickItem } from 'vscode';
import type { UsageStats } from '../../../src/types';

vi.mock('vscode', () => import('../__mocks__/vscode').then((m) => m.default));

import vscode from '../__mocks__/vscode';
import { showUsagePicker, type UsagePickerInput } from '../../../src/ui/UsagePicker';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const DAY = 86_400_000;
const at = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const STATS: UsageStats = {
  totalTranscriptions: 120,
  totalDurationMs: 3_600_000,
  totalEstimatedCost: 0.4,
  todayTranscriptions: 14,
  todayDurationMs: 750_000,
  todayEstimatedCost: 0.056,
  weekTranscriptions: 40,
  weekDurationMs: 1_800_000,
  weekEstimatedCost: 0.2,
};

const ELEVENLABS: UsagePickerInput = {
  provider: 'elevenlabs',
  stats: STATS,
  balance: { used: 24_588, limit: 121_000, tier: 'creator', status: 'active', renewsAt: NOW + 26 * DAY, checkedAt: NOW - 2 * 60_000 },
  rate: { creditsPerMinute: 20, measuredSeconds: 3000 },
  now: NOW,
};

/** Open the picker, choosing the item with this label (or nothing); returns the items it showed. */
async function pick(input: UsagePickerInput, label?: string): Promise<{ items: QuickPickItem[]; options: unknown; action: unknown }> {
  let items: QuickPickItem[] = [];
  let options: unknown;
  vscode.window.showQuickPick.mockImplementationOnce(async (shown: QuickPickItem[], opts: unknown) => {
    items = shown;
    options = opts;
    return shown.find((i) => i.label === label);
  });
  const action = await showUsagePicker(input);
  return { items, options, action };
}

describe('showUsagePicker()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('with ElevenLabs puts the balance first, and the dictation in credits', async () => {
    const { items, options } = await pick(ELEVENLABS);

    expect(items.map((i) => i.label)).toEqual([
      'ElevenLabs',
      '$(credit-card) 96,412 credits left',
      '$(refresh) Check the balance again',
      '$(link-external) Open your ElevenLabs subscription',
      'Dictation',
      '$(calendar) Today',
      '$(calendar) This Week',
      '$(history) All Time',
      '',
      '$(book) View History',
      '$(gear) Open Settings',
    ]);
    expect(items[1].description).toBe('of 121,000 · Creator plan');
    expect(items[1].detail).toBe(`About 80 hours of dictation at ~20 credits a minute · renews in 26 days · checked at ${at(NOW - 2 * 60_000)}`);
    expect(items[5].description).toBe('14 transcriptions');
    expect(items[5].detail).toBe('Audio: 12m 30s · about 250 credits');
    expect(options).toEqual({
      title: 'Code Dictator — Speech-to-Text Usage',
      placeHolder: 'Your ElevenLabs credits, and the audio you dictated',
    });
  });

  it('opens the ElevenLabs subscription page itself', async () => {
    const { action } = await pick(ELEVENLABS, '$(link-external) Open your ElevenLabs subscription');

    expect(action).toBeUndefined();
    expect(vscode.env.openExternal).toHaveBeenCalledWith(expect.objectContaining({ fsPath: 'https://elevenlabs.io/app/subscription' }));
  });

  it('returns the choices the caller carries out', async () => {
    expect((await pick(ELEVENLABS, '$(refresh) Check the balance again')).action).toBe('checkBalance');
    expect((await pick(ELEVENLABS, '$(book) View History')).action).toBe('history');
    expect((await pick(ELEVENLABS, '$(gear) Open Settings')).action).toBe('settings');
    expect((await pick(ELEVENLABS)).action).toBeUndefined();
  });

  it('says when the credits are used up', async () => {
    const { items } = await pick({ ...ELEVENLABS, balance: { ...ELEVENLABS.balance!, used: 121_000 } });

    expect(items[1].label).toBe('$(credit-card) No credits left');
    expect(items[1].detail).toBe(`ElevenLabs refuses transcriptions until they renew · renews in 26 days · checked at ${at(NOW - 2 * 60_000)}`);
  });

  it('leads to the API key settings when the key may not read the balance', async () => {
    const input: UsagePickerInput = { provider: 'elevenlabs', stats: STATS, rate: ELEVENLABS.rate, problem: { kind: 'missing-permission' }, now: NOW };
    const { items } = await pick(input);

    expect(items[1].label).toBe('$(key) Show your ElevenLabs credits here');
    expect(items[1].detail).toContain('edit the key and set User to Read');
    expect(items.find((i) => i.label === '$(calendar) Today')?.detail).toBe('Audio: 12m 30s · Estimated speech-to-text cost: $0.06');

    await pick(input, '$(key) Show your ElevenLabs credits here');
    expect(vscode.env.openExternal).toHaveBeenCalledWith(expect.objectContaining({ fsPath: 'https://elevenlabs.io/app/settings/api-keys' }));
  });

  it('offers to read the balance again after another failure', async () => {
    const { items, action } = await pick(
      { provider: 'elevenlabs', stats: STATS, rate: ELEVENLABS.rate, problem: { kind: 'unavailable', detail: 'ElevenLabs could not be reached' }, now: NOW },
      '$(refresh) Read your ElevenLabs balance',
    );

    expect(items[1].detail).toBe('It could not be read: ElevenLabs could not be reached');
    expect(action).toBe('checkBalance');
  });

  it('with OpenAI shows the estimated speech-to-text cost, and no balance', async () => {
    const { items, options } = await pick({ provider: 'openai', stats: STATS, now: NOW });

    expect(items.map((i) => i.label)).toEqual([
      '$(calendar) Today',
      '$(calendar) This Week',
      '$(history) All Time',
      '',
      '$(book) View History',
      '$(gear) Open Settings',
    ]);
    expect(items[0].detail).toBe('Audio: 12m 30s · Estimated speech-to-text cost: $0.06');
    expect(items[2].description).toBe('120 transcriptions');
    expect(options).toEqual({
      title: 'Code Dictator — Speech-to-Text Usage',
      placeHolder: 'The audio you dictated and its estimated speech-to-text cost (AI cleanup not included)',
    });
  });
});
