# Voice Activity Detection (VAD) — Technical Reference

Code Dictator implements an adaptive Voice Activity Detection system for automatic silence-based recording termination. This document describes the signal processing pipeline, the mathematical model, and the design rationale behind each component.

---

## Overview

When a user finishes speaking, the extension should detect the resulting silence and automatically stop recording after a configurable timeout. The core challenge is that "silence" is relative — a quiet office, a noisy cafe, and a high-gain USB microphone all produce vastly different baseline amplitude levels. A fixed threshold fails across these environments. Code Dictator solves this with an adaptive energy-based VAD that calibrates itself in real time during every recording session.

**Key properties:**
- Zero configuration required — adapts to any microphone, gain level, and ambient environment
- Works in the dBFS (decibels relative to full scale) domain for perceptually meaningful comparisons
- Dual exponential moving average (EMA) tracking of noise floor and speech energy
- Adaptive threshold placement between noise and speech levels
- SNR-gated activation prevents false triggers in indistinguishable noise conditions

---

## Signal Processing Pipeline

### 1. RMS Energy Extraction

Raw audio arrives as signed 16-bit little-endian PCM at 16 kHz mono. For each chunk of *N* samples, we compute the root mean square (RMS) amplitude:

```
RMS = sqrt( (1/N) * sum( x[i]^2 ) )     for i = 0..N-1
```

where `x[i]` is each 16-bit signed sample in the range [-32768, 32767]. RMS is preferred over peak amplitude because it correlates with perceived loudness and is robust against isolated transient spikes.

### 2. Conversion to dBFS

The RMS value is converted to decibels relative to full scale:

```
dBFS = 20 * log10( RMS / 32768 )
```

This transformation is essential for two reasons:

- **Perceptual linearity.** Human hearing perceives loudness logarithmically. A difference of 6 dB corresponds roughly to a doubling of perceived volume. Operating in dB means that threshold placement and comparisons align with how humans distinguish "quiet" from "loud."
- **Gain invariance.** A microphone with twice the gain shifts all dBFS values by a constant offset. The *relative* gap between noise floor and speech remains the same, so the adaptive threshold tracks correctly regardless of absolute gain.

Digital silence maps to approximately -96 dBFS (the noise floor of 16-bit quantization). Typical quiet-room ambient noise sits around -50 to -40 dBFS. Normal conversational speech at arm's length produces -30 to -15 dBFS.

---

## Adaptive Threshold Model

The system maintains two continuously updated estimates using exponential moving averages:

### Noise Floor Estimate (slow EMA)

```
F[n] = F[n-1] + alpha_noise * (dBFS[n] - F[n-1])
```

- `alpha_noise = 0.05` when the chunk is louder than the current floor — slow adaptation, time constant of ~20 chunks
- `alpha_noise_fall = 0.3` when the chunk is quieter than the current floor — fast adaptation, so a floor seeded too high (speaker talking from the first chunk) drops to ambient within a few hundred milliseconds
- Updated **only during non-speech chunks** to prevent speech energy from inflating the floor estimate
- Tracks gradual environmental changes (HVAC cycling, window opened, background music fading)

#### Anti-latch drift

Because the floor only adapts on non-speech chunks, a floor sitting *below* the true ambient level is self-sustaining: every chunk clears the `MIN_SNR_DB` margin, so nothing is ever classified as noise and the estimate can never recover. A correctly-placed floor is refreshed constantly by the pauses between words, so an unbroken run of "speech" is itself the signal that the estimate is stale:

```
if no non-speech chunk for FLOOR_STALE_CHUNKS: F[n] = F[n-1] + FLOOR_DRIFT_DB
```

with `FLOOR_STALE_CHUNKS = 50` (~5 s) and `FLOOR_DRIFT_DB = 0.5`. The floor creeps upward until ambient chunks fall back inside the margin and normal adaptation resumes.

### Speech Peak Estimate (moderate EMA)

