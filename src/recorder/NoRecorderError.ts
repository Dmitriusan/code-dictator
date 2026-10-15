interface InstallAdvice {
  message: string;
  /** One command that installs a recording tool, where there is one. */
  command?: string;
}

function installAdvice(platform: NodeJS.Platform): InstallAdvice {
  switch (platform) {
    case 'darwin':
      return {
        message: 'Code Dictator needs SoX to record. Install it with: brew install sox — then press Alt+D again.',
        command: 'brew install sox',
      };
    case 'win32':
      return {
        message: 'Code Dictator needs ffmpeg to record. Install it with: winget install Gyan.FFmpeg — then press Alt+D again.',
        command: 'winget install Gyan.FFmpeg',
      };
    default:
      // The package that holds each tool depends on the distribution, so no single command
      return {
        message: 'Code Dictator needs a recording tool. Install pulseaudio-utils (parecord), pipewire-bin (pw-record) or alsa-utils (arecord) — then press Alt+D again.',
      };
  }
}

/**
 * A recording cannot start because this machine has no recording tool, and the
 * webview recorder cannot take over (VS Code never gives it the microphone).
 * `message` is what to tell the user; `installCommand` is the one command that
 * installs a tool on macOS and Windows, so the extension can offer to copy it.
 */
export class NoRecorderError extends Error {
  readonly installCommand: string | undefined;

  constructor(platform: NodeJS.Platform = process.platform) {
    const advice = installAdvice(platform);
    super(advice.message);
    this.name = 'NoRecorderError';
    this.installCommand = advice.command;
  }
}
