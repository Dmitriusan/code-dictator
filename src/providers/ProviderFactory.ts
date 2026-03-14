import type { CodeDictatorSettings, STTProvider } from '../types';
import { ElevenLabsProvider } from './ElevenLabsProvider';
import { OpenAIProvider } from './OpenAIProvider';
import { CustomProvider } from './CustomProvider';

export function createProvider(
  settings: CodeDictatorSettings,
  getApiKey: (provider: string) => Promise<string | undefined>,
): STTProvider {
  switch (settings.provider) {
    case 'elevenlabs':
      return new ElevenLabsProvider(() => getApiKey('elevenlabs'));
    case 'openai':
      return new OpenAIProvider(() => getApiKey('openai'));
    case 'custom':
      return new CustomProvider(settings.customApiUrl);
    default: {
      // Exhaustive check — TypeScript will error here if a new ProviderType is added
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const _exhaustive: never = settings.provider;
      return new ElevenLabsProvider(() => getApiKey('elevenlabs'));
    }
  }
}
