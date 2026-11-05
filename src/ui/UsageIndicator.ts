import { isFreePlan, type Balance, type BalanceProblem, type CreditRate } from '../tracking/ElevenLabsBalance';
import { formatCost, formatDuration } from '../tracking/UsageTracker';
import type { ProviderType, UsageStats } from '../types';

export const ELEVENLABS_API_KEYS_URL = 'https://elevenlabs.io/app/settings/api-keys';
export const ELEVENLABS_SUBSCRIPTION_URL = 'https://elevenlabs.io/app/subscription';

/** Whose price today's cost estimate uses. */
const PRICE_OWNERS: Record<ProviderType, string> = {
  elevenlabs: "ElevenLabs'",
  openai: "OpenAI's",
  custom: "the provider's",
};

/** With less dictation than this left, the balance asks for attention. */
const LOW_BALANCE_MINUTES = 30;
/** Measured over this much dictation, the rate is mostly the user's own. */
const MEASURED_SECONDS = 60;

/** What the usage item in the status bar shows. */
export interface UsageView {
  /** Item text, with its icon. */
  text: string;
  /** Hover text, as Markdown. */
  tooltip: string;
  /** A background that asks for attention. */
  level?: 'warning' | 'error';
}

/**
 * The ElevenLabs balance: the credits left and the dictation they buy,
 * e.g. "96.4K · ~80h". `problem` is set when the balance could not be read again.
 */
export function balanceView(balance: Balance, rate: CreditRate, problem: BalanceProblem | undefined, now: number): UsageView {
  const left = Math.max(0, balance.limit - balance.used);
  const minutes = left / rate.creditsPerMinute;
  const renewal = renewalText(balance, now);
  const lines: string[] = [];
  if (left === 0) {
    lines.push(`**ElevenLabs credits: none left** of ${formatCredits(balance.limit)}`);
    lines.push(`ElevenLabs turns transcriptions away until your credits renew${renewal ? ` ${renewal}` : ''}, unless your account has pay-as-you-go credits or usage-based billing.`);
  } else {
    lines.push(`**ElevenLabs credits left: ${formatCredits(left)}** of ${formatCredits(balance.limit)}`);
    lines.push(`About **${longDuration(minutes)}** of dictation, ${rateText(rate)}`);
  }
  lines.push(escapeMarkdown(balanceFacts(balance, now).join(' · ')));
  if (problem) {
    lines.push(`*Could not check it again: ${escapeMarkdown(problemText(problem))}*`);
  }
  lines.push('---');
  lines.push('Your ElevenLabs subscription balance, read from your account. Every second of audio you dictate uses credits, and so does anything else you do with ElevenLabs. Click for details.');
  return {
    text: left === 0 ? '$(credit-card) No credits' : `$(credit-card) ${compactCredits(left)} · ~${compactDuration(minutes)}`,
    tooltip: lines.join('\n\n'),
    level: left === 0 ? 'error' : minutes < LOW_BALANCE_MINUTES ? 'warning' : undefined,
  };
}

/**
 * Today's estimated speech-to-text cost, or undefined before the first
 * transcription of the day. With ElevenLabs it stands in for a balance that
 * could not be read, and says why.
 */
export function costView(stats: UsageStats, provider: ProviderType, problem?: BalanceProblem): UsageView | undefined {
  if (stats.todayTranscriptions === 0 && stats.todayEstimatedCost === 0) {
    return undefined;
  }
  const cost = stats.todayEstimatedCost;
  const lines: string[] = [];
  lines.push(cost === 0
    ? '**Speech-to-text cost today: none**'
    : `**Speech-to-text cost today: about ${formatCost(cost)}**`);
  lines.push(`${plural(stats.todayTranscriptions, 'transcription')} · ${formatDuration(stats.todayDurationMs)} of audio`);
  lines.push(cost === 0 && provider === 'custom'
    ? 'Code Dictator does not know what your own endpoint costs. Click for this week and all time.'
    : `Code Dictator's estimate from the length of today's recordings and ${PRICE_OWNERS[provider]} price for transcription. It is not read from your account, and AI cleanup is not included. Click for this week and all time.`);
  if (provider === 'elevenlabs' && problem) {
    lines.push('---');
    lines.push(balanceProblemHint(problem));
  }
  return { text: `$(credit-card) ${formatCost(cost)}`, tooltip: lines.join('\n\n') };
}

