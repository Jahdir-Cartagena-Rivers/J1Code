import { AndroidDictationDraft } from "../../native/androidDictationDraft";
import type { AndroidDictationEvent } from "../../native/androidDictation";
import {
  VOICE_RECORDING_LIMIT_SECONDS,
  VoiceInputController,
  voiceInputBlocksSubmission,
  type VoiceDraftSnapshot,
  type VoiceInputControllerDependencies,
  type VoiceInputPhase,
  type VoiceInputState,
} from "@j1code/client-runtime/voice-input";

import { normalizeVoiceInputDecibels, VOICE_WAVEFORM_SAMPLE_COUNT } from "./voiceInputMetering";

const VOICE_METERING_INTERVAL_MS = 80;
const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };
const SILENT_LEVELS: ReadonlyArray<number> = Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0);

export type VoiceInputTarget = {
  readonly ownerKey: string;
  readonly label?: string;
  readonly readDraft: () => VoiceDraftSnapshot | null;
  readonly commitDraft: VoiceInputControllerDependencies["commitDraft"];
};

export type VoiceInputSnapshot = {
  readonly state: VoiceInputState;
  readonly ownerKey: string | null;
  readonly label: string | null;
  readonly elapsedSeconds: number;
  readonly focusedOwners: ReadonlySet<string>;
};

export type VoiceRecordingSample = {
  readonly durationMillis: number;
  readonly metering: number | undefined;
};

export interface NativeLiveDictation {
  readonly enabled: () => boolean;
  readonly nextSession: () => number;
  readonly fallbackOnUnavailable: boolean;
  readonly native: {
    startDictation(id: number): Promise<void>;
    stopDictation(id: number): void;
    cancelDictation(id: number): void;
    addListener(name: "onDictation", listener: (event: AndroidDictationEvent) => void): { remove(): void };
  };
}

export type VoiceInputSessionDependencies = Omit<
  VoiceInputControllerDependencies,
  "readDraft" | "commitDraft" | "onStateChange"
> & {
  readonly liveDictation?: NativeLiveDictation;
  /** Reads the live recorder, or null when it is not capturing. */
  readonly sampleRecording: () => VoiceRecordingSample | null;
  /** Levels change every metering tick, so they bypass React state. */
  readonly publishAudioLevels: (levels: ReadonlyArray<number>) => void;
  /** Holds the screen awake while recording; returns the release. */
  readonly keepAwake: () => () => void;
};

export function createVoiceInputTarget(
  ownerKey: string,
  readText: () => string | null,
  commitDraft: VoiceInputTarget["commitDraft"],
  selection: VoiceDraftSnapshot["selection"],
): VoiceInputTarget {
  return {
    ownerKey,
    readDraft: () => {
      const text = readText();
      return text === null ? null : { ownerKey, text, selection };
    },
    commitDraft,
  };
}

/**
 * The app's single voice input: it owns the controller, the recording-only
 * side effects (keep-awake, metering) and publishes what the UI renders.
 */
export class VoiceInputSession {
  readonly controller: VoiceInputController;
  private readonly dependencies: VoiceInputSessionDependencies;
  private liveRequest: number | null = null;
  private liveDraft: AndroidDictationDraft | null = null;
  private liveStarted = 0;
  private liveStopping = false;
  private liveSubscription: { remove(): void } | undefined;
  private target: VoiceInputTarget | null = null;
  private startText: string | null = null;
  private snapshot: VoiceInputSnapshot = {
    state: IDLE_STATE,
    ownerKey: null,
    label: null,
    elapsedSeconds: 0,
    focusedOwners: new Set(),
  };
  private readonly listeners = new Set<() => void>();
  private audioLevels = SILENT_LEVELS;
  private releaseKeepAwake: (() => void) | null = null;
  private meteringInterval: ReturnType<typeof setInterval> | null = null;

