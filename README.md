# Code Dictator

Voice dictation for developers — speak code, commands, and prose directly into VS Code.

If you spend your day talking to AI coding assistants, why are you still typing? Press `Alt+D`, say what you mean, and Code Dictator puts the text exactly where you need it — Claude Chat, Copilot Chat, your editor, or any input field. Zero native dependencies. 33KB. Works on macOS, Windows, and Linux.

---

## Why Voice?

A professional developer types around 60–80 words per minute. You speak at 150+. That's not a marginal improvement — it's a fundamentally different workflow.

- **A one-minute typed prompt takes 20–30 seconds to dictate.** Over a full day of AI-assisted development, that adds up to 30–60 minutes saved.
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

\* AI-powered text cleanup is optional — when enabled, it uses an OpenAI language model and requires a separate OpenAI API key regardless of your speech-to-text provider.

---

## Setup

1. **Install** — Search "Code Dictator" in the VS Code Extensions panel, or install from the Marketplace page.

2. **Get an API key** — Sign up for [ElevenLabs](https://try.elevenlabs.io/rgoomc9z8dvv) (**free tier, no credit card required**) or use your existing OpenAI API key.

3. **Configure** — Open VS Code Settings (`Ctrl+,`), search "Code Dictator", select your provider, then run `Code Dictator: Set API Key` from the Command Palette to store your key securely.

4. **Dictate** — Click into any input field — Claude Chat, Copilot Chat, your editor. Press `Alt+D`, speak, press `Alt+D` again. Text appears at the cursor.

That's it. No system dependencies to install, no microphone configuration, no browser extensions.

---

## Provider Comparison

| | ElevenLabs Scribe v2 | OpenAI Whisper | Custom |
|---|---|---|---|
| **Accuracy** | High (Scribe v2) | Good (Whisper) | Model-dependent |
| **Cost per minute** | ~$0.0067 | Per-model pricing | Free (local) |
| **Latency** | ~1–2s | ~1–3s | Varies |
| **Languages** | 90+ | 57 | Model-dependent |
| **Free tier** | **Yes** | No | N/A |
| **Best for** | Accuracy, multilingual | Existing OpenAI users | Privacy / air-gapped |

---

## Pricing

Code Dictator is free and open-source. You pay only for the speech-to-text API you choose:

| Provider | Cost |
|---|---|
| ElevenLabs | **Free tier available**, then ~$0.0067/min (~$0.40/hr) |
| Custom / Local | Free |

A typical 30-second prompt dictation costs under $0.01. With steady use throughout a workday — 20–40 prompts — expect **$0.05–0.15/day**, or roughly **$1–3 per month**. Most developers spend well under a dollar.

For context: if you're spending 30–60 minutes a day typing prompts to AI assistants, Code Dictator pays for itself many times over in time saved — even before accounting for reduced hand fatigue.

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
| `double equals` | `===` |
| `triple equals` | `===` |
| `dot` | `.` |
| `new line` | *(line break)* |

50+ mappings total. Example:

> **Say**: "const items equals open bracket close bracket"
> **Inserted**: `const items = []`

> **Say**: "if open paren error triple equals null close paren"
> **Inserted**: `if (error === null)`

When dictating into Claude Chat or Copilot Chat, disable code-aware mode or speak naturally — the AI handles code generation from plain-language prompts.

---

## Filler Word Removal

Code Dictator automatically strips hesitation markers from your transcription — no API key required. Language is auto-detected from the speech-to-text provider response.

Covers 90+ languages — English `uh/um/er/hmm`, German `äh/ähm`, French `euh/heu`, Russian `ну/значит`, Japanese `えーと/あの`, and many more. Also removes stutter patterns (`u-uh`, `m-uh`) and bracketed noise markers (`[cough]`, `[engine revving]`).

For deeper cleanup (rephrasing, grammar, context-sensitive detection), enable **AI-powered Cleanup** (`codeDictator.autoCleanup`) which uses an OpenAI API call.

---

## ElevenLabs

ElevenLabs Scribe v2 offers high transcription accuracy across 90+ languages. **Free tier available — no credit card required** to start.

→ [Sign up for ElevenLabs](https://try.elevenlabs.io/rgoomc9z8dvv)

*This is a referral link — using it supports Code Dictator's development at no extra cost to you.*

---

## All Settings

| Setting | Default | Description |
|---|---|---|
| `codeDictator.provider` | `elevenlabs` | `elevenlabs`, `openai`, `custom` |
| `codeDictator.customApiUrl` | *(empty)* | Whisper-compatible endpoint URL |
| `codeDictator.recordingMode` | `toggle` | Press once to start, once to stop |
| `codeDictator.audioIsolation` | `basic` | `off`, `basic`, `aggressive` |
| `codeDictator.language` | *(auto)* | Language code (e.g. `en`, `de`, `ja`) or leave blank for auto-detect |
| `codeDictator.preferredLanguages` | `[]` | Shortlist for the language picker |
| `codeDictator.codeAwareMode` | `true` | Spoken-to-symbol conversion |
| `codeDictator.autoCleanup` | `false` | Optional AI-powered cleanup (requires OpenAI key; basic filler removal is always on) |
| `codeDictator.cleanupModel` | `gpt-4.1-nano` | OpenAI model for text cleanup |
| `codeDictator.defaultTarget` | `auto` | `auto`, `editor`, `clipboard` |
| `codeDictator.autoCopyToClipboard` | `true` | Also copy to clipboard after insertion |
| `codeDictator.showCostIndicator` | `true` | Show estimated cost in status bar |
| `codeDictator.maxRecordingDuration` | `300` | Max recording seconds (10–3600) |
| `codeDictator.silenceTimeout` | `0` | Auto-stop after N seconds of silence (0 = off) |

---

## Troubleshooting

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