/** What to do about a balance that could not be read, as Markdown. */
function balanceProblemHint(problem: BalanceProblem): string {
  if (problem.kind === 'missing-permission') {
    return `**Your ElevenLabs credits can show here instead.** Your API key may transcribe but not read your account: on [elevenlabs.io](${ELEVENLABS_API_KEYS_URL}), edit the key and set **User** to **Read**.`;
  }
  return `**Your ElevenLabs balance could not be read:** ${escapeMarkdown(problemText(problem))}. Code Dictator tries again after your next dictation.`;
}

/** The problem in a sentence fragment, e.g. "ElevenLabs refused the API key (Invalid API key)". */
export function problemText(problem: BalanceProblem): string {
  switch (problem.kind) {
    case 'missing-permission':
      return 'the API key may not read your account';
    case 'rejected':
      return `ElevenLabs refused the API key (${problem.detail})`;
    case 'unavailable':
      return problem.detail;
  }
}

/** How the time left was worked out, after "About 80 hours of dictation, ". */
function rateText(rate: CreditRate): string {
  const perMinute = `at about ${Math.round(rate.creditsPerMinute)} credits a minute`;
  return rate.measuredSeconds >= MEASURED_SECONDS
    ? `${perMinute}, what your dictation has cost so far`
    : `${perMinute}, ElevenLabs' API price for Scribe v2 on your plan`;
}

/** Plan, renewal and when the balance was read, e.g. ["Creator plan", "renews in 26 days", "checked at 14:02"]. */
function balanceFacts(balance: Balance, now: number): string[] {
  const facts: string[] = [];
  const plan = planName(balance);
  if (plan) {
    facts.push(plan);
  }
  const renewal = renewalText(balance, now);
  if (renewal) {
    facts.push(`renews ${renewal}`);
  }
  facts.push(checkedText(balance.checkedAt, now));
  return facts;
}

/** "Creator plan", "Free plan"; undefined when the answer named none. */
export function planName(balance: Balance): string | undefined {
  if (isFreePlan(balance)) {
    return 'Free plan';
  }
  if (!balance.tier) {
    return undefined;
  }
  const tier = balance.tier.replace(/_/g, ' ');
  return `${tier.charAt(0).toUpperCase()}${tier.slice(1)} plan`;
}

/** "in 26 days", "in 5 hours"; undefined when unknown or already past. */
export function renewalText(balance: Balance, now: number): string | undefined {
  const ms = (balance.renewsAt ?? 0) - now;
  if (ms <= 0) {
    return undefined;
  }
  const hours = Math.ceil(ms / 3_600_000);
  return hours < 24 ? `in ${plural(hours, 'hour')}` : `in ${plural(Math.round(hours / 24), 'day')}`;
}

/**
 * "checked at 14:02" the same day, else "checked 2 days ago": a tooltip keeps
 * its text until the item is updated, so "just now" would soon be wrong.
 */
export function checkedText(checkedAt: number, now: number): string {
  const checked = new Date(checkedAt);
  if (checked.toDateString() === new Date(now).toDateString()) {
    return `checked at ${checked.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
  return `checked ${ago(now - checkedAt)}`;
}

/** "just now", "5 minutes ago", "2 days ago". */
function ago(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${plural(minutes, 'minute')} ago`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${plural(hours, 'hour')} ago` : `${plural(Math.floor(hours / 24), 'day')} ago`;
}

/** 96412 → "96,412" */
export function formatCredits(credits: number): string {
  return Math.round(credits).toLocaleString('en-US');
}

/** 96412 → "96.4K", 1234567 → "1.2M" */
export function compactCredits(credits: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(credits);
}

/** Minutes of dictation as the status bar shows them: "<1m", "45m", "4.5h", "80h". Rounded down. */
export function compactDuration(minutes: number): string {
  if (minutes < 1) {
    return '<1m';
  }
  if (minutes < 60) {
    return `${Math.floor(minutes)}m`;
  }
  if (minutes < 600) {
    return `${Math.floor(minutes / 6) / 10}h`;
  }
  return `${Math.floor(minutes / 60)}h`;
}

/** "less than a minute", "45 minutes", "4 hours 30 minutes", "80 hours". Rounded down. */
export function longDuration(minutes: number): string {
  if (minutes < 1) {
    return 'less than a minute';
  }
  const whole = Math.floor(minutes);
  if (whole < 60) {
    return plural(whole, 'minute');
  }
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  return hours >= 10 || rest === 0 ? plural(hours, 'hour') : `${plural(hours, 'hour')} ${plural(rest, 'minute')}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** Text from outside (an error message) shown literally in a Markdown tooltip. */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()<>#+!|$~]/g, '\\$&');
}
