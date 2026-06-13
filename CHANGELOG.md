# Changelog

All notable changes to Code Dictator will be documented in this file.

## [1.1.14] - 2026-06-13

### Fixed
- **Linux: recovered the last 1–2 seconds of longer recordings.** When the native `parecord` (PulseAudio/PipeWire) recorder was in use, the tail of each recording was silently dropped — PulseAudio/PipeWire buffers ~1–2 s of audio, and that buffer was discarded when recording stopped, cutting off the final words. `parecord` now runs with a capped capture latency (`--latency-msec=100`), reducing tail loss from 1–2 s to ~0.1 s. Affects both the default (file) and silence-detection (raw stream) recording paths.

### Changed
- Linux completion chime now prefers PipeWire/PulseAudio players (`pw-play` → `paplay`) before falling back to `aplay`, so it routes to your active output device (including Bluetooth).
- Docs: corrected the native-recorder description (PulseAudio/PipeWire preferred over ALSA for Bluetooth support) and the AI-cleanup default model in the README, and clarified that silence auto-stop works with `arecord`/`parecord` (but not `pw-record`).

## [1.1.0] - 2026-03-17

Stability improvements and bug fixes. Better Bluetooth headphone support on all platforms — the extension now detects when a wireless device disconnects mid-recording and shows a helpful message instead of producing empty transcriptions. On Linux, PipeWire/PulseAudio recorders are preferred over ALSA for reliable Bluetooth audio routing. Improved language handling in AI text cleanup — the post-processing LLM now respects your configured languages instead of occasionally producing output in unrelated languages.

### Added
- Voice model selection — choose between provider models (e.g. `scribe_v2`, `whisper-1`, `gpt-4o-transcribe`) or leave on auto
- Configurable filler word removal toggle (`textProcessing.fillerRemoval`)
- Bluetooth/wireless headset disconnect detection with user-friendly warning message
- Linux: prefer `parecord`/`pw-record` over `arecord` for better Bluetooth audio support
- Empty/too-short recording guard to prevent transcription of silence from device disconnects
- No-audio-data detection (2s timeout) in native recorder
- Clearer ElevenLabs API key setup instructions in walkthrough and setup wizard

### Changed
- Settings restructured into logical groups: `recording.*`, `textProcessing.*`, `output.*`, `feedback.*` (old flat keys are migrated automatically)
- README updated with grouped settings reference, provider comparison table, and keyboard shortcut guidance

### Fixed
- LLM text cleanup no longer outputs in random languages (e.g. Kazakh) — detected language from STT provider is now passed to the cleanup prompt with a top-of-prompt language constraint
- Status bar transient messages no longer interrupted by stale timers during recording

## [1.0.2] - 2026-03-16

### Fixed
- Release workflow improvements

## [1.0.1] - 2026-03-16

### Fixed
- Improved extension description for better readability

### Added
- Marketplace, CI, GitHub stars, and license badges in README
- GitHub Releases with `.vsix` downloads

## [1.0.0] - 2026-03-14

### Added
- Push-to-talk voice recording with toggle mode
- ElevenLabs Scribe v2 integration (recommended provider)
- OpenAI Whisper integration
- Custom Whisper-compatible API support
- Transcription copied to clipboard for easy pasting into any input — Claude Chat, Copilot Chat, editors, terminals
- Audio isolation with three modes: off, basic (browser-native), aggressive (multi-stage filtering)
- Code-aware dictation with 50+ spoken-to-symbol mappings
- LLM text cleanup (optional, via OpenAI)
- 90+ language support with auto-detection
- Preferred languages shortlist for quick switching
- Usage tracking with cost estimation
- Transcription history (last 50 entries, searchable)
- Audio file transcription (MP3, WAV, M4A, WebM, FLAC, OGG)
- Onboarding walkthrough for first-time setup
- Secure API key storage via OS keychain
- Cross-platform support (Windows, macOS, Linux) with zero native dependencies
- Silence detection with configurable auto-stop
- Maximum recording duration enforcement
- Session status bar with recording timer, language indicator, and cost display
