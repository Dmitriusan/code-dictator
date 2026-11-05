import * as vscode from 'vscode';
import { transcript, type Reply } from '../mockStt';
import { clipboard, dictate, notes, type Scenario } from '../steps';
import { check, clock, show, waitFor } from '../util';

const USAGE_ITEM = 'Code Dictator: Speech-to-Text Usage';
const E2E_KEY = 'xi-e2e-0123456789abcdef';

/** A `GET /v1/user/subscription` answer: `used` of a Creator plan's 121,000 credits. */
function subscription(used: number): Reply {
  return {
    status: 200,
    body: {
      tier: 'creator',
      character_count: used,
      character_limit: 121_000,
      status: 'active',
      next_character_count_reset_unix: Math.floor(Date.now() / 1000) + 26 * 86_400,
    },
  };
}

/**
 * With ElevenLabs, the usage item shows the credits left in the subscription:
 * read with the key the setup wizard stored, and read again after a dictation.
 * Runs in a window of its own, because the ElevenLabs key it stores stays there.
 */
export const elevenLabsBalance: Scenario = async ({ h, expect, observe }) => {
  let used = 24_588;
  h.stt.respond((request) => (request.method === 'GET' ? subscription(used) : transcript('checking the balance')));
  await h.configure({ 'textProcessing.aiCleanup': false });
  const usage = h.statusBar.named(USAGE_ITEM);
  check(usage !== undefined, `the ${USAGE_ITEM} item was not captured`);
  const reads = () => h.stt.requests.filter((r) => r.method === 'GET');
  const tooltip = () => (usage.item.tooltip as { value?: string } | undefined)?.value;

  // The setup wizard switches to ElevenLabs and stores the key
  h.ui.responders = {
    quickPick: (items, options) => (options?.placeHolder === 'Choose your speech-to-text provider'
      ? items.find((i) => (i as { providerId?: string }).providerId === 'elevenlabs')
      : undefined),
    message: (_kind, text) => (text.startsWith('You need an ElevenLabs API key') ? 'I already have one' : undefined),
    inputBox: (options) => (options?.title === 'Code Dictator — ElevenLabs API Key' ? E2E_KEY : undefined),
  };
  const t0 = clock();
  await vscode.commands.executeCommand('codeDictator.setApiKey');
  h.ui.responders = {};
  const t1 = clock();

  // 96,412 credits at ElevenLabs' price of 21 credits a minute: 76 hours
  await waitFor('the balance in the status bar', () => usage.visible && usage.item.text === '$(credit-card) 96.4K · ~76h', 5000)
    .catch(() => expect(false, `usage item ${show({ text: usage.item.text, visible: usage.visible, reads: reads().length })}`));
  const [first] = reads();
  expect(first?.path === '/__el/v1/user/subscription' && first.headers['xi-api-key'] === E2E_KEY,
    `balance request ${show(first && { path: first.path, key: first.headers['xi-api-key'] })}`);
  expect(tooltip()?.includes('**ElevenLabs credits left: 96,412** of 121,000') && tooltip()?.includes('Creator plan · renews in 26 days'),
    `tooltip ${show(tooltip())}`);

  // The dictation goes to ElevenLabs, and the balance is read again once its charge can show
  used = 30_000;
  await dictate(h, 400);
  expect((await clipboard()) === 'Checking the balance', `clipboard ${show(await clipboard())}`);
  const uploads = h.stt.requests.filter((r) => r.method === 'POST');
  expect(uploads.length === 1 && uploads[0].path === '/__el/v1/speech-to-text', `uploads ${show(uploads.map((r) => r.path))}`);
  await waitFor('the balance to be read again', () => reads().length >= 2, 6000)
    .catch(() => expect(false, `${reads().length} balance requests after the dictation`));
  // 91,000 credits; 5,412 credits for a short dictation is not what dictation costs, so the price still applies
  await waitFor('the new balance', () => usage.item.text === '$(credit-card) 91K · ~72h', 3000)
    .catch(() => expect(false, `usage item after the dictation ${show(usage.item.text)}`));

  expect(h.ui.notifications(t1).length === 0, `notifications ${show(notes(h.ui.notifications(t1)))}`);
  observe('usageTexts', usage.texts.filter((x) => x.t >= t0).map((x) => x.value));
};
