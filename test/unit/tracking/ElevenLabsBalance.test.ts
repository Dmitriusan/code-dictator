import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Memento } from 'vscode';
import { ElevenLabsBalance } from '../../../src/tracking/ElevenLabsBalance';

const SUBSCRIPTION_URL = 'https://api.elevenlabs.io/v1/user/subscription';
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const RENEWS_UNIX = Date.UTC(2026, 11, 1) / 1000;

/** Global state as VS Code keeps it, shared by every window. */
function createState(): Memento & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    keys: () => [...store.keys()],
    get: <T>(key: string, defaultValue?: T) => (store.has(key) ? store.get(key) : defaultValue) as T,
    update: async (key: string, value: unknown) => {
      if (value === undefined) {
        store.delete(key);
      } else {
        store.set(key, value);
      }
    },
  } as Memento & { store: Map<string, unknown> };
}

/** A `GET /v1/user/subscription` answer. */
function subscription(used: number, extra: Record<string, unknown> = {}) {
  return {
    tier: 'creator',
    character_count: used,
    character_limit: 121_000,
    status: 'active',
    next_character_count_reset_unix: RENEWS_UNIX,
    voice_limit: 30,
    ...extra,
  };
}

function reply(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

describe('ElevenLabsBalance', () => {
  let state: ReturnType<typeof createState>;
  let apiKey: string | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;
  let balance: ElevenLabsBalance;

  /** Answer the next balance request with this. */
  const answer = (response: Response | Error) => fetchMock.mockImplementationOnce(async () => {
    if (response instanceof Error) {
      throw response;
    }
    return response;
  });

  beforeEach(() => {
    state = createState();
    apiKey = 'xi-test-key-1234';
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    balance = new ElevenLabsBalance(state, async () => apiKey, () => NOW);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('refresh()', () => {
    it('reads the subscription with the API key and keeps the balance', async () => {
      answer(reply(200, subscription(24_588)));

      await balance.refresh();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(SUBSCRIPTION_URL);
      expect(init.headers).toEqual({ 'xi-api-key': 'xi-test-key-1234' });
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(balance.balance).toEqual({
        used: 24_588,
        limit: 121_000,
        tier: 'creator',
        status: 'active',
        renewsAt: RENEWS_UNIX * 1000,
        checkedAt: NOW,
      });
      expect(balance.problem).toBeUndefined();
      expect(balance.lastChecked).toBe(NOW);
    });

    it('shares the balance with other windows through global state', async () => {
      answer(reply(200, subscription(24_588)));
      await balance.refresh();

      const otherWindow = new ElevenLabsBalance(state, async () => apiKey, () => NOW);

      expect(otherWindow.balance?.used).toBe(24_588);
    });

    it('sends nothing without an API key, and forgets an old balance', async () => {
      answer(reply(200, subscription(1000)));
      await balance.refresh();
      apiKey = undefined;

      await balance.refresh();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(balance.balance).toBeUndefined();
      expect(balance.problem).toBeUndefined();
    });

    it('reads once more after a reading in flight, for all the calls made meanwhile', async () => {
      let respond!: (response: Response) => void;
      fetchMock.mockImplementationOnce(() => new Promise((resolve) => { respond = resolve; }));
      answer(reply(200, subscription(7)));

      const first = balance.refresh();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      apiKey = 'xi-new-key-5678'; // stored while the first reading waits for its answer
      const second = balance.refresh();
      const third = balance.refresh();
      respond(reply(200, subscription(5)));
      await first;
      expect(balance.balance?.used).toBe(5);
      await Promise.all([second, third]);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][1].headers).toEqual({ 'xi-api-key': 'xi-new-key-5678' });
      expect(balance.balance?.used).toBe(7);
    });

    it('reads again with a key stored while a reading without one was in flight', async () => {
      const lookups: Array<(key: string | undefined) => void> = [];
      balance = new ElevenLabsBalance(state, () => new Promise((resolve) => lookups.push(resolve)), () => NOW);
      answer(reply(200, subscription(5)));

      const first = balance.refresh(); // the setup wizard switched to ElevenLabs: no key yet
      const second = balance.refresh(); // ...and then stored one
      lookups[0](undefined);
      await first;
      expect(fetchMock).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(lookups).toHaveLength(2));
      lookups[1]('xi-test-key-1234');
      await second;

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(balance.balance?.used).toBe(5);
    });

    it.each([
      ['the legacy status field', 401, { detail: { status: 'missing_permissions', message: 'The API key you used is missing the permission user_read to execute this operation.' } }],
      ['the code field', 403, { detail: { type: 'authorization_error', code: 'insufficient_permissions', message: 'You do not have the required permissions for this action.' } }],
      ['only the message', 401, { detail: { message: 'Missing permission: user_read' } }],
    ])('recognises a key that may not read the account, by %s', async (_how, status, body) => {
      answer(reply(200, subscription(1000)));
      await balance.refresh();
      answer(reply(status, body));

      await balance.refresh();

      expect(balance.problem).toEqual({ kind: 'missing-permission' });
      expect(balance.balance).toBeUndefined(); // no longer that key's to show
    });

    it('reports a key ElevenLabs refuses, with its message', async () => {
      answer(reply(401, { detail: { status: 'invalid_api_key', message: 'Invalid API key' } }));

      await balance.refresh();

      expect(balance.problem).toEqual({ kind: 'rejected', detail: 'Invalid API key' });
    });

    it('keeps the last balance through an outage, and says what went wrong', async () => {
      answer(reply(200, subscription(1000)));
      await balance.refresh();

      answer(reply(503, { detail: { message: 'Service unavailable' } }));
      await balance.refresh();
      expect(balance.problem).toEqual({ kind: 'unavailable', detail: 'ElevenLabs answered 503: Service unavailable' });
      expect(balance.balance?.used).toBe(1000);

      answer(new TypeError('fetch failed'));
      await balance.refresh();
      expect(balance.problem).toEqual({ kind: 'unavailable', detail: 'ElevenLabs could not be reached' });
      expect(balance.balance?.used).toBe(1000);

      answer(reply(200, '<html>maintenance</html>'));
      await balance.refresh();
      expect(balance.problem).toEqual({ kind: 'unavailable', detail: 'ElevenLabs answered in an unexpected format' });

      answer(reply(200, subscription(1200)));
      await balance.refresh();
      expect(balance.problem).toBeUndefined();
      expect(balance.balance?.used).toBe(1200);
    });

    it('never rejects, even when the key cannot be read', async () => {
      balance = new ElevenLabsBalance(state, () => Promise.reject(new Error('keychain locked')), () => NOW);

      await expect(balance.refresh()).resolves.toBeUndefined();

      expect(balance.problem).toEqual({ kind: 'unavailable', detail: 'keychain locked' });
    });

    it('counts a failed attempt as a check, so a window does not retry at every focus', async () => {
      answer(new TypeError('fetch failed'));

      await balance.refresh();

      expect(balance.lastChecked).toBe(NOW);
    });
  });

  describe('rate()', () => {
    /** Read the balance with `used` credits used. */
    const readAt = async (used: number, extra?: Record<string, unknown>) => {
      answer(reply(200, subscription(used, extra)));
      await balance.refresh();
    };

    it("starts from ElevenLabs' API price on a paid plan: 21 credits a minute", async () => {
      await readAt(1000);

      expect(balance.rate()).toEqual({ creditsPerMinute: 21, measuredSeconds: 0 });
    });

    it('starts from 37 credits a minute on the Free plan, whose credits buy fewer hours', async () => {
      await readAt(1000, { tier: 'free', status: 'free', character_limit: 10_000 });

      expect(balance.rate()).toEqual({ creditsPerMinute: 37, measuredSeconds: 0 });
    });

    it('moves to what the dictation was charged', async () => {
      await readAt(1000);
      await balance.noteTranscribed(60);
      await readAt(1020); // 20 credits for a minute

      const rate = balance.rate();
      expect(rate.measuredSeconds).toBe(60);
      // One measured minute at 20 against half a minute at the price
      expect(rate.creditsPerMinute).toBeCloseTo((20 * 60 + 21 * 30) / 90, 6);

      for (let used = 1020; used < 1020 + 20 * 60; used += 20) {
        await balance.noteTranscribed(60);
        await readAt(used + 20);
      }
      expect(balance.rate().creditsPerMinute).toBeCloseTo(20, 1);
    });

    it('waits for a charge that has not shown yet, and measures it with the next', async () => {
      await readAt(1000);
      await balance.noteTranscribed(30);
      await readAt(1000); // not posted yet
      expect(balance.rate().measuredSeconds).toBe(0);

      await balance.noteTranscribed(30);
      await readAt(1020); // both dictations charged

      expect(balance.rate().measuredSeconds).toBe(60);
    });

    it('leaves out credits spent on something other than dictation', async () => {
      await readAt(1000);
      await readAt(6000); // text to speech, no dictation in between
      await balance.noteTranscribed(30);
      await readAt(6010);

      expect(balance.rate().measuredSeconds).toBe(30);

      await balance.noteTranscribed(10);
      await readAt(9010); // 3000 credits for 10 s: more than any dictation costs
      expect(balance.rate().measuredSeconds).toBe(30);
    });

    it('starts over in a new period, where the count of used credits starts again', async () => {
      await readAt(100_000);
      await balance.noteTranscribed(60);
      await readAt(20, { next_character_count_reset_unix: RENEWS_UNIX + 30 * 86_400 });

      expect(balance.rate().measuredSeconds).toBe(0);

      await balance.noteTranscribed(60);
      await readAt(40, { next_character_count_reset_unix: RENEWS_UNIX + 30 * 86_400 });
      expect(balance.rate().measuredSeconds).toBe(60);
    });

    it('forgets the measured rate when the plan changes', async () => {
      await readAt(1000);
      await balance.noteTranscribed(60);
      await readAt(1020);
      expect(balance.rate().measuredSeconds).toBe(60);

      await readAt(1020, { tier: 'pro', character_limit: 600_000 });

      expect(balance.rate()).toEqual({ creditsPerMinute: 21, measuredSeconds: 0 });
    });

    it('lets old measurements fade, so a new price shows', async () => {
      await readAt(0);
      let used = 0;
      for (let hour = 0; hour < 5; hour++) {
        await balance.noteTranscribed(3600);
        used += 20 * 60;
        await readAt(used);
      }

      expect(balance.rate().measuredSeconds).toBeLessThanOrEqual(4 * 3600);
      expect(balance.rate().creditsPerMinute).toBeCloseTo(20, 0);
    });

    it('counts dictation from every window', async () => {
      await readAt(1000);
      const otherWindow = new ElevenLabsBalance(state, async () => apiKey, () => NOW);
      await otherWindow.noteTranscribed(30);
      await balance.noteTranscribed(30);
      await readAt(1020);

      expect(balance.rate().measuredSeconds).toBe(60);
    });

    it('ignores recordings without a length', async () => {
      await balance.noteTranscribed(0);
      await balance.noteTranscribed(Number.NaN);

      expect(state.store.size).toBe(0);
    });
  });
});
