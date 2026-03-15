# Code Dictator

Voice dictation for developers — speak instead of type when working with AI coding assistants.

If you spend your day talking to AI coding assistants, why are you still typing? Press `Alt+D`, speak, press `Alt+D` again — your speech is transcribed and copied to the clipboard in seconds. Paste it into Claude Chat, Copilot Chat, Cursor, Windsurf, a terminal, or any input field. Zero native dependencies. Works on macOS, Windows, and Linux.

---

## Why Voice?

A professional developer types around 60–80 words per minute. You speak at 150+. That's not a marginal improvement — it's a fundamentally different workflow.

- **A one-minute typed prompt takes 20–30 seconds to dictate.** Over a full day of AI-assisted development, that adds up to 30–60 minutes saved.
- **Code from anywhere.** Put on wireless headphones and your development environment follows you. Dictate a prompt while grabbing coffee in the kitchen. Describe a feature while folding laundry. Sketch out an architecture while going for a walk. Your AI assistant doesn't care whether you're at your desk — and now, neither do you.
- **Less fatigue.** Your hands stay on the keyboard for the work that matters — reviewing diffs, navigating code, running commands. Let your voice handle the natural-language parts.
- **Lower friction, better prompts.** When dictating is effortless, you write more detailed prompts and get better results from your AI assistant.

---

## Features

| Capability | ElevenLabs | OpenAI Whisper | Custom |
|---|---|---|---|
| Push-to-talk dictation | ✓ | ✓ | ✓ |
| Code-aware symbol conversion | ✓ | ✓ | ✓ |
| Transcribe audio file | ✓ | ✓ | ✓ |
| Language auto-detect | ✓ (90+ langs) | ✓ (57 langs) | model-dependent |
| Filler word removal (no API) | ✓ auto-detected | ✓ auto-detected | ✓ (uses setting) |
| AI-powered text cleanup | ✓* | ✓* | ✓* |
| Audio noise reduction | ✓ | ✓ | ✓ |
| Usage & cost tracking | ✓ | ✓ | ✓ |
| Native ALSA fallback (Linux) | ✓ | ✓ | ✓ |
| **Accuracy** | High (Scribe v2) | Good (Whisper) | Model-dependent |
| **Latency** | ~1–2s | ~1–3s | Varies |
| **Free tier** | **Yes** | No | N/A |
| **Best for** | Accuracy, multilingual | Existing OpenAI users | Privacy / air-gapped |

\* AI-powered text cleanup is optional — when enabled, it uses an OpenAI language model and requires a separate OpenAI API key regardless of your speech-to-text provider.

---

## Setup

1. **Install** — Search "Code Dictator" in the VS Code Extensions panel, or install from the Marketplace page.

