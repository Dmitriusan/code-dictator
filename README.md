# Code Dictator

Voice dictation for developers — speak code, commands, and prose directly into VS Code.

Stop typing prompts. Press `Alt+V`, say what you mean, and Code Dictator puts the text exactly where you need it — Claude Chat, Copilot Chat, your editor, or any input field. Zero native dependencies. 90+ languages. Works on every OS.

---

## Features

| Mode / Capability | ElevenLabs | OpenAI Whisper | Custom |
|---|---|---|---|
| Dictate (toggle or hold-to-talk) | ✓ | ✓ | ✓ |
| Code-aware symbol conversion | ✓ | ✓ | ✓ |
| Transcribe audio file | ✓ | ✓ | ✓ |
| Language auto-detect | ✓ (90+ langs) | ✓ (57 langs) | model-dependent |
| LLM text cleanup | ✓* | ✓* | ✓* |
| Audio noise reduction | ✓ | ✓ | ✓ |
| Usage & cost tracking | ✓ | ✓ | ✓ |
| Native ALSA fallback (Linux) | ✓ | ✓ | ✓ |

\* LLM cleanup requires a separate OpenAI API key regardless of STT provider.

---

## Setup

1. **Install** — Search "Code Dictator" in the VS Code Extensions panel, or install from the Marketplace page.

2. **Get an API key** — Sign up for [ElevenLabs](https://elevenlabs.io/?via=code-dictator) (free tier, no credit card required) or use your existing OpenAI API key.

3. **Configure your provider** — Open VS Code Settings (`Ctrl+,`), search "Code Dictator", select your provider (`elevenlabs`, `openai`, or `custom`), then run `Code Dictator: Set API Key` from the Command Palette to store your key securely.

4. **Set a keyboard shortcut** (optional) — Default is `Alt+V`. To change it: open Keyboard Shortcuts (`Ctrl+K Ctrl+S`), search "Code Dictator: Toggle Voice Recording", click the pencil icon, and press your preferred key combination.

5. **Record your first dictation** — Click into a Claude Chat / Copilot Chat input, your editor, or any text field. Press `Alt+V`, speak, press `Alt+V` again. Text appears at the cursor.

---

## Provider Comparison

| | ElevenLabs Scribe v2 | OpenAI Whisper | Custom |
|---|---|---|---|
| **Word accuracy** | ~96.7% | ~95–97% | Model-dependent |
| **Cost per minute** | ~$0.0067 | ~$0.006 | Free (local) |
| **Latency** | ~1–2s | ~1–3s | Varies |
| **Languages** | 90+ | 57 | Model-dependent |
| **Free tier** | Yes | No | N/A |
| **BYOK required** | Yes | Yes | No |
| **Best for** | Highest accuracy, multilingual | Existing OpenAI users | Privacy / air-gapped |

---

## Keyboard Shortcuts

| Action | Default Shortcut |
|---|---|
| Toggle recording (start / stop) | `Alt+V` |
| Cancel recording (discard) | `Escape` (while recording) |

To customize: open Keyboard Shortcuts (`Ctrl+K Ctrl+S`), search "Code Dictator: Toggle Voice Recording", click the pencil icon, press your new binding.

---

## Code-Aware Mode

When code-aware mode is enabled (default: on), spoken programming terms convert to their symbol equivalents before insertion. Useful when dictating into a code editor rather than a chat input.

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

When dictating into Claude Chat or Copilot Chat, disable code-aware mode or speak naturally — the AI handles code generation from plain-language prompts.

---

## ElevenLabs

ElevenLabs Scribe v2 offers the highest transcription accuracy available — 96.7% word accuracy across 90+ languages. Free tier is available with no credit card required to start.

→ [Sign up for ElevenLabs](https://elevenlabs.io/?via=code-dictator)

---

## Pricing

Code Dictator is free and open-source. You pay only for the speech-to-text API:

| Provider | Cost |
|---|---|
| ElevenLabs | Free tier, then ~$0.0067/min (~$0.40/hr) |
| OpenAI Whisper | ~$0.006/min (~$0.36/hr) |
| Custom / Local | Free |

A typical 30-second prompt dictation costs under $0.01.

---

## All Settings

| Setting | Default | Options / Description |
|---|---|---|
| `codeDictator.provider` | `elevenlabs` | `elevenlabs`, `openai`, `custom` |
| `codeDictator.customApiUrl` | *(empty)* | Whisper-compatible endpoint URL |
| `codeDictator.recordingMode` | `toggle` | `toggle` (press twice) or `hold` (hold key) |
| `codeDictator.audioIsolation` | `basic` | `off`, `basic`, `aggressive` |
| `codeDictator.language` | *(auto)* | ISO 639-1 code or leave blank for auto-detect |
| `codeDictator.preferredLanguages` | `[]` | Shortlist for the language picker |
| `codeDictator.codeAwareMode` | `true` | Spoken-to-symbol conversion |
| `codeDictator.autoCleanup` | `false` | LLM filler word removal (requires OpenAI key) |
| `codeDictator.cleanupModel` | `gpt-4.1-nano` | LLM for cleanup: nano / mini / full |
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

Built by [Dmytro Lisnichenko](https://github.com/Dmitriusan) · [irrationalways.com](https://irrationalways.com)
