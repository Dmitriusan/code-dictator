import { describe, it, expect } from 'vitest';
import type { Balance } from '../../../src/tracking/ElevenLabsBalance';
import type { UsageStats } from '../../../src/types';
import {
  balanceView,
  compactCredits,
  compactDuration,
  costView,
  longDuration,
} from '../../../src/ui/UsageIndicator';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const DAY = 86_400_000;

function creator(used: number, extra: Partial<Balance> = {}): Balance {
  return { used, limit: 121_000, tier: 'creator', status: 'active', renewsAt: NOW + 26 * DAY, checkedAt: NOW - 2 * 60_000, ...extra };
}

const PRICE = { creditsPerMinute: 21, measuredSeconds: 0 };
/** How the tooltip writes the time the balance was read, in the local time zone. */
const at = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const MEASURED = { creditsPerMinute: 20.2, measuredSeconds: 2040 };

function stats(today: Partial<UsageStats>): UsageStats {
  return {
    totalTranscriptions: 0,
    totalDurationMs: 0,
    totalEstimatedCost: 0,
    todayTranscriptions: 0,
    todayDurationMs: 0,
    todayEstimatedCost: 0,
    weekTranscriptions: 0,
    weekDurationMs: 0,
    weekEstimatedCost: 0,
    ...today,
  };
}

describe('balanceView()', () => {
  it('shows the credits left and the dictation they buy', () => {
    const view = balanceView(creator(24_588), MEASURED, undefined, NOW);

    // 96,412 credits at 20.2 a minute: 4,772 minutes, 79 hours
    expect(view.text).toBe('$(credit-card) 96.4K · ~79h');
    expect(view.level).toBeUndefined();
  });

  it('explains in the tooltip what the item is and how the time was worked out', () => {
    const { tooltip } = balanceView(creator(24_588), MEASURED, undefined, NOW);

    expect(tooltip).toContain('**ElevenLabs credits left: 96,412** of 121,000');
    expect(tooltip).toContain('About **79 hours** of dictation, at about 20 credits a minute, what your dictation has cost so far');
    expect(tooltip).toContain(`Creator plan · renews in 26 days · checked at ${at(NOW - 2 * 60_000)}`);
    expect(tooltip).toContain('Your ElevenLabs subscription balance, read from your account.');
    expect(tooltip).toContain('Click for details.');
  });

  it("says when the time comes from ElevenLabs' price rather than measured dictation", () => {
    const { tooltip } = balanceView(creator(24_588), PRICE, undefined, NOW);

    expect(tooltip).toContain("at about 21 credits a minute, ElevenLabs' API price for Scribe v2 on your plan");
  });

  it('turns yellow with less than half an hour of dictation left', () => {
    const view = balanceView(creator(120_400), PRICE, undefined, NOW); // 600 credits: 28 minutes

    expect(view.text).toBe('$(credit-card) 600 · ~28m');
    expect(view.level).toBe('warning');
  });

  it('turns red when no credits are left, and says what happens then', () => {
    const view = balanceView(creator(121_250), PRICE, undefined, NOW);

    expect(view.text).toBe('$(credit-card) No credits');
    expect(view.level).toBe('error');
    expect(view.tooltip).toContain('**ElevenLabs credits: none left** of 121,000');
    expect(view.tooltip).toContain('ElevenLabs turns transcriptions away until your credits renew in 26 days');
  });

  it('names the Free plan and other tiers as plans', () => {
    expect(balanceView(creator(0, { tier: 'free', status: 'free', limit: 10_000 }), PRICE, undefined, NOW).tooltip)
      .toContain('Free plan · renews in 26 days');
    expect(balanceView(creator(0, { tier: 'growing_business' }), PRICE, undefined, NOW).tooltip)
      .toContain('Growing business plan · ');
    expect(balanceView(creator(0, { tier: undefined, renewsAt: undefined }), PRICE, undefined, NOW).tooltip)
      .toContain(`\n\nchecked at ${at(NOW - 2 * 60_000)}\n\n`);
  });

  it('says so when the balance could not be read again, escaping what ElevenLabs said', () => {
    const view = balanceView(creator(24_588, { checkedAt: NOW - 3 * DAY }), PRICE,
      { kind: 'unavailable', detail: 'ElevenLabs answered 503: *busy*' }, NOW);

    expect(view.tooltip).toContain('checked 3 days ago');
    expect(view.tooltip).toContain('*Could not check it again: ElevenLabs answered 503: \\*busy\\**');
  });

  it('counts renewal in hours on its last day', () => {
    expect(balanceView(creator(0, { renewsAt: NOW + 5 * 3_600_000 - 1000 }), PRICE, undefined, NOW).tooltip)
      .toContain('renews in 5 hours');
  });
});

