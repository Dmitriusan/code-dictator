import type { CodeDictatorSettings, STTProvider } from '../types';
import { ElevenLabsProvider } from './ElevenLabsProvider';
import { OpenAIProvider } from './OpenAIProvider';
import { CustomProvider } from './CustomProvider';

/** Resolve the voice model for a provider: 'auto' → provider-specific default. */
function resolveModel(provider: string, voiceModel: string): string | undefined {
  if (voiceModel && voiceModel !== 'auto') return voiceModel;
  // 'auto' or empty → let each provider use its built-in default
  return undefined;
}

export function createProvider(
  settings: CodeDictatorSettings,
  getApiKey: (provider: string) => Promise<string | undefined>,
): STTProvider {
  const model = resolveModel(settings.provider, settings.voiceModel);
  switch (settings.provider) {
    case 'elevenlabs':
      return new ElevenLabsProvider(() => getApiKey('elevenlabs'), model);
    case 'openai':
      return new OpenAIProvider(() => getApiKey('openai'), model);
    case 'custom':
      return new CustomProvider(settings.customApiUrl, () => getApiKey('custom'), model);
    default: {
      // Exhaustive check — TypeScript will error here if a new ProviderType is added
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const _exhaustive: never = settings.provider;
      return new ElevenLabsProvider(() => getApiKey('elevenlabs'), model);
    }
  }
}