```
S[n] = S[n-1] + alpha_speech * (dBFS[n] - S[n-1])
```

- `alpha_speech = 0.1` — moderate adaptation, time constant of ~10 chunks
- Updated **only during speech chunks** to track the speaker's current volume
- Adapts to natural volume variation (speaker moving closer/further, emphasis changes)

### Speech/Noise Classification

A chunk is classified as speech when its energy exceeds the current noise floor by at least the minimum SNR margin:

```
is_speech = (dBFS[n] - F[n]) > MIN_SNR_DB
```

where `MIN_SNR_DB = 6 dB`. This corresponds to approximately 2x the noise floor amplitude — a conservative boundary that avoids misclassifying loud ambient noise as speech.

### Adaptive Threshold Placement

The silence detection threshold is placed at a fixed fraction between the noise floor and speech peak estimates:

```
T = F + (S - F) * THRESHOLD_POSITION
```

where `THRESHOLD_POSITION = 0.35`. This places the threshold closer to the noise floor (35% of the way up to speech), making the system reasonably sensitive to the end of speech while maintaining a margin above ambient noise.

The choice of 0.35 reflects a design trade-off:
- Lower values (closer to noise) detect silence faster but risk false triggers from brief pauses between words or sentences
- Higher values (closer to speech) are more robust but may not detect silence until the speaker has been quiet for noticeably longer than the configured timeout
- 0.35 was selected empirically to handle natural speech cadence, where inter-word pauses typically remain above noise floor while post-utterance silence drops to ambient levels within 200-500ms

---

## State Machine

The VAD operates as a three-phase state machine:

### Phase 1: Bootstrap

The noise floor EMA is seeded from the first chunk carrying real signal — anything at or below `ABSOLUTE_SILENCE_DBFS` (-90 dBFS) is skipped. No classification or silence detection occurs during this phase. This avoids undefined initial state.

The dead-chunk skip matters because `parecord`/`arecord` routinely emit all-zero chunks (-96 dBFS) while the capture device spins up. Seeding from one pins the floor at the 16-bit quantization floor, roughly 35 dB below real ambient noise — which then latches (see *Anti-latch drift* above) and suppresses silence detection for the entire recording.

### Phase 2: Calibration

The system processes incoming audio, updating noise floor and speech peak estimates, but does not trigger silence detection. This phase ends when two conditions are met simultaneously:

1. At least one speech chunk has been observed (`hasSeenSpeech = true`)
2. The signal-to-noise ratio exceeds the minimum: `S - F >= MIN_SNR_DB`

This ensures the system never triggers a false silence timeout before the user has actually started speaking, and never activates when the microphone cannot meaningfully distinguish speech from noise.

### Phase 3: Active Detection

Once calibrated, each chunk is compared against the adaptive threshold. When the signal drops below threshold:

```
is_silent = (dBFS[n] < T) OR (dBFS[n] < ABSOLUTE_SILENCE_DBFS)
```

The absolute floor (`ABSOLUTE_SILENCE_DBFS = -60 dBFS`) acts as a safety net — anything below -60 dBFS is treated as silence regardless of calibration state, handling edge cases where both EMAs have drifted.

A silence timer starts on the first silent chunk. If silence persists continuously for `silenceTimeout` seconds, the recording stops automatically. Any non-silent chunk resets the timer to zero.

---

## Design Rationale

### Why not a fixed threshold?

A fixed RMS or dBFS threshold requires the user to manually calibrate for their specific microphone, gain setting, and environment. In testing, we observed RMS values during silence ranging from 5 (digital near-silence on a low-gain condenser) to 400+ (high-gain USB microphone in a room with HVAC), making any single fixed value either too sensitive or too conservative for a meaningful fraction of users.

### Why dual EMAs instead of a single adaptive threshold?

A single EMA tracking "average energy" would be pulled upward during speech and downward during silence, oscillating around a midpoint that serves neither purpose well. By maintaining separate slow-floor and moderate-peak estimates with asymmetric update rules (floor updates only during silence, peak updates only during speech), the system independently tracks both reference points and places the threshold between them with stable convergence.

