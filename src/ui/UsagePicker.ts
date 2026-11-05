import * as vscode from 'vscode';
import type { Balance, BalanceProblem, CreditRate } from '../tracking/ElevenLabsBalance';
import { formatCost, formatDuration } from '../tracking/UsageTracker';
import type { ProviderType, UsageStats } from '../types';
import {
  ELEVENLABS_API_KEYS_URL,
  ELEVENLABS_SUBSCRIPTION_URL,
  checkedText,
  formatCredits,
  longDuration,
  planName,
  problemText,
  renewalText,
} from './UsageIndicator';

/** What the user picked that the caller carries out. */
export type UsagePickerAction = 'checkBalance' | 'history' | 'settings';

export interface UsagePickerInput {
  provider: ProviderType;
  stats: UsageStats;
  /** ElevenLabs only: the balance last read, its rate, and why it could not be read again. */
  balance?: Balance;
  rate?: CreditRate;
  problem?: BalanceProblem;
  now: number;
}

interface UsagePickItem extends vscode.QuickPickItem {
  action?: UsagePickerAction;
  url?: string;
}

/**
 * The usage QuickPick behind the status bar item: the ElevenLabs balance (with
 * ElevenLabs), then the audio transcribed today, this week and in total.
 * Opens the links it offers itself; returns the other choices.
 */
export async function showUsagePicker(input: UsagePickerInput): Promise<UsagePickerAction | undefined> {
  const { stats, balance, rate } = input;
  const elevenLabs = input.provider === 'elevenlabs';
  const credits = elevenLabs && balance && rate ? rate : undefined;
  const items: UsagePickItem[] = [];

  if (elevenLabs) {
    items.push({ label: 'ElevenLabs', kind: vscode.QuickPickItemKind.Separator });
    items.push(...balanceItems(input));
    items.push({ label: 'Dictation', kind: vscode.QuickPickItemKind.Separator });
  }

  const usage = (count: number, durationMs: number, cost: number) => ({
    description: `${count} transcription${count === 1 ? '' : 's'}`,
    detail: credits
      ? `Audio: ${formatDuration(durationMs)} · about ${formatCredits((durationMs / 60_000) * credits.creditsPerMinute)} credits`
      : `Audio: ${formatDuration(durationMs)} · Estimated speech-to-text cost: ${formatCost(cost)}`,
  });
  items.push(
    { label: '$(calendar) Today', ...usage(stats.todayTranscriptions, stats.todayDurationMs, stats.todayEstimatedCost) },
    { label: '$(calendar) This Week', ...usage(stats.weekTranscriptions, stats.weekDurationMs, stats.weekEstimatedCost) },
    { label: '$(history) All Time', ...usage(stats.totalTranscriptions, stats.totalDurationMs, stats.totalEstimatedCost) },
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: '$(book) View History', description: 'Browse past transcriptions', action: 'history' },
    { label: '$(gear) Open Settings', description: 'Configure Code Dictator', action: 'settings' },
  );

  const selected = await vscode.window.showQuickPick(items, {
    title: 'Code Dictator — Speech-to-Text Usage',
    placeHolder: credits
      ? 'Your ElevenLabs credits, and the audio you dictated'
      : 'The audio you dictated and its estimated speech-to-text cost (AI cleanup not included)',
  });
  if (selected?.url) {
    await vscode.env.openExternal(vscode.Uri.parse(selected.url));
    return undefined;
  }
  return selected?.action;
}

function balanceItems({ balance, rate, problem, now }: UsagePickerInput): UsagePickItem[] {
  if (!balance || !rate) {
    if (problem?.kind === 'missing-permission') {
      return [{
        label: '$(key) Show your ElevenLabs credits here',
        detail: 'Your API key may transcribe but not read your account. Opens your API keys on elevenlabs.io: edit the key and set User to Read.',
        url: ELEVENLABS_API_KEYS_URL,
      }];
    }
    return [{
      label: '$(refresh) Read your ElevenLabs balance',
      detail: problem ? `It could not be read: ${problemText(problem)}` : 'Code Dictator has not read it yet',
      action: 'checkBalance',
    }];
  }
  const left = Math.max(0, balance.limit - balance.used);
  const minutes = left / rate.creditsPerMinute;
  const plan = planName(balance);
  const renewal = renewalText(balance, now);
  return [
    {
      label: left === 0 ? '$(credit-card) No credits left' : `$(credit-card) ${formatCredits(left)} credits left`,
      description: `of ${formatCredits(balance.limit)}${plan ? ` · ${plan}` : ''}`,
      detail: [
        left === 0
          ? 'ElevenLabs refuses transcriptions until they renew'
          : `About ${longDuration(minutes)} of dictation at ~${Math.round(rate.creditsPerMinute)} credits a minute`,
        ...(renewal ? [`renews ${renewal}`] : []),
        checkedText(balance.checkedAt, now),
        ...(problem ? [`could not check again: ${problemText(problem)}`] : []),
      ].join(' · '),
    },
    { label: '$(refresh) Check the balance again', action: 'checkBalance' },
    { label: '$(link-external) Open your ElevenLabs subscription', url: ELEVENLABS_SUBSCRIPTION_URL },
  ];
}
