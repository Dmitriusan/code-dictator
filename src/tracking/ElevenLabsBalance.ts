import type { Memento } from 'vscode';

const SUBSCRIPTION_URL = 'https://api.elevenlabs.io/v1/user/subscription';
const REQUEST_TIMEOUT_MS = 10_000;

const BALANCE_KEY = 'codeDictator.elevenlabs.balance';
const METER_KEY = 'codeDictator.elevenlabs.creditMeter';

/**
 * Credits a minute of Scribe v2 costs through the API, until Code Dictator has
 * measured it. The API price is $0.22 an hour on every plan, paid in credits at
 * the plan's rate: the Free plan's 10,000 credits buy 4.5 hours (37 a minute),
 * paid plans' credits buy 18.5 (Starter) to 22.2 (Pro and up) credits a minute
 * (elevenlabs.io/pricing/api, November 2026).
 */
const FREE_PLAN_CREDITS_PER_MINUTE = 37;
const PAID_PLAN_CREDITS_PER_MINUTE = 21;
/** Seconds of dictation the plan's price counts for, against what was measured. */
const PRICE_WEIGHT_SECONDS = 30;
/**
 * More than ElevenLabs charges in its web app (330 credits a minute): credits
 * beyond that went to something else, like text to speech.
 */
const MAX_CREDITS_PER_MINUTE = 400;
/** Measured charges fade out after about this much dictation, so a new price shows. */
const MEASURED_SECONDS_CAP = 4 * 3600;

/** API errors that mean the key works but may not read the account (it lacks `user_read`). */
const PERMISSION_CODES = new Set(['missing_permissions', 'insufficient_permissions']);

/** The credits of an ElevenLabs subscription, as last read from the account. */
export interface Balance {
  /** Credits used in the current period. */
  used: number;
  /** Credits the subscription has for the current period. */
  limit: number;
  tier?: string;
  /** Subscription status: "free", "active", "past_due"... */
  status?: string;
  /** When the credits renew, in ms. */
  renewsAt?: number;
  /** When the balance was read, in ms. */
  checkedAt: number;
}

/** What a minute of dictation costs in credits, and over how much dictation that was measured. */
export interface CreditRate {
  creditsPerMinute: number;
  measuredSeconds: number;
}

/** Why the balance could not be read. */
export type BalanceProblem =
  /** The key may transcribe but not read the account. */
  | { kind: 'missing-permission' }
  /** ElevenLabs refused the key itself. */
  | { kind: 'rejected'; detail: string }
  /** No answer, or one Code Dictator does not understand; worth trying again. */
  | { kind: 'unavailable'; detail: string };

/**
 * What dictation costs, learned from how far the credits move between readings.
 * Kept in global state, so every VS Code window adds to the same count.
 */
interface CreditMeter {
  /** Seconds of audio Code Dictator has had transcribed, in total. */
  audioSeconds: number;
  /** The reading the next measurement starts from. */
  mark?: { used: number; audioSeconds: number; period: string };
  /** Credits charged for `seconds` of dictation. */
  credits: number;
  seconds: number;
  /** The plan the measurement belongs to. */
  tier?: string;
}

/**
 * The ElevenLabs credit balance: read from the account with the user's API key,
 * kept across restarts, and turned into an estimate of the dictation it buys.
 */
export class ElevenLabsBalance {
  private lastProblem: BalanceProblem | undefined;
  private lastAttempt = 0;
  private reading: Promise<void> | undefined;
  private rereading: Promise<void> | undefined;

  constructor(
    private readonly state: Memento,
    private readonly getApiKey: () => Promise<string | undefined>,
    private readonly now: () => number = Date.now,
  ) {}

  /** The balance last read, by this window or another. */
  get balance(): Balance | undefined {
    return this.state.get<Balance>(BALANCE_KEY);
  }

  /** Why the last reading failed; undefined once one succeeds. */
  get problem(): BalanceProblem | undefined {
    return this.lastProblem;
  }

  /** When the balance was last read, or this window last tried to, in ms. */
  get lastChecked(): number {
    return Math.max(this.lastAttempt, this.balance?.checkedAt ?? 0);
  }

  /**
   * Read the balance from the account. Never rejects. Calls made while a reading
   * is in flight share one more reading after it: what prompted them (a new key)
   * may have come after the one in flight started.
   */
  refresh(): Promise<void> {
    if (this.reading) {
      this.rereading ??= this.reading.then(() => {
        this.rereading = undefined;
        return this.refresh();
      });
      return this.rereading;
    }
    this.reading = this.read()
      .catch((error) => {
        this.lastProblem = { kind: 'unavailable', detail: error instanceof Error ? error.message : String(error) };
      })
      .finally(() => {
        this.reading = undefined;
      });
    return this.reading;
  }

  /** Count audio sent for transcription, so that the credits it cost can be measured. */
  async noteTranscribed(seconds: number): Promise<void> {
    if (!(seconds > 0)) {
      return;
    }
    const meter = this.meter();
    await this.state.update(METER_KEY, { ...meter, audioSeconds: meter.audioSeconds + seconds });
  }

