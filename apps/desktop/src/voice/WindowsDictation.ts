// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import * as NodeChildProcess from "node:child_process";

const sessions = new Map<string, NodeChildProcess.ChildProcess>();
const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Speech
$recognizer = [System.Speech.Recognition.SpeechRecognitionEngine]::new()
try {
  $recognizer.LoadGrammar([System.Speech.Recognition.DictationGrammar]::new())
  $recognizer.SetInputToDefaultAudioDevice()
  $recognizer.BabbleTimeout = [TimeSpan]::FromSeconds(30)
  $result = $recognizer.Recognize([TimeSpan]::FromSeconds(15))
  if ($null -ne $result) { [Console]::Write($result.Text) }
} finally { $recognizer.Dispose() }
`;

export function cancelWindowsDictation(requestId: string): void {
  sessions.get(requestId)?.kill();
}

export function cancelAllWindowsDictation(): void {
  for (const child of sessions.values()) child.kill();
}

export function startWindowsDictation(
  requestId: string,
  platform: NodeJS.Platform,
): Promise<string> {
  if (platform !== "win32") return Promise.reject(new Error("Native dictation requires Windows."));
  if (sessions.size > 0) return Promise.reject(new Error("Dictation is already listening."));
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    sessions.set(requestId, child);
    let text = "";
    let error = "";
    const timeout = setTimeout(() => child.kill(), 65_000);
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      text = (text + chunk).slice(0, 120_000);
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      error = (error + chunk).slice(0, 2000);
    });
    const clean = () => {
      clearTimeout(timeout);
      if (sessions.get(requestId) === child) sessions.delete(requestId);
    };
    child.once("error", (cause) => {
      clean();
      reject(cause);
    });
    child.once("close", (code) => {
      clean();
      if (code === 0) resolve(text.trim());
      else
        reject(
          new Error(
            error ||
              "Dictation stopped. Check your microphone and installed Windows speech language.",
          ),
        );
    });
  });
}
