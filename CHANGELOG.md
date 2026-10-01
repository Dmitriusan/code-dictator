# Changelog

All notable changes to Code Dictator will be documented in this file.

## [Unreleased]

### Added
- **A failed transcription no longer loses your recording.** When the speech-to-text service turns a recording away (quota exceeded, rate limit, network error), the audio is now kept and the error offers **Retry** to send it again once the problem is sorted. A recording you didn't retry from the notification can be sent later with **Code Dictator: Retry Failed Transcription**, even after restarting VS Code. Up to 10 failed recordings are kept, and each is deleted once it has been transcribed.
- **ElevenLabs "system busy" errors are retried automatically.** When ElevenLabs answers that its servers are overloaded (`system_busy`), Code Dictator now waits and resends the recording up to two more times before reporting an error. Escape cancels the wait.

### Fixed
- **Recordings with a quiet start are no longer thrown away as "Microphone is producing silence".** The silence check that runs before transcription measured only the first second of audio. Microphones with noise suppression output near-digital silence until you start talking, so pausing for a second before speaking discarded the whole recording — minutes of dictation included. The check now scans the entire recording and skips transcription only when no part of it is audible. It also finds the samples in WAV files with extra header chunks (as ffmpeg writes them), and no longer tries to judge compressed webm/ogg audio.
- **AI cleanup no longer acts on what you dictated.** When a transcription read like a request ("write a description for…", "what's the capital of…"), the cleanup model would answer it and inject its reply instead of your words. The transcript is now passed as delimited data rather than as the request itself, and the result is checked against the original before use — if the model rewrote, summarised, or answered instead of tidying, the raw transcription is kept.
- **Silence auto-stop now works on Linux.** `parecord`/`arecord` often emit a chunk of digital silence while the microphone spins up. That chunk was used to calibrate the noise floor, pinning it ~35 dB below real ambient noise. Everything afterwards then registered as speech, so the noise floor never adapted and `recording.silenceTimeout` never fired for the whole recording. The floor is now seeded from the first chunk with real signal, adapts downward quickly, and drifts back up if it ever gets stuck below ambient.

### Changed
- **ElevenLabs 429 errors now say what actually happened.** They were all reported as "rate limit reached". The message now carries ElevenLabs' own code and explanation: overloaded servers (`system_busy`), your plan's concurrency limit, or a real rate limit.
- Dependencies refreshed: TypeScript 6, esbuild 0.28 (clears a Windows dev-server advisory), ESLint 10.8, Vitest 4.1.10, `@vscode/vsce` 3.9, `@vscode/test-electron` 3, and `actions/checkout@v7` in CI.

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