  /** What dictation costs: the plan's price at first, then more and more what was measured. */
  rate(): CreditRate {
    const meter = this.meter();
    const balance = this.balance;
    const price = balance && isFreePlan(balance) ? FREE_PLAN_CREDITS_PER_MINUTE : PAID_PLAN_CREDITS_PER_MINUTE;
    return {
      creditsPerMinute: (meter.credits * 60 + price * PRICE_WEIGHT_SECONDS) / (meter.seconds + PRICE_WEIGHT_SECONDS),
      measuredSeconds: meter.seconds,
    };
  }

  private async read(): Promise<void> {
    this.lastAttempt = this.now();
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      this.lastProblem = undefined;
      await this.state.update(BALANCE_KEY, undefined);
      return;
    }

    let response: Response;
    try {
      response = await fetch(SUBSCRIPTION_URL, {
        headers: { 'xi-api-key': apiKey },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      this.lastProblem = { kind: 'unavailable', detail: 'ElevenLabs could not be reached' };
      return;
    }

    if (!response.ok) {
      this.lastProblem = await readProblem(response);
      if (this.lastProblem.kind !== 'unavailable') {
        // The balance on record belongs to a key that no longer reads it
        await this.state.update(BALANCE_KEY, undefined);
      }
      return;
    }

    const balance = parseSubscription(await response.json().catch(() => undefined), this.now());
    if (!balance) {
      this.lastProblem = { kind: 'unavailable', detail: 'ElevenLabs answered in an unexpected format' };
      return;
    }
    this.lastProblem = undefined;
    await this.measure(balance);
    await this.state.update(BALANCE_KEY, balance);
  }

  /** Learn what dictation costs from how far the credits moved since the last reading. */
  private async measure(balance: Balance): Promise<void> {
    let meter = this.meter();
    if (meter.tier !== balance.tier) {
      // Another plan (or account) has its own rate
      meter = { audioSeconds: meter.audioSeconds, credits: 0, seconds: 0, tier: balance.tier };
    }
    const period = `${balance.limit}/${balance.renewsAt ?? ''}`;
    const mark = meter.mark;
    if (mark && mark.period === period && balance.used >= mark.used) {
      const credits = balance.used - mark.used;
      const seconds = meter.audioSeconds - mark.audioSeconds;
      if (seconds > 0 && credits === 0) {
        return; // the charge has not shown yet: measure it from the same mark next time
      }
      // Credits used with no dictation, or far more than dictation costs, went to something else
      if (seconds > 0 && (credits / seconds) * 60 <= MAX_CREDITS_PER_MINUTE) {
        meter = { ...meter, credits: meter.credits + credits, seconds: meter.seconds + seconds };
        if (meter.seconds > MEASURED_SECONDS_CAP) {
          meter = { ...meter, credits: meter.credits / 2, seconds: meter.seconds / 2 };
        }
      }
    }
    await this.state.update(METER_KEY, { ...meter, mark: { used: balance.used, audioSeconds: meter.audioSeconds, period } });
  }

  private meter(): CreditMeter {
    return this.state.get<CreditMeter>(METER_KEY) ?? { audioSeconds: 0, credits: 0, seconds: 0 };
  }
}

export function isFreePlan(balance: Balance): boolean {
  return balance.status === 'free' || balance.tier === 'free';
}

/** The balance in a `GET /v1/user/subscription` answer, or undefined if it has none. */
function parseSubscription(json: unknown, checkedAt: number): Balance | undefined {
  const data = json as Record<string, unknown> | undefined;
  if (typeof data?.character_count !== 'number' || typeof data.character_limit !== 'number') {
    return undefined;
  }
  const renews = data.next_character_count_reset_unix;
  return {
    used: data.character_count,
    limit: data.character_limit,
    tier: typeof data.tier === 'string' ? data.tier : undefined,
    status: typeof data.status === 'string' ? data.status : undefined,
    renewsAt: typeof renews === 'number' ? renews * 1000 : undefined,
    checkedAt,
  };
}

async function readProblem(response: Response): Promise<BalanceProblem> {
  const body = await response.text().catch(() => '');
  let code = '';
  let message = '';
  try {
    const detail = JSON.parse(body)?.detail;
    // `code` in current API responses, `status` in older ones
    code = detail?.code || detail?.status || '';
    message = detail?.message || (typeof detail === 'string' ? detail : '');
  } catch {
    // not JSON
  }
  if (response.status === 401 || response.status === 403) {
    if (PERMISSION_CODES.has(code) || /permission/i.test(message)) {
      return { kind: 'missing-permission' };
    }
    return { kind: 'rejected', detail: message || `HTTP ${response.status}` };
  }
  return { kind: 'unavailable', detail: `ElevenLabs answered ${response.status}${message ? `: ${message}` : ''}` };
}