### Why dBFS instead of linear RMS?

In the linear RMS domain, the perceptual difference between RMS 100 and RMS 200 is vastly different from the difference between RMS 10000 and RMS 10100, yet both represent a delta of 100. Threshold placement as a linear interpolation between noise and speech in the RMS domain would be dominated by the speech peak, making the threshold insensitive to noise floor variations. In the dB domain, interpolation produces perceptually uniform placement.

### Why require speech before activating?

Without this gate, pressing the dictation key and pausing to think (a common pattern) would trigger the silence timeout before the user speaks. The SNR gate ensures the system has observed a meaningful speech-to-noise contrast before it begins counting silence.

---

## Parameters

| Parameter | Value | Description |
|---|---|---|
| `NOISE_ALPHA` | 0.05 | Noise floor EMA smoothing factor (slow) |
| `SPEECH_ALPHA` | 0.1 | Speech peak EMA smoothing factor (moderate) |
| `THRESHOLD_POSITION` | 0.35 | Threshold placement between floor and peak |
| `MIN_SNR_DB` | 6 dB | Minimum SNR before VAD activates |
| `ABSOLUTE_SILENCE_DBFS` | -60 dBFS | Hard floor for silence classification |
| `silenceTimeout` | User-configured | Seconds of continuous silence before auto-stop |

---

## Platform Notes

Code Dictator uses a two-tier recording architecture. The silence detection approach differs between tiers:

### WebView Recorder (macOS, Windows — primary on all platforms)

The primary recording path uses a hidden WebView with the browser's MediaRecorder API. Silence detection here leverages the Web Audio API's `AnalyserNode`, which provides frequency-domain data via `getByteFrequencyData()`. The average spectral energy across all frequency bins is compared against a fixed threshold. This works well because the browser's audio pipeline applies its own gain normalization, making the input levels relatively consistent across microphones.

### Native Recorder (Linux fallback, macOS/Windows fallback)

On Linux, where WebView microphone permissions are frequently sandboxed by the desktop environment (Wayland compositors, Snap/Flatpak confinement), the extension falls back to a native recorder, preferring `parecord` / `pw-record` (PulseAudio/PipeWire, so Bluetooth mics route correctly) over `arecord` (ALSA). On macOS and Windows, `sox`/`rec` serves as the fallback if WebView recording fails for any reason.

When using the native recorder with silence detection enabled, `arecord`/`parecord` is launched in raw PCM stdout-pipe mode (`-t raw -` / `--raw`) rather than writing directly to a WAV file. The extension host process reads the PCM stream, writes it to disk with a WAV header, and simultaneously feeds each chunk to the adaptive VAD described in this document. The WAV header is written with a placeholder data size and patched with the correct size when recording stops. (`pw-record` cannot stream to stdout, so it always writes to a file and silence detection is unavailable with it.)

To avoid PulseAudio/PipeWire dropping the tail of a recording, `parecord` is launched with `--latency-msec=100`, which caps the capture buffer; otherwise the last 1–2 seconds are lost when the process is signalled to stop.

This architecture means the adaptive VAD runs in the Node.js extension host process, operating on time-domain PCM samples — a fundamentally different signal path from the WebView's frequency-domain approach. The dBFS/EMA model described here was designed specifically for this raw PCM path, where no browser-level gain normalization occurs and the full dynamic range of the input device is preserved.

---

## References

- ITU-T G.729 Annex B — Voice Activity Detection for use with near toll quality coding at 8 kbit/s
- ETSI EN 300 961 — Digital cellular telecommunications system; Voice Activity Detector (VAD)
- Benyassine, A. et al. (1997). "ITU-T Recommendation G.729 Annex B: A Silence Compression Scheme for Use with G.729 Optimized for V.70 Digital Simultaneous Voice and Data Applications." IEEE Communications Magazine, 35(9), 64-73.
