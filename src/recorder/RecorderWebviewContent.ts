// No runtime type imports needed — the webview HTML is a self-contained string.

/**
 * Returns the HTML content for the hidden recorder webview panel.
 * The webview handles MediaRecorder, audio processing, silence detection,
 * and communicates with the extension host via postMessage.
 */
export function getRecorderWebviewContent(nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'nonce-${nonce}'; media-src mediastream:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Code Dictator Recorder</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
      font-size: 13px;
    }
    .status {
      text-align: center;
      opacity: 0.7;
    }
    .recording {
      color: #f44336;
      font-weight: bold;
    }
    .dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #f44336;
      margin-right: 6px;
      animation: pulse 1s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }
  </style>
</head>
<body>
  <div class="status" id="status">Microphone ready</div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    let mediaRecorder = null;
    let audioChunks = [];
    let stream = null;
    let audioContext = null;
    let analyser = null;
    let silenceCheckInterval = null;
    let silenceStart = null;
    let recordingStart = null;
    let maxDurationTimeout = null;
    let currentIsolation = 'basic';
    let currentSilenceTimeout = 0;
    let currentMaxDuration = 300;
    let cancelled = false;

    function updateStatus(text, isRecording) {
      const el = document.getElementById('status');
      // Always use textContent — never innerHTML — to prevent any XSS risk.
      el.textContent = '';
      if (isRecording) {
        const dot = document.createElement('span');
        dot.className = 'dot';
        const label = document.createElement('span');
        label.className = 'recording';
        label.textContent = text;
        el.appendChild(dot);
        el.appendChild(label);
      } else {
        el.textContent = text;
      }
    }

    async function startRecording(isolation, silenceTimeout, maxDuration) {
      cancelled = false;
      currentIsolation = isolation;
      currentSilenceTimeout = silenceTimeout;
      currentMaxDuration = maxDuration;
      audioChunks = [];
      silenceStart = null;

      try {
        const constraints = {
          audio: {
            channelCount: 1,
            sampleRate: 16000,
            echoCancellation: isolation !== 'off',
            noiseSuppression: isolation !== 'off',
            autoGainControl: isolation !== 'off'
          }
        };

        stream = await navigator.mediaDevices.getUserMedia(constraints);

        let recorderStream = stream;

        // For aggressive mode, apply Web Audio API filtering
        if (isolation === 'aggressive') {
          audioContext = new AudioContext({ sampleRate: 16000 });
          const source = audioContext.createMediaStreamSource(stream);

          // High-pass filter at 85Hz to remove low rumble
          const highpass = audioContext.createBiquadFilter();
          highpass.type = 'highpass';
          highpass.frequency.value = 85;
          highpass.Q.value = 0.7;

          // Low-pass filter at 8000Hz to remove high-frequency noise
          const lowpass = audioContext.createBiquadFilter();
          lowpass.type = 'lowpass';
          lowpass.frequency.value = 8000;
          lowpass.Q.value = 0.7;

          // Compressor to normalize volume
          const compressor = audioContext.createDynamicsCompressor();
          compressor.threshold.value = -24;
          compressor.knee.value = 30;
          compressor.ratio.value = 12;
          compressor.attack.value = 0.003;
          compressor.release.value = 0.25;

          // Connect the chain
          source.connect(highpass);
          highpass.connect(lowpass);
          lowpass.connect(compressor);

          const destination = audioContext.createMediaStreamDestination();
          compressor.connect(destination);

          recorderStream = destination.stream;

          // Set up analyser on the processed stream for silence detection
          analyser = audioContext.createAnalyser();
          analyser.fftSize = 256;
          compressor.connect(analyser);
        } else if (silenceTimeout > 0) {
          // Set up analyser for silence detection even in non-aggressive mode
          audioContext = new AudioContext({ sampleRate: 16000 });
          const source = audioContext.createMediaStreamSource(stream);
          analyser = audioContext.createAnalyser();
          analyser.fftSize = 256;
          source.connect(analyser);
        }

        // Determine supported mime type
        let mimeType = 'audio/webm;codecs=opus';
        if (!MediaRecorder.isTypeSupported(mimeType)) {
          mimeType = 'audio/webm';
          if (!MediaRecorder.isTypeSupported(mimeType)) {
            mimeType = 'audio/ogg;codecs=opus';
            if (!MediaRecorder.isTypeSupported(mimeType)) {
              mimeType = ''; // Let browser choose
            }
          }
        }

        const recorderOptions = mimeType ? { mimeType } : undefined;
        mediaRecorder = new MediaRecorder(recorderStream, recorderOptions);

        mediaRecorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) {
            audioChunks.push(event.data);
          }
        };

        mediaRecorder.onstop = async () => {
          clearInterval(silenceCheckInterval);
          silenceCheckInterval = null;
          clearTimeout(maxDurationTimeout);
          maxDurationTimeout = null;

          if (cancelled) {
            cleanup();
            updateStatus('Recording cancelled', false);
            return;
          }

          if (audioChunks.length === 0) {
            cleanup();
            vscode.postMessage({ type: 'recordingError', message: 'No audio data captured' });
            return;
          }

          const actualMimeType = mediaRecorder.mimeType || 'audio/webm';
          const blob = new Blob(audioChunks, { type: actualMimeType });
          const durationMs = Date.now() - recordingStart;

          try {
            const arrayBuffer = await blob.arrayBuffer();
            const uint8Array = new Uint8Array(arrayBuffer);
            let binary = '';
            const chunkSize = 8192;
            for (let i = 0; i < uint8Array.length; i += chunkSize) {
              const slice = uint8Array.subarray(i, Math.min(i + chunkSize, uint8Array.length));
              binary += String.fromCharCode.apply(null, slice);
            }
            const base64 = btoa(binary);

            vscode.postMessage({
              type: 'audioData',
              data: base64,
              mimeType: actualMimeType,
              durationMs: durationMs
            });
          } catch (err) {
            vscode.postMessage({
              type: 'recordingError',
              message: 'Failed to encode audio: ' + (err.message || String(err))
            });
          }

          cleanup();
          updateStatus('Microphone ready', false);
        };

        mediaRecorder.onerror = (event) => {
          cleanup();
          vscode.postMessage({
            type: 'recordingError',
            message: 'MediaRecorder error: ' + (event.error ? event.error.message : 'Unknown')
          });
        };

        mediaRecorder.start(250); // Collect data every 250ms
        recordingStart = Date.now();

        // Set up silence detection
        if (silenceTimeout > 0 && analyser) {
          const bufferLength = analyser.frequencyBinCount;
          const dataArray = new Uint8Array(bufferLength);
          const silenceThreshold = 10; // Amplitude threshold (0-255 range)

          silenceCheckInterval = setInterval(() => {
            analyser.getByteFrequencyData(dataArray);
            let sum = 0;
            for (let i = 0; i < bufferLength; i++) {
              sum += dataArray[i];
            }
            const average = sum / bufferLength;

            if (average < silenceThreshold) {
              if (silenceStart === null) {
                silenceStart = Date.now();
              } else if (Date.now() - silenceStart >= silenceTimeout * 1000) {
                vscode.postMessage({ type: 'silenceDetected' });
                silenceStart = null; // Reset so we don't fire repeatedly
              }
            } else {
              silenceStart = null;
            }
          }, 200);
        }

        // Max duration enforcement
        if (maxDuration > 0) {
          maxDurationTimeout = setTimeout(() => {
            if (mediaRecorder && mediaRecorder.state === 'recording') {
              mediaRecorder.stop();
            }
          }, maxDuration * 1000);
        }

        updateStatus('Recording...', true);
        vscode.postMessage({ type: 'recordingStarted' });

      } catch (err) {
        cleanup();
        let message = 'Microphone access denied or unavailable';
        if (err.name === 'NotAllowedError') {
          message = 'Microphone permission denied. Please allow microphone access in your browser/OS settings.';
        } else if (err.name === 'NotFoundError') {
          message = 'No microphone found. Please connect a microphone and try again.';
        } else if (err.message) {
          message = err.message;
        }
        vscode.postMessage({ type: 'recordingError', message: message });
      }
    }

    function stopRecording() {
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
        vscode.postMessage({ type: 'recordingStopped' });
        updateStatus('Processing...', false);
      }
    }

    function cancelRecording() {
      cancelled = true;
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
      }
      cleanup();
      updateStatus('Recording cancelled', false);
    }

    function cleanup() {
      if (silenceCheckInterval) {
        clearInterval(silenceCheckInterval);
        silenceCheckInterval = null;
      }
      if (maxDurationTimeout) {
        clearTimeout(maxDurationTimeout);
        maxDurationTimeout = null;
      }
      if (audioContext && audioContext.state !== 'closed') {
        audioContext.close().catch(() => {});
        audioContext = null;
      }
      analyser = null;
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
        stream = null;
      }
      mediaRecorder = null;
      audioChunks = [];
    }

    // Listen for messages from the extension
    window.addEventListener('message', (event) => {
      const message = event.data;
      switch (message.type) {
        case 'startRecording':
          startRecording(message.isolation, message.silenceTimeout, message.maxDuration);
          break;
        case 'stopRecording':
          stopRecording();
          break;
        case 'cancelRecording':
          cancelRecording();
          break;
        case 'ping':
          vscode.postMessage({ type: 'ready' });
          break;
      }
    });

    // Signal that we're ready
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}
