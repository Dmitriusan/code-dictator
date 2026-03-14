# Code Dictator

**Voice dictation for Claude, Copilot, Codex & Cline — speak instead of type.**

Stop typing prompts. Press `Alt+V`, say what you mean, and Code Dictator puts the text exactly where you need it — in Claude Chat, Copilot Chat, your editor, or any input field. Zero native dependencies, 90+ languages, works on every OS.

## Features

### Push-to-Talk Voice Input
Press `Alt+V` to start dictating. Press again to stop. Text appears wherever your cursor is — in Claude Chat, Copilot Chat, your editor, or any input field.

### Works With Every AI Assistant
Claude, Copilot, Codex, Cline, Continue — Code Dictator injects text into any focused input. Not locked to a single AI tool.

### Zero Dependencies
No sox. No ffmpeg. No Docker. No companion apps. Just install and talk. Works on Windows, macOS, and Linux out of the box.

### Audio Isolation
Built-in noise reduction cleans up your audio before transcription. Choose from off, basic (browser-native), or aggressive (multi-stage filtering).

### 90+ Languages
Auto-detect or pick from 37 languages. Set your preferred languages for quick switching between 2-3 you use daily.

### Usage Tracking
See transcription count, audio duration, and estimated costs at a glance in the status bar. Never get surprised by API bills.

### Code-Aware Dictation
Say "open paren" and get `(`. Say "arrow function" and get `=>`. 50+ spoken-to-symbol mappings for natural voice coding.

### Transcribe Audio Files
Drag and drop any audio file (MP3, WAV, M4A, WebM, FLAC) to transcribe meetings, lectures, or voice memos.

### LLM Text Cleanup
Optionally clean up transcriptions with AI — removes filler words, fixes punctuation, adds paragraph breaks.

## Quick Start

1. Install Code Dictator from the VS Code Marketplace
2. Follow the 30-second setup wizard
3. Press `Alt+V` and start talking

## Providers

### ElevenLabs (Recommended)
Best-in-class accuracy with Scribe v2 — 96.7% word accuracy, 90+ languages.
→ [Get your free API key](https://elevenlabs.io/?via=code-dictator)

### OpenAI Whisper
Great alternative if you already have an OpenAI API key. Any Whisper-compatible API works.

### Custom / Local
Point to any Whisper-compatible endpoint — faster-whisper-server, whisper.cpp, or your own setup.

## Pricing

Code Dictator is **free and open-source**. You pay only for the STT provider:
- ElevenLabs: Free tier available, then ~$0.40/hour
- OpenAI Whisper: ~$0.36/hour
- Local/Custom: Free

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `codeDictator.provider` | `elevenlabs` | STT provider |
| `codeDictator.recordingMode` | `toggle` | Press-twice or hold-to-talk |
| `codeDictator.audioIsolation` | `basic` | Noise reduction level |
| `codeDictator.language` | (auto) | Transcription language |
| `codeDictator.preferredLanguages` | `[]` | Quick-switch language shortlist |
| `codeDictator.codeAwareMode` | `true` | Spoken-to-symbol conversion |
| `codeDictator.autoCleanup` | `false` | LLM filler word removal |
| `codeDictator.defaultTarget` | `auto` | Where to send transcriptions |
| `codeDictator.autoCopyToClipboard` | `true` | Also copy to clipboard |
| `codeDictator.showCostIndicator` | `true` | Show cost in status bar |

## Keyboard Shortcuts

| Action | Windows/Linux | macOS |
|--------|--------------|-------|
| Toggle recording | `Alt+V` | `Alt+V` |
| Cancel recording | `Escape` | `Escape` |

All keybindings are fully customizable via VS Code's Keyboard Shortcuts editor.

## Troubleshooting

### Microphone not working
- **macOS**: System Settings → Privacy & Security → Microphone → enable VS Code
- **Windows**: Settings → Privacy → Microphone → allow app access
- **Linux**: Check PulseAudio/PipeWire settings with `pavucontrol`

### Recording fails in Remote/SSH/WSL
Voice input requires a local VS Code window. Remote environments don't have microphone access.

### Transcription returns empty text
- Check that your microphone is working (test with another app)
- Verify your API key is correct
- Check your internet connection

## Privacy

- API keys stored in your OS keychain (VS Code SecretStorage)
- Audio sent only to your configured provider
- No telemetry — zero usage data collected
- No audio stored on disk

## Contributing

Contributions welcome! Please open an issue first to discuss what you'd like to change.

## Support

If Code Dictator saves you time, consider:
- [Buy me a coffee](https://buymeacoffee.com/dmitriusan)
- Star this repo on GitHub
- Leave a review on the VS Code Marketplace

## License

MIT — see [LICENSE](LICENSE) for details.

---

Built by [Dmytro Lisnichenko](https://github.com/Dmitriusan) · [irrationalways.com](https://irrationalways.com)