describe('costView()', () => {
  it('is hidden before the first transcription of the day', () => {
    expect(costView(stats({}), 'openai')).toBeUndefined();
  });

  it("shows today's cost, and says in the tooltip that it is the speech-to-text cost Code Dictator estimated", () => {
    const view = costView(stats({ todayTranscriptions: 14, todayDurationMs: 750_000, todayEstimatedCost: 0.056 }), 'openai');

    expect(view?.text).toBe('$(credit-card) $0.06');
    expect(view?.level).toBeUndefined();
    expect(view?.tooltip).toContain('**Speech-to-text cost today: about $0.06**');
    expect(view?.tooltip).toContain('14 transcriptions · 12m 30s of audio');
    expect(view?.tooltip).toContain("Code Dictator's estimate from the length of today's recordings and OpenAI's price for transcription. It is not read from your account, and AI cleanup is not included.");
  });

  it('says that a custom endpoint has no price', () => {
    const view = costView(stats({ todayTranscriptions: 1, todayDurationMs: 4000 }), 'custom');

    expect(view?.text).toBe('$(credit-card) Free');
    expect(view?.tooltip).toContain('**Speech-to-text cost today: none**');
    expect(view?.tooltip).toContain('1 transcription · 4s of audio');
    expect(view?.tooltip).toContain('Code Dictator does not know what your own endpoint costs.');
  });

  it('tells an ElevenLabs user how to let the key read the balance', () => {
    const view = costView(stats({ todayTranscriptions: 2, todayDurationMs: 20_000, todayEstimatedCost: 0.0012 }), 'elevenlabs',
      { kind: 'missing-permission' });

    expect(view?.text).toBe('$(credit-card) $0.0012');
    expect(view?.tooltip).toContain("today's recordings and ElevenLabs' price for transcription");
    expect(view?.tooltip).toContain('**Your ElevenLabs credits can show here instead.**');
    expect(view?.tooltip).toContain('[elevenlabs.io](https://elevenlabs.io/app/settings/api-keys), edit the key and set **User** to **Read**');
  });

  it('says why the ElevenLabs balance could not be read', () => {
    const today = stats({ todayTranscriptions: 2, todayDurationMs: 20_000, todayEstimatedCost: 0.0012 });

    expect(costView(today, 'elevenlabs', { kind: 'rejected', detail: 'Invalid API key' })?.tooltip)
      .toContain('**Your ElevenLabs balance could not be read:** ElevenLabs refused the API key \\(Invalid API key\\).');
    expect(costView(today, 'elevenlabs', { kind: 'unavailable', detail: 'ElevenLabs could not be reached' })?.tooltip)
      .toContain('ElevenLabs could not be reached. Code Dictator tries again after your next dictation.');
    expect(costView(today, 'openai', { kind: 'missing-permission' })?.tooltip).not.toContain('ElevenLabs');
  });
});

describe('formatting', () => {
  it.each([
    [0, '0'],
    [950, '950'],
    [9_999, '10K'],
    [96_412, '96.4K'],
    [121_000, '121K'],
    [1_234_567, '1.2M'],
  ])('compacts %d credits to %s', (credits, text) => {
    expect(compactCredits(credits)).toBe(text);
  });

  it.each([
    [0.4, '<1m'],
    [45.9, '45m'],
    [60, '1h'],
    [275, '4.5h'],
    [599, '9.9h'],
    [4772, '79h'],
  ])('compacts %d minutes to %s, rounding down', (minutes, text) => {
    expect(compactDuration(minutes)).toBe(text);
  });

  it.each([
    [0.5, 'less than a minute'],
    [1, '1 minute'],
    [45.9, '45 minutes'],
    [60, '1 hour'],
    [61, '1 hour 1 minute'],
    [275, '4 hours 35 minutes'],
    [600, '10 hours'],
    [4772, '79 hours'],
  ])('writes %d minutes out as "%s"', (minutes, text) => {
    expect(longDuration(minutes)).toBe(text);
  });
});
