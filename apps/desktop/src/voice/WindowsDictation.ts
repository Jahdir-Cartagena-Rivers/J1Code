// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import * as NodeChildProcess from "node:child_process";

const sessions = new Map<
  string,
  {
    child: NodeChildProcess.ChildProcess;
    text: string;
    finalText: string;
    pending: string;
    level: number;
    stopping: boolean;
    timer?: ReturnType<typeof setTimeout>;
  }
>();
const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Speech
$source = @'
using System;
using System.Speech.Recognition;
using System.Text;
using System.Threading.Tasks;
public static class J1Dictation {
  public static void Run() {
    using (var recognizer = new SpeechRecognitionEngine()) {
      var gate = new object();
      var final = new StringBuilder();
      var completed = new TaskCompletionSource<bool>();
      long lastLevelAt = 0;
      Exception recognitionError = null;
      Action<string, string> emit = (kind, text) => {
        Console.WriteLine(kind + "\\t" + Convert.ToBase64String(Encoding.UTF8.GetBytes(text)));
        Console.Out.Flush();
      };
      recognizer.LoadGrammar(new DictationGrammar());
      recognizer.SetInputToDefaultAudioDevice();
      recognizer.SpeechHypothesized += (sender, e) => {
        lock (gate) { emit("P", (final.ToString() + " " + e.Result.Text).Trim()); }
      };
      recognizer.SpeechRecognized += (sender, e) => {
        lock (gate) {
          if (final.Length > 0) final.Append(" ");
          final.Append(e.Result.Text);
          emit("F", final.ToString());
        }
      };
      recognizer.AudioLevelUpdated += (sender, e) => {
        lock (gate) {
          long now = DateTime.UtcNow.Ticks;
          if (now - lastLevelAt >= TimeSpan.TicksPerMillisecond * 200) {
            lastLevelAt = now;
            emit("L", e.AudioLevel.ToString());
          }
        }
      };
      recognizer.RecognizeCompleted += (sender, e) => { recognitionError = e.Error; completed.TrySetResult(true); };
      recognizer.RecognizeAsync(RecognizeMode.Multiple);
      var stop = Task.Run(() => Console.ReadLine());
      if (Task.WaitAny(stop, completed.Task) == 0) {
        recognizer.RecognizeAsyncStop();
        if (!completed.Task.Wait(TimeSpan.FromSeconds(8))) throw new TimeoutException("Speech recognition did not finish.");
      }
      if (recognitionError != null) throw recognitionError;
    }
  }
}
'@
Add-Type -TypeDefinition $source -ReferencedAssemblies @('System.Speech', 'System')
[J1Dictation]::Run()
`;

export function cancelWindowsDictation(requestId: string): void {
  sessions.get(requestId)?.child.kill();
}

export function stopWindowsDictation(requestId: string): void {
  const session = sessions.get(requestId);
  if (session && !session.stopping) {
    session.stopping = true;
    session.child.stdin?.end("stop\n");
    session.timer = setTimeout(() => session.child.kill(), 10_000);
  }
}

export function getWindowsDictationText(requestId: string): string {
  return sessions.get(requestId)?.text ?? "";
}
export function getWindowsDictationLevel(requestId: string): number {
  return sessions.get(requestId)?.level ?? 0;
}

export function cancelAllWindowsDictation(): void {
  for (const session of sessions.values()) session.child.kill();
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
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const session: NonNullable<ReturnType<typeof sessions.get>> = {
      child,
      text: "",
      finalText: "",
      pending: "",
      level: 0,
      stopping: false,
    };
    sessions.set(requestId, session);
    child.stdin?.on("error", () => {});
    let error = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      session.pending += chunk;
      const lines = session.pending.split(/\r?\n/);
      session.pending = lines.pop() ?? "";
      for (const line of lines) {
        const match = /^([PFL])\t([A-Za-z0-9+/=]*)$/.exec(line);
        if (!match) continue;
        const text = Buffer.from(match[2]!, "base64").toString("utf8").slice(0, 120_000);
        if (match[1] === "L") session.level = Math.min(100, Math.max(0, Number(text) || 0));
        else {
          session.text = text;
          if (match[1] === "F") session.finalText = text;
        }
      }
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      error = (error + chunk).slice(0, 2000);
    });
    const clean = () => {
      if (session.timer) clearTimeout(session.timer);
      if (sessions.get(requestId) === session) sessions.delete(requestId);
    };
    child.once("error", (cause) => {
      clean();
      reject(cause);
    });
    child.once("close", (code) => {
      clean();
      if (code === 0) resolve(session.finalText);
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