  constructor(dependencies: VoiceInputSessionDependencies) {
    this.dependencies = dependencies;
    this.liveSubscription = dependencies.liveDictation?.native.addListener("onDictation", (event) => {
      if (event.sessionId !== this.liveRequest) return;
      if (event.type === "partial" || event.type === "final") {
        const current = this.target?.readDraft();
        const result = current && this.liveDraft?.update(
          current.ownerKey, current.text, event.text ?? "",
          event.type === "final" && !dependencies.liveDictation?.fallbackOnUnavailable,
        );
        if (!result) { this.cancelLive(); return; }
        this.target?.commitDraft(result.text, { start: result.cursor, end: result.cursor });
      } else if (event.type === "ready" && !this.liveStopping) {
        this.handleStateChange({ phase: "recording", error: null, errorAction: null });
      } else if (event.type === "level") {
        const level = Math.max(0, Math.min(1, event.level ?? 0));
        this.setAudioLevels([...this.audioLevels.slice(1), level]);
      } else if (event.type === "error") {
        this.cancelLive();
        this.handleStateChange({ phase: "error", error: event.message ?? "Speech recognition failed.", errorAction: "retry" });
      } else if (event.type === "end") {
        this.liveRequest = null;
        this.liveDraft = null;
        this.handleStateChange(IDLE_STATE);
      }
    });
    this.controller = new VoiceInputController({
      ...dependencies,
      onStateChange: (state) => this.handleStateChange(state),
      // The target's selection is fixed at start, so a draft changed since refuses the transcript.
      readDraft: () => {
        const draft = this.target?.readDraft() ?? null;
        return draft?.text === this.startText ? draft : null;
      },
      commitDraft: (text, selection) => this.target?.commitDraft(text, selection),
    });
  }

  get ownerKey(): string | null {
    return this.target?.ownerKey ?? null;
  }

  get label(): string | null {
    return this.target?.label ?? null;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): VoiceInputSnapshot => this.snapshot;

  setOwnerFocused(ownerKey: string, focused: boolean): void {
    if (this.snapshot.focusedOwners.has(ownerKey) === focused) return;
    const focusedOwners = new Set(this.snapshot.focusedOwners);
    if (focused) focusedOwners.add(ownerKey);
    else focusedOwners.delete(ownerKey);
    this.publish({ ...this.snapshot, focusedOwners });
  }

  cancel(ownerKey: string | null): void {
    if (ownerKey !== null && this.ownerKey === ownerKey) {
      this.cancelLive();
      this.controller.cancel();
    }
  }

  retry(): Promise<void> {
    return this.target ? this.start(this.target) : Promise.resolve();
  }

  start(target: VoiceInputTarget): Promise<void> {
    if (voiceInputBlocksSubmission(this.snapshot.state)) return Promise.resolve();
    this.target = target;
    this.startText = target.readDraft()?.text ?? null;
    const live = this.dependencies.liveDictation;
    const draft = target.readDraft();
    if (live?.enabled() && draft !== null) return this.startLive(live, draft);
    return this.controller.start();
  }

  get isLiveDictating(): boolean { return this.liveRequest !== null; }

  async stop(): Promise<void> {
    if (this.liveRequest === null) return this.controller.stop();
    this.liveStopping = true;
    this.handleStateChange({ phase: "transcribing", error: null, errorAction: null });
    this.dependencies.liveDictation?.native.stopDictation(this.liveRequest);
  }

  async appMovedToBackground(): Promise<void> {
    this.cancelLive();
    await this.controller.appMovedToBackground();
  }

  private cancelLive(): void {
    const request = this.liveRequest;
    this.liveRequest = null;
    this.liveDraft = null;
    if (request === null) return;
    this.dependencies.liveDictation?.native.cancelDictation(request);
    this.handleStateChange(IDLE_STATE);
  }

