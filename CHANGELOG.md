# Changelog

All notable changes to Code Dictator will be documented in this file.

## [Unreleased]

### Added
- **A failed transcription no longer loses your recording.** When the speech-to-text service turns a recording away (quota exceeded, rate limit, network error), the audio is now kept and the error offers **Retry** to send it again once the problem is sorted. A recording you didn't retry from the notification can be sent later with **Code Dictator: Retry Failed Transcription**, even after restarting VS Code. Up to 10 failed recordings are kept, and each is deleted once it has been transcribed.
- **ElevenLabs "system busy" errors are retried automatically.** When ElevenLabs answers that its servers are overloaded (`system_busy`), Code Dictator now waits and resends the recording up to two more times before reporting an error. Escape cancels the wait.

### Fixed
- **The "Code Dictator: Recorder" editor tab no longer opens on the first recording.** The native recorder is used directly when one is installed.
- **Hold mode: pressing the key again right after letting go no longer leaves a recorder running.** When the press came while the previous recording was still being stopped, the new recording could no longer be stopped or cancelled, its recorder kept capturing, and the shortcut stopped working until VS Code was reloaded.
- **Hold mode: Escape cancels every transcription in progress.** When you dictated again while the previous recording was still being transcribed, the first transcription to finish switched Escape off for the other one, so it could no longer be cancelled and its text was inserted anyway.
- **Escape during AI cleanup now cancels the dictation.** Pressing Escape while the status bar showed "Cleaning up..." stopped only the cleanup, and the raw transcription was inserted anyway.
- **A recording cut short by the recorder process is no longer left in the temp folder.** When the native recorder ended on its own (microphone unplugged, sound server restarted), the partial recording stayed in the system temp directory.
- **Escape pressed right after Alt+D now cancels the recording.** The recorder takes a moment to start, and an Escape in that moment was lost: the recorder started anyway and kept capturing, while the status bar showed a recording that Escape could no longer cancel. The audio was then transcribed at the next Alt+D or when the maximum recording time ran out, and in hold mode letting go of the key did not stop it either. The recorder is now stopped as soon as it has started, and nothing is kept or sent.
- **A recorder that fails to start now says why.** When the recording tool (`parecord`, `ffmpeg`, `sox`…) quit right at startup, the error showed only its exit code, "Recording process exited immediately (code=1)." It now ends with the last of what the tool printed, such as `Connection failure: Connection refused` when the sound server isn't running.
- **Filler removal no longer cuts into real words.** When it worked in a language other than English, a dictation that began with a word starting like a filler lost those letters ("Отримав" became "Римав", "Это" became "То", "Ähnlich" became "Nlich"), and fillers that are also ordinary words, such as Ukrainian "значить" (it means) and "типу" (of type), Spanish "este" (this) or Portuguese "tipo" (type), were removed from the middle of sentences. Such words are now removed only where commas set them off as fillers, as in "Значить, …". Hesitation sounds like "uh", "äh" or "е" are still removed wherever they stand alone.
- **With ElevenLabs, filler removal and the AI cleanup's language check now use the language you spoke.** ElevenLabs reports it as a three-letter code ("ukr" for Ukrainian) that Code Dictator did not recognise, so filler removal always used the English list, and the check that discards an AI cleanup which switched your text to another alphabet (Ukrainian translated into English, say) never ran.
- **Choosing "Scribe v1" no longer breaks transcription.** ElevenLabs removed `scribe_v1` on 9 July 2026, so every recording sent with it failed. Scribe v1 is gone from the model list, and a saved `scribe_v1` now uses Scribe v2.
- **Recordings with a quiet start are no longer thrown away as "Microphone is producing silence".** The silence check that runs before transcription measured only the first second of audio. Microphones with noise suppression output near-digital silence until you start talking, so pausing for a second before speaking discarded the whole recording — minutes of dictation included. The check now scans the entire recording and skips transcription only when no part of it is audible. It also finds the samples in WAV files with extra header chunks (as ffmpeg writes them), and no longer tries to judge compressed webm/ogg audio.
- **AI cleanup no longer acts on what you dictated.** When a transcription read like a request ("write a description for…", "what's the capital of…"), the cleanup model would answer it and inject its reply instead of your words. The transcript is now passed as delimited data rather than as the request itself, and the result is checked against the original before use — if the model rewrote, summarised, or answered instead of tidying, the raw transcription is kept.
- **Silence auto-stop now works on Linux.** `parecord`/`arecord` often emit a chunk of digital silence while the microphone spins up. That chunk was used to calibrate the noise floor, pinning it ~35 dB below real ambient noise. Everything afterwards then registered as speech, so the noise floor never adapted and `recording.silenceTimeout` never fired for the whole recording. The floor is now seeded from the first chunk with real signal, adapts downward quickly, and drifts back up if it ever gets stuck below ambient.

### Changed
- **AI cleanup now uses GPT-6 Luna.** OpenAI is retiring every model the cleanup offered: `gpt-4.1-nano` on 23 October 2026, and `gpt-4.1-mini` (the default) and `gpt-4.1` on 14 January 2027. After that, cleanup would have quietly returned the raw transcription. The choice is now `gpt-6-luna` (the default, cheaper than the old one) or `gpt-6-sol` for the best quality, and a setting that still names a retired model uses `gpt-6-luna`.
- **The OpenAI provider now transcribes with GPT Transcribe.** OpenAI shuts down `whisper-1`, `gpt-4o-transcribe` and `gpt-4o-mini-transcribe` on 26 February 2027. `gpt-transcribe` replaces all three: it costs $0.0045 a minute instead of $0.006, and it reports the spoken language as a code, so filler removal now picks the right language when it is auto-detected. A setting that still names a retired model uses `gpt-transcribe`.
- **ElevenLabs 429 errors now say what actually happened.** They were all reported as "rate limit reached". The message now carries ElevenLabs' own code and explanation: overloaded servers (`system_busy`), your plan's concurrency limit, or a real rate limit.
- **The README, the Marketplace description and the walkthrough now say what recording needs.** VS Code does not give extensions' web views access to the microphone, so Code Dictator records with a tool on your system: nothing to install on most Linux desktops (`parecord`, `pw-record` or `arecord`), `brew install sox` on macOS, `winget install Gyan.FFmpeg` on Windows. They no longer say that nothing needs installing or that a hidden WebView does the recording.
- **A missing recording tool now says what to install.** The error names the tool for your system (for example "Code Dictator needs SoX to record. Install it with: brew install sox — then press Alt+D again.") and, on macOS and Windows, has a button that copies the install command. It replaces a message that mentioned microphone permissions and listed the tools for all three platforms at once.
- **`recording.audioIsolation` is deprecated and has no effect.** It only applied to the in-editor recorder, which VS Code does not let use the microphone. The setting stays so existing configurations remain valid, and it is no longer listed in the README or the walkthrough.
- **The `recording.silenceTimeout` description now says where silence auto-stop works.** Only `parecord` and `arecord` (Linux) stream audio for silence detection. With `pw-record`, SoX (macOS) and ffmpeg (Windows) the setting has no effect, so use `recording.maxDuration` there.
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