2. **Get an API key** — Sign up for [ElevenLabs](https://try.elevenlabs.io/rgoomc9z8dvv) (**free tier, no credit card required**) or use your existing OpenAI API key.

3. **Configure** — Open VS Code Settings (`Ctrl+,`), search "Code Dictator", select your provider, then run `Code Dictator: Set API Key` from the Command Palette to store your key securely.

4. **Dictate** — Press `Alt+D`, speak, press `Alt+D` again. The transcription is copied to your clipboard — just `Ctrl+V` into Claude Chat, Copilot Chat, Cursor, Windsurf, a terminal, or any other input.

That's it. No system dependencies to install, no microphone configuration, no browser extensions.

---

## Pricing

Code Dictator is free and open-source. You pay only for the speech-to-text API you choose:

| Provider | Cost |
|---|---|
| ElevenLabs | **Free tier available**, then ~$0.0067/min (~$0.40/hr) |
| OpenAI Whisper | Varies by model — see [OpenAI pricing](https://openai.com/api/pricing/) |
| Custom / Local | Free |

ElevenLabs' **free plan** includes **10,000 credits/month** — enough for roughly **2.5 hours of transcription**. That comfortably covers most developers' daily use. If you need more, the [Starter plan](https://try.elevenlabs.io/rgoomc9z8dvv) at **$5/month** (30,000 credits) provides 3x the allowance. Check [ElevenLabs pricing](https://try.elevenlabs.io/rgoomc9z8dvv) for current rates.

For context: if you're spending 30–60 minutes a day typing prompts to AI assistants, Code Dictator pays for itself many times over in time saved — even before accounting for reduced hand fatigue.

→ [Sign up for ElevenLabs](https://try.elevenlabs.io/rgoomc9z8dvv) — free tier, no credit card required

*This is a referral link — using it supports Code Dictator's development at no extra cost to you.*

---

## Keyboard Shortcuts

| Action | Default Shortcut |
|---|---|
| Toggle recording (start / stop) | `Alt+D` |
| Cancel recording (discard) | `Escape` (while recording) |

To customize: open Keyboard Shortcuts (`Ctrl+K Ctrl+S`), search "Code Dictator: Toggle Voice Recording", click the pencil icon, press your new binding.

---

## Code-Aware Mode

When code-aware mode is enabled (default: on), spoken programming terms convert to their symbol equivalents. Useful when dictating directly into a code editor.

| Say | Inserted |
|---|---|
| `open paren` | `(` |
| `close paren` | `)` |
| `open bracket` | `[` |
| `close bracket` | `]` |
| `open brace` | `{` |
| `close brace` | `}` |
| `arrow function` | `=>` |
| `double equals` | `==` |
| `triple equals` | `===` |
| `dot` | `.` |
| `new line` | *(line break)* |

50+ mappings total. Example:

> **Say**: "const items equals open bracket close bracket"
> **Inserted**: `const items = []`

> **Say**: "if open paren error triple equals null close paren"
> **Inserted**: `if (error === null)`

When dictating prompts for AI assistants, disable code-aware mode or speak naturally — the AI handles code generation from plain-language prompts.

---

## Filler Word Removal

Code Dictator automatically strips hesitation markers from your transcription — no API key required. Language is auto-detected from the speech-to-text provider response.

Covers 90+ languages — English `uh/um/er/hmm`, German `äh/ähm`, French `euh/heu`, Russian `ну/значит`, Japanese `えーと/あの`, and many more. Also removes stutter patterns (`u-uh`, `m-uh`) and bracketed noise markers (`[cough]`, `[engine revving]`).

For deeper cleanup (rephrasing, grammar, context-sensitive detection), enable **AI-powered Cleanup** (`codeDictator.aiTextCleanup`) which uses an OpenAI API call.

---

## All Settings

| Setting | Default | Description |
|---|---|---|
| `codeDictator.speechToTextProvider` | `elevenlabs` | `elevenlabs`, `openai`, `custom` |
| `codeDictator.customApiUrl` | *(empty)* | Whisper-compatible endpoint URL |
| `codeDictator.recordingMode` | `toggle` | Press once to start, once to stop |
| `codeDictator.audioIsolation` | `basic` | `off`, `basic`, `aggressive` |
| `codeDictator.language` | *(auto)* | Language code (e.g. `en`, `de`, `ja`) or leave blank for auto-detect |
| `codeDictator.preferredLanguages` | `[]` | Shortlist for the language picker |
| `codeDictator.codeAwareMode` | `true` | Spoken-to-symbol conversion |
| `codeDictator.aiTextCleanup` | `false` | Optional AI-powered cleanup (requires OpenAI key; basic filler removal is always on) |
| `codeDictator.cleanupModel` | `gpt-4.1-nano` | OpenAI model for text cleanup |
| `codeDictator.defaultTarget` | `clipboard` | `clipboard`, `editor` |
| `codeDictator.autoCopyToClipboard` | `true` | Also copy to clipboard after insertion |
| `codeDictator.showCostIndicator` | `true` | Show estimated cost in status bar |
| `codeDictator.maxRecordingDuration` | `300` | Max recording seconds (10–3600) |
| `codeDictator.silenceTimeout` | `0` | Auto-stop after N seconds of silence (0 = off) |

---

## How Recording Works

Code Dictator uses a two-tier recording architecture that adapts to each platform's capabilities automatically — no configuration needed.

### Recording Engine

| Platform | Primary Recorder | Fallback |
|---|---|---|
| **macOS** | WebView MediaRecorder API | `sox` / `rec` via Homebrew |
| **Windows** | WebView MediaRecorder API | `sox` (if installed) |
| **Linux** | WebView MediaRecorder API | `arecord` (ALSA, pre-installed on most distros) |

The extension first attempts to record via a hidden WebView using the browser's [MediaRecorder API](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder). This requires zero native dependencies and works out of the box on macOS and Windows. On Linux, WebView microphone permissions are often sandboxed by the desktop environment — when this happens, the extension automatically detects the permission error and falls back to `arecord` (ALSA), which is pre-installed on virtually all Linux distributions.

The fallback is transparent: you press `Alt+D`, you speak, you get text. The recording path is logged in the Output panel (`Code Dictator`) if you're curious which one is active.

### Adaptive Silence Detection

When `silenceTimeout` is enabled, the extension automatically stops recording after a configurable period of silence. Rather than using a fixed volume threshold (which would fail across different microphones, gain settings, and environments), Code Dictator implements an adaptive Voice Activity Detection (VAD) system:

- Audio is analyzed in the **dBFS** (decibels relative to full scale) domain for perceptually meaningful comparisons
- Two **exponential moving averages** continuously track the noise floor (slow adaptation) and speech energy (moderate adaptation)
- The silence threshold is placed **adaptively between noise and speech levels**, so it works whether you're in a quiet studio or a noisy cafe
- Detection only activates **after speech is first detected**, so pausing to think before speaking won't trigger a premature stop
- A minimum **signal-to-noise ratio** (6 dB) is required before the system will engage, preventing false triggers when the microphone can't meaningfully distinguish speech from ambient noise

This means zero calibration is needed — the system adapts to your microphone, your voice, and your environment automatically within the first second of speech.

For the full signal processing details, mathematical model, and design rationale, see the [Voice Activity Detection Technical Reference](docs/voice-activity-detection.md).

---

## Troubleshooting

**Why isn't there a microphone button inside AI chat windows?**
VS Code's Extension API does not allow extensions to inject buttons, icons, or any custom UI into another extension's chat panel. Each extension's views are sandboxed — there is no API for a third-party extension to modify the Claude, Copilot, or any other chat interface. This is a VS Code platform limitation, not something any extension can work around. The keyboard shortcut (`Alt+D`) and the status bar microphone button work universally across all contexts — just click into the chat input, press `Alt+D`, and speak. No in-panel button needed.

**Microphone not detected**
- macOS: System Settings → Privacy & Security → Microphone → enable VS Code
- Windows: Settings → Privacy → Microphone → allow app access
- Linux: Check PulseAudio/PipeWire with `pavucontrol`; native ALSA fallback activates automatically if the WebView recorder fails

**Recording fails in Remote / SSH / WSL**
Voice input requires a local VS Code window. Remote environments don't expose microphone access to extensions.

**Transcription comes back empty**
- Test your microphone in another app first
- Verify your API key: run `Code Dictator: Set API Key` from the Command Palette
- Check your provider's status page

---

## Privacy

- API keys stored via VS Code SecretStorage (OS keychain) — never written to disk in plaintext
- Audio sent only to your configured provider, nowhere else
- No telemetry, no usage data collected by this extension
- No audio retained after transcription completes

---

## Contributing

Open an issue first to discuss what you'd like to change. PRs welcome.

[GitHub Issues](https://github.com/Dmitriusan/code-dictator/issues)

---

## License

MIT — see [LICENSE](LICENSE) for details.

---

If you find Code Dictator useful, consider [buying me a coffee](https://buymeacoffee.com/dmitriusan).

Built by [Dmytro Lisnichenko](https://github.com/Dmitriusan) · [irrationalways.com](https://irrationalways.com)