  private async startLive(live: NativeLiveDictation, draft: VoiceDraftSnapshot): Promise<void> {
    const request = live.nextSession();
    this.liveRequest = request;
    this.liveStopping = false;
    this.liveStarted = Date.now();
    this.liveDraft = new AndroidDictationDraft(draft.ownerKey, draft.text, draft.selection.start, draft.selection.end);
    this.handleStateChange({ phase: "preparing", error: null, errorAction: null });
    try {
      const permission = await this.dependencies.requestPermission();
      if (request !== this.liveRequest) return;
      if (!permission.granted) throw new Error("Microphone permission is required for dictation.");
      if (this.liveStopping) { this.cancelLive(); return; }
      await live.native.startDictation(request);
      if (request === this.liveRequest && this.liveStopping) live.native.stopDictation(request);
    } catch (error) {
      if (request !== this.liveRequest) return;
      const current = this.target?.readDraft();
      const stopped = this.liveStopping;
      this.cancelLive();
      if (stopped) return;
      if (live.fallbackOnUnavailable && (error as { code?: string } | null)?.code === "ERR_SPEECH_UNAVAILABLE" &&
          current?.ownerKey === draft.ownerKey && current.text === draft.text) {
        await this.controller.start();
        return;
      }
      this.handleStateChange({ phase: "error", error: String(error), errorAction: "retry" });
    }
  }

  dispose(): void {
    this.cancelLive();
    this.liveSubscription?.remove();
    this.controller.dispose();
    this.stopRecordingActivity();
    this.listeners.clear();
  }

  private handleStateChange(state: VoiceInputState): void {
    const previousPhase = this.snapshot.state.phase;
    let elapsedSeconds = this.snapshot.elapsedSeconds;
    if (state.phase !== previousPhase) {
      if (previousPhase === "recording") this.stopRecordingActivity();
      if (capturesAudio(state.phase)) {
        if (this.audioLevels.some((level) => level !== 0)) this.setAudioLevels(SILENT_LEVELS);
        elapsedSeconds = 0;
      }
    }
    this.publish({
      ...this.snapshot,
      state,
      ownerKey: this.ownerKey,
      label: this.label,
      elapsedSeconds,
    });
    if (state.phase === "recording" && previousPhase !== "recording") {
      this.startRecordingActivity();
    }
  }

  private startRecordingActivity(): void {
    this.releaseKeepAwake = this.dependencies.keepAwake();
    this.sampleRecording();
    this.meteringInterval = setInterval(() => this.sampleRecording(), VOICE_METERING_INTERVAL_MS);
  }

  private stopRecordingActivity(): void {
    if (this.meteringInterval !== null) clearInterval(this.meteringInterval);
    this.meteringInterval = null;
    this.releaseKeepAwake?.();
    this.releaseKeepAwake = null;
  }

  private sampleRecording(): void {
    if (this.snapshot.state.phase !== "recording") return;
    if (this.liveRequest !== null) {
      const elapsedSeconds = Math.min(VOICE_RECORDING_LIMIT_SECONDS, Math.max(0, Math.floor((Date.now() - this.liveStarted) / 1_000)));
      if (elapsedSeconds !== this.snapshot.elapsedSeconds) this.publish({ ...this.snapshot, elapsedSeconds });
      if (elapsedSeconds >= VOICE_RECORDING_LIMIT_SECONDS) void this.stop();
      return;
    }
    const sample = this.dependencies.sampleRecording();
    if (!sample) return;

    const level = normalizeVoiceInputDecibels(sample.metering);
    if (level !== 0 || this.audioLevels.some((sample) => sample !== 0)) {
      this.setAudioLevels([...this.audioLevels.slice(1), level]);
    }

    const elapsedSeconds = Math.min(
      VOICE_RECORDING_LIMIT_SECONDS,
      Math.max(0, Math.floor(sample.durationMillis / 1_000)),
    );
    if (elapsedSeconds !== this.snapshot.elapsedSeconds) {
      this.publish({ ...this.snapshot, elapsedSeconds });
    }
  }

  private setAudioLevels(levels: ReadonlyArray<number>): void {
    this.audioLevels = levels;
    this.dependencies.publishAudioLevels(levels);
  }

  private publish(snapshot: VoiceInputSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

function capturesAudio(phase: VoiceInputPhase): boolean {
  return phase === "preparing" || phase === "recording";
}
