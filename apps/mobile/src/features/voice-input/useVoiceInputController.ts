import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  setIsAudioActiveAsync,
  useAudioRecorder,
  type RecordingStatus,
} from "expo-audio";
import { File } from "expo-file-system";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AppState } from "react-native";
import { useSharedValue } from "react-native-reanimated";

import type { ComposerEditorSelection } from "../../components/ComposerEditor";
import { getLocalVoiceTranscriber } from "../../native/voiceTranscription";
import { androidDictation, nextAndroidDictationSession } from "../../native/androidDictation";
import { iosLiveDictation, nextIOSLiveDictationSession } from "../../native/iosLiveDictation";
import { AndroidDictationLifecycle } from "../../native/androidDictationLifecycle";
import { AndroidDictationDraft } from "../../native/androidDictationDraft";
import { getNativeShowcaseScene } from "../showcase/nativeShowcaseScene";
import {
  VoiceInputController,
  VOICE_RECORDING_LIMIT_SECONDS,
  voiceInputBlocksSubmission,
  voiceInputFreezesEditor,
  type VoiceDraftSnapshot,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import { normalizeVoiceInputDecibels, VOICE_WAVEFORM_SAMPLE_COUNT } from "./voiceInputMetering";

const liveDictation = iosLiveDictation ?? androidDictation;

const INITIAL_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };
const VOICE_METERING_INTERVAL_MS = 80;
const VOICE_RECORDING_OPTIONS = {
  ...RecordingPresets.HIGH_QUALITY,
  isMeteringEnabled: true,
};

async function releaseVoiceRecordingAudio(): Promise<void> {
  try {
    await setAudioModeAsync({ allowsRecording: false });
  } finally {
    // Expo does not deactivate AVAudioSession when recording stops or its
    // category changes. Explicit deactivation resumes interrupted app audio.
    await setIsAudioActiveAsync(false);
  }
}

async function configureVoiceRecordingAudio(): Promise<void> {
  try {
    await setAudioModeAsync({
      allowsRecording: true,
      interruptionMode: "doNotMix",
      playsInSilentMode: true,
      shouldPlayInBackground: false,
    });
    await setIsAudioActiveAsync(true);
  } catch (error) {
    try {
      await releaseVoiceRecordingAudio();
    } catch {
      // Keep the setup error. The controller has not started a recorder yet.
    }
    throw error;
  }
}

export function useVoiceInputController(input: {
  readonly ownerKey: string | null;
  readonly draftMessage: string;
  readonly selection: ComposerEditorSelection;
  readonly disabled?: boolean;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onChangeSelection: (selection: ComposerEditorSelection) => void;
}) {
  const [state, setState] = useState<VoiceInputState>(INITIAL_STATE);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const keepAwakeId = useId();
  const keepAwakeSessionRef = useRef(0);
  const elapsedSecondsRef = useRef(0);
  const audioLevelsRef = useRef(Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0));
  const audioLevels = useSharedValue(audioLevelsRef.current);
  const controllerRef = useRef<VoiceInputController | null>(null);
  const previousDraftRef = useRef({ ownerKey: input.ownerKey, text: input.draftMessage });
  const revisionRef = useRef(0);
  if (
    previousDraftRef.current.ownerKey !== input.ownerKey ||
    previousDraftRef.current.text !== input.draftMessage
  ) {
    previousDraftRef.current = { ownerKey: input.ownerKey, text: input.draftMessage };
    revisionRef.current += 1;
  }
  const latestInputRef = useRef(input);
  latestInputRef.current = input;
  const liveRequestRef = useRef(0);
  const livePendingRef = useRef(false);
  const liveStoppingRef = useRef(false);
  const iosFallbackRef = useRef(false);
  const liveLifecycle = useRef(new AndroidDictationLifecycle());
  const liveDraftRef = useRef<AndroidDictationDraft | null>(null);
  const liveStartedRef = useRef(0);
  useEffect(() => {
    if (!liveDictation) return;
    const subscription = liveDictation.addListener("onDictation", (event) => {
      if (!liveLifecycle.current.accepts(event.sessionId)) return;
      if (event.type === "partial" || event.type === "final") {
        const current = latestInputRef.current;
        const result = liveDraftRef.current?.update(
          current.ownerKey,
          current.draftMessage,
          event.text ?? "",
          event.type === "final" && !iosLiveDictation,
        );
        if (!result) {
          livePendingRef.current = false;
          liveLifecycle.current.cancel();
          liveDictation?.cancelDictation(liveRequestRef.current);
          setState(INITIAL_STATE);
          return;
        }
        // Keep the expected value current even before React commits the render.
        latestInputRef.current = { ...current, draftMessage: result.text };
        current.onChangeDraftMessage(result.text);
        current.onChangeSelection({ start: result.cursor, end: result.cursor });
      } else if (event.type === "level") {
        audioLevelsRef.current = [...audioLevelsRef.current.slice(1), event.level ?? 0];
        audioLevels.value = audioLevelsRef.current;
        setElapsedSeconds(Math.floor((Date.now() - liveStartedRef.current) / 1000));
      } else if (event.type === "error") {
        setState({
          phase: "error",
          error: event.message ?? "Speech recognition failed.",
          errorAction: "retry",
        });
      } else if (event.type === "end") {
        livePendingRef.current = false;
        liveLifecycle.current.cancel();
        setState((previous) => (previous.phase === "error" ? previous : INITIAL_STATE));
      } else if (event.type === "ready" && !liveStoppingRef.current) {
        setState({ phase: "recording", error: null, errorAction: null });
      }
    });
    return () => subscription.remove();
  }, [audioLevels]);
  useEffect(() => {
    setState(INITIAL_STATE);
    return () => {
      liveDictation?.cancelDictation(liveRequestRef.current);
      liveRequestRef.current = 0;
      livePendingRef.current = false;
      liveLifecycle.current.cancel();
    };
  }, [input.ownerKey]);

  const handleRecorderStatus = useCallback((status: RecordingStatus) => {
    controllerRef.current?.handleRecorderStatus({
      isFinished: status.isFinished,
      hasError: status.hasError || status.mediaServicesDidReset === true,
      error: status.error,
      url: status.url,
    });
  }, []);
  const recorder = useAudioRecorder(VOICE_RECORDING_OPTIONS, handleRecorderStatus);

  if (!controllerRef.current) {
    controllerRef.current = new VoiceInputController({
      recorder,
      getTranscriber: getLocalVoiceTranscriber,
      requestPermission: async () => {
        const permission = await requestRecordingPermissionsAsync();
        return { granted: permission.granted, canAskAgain: permission.canAskAgain };
      },
      configureRecording: configureVoiceRecordingAudio,
      releaseRecording: releaseVoiceRecordingAudio,
      deleteRecording: (uri) => new File(uri).delete(),
      readDraft: (): VoiceDraftSnapshot | null => {
        const current = latestInputRef.current;
        if (!current.ownerKey) return null;
        return {
          ownerKey: current.ownerKey,
          text: current.draftMessage,
          selection: current.selection,
          revision: revisionRef.current,
        };
      },
      commitDraft: (text, selection) => {
        const current = latestInputRef.current;
        current.onChangeSelection(selection);
        current.onChangeDraftMessage(text);
      },
      onStateChange: setState,
    });
  }

  const controller = controllerRef.current;
  const previousOwnerRef = useRef(input.ownerKey);
  useEffect(() => {
    if (previousOwnerRef.current === input.ownerKey) return;
    previousOwnerRef.current = input.ownerKey;
    controller.ownerChanged();
  }, [controller, input.ownerKey]);

  useFocusEffect(
    useCallback(
      () => () => {
        liveDictation?.cancelDictation(liveRequestRef.current);
        liveRequestRef.current = 0;
        livePendingRef.current = false;
        liveLifecycle.current.cancel();
        controller.dispose();
      },
      [controller],
    ),
  );

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      // iOS reports `inactive` while its permission dialog is open. Only the
      // real background state cancels preparation; recorder status handles
      // calls and route interruptions during capture.
      if (nextState === "background") {
        controller.appMovedToBackground();
        if (livePendingRef.current) {
          livePendingRef.current = false;
          liveLifecycle.current.cancel();
          liveDictation?.cancelDictation(liveRequestRef.current);
          liveRequestRef.current = 0;
          setState(INITIAL_STATE);
        }
      }
    });
    return () => subscription.remove();
  }, [controller]);

  useEffect(() => () => controller.dispose(), [controller]);

  useEffect(() => {
    if (state.phase !== "recording") return;

    const tag = `voice-input:${keepAwakeId}:${++keepAwakeSessionRef.current}`;
    const activation = activateKeepAwakeAsync(tag);
    void activation.catch(() => {});
    return () => {
      // Release after activation settles, even if the recording ends immediately.
      void activation.then(() => deactivateKeepAwake(tag)).catch(() => {});
    };
  }, [keepAwakeId, state.phase]);

  useEffect(() => {
    if (state.phase !== "preparing" && state.phase !== "recording") return;

    if (audioLevelsRef.current.some((level) => level !== 0)) {
      audioLevelsRef.current = Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0);
      audioLevels.value = audioLevelsRef.current;
    }
    if (elapsedSecondsRef.current !== 0) {
      elapsedSecondsRef.current = 0;
      setElapsedSeconds(0);
    }
    if (state.phase !== "recording") return;

    const sampleRecording = () => {
      if (controller.currentState.phase !== "recording") return;
      const status = recorder.getStatus();
      if (!status.isRecording) return;

      const level = normalizeVoiceInputDecibels(status.metering);
      const history = audioLevelsRef.current;
      if (level !== 0 || history.some((sample) => sample !== 0)) {
        const nextLevels = [...history.slice(1), level];
        audioLevelsRef.current = nextLevels;
        audioLevels.value = nextLevels;
      }

      const nextElapsedSeconds = Math.min(
        VOICE_RECORDING_LIMIT_SECONDS,
        Math.max(0, Math.floor(status.durationMillis / 1_000)),
      );
      if (nextElapsedSeconds !== elapsedSecondsRef.current) {
        elapsedSecondsRef.current = nextElapsedSeconds;
        setElapsedSeconds(nextElapsedSeconds);
      }
    };

    sampleRecording();
    const intervalId = setInterval(sampleRecording, VOICE_METERING_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [audioLevels, controller, recorder, state.phase]);

  const start = useCallback(() => {
    if (latestInputRef.current.disabled || !latestInputRef.current.ownerKey) return;
    if (!liveDictation || iosFallbackRef.current) {
      void controller.start();
      return;
    }
    if (livePendingRef.current) return;
    livePendingRef.current = true;
    liveStoppingRef.current = false;
    const snapshot = latestInputRef.current;
    const request = iosLiveDictation
      ? nextIOSLiveDictationSession()
      : nextAndroidDictationSession();
    liveRequestRef.current = request;
    liveLifecycle.current.begin(request);
    liveStartedRef.current = Date.now();
    liveDraftRef.current = new AndroidDictationDraft(
      snapshot.ownerKey!,
      snapshot.draftMessage,
      snapshot.selection.start,
      snapshot.selection.end,
    );
    setElapsedSeconds(0);
    setState({ phase: "preparing", error: null, errorAction: null });
    void requestRecordingPermissionsAsync()
      .then(async (permission) => {
        if (request !== liveRequestRef.current || !livePendingRef.current) return;
        if (!permission.granted)
          throw new Error("Microphone permission is required for dictation.");
        if (liveStoppingRef.current) {
          livePendingRef.current = false;
          liveLifecycle.current.cancel();
          setState(INITIAL_STATE);
          return;
        }
        await liveDictation?.startDictation(request);
      })
      .catch((error: unknown) => {
        if (request !== liveRequestRef.current) return;
        livePendingRef.current = false;
        liveLifecycle.current.cancel();
        if (liveStoppingRef.current) {
          setState(INITIAL_STATE);
          return;
        }
        const code = (error as { code?: string } | null)?.code;
        if (
          iosLiveDictation &&
          code === "ERR_SPEECH_UNAVAILABLE" &&
          !liveStoppingRef.current &&
          latestInputRef.current.ownerKey === snapshot.ownerKey &&
          latestInputRef.current.draftMessage === snapshot.draftMessage
        ) {
          iosFallbackRef.current = true;
          void controller.start();
          return;
        }
        setState({ phase: "error", error: String(error), errorAction: "retry" });
      });
  }, [controller]);
  const stop = useCallback(() => {
    if (livePendingRef.current) {
      liveStoppingRef.current = true;
      setState({ phase: "transcribing", error: null, errorAction: null });
      liveDictation?.stopDictation(liveRequestRef.current);
    } else controller.stop();
  }, [controller]);
  const cancel = useCallback(() => {
    liveDictation?.cancelDictation(liveRequestRef.current);
    liveRequestRef.current = 0;
    livePendingRef.current = false;
    liveLifecycle.current.cancel();
    controller.cancel();
    setState(INITIAL_STATE);
  }, [controller]);

  return {
    // Store screenshots show the dictation button even on simulators, whose
    // on-device transcription is unavailable.
    isAvailable:
      liveDictation !== null ||
      getLocalVoiceTranscriber() !== null ||
      getNativeShowcaseScene() !== null,
    state,
    audioLevels,
    elapsedSeconds,
    isBusy: voiceInputBlocksSubmission(state),
    freezesEditor:
      liveDictation && !iosFallbackRef.current ? false : voiceInputFreezesEditor(state),
    blocksSubmission: voiceInputBlocksSubmission(state),
    start,
    stop,
    cancel,
  };
}
