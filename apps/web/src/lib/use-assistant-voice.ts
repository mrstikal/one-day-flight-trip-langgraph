"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ApiError } from "./api-client";
import {
  downmixToMono,
  encodePcmWav,
  VOICE_WAV_MAX_SAMPLES,
  VOICE_WAV_SAMPLE_RATE,
} from "./voice-audio";
import {
  createCaptureController,
  pickRecorderMimeType,
  type AudioContextLike,
  type CaptureController,
  type MediaStreamLike,
  type RecorderLike,
} from "./voice-capture";
import { fetchSynthesizedReply, submitTranscription } from "./voice-client";
import {
  anchorReplyRefresh,
  canPlayReply,
  clearInFlightReply,
  initialReplySelection,
  initializeReplyBaseline,
  markReplyProcessed,
  playbackBufferReady,
  playbackComplete,
  playbackDiscard,
  playbackPrepare,
  playbackStart,
  playbackStop,
  registerReplyRefresh,
  replyRefreshActive,
  resetReplyBaseline,
  selectReplyCandidate,
  stopReplyRefresh,
  VOICE_CAPTURE_LIMIT_MS,
  VOICE_COPY,
  VOICE_REPLY_REFRESH_INTERVAL_MS,
  type PlaybackState,
  type ReplyRefreshState,
  type ReplySelectionState,
  type VoiceOperationStatus,
  type VoicePhase,
  type VoiceReplyMessage,
} from "./voice-state";
import {
  applyVadOrtBaseline,
  VOICE_VAD_OPTIONS,
  type VadOrtLike,
  type VoiceVadOptions,
} from "./voice-vad";

/** vad-web options plus the browser ports this hook supplies. */
interface VadOptionsLike extends VoiceVadOptions {
  readonly audioContext: AudioContext;
  readonly getStream: () => Promise<MediaStream>;
  readonly resumeStream: () => Promise<MediaStream>;
  readonly pauseStream: () => Promise<void>;
  readonly ortConfig: (ort: VadOrtLike) => void;
  readonly onSpeechRealStart: () => void;
  readonly onVADMisfire: () => void;
  readonly onSpeechEnd: () => void;
}

/**
 * Assistant voice hook (VOICE_CONTROLL.md sections 10 and 11).
 *
 * Browser glue only: the capture pipeline lives in `voice-capture.ts` behind
 * injected ports, all pure decisions in `voice-state.ts`/`voice-vad.ts`. This
 * hook wires the real Web APIs, activates voice per explicit gesture, selects
 * settled replies from message DTOs (never DOM scraping), plays one source at
 * a time, and runs the bounded post-completion reply refresh.
 */

export { VOICE_COPY, VOICE_CAPTURE_LIMIT_MS };

const TOO_LONG_SENTINEL = "VOICE_CAPTURE_TOO_LONG";

export interface UseAssistantVoiceOptions {
  readonly tripId: string;
  readonly messages: readonly VoiceReplyMessage[];
  readonly operations: readonly VoiceOperationStatus[];
  /** True once a projection belonging to the CURRENT trip is loaded. */
  readonly projectionLoaded: boolean;
  readonly refreshProjection: () => void;
  /** Insert a finished transcript into the owned composer (rail callback). */
  readonly onTranscript: (transcript: string) => void;
}

export interface AssistantVoice {
  readonly supported: boolean;
  readonly activated: boolean;
  readonly repliesEnabled: boolean;
  /** Recording/stopping/normalizing/transcribing — Send must stay disabled. */
  readonly busy: boolean;
  readonly phase: VoicePhase;
  readonly hasConfirmedSpeech: boolean;
  readonly vadUnavailable: boolean;
  readonly statusMessage: string | null;
  readonly error: string | null;
  readonly notice: string | null;
  readonly offerPlayReply: boolean;
  readonly dictate: () => void;
  readonly stopRecording: () => void;
  readonly cancelDictation: () => void;
  readonly setRepliesEnabled: (enabled: boolean) => void;
  readonly stopSpeaking: () => void;
  readonly playReply: () => void;
  readonly registerSentOperation: (operationId: string) => void;
}

/** One shared playback context for the tab (never closed by capture cleanup). */
let sharedPlaybackContext: AudioContext | null = null;

function playbackContext(): AudioContext {
  sharedPlaybackContext ??= new AudioContext();
  return sharedPlaybackContext;
}

function detectVoiceSupport(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof MediaRecorder !== "undefined" &&
    typeof AudioContext !== "undefined" &&
    typeof OfflineAudioContext !== "undefined"
  );
}

const subscribeNoop = (): (() => void) => () => {};

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function describeVoiceError(error: unknown): string {
  if (error instanceof Error && error.message === TOO_LONG_SENTINEL) {
    return VOICE_COPY.maxDuration;
  }
  if (error instanceof ApiError) {
    switch (error.code) {
      case "VOICE_DISABLED":
        return VOICE_COPY.voiceDisabled;
      case "VOICE_NO_SPEECH":
        return VOICE_COPY.noSpeech;
      default:
        return error.message;
    }
  }
  return "The voice request failed. Try again or type your request.";
}

export function useAssistantVoice(options: UseAssistantVoiceOptions): AssistantVoice {
  const { tripId, messages, operations, projectionLoaded, refreshProjection, onTranscript } =
    options;

  // Client-only support detection without a hydration mismatch: the server
  // snapshot is `false`, the client snapshot is computed once.
  const supported = useSyncExternalStore(subscribeNoop, detectVoiceSupport, () => false);

  const [activated, setActivated] = useState(false);
  const [repliesEnabled, setRepliesEnabledState] = useState(false);
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [hasConfirmedSpeech, setHasConfirmedSpeech] = useState(false);
  const [vadUnavailable, setVadUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [playback, setPlayback] = useState<PlaybackState>(playbackDiscard());

  const mountedRef = useRef(true);
  const activatedRef = useRef(false);
  const repliesEnabledRef = useRef(false);
  const tripIdRef = useRef(tripId);
  const phaseRef = useRef<VoicePhase>("idle");
  const controllerRef = useRef<CaptureController | null>(null);
  const selectionRef = useRef<ReplySelectionState>(initialReplySelection());
  const refreshRef = useRef<ReplyRefreshState>({ operationId: null, deadlineAt: null });
  const pendingBaselineRef = useRef(false);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const bufferRef = useRef<AudioBuffer | null>(null);
  const ttsAbortRef = useRef<AbortController | null>(null);
  const replyGenerationRef = useRef(0);

  const setPhaseSafe = useCallback((next: VoicePhase) => {
    phaseRef.current = next;
    if (mountedRef.current) {
      setPhase(next);
    }
  }, []);

  useEffect(() => {
    tripIdRef.current = tripId;
  }, [tripId]);

  const onTranscriptRef = useRef(onTranscript);
  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  /** Real-API ports for the capture controller (stable for the hook's life). */
  const ports = useMemo(
    () => ({
      acquireStream: () => navigator.mediaDevices.getUserMedia({ audio: true }),
      createRecorder: (stream: MediaStreamLike): RecorderLike => {
        const mime = pickRecorderMimeType((type) => MediaRecorder.isTypeSupported(type));
        return new MediaRecorder(
          stream as MediaStream,
          mime ? { mimeType: mime } : undefined,
        ) as unknown as RecorderLike;
      },
      createContext: () => new AudioContext(),
      loadVad: async (
        context: AudioContextLike,
        stream: MediaStreamLike,
        callbacks: { onSpeechRealStart: () => void; onSpeechEnd: () => void },
      ) => {
        const { MicVAD } = await import("@ricky0123/vad-web");
        const realContext = context as AudioContext;
        const realStream = stream as MediaStream;
        const vadOptions: VadOptionsLike = {
          ...VOICE_VAD_OPTIONS,
          audioContext: realContext,
          getStream: async () => realStream,
          resumeStream: async () => realStream,
          pauseStream: async () => {
            // Owned by MediaRecorder/this hook: never stop the shared stream.
          },
          ortConfig: applyVadOrtBaseline,
          onSpeechRealStart: callbacks.onSpeechRealStart,
          onVADMisfire: () => {
            // Insufficient short segment: keep listening.
          },
          onSpeechEnd: callbacks.onSpeechEnd,
        };
        return MicVAD.new(vadOptions as Parameters<typeof MicVAD.new>[0]);
      },
      normalize: async (blob: Blob, context: AudioContextLike): Promise<Uint8Array> => {
        const samples = await normalizeTo16kMono(blob, context as AudioContext);
        if (samples.length > VOICE_WAV_MAX_SAMPLES) {
          throw new Error(TOO_LONG_SENTINEL);
        }
        return encodePcmWav(samples);
      },
      transcribe: async (input: { audio: Uint8Array; requestId: string; signal: AbortSignal }) =>
        submitTranscription({
          tripId: tripIdRef.current,
          requestId: input.requestId,
          audio: input.audio,
          signal: input.signal,
        }),
      describeError: describeVoiceError,
      randomId: () => crypto.randomUUID(),
      setTimer: (handler: () => void, ms: number) => setTimeout(handler, ms),
      clearTimer: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
      isAbort: isAbortError,
      callbacks: {
        onPhase: (next: VoicePhase) => setPhaseSafe(next),
        onConfirmedSpeech: (confirmed: boolean) => {
          if (mountedRef.current) {
            setHasConfirmedSpeech(confirmed);
          }
        },
        onVadUnavailable: () => {
          if (mountedRef.current) {
            setVadUnavailable(true);
          }
        },
        onError: (message: string) => {
          if (mountedRef.current) {
            setError(message);
          }
        },
        onTranscript: (text: string) => {
          if (mountedRef.current) {
            onTranscriptRef.current(text);
          }
        },
      },
    }),
    [setPhaseSafe],
  );

  const controller = useCallback((): CaptureController => {
    controllerRef.current ??= createCaptureController(ports);
    return controllerRef.current;
  }, [ports]);

  const stopSource = useCallback((): void => {
    const source = sourceRef.current;
    sourceRef.current = null;
    if (source) {
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
      source.disconnect();
    }
    setPlayback((state) => playbackStop(state));
  }, []);

  const stopSpeaking = useCallback((): void => {
    // Only speech generation/playback is stopped; STT uploads are not aborted.
    ttsAbortRef.current?.abort();
    ttsAbortRef.current = null;
    replyGenerationRef.current += 1;
    stopSource();
    if (phaseRef.current === "tts-preparing") {
      setPhaseSafe("idle");
    }
  }, [setPhaseSafe, stopSource]);

  const dictate = useCallback((): void => {
    const captureBusy =
      phaseRef.current === "preparing" ||
      phaseRef.current === "recording" ||
      phaseRef.current === "stopping" ||
      phaseRef.current === "transcribing";
    if (!supported || captureBusy) {
      return;
    }
    setError(null);
    setNotice(null);
    setVadUnavailable(false);
    // First explicit activation also enables spoken replies for this tab; a
    // later dictation must never silently re-enable replies the user turned off.
    if (!activatedRef.current) {
      activatedRef.current = true;
      setActivated(true);
      repliesEnabledRef.current = true;
      setRepliesEnabledState(true);
    }
    // Stop any previous speech before recording so the microphone never
    // records the assistant's own output (the generation bump discards late TTS).
    stopSpeaking();
    // Initialize/resume the playback context directly in this gesture too.
    void playbackContext()
      .resume()
      .catch(() => {});
    controller().start();
  }, [controller, stopSpeaking, supported]);

  const stopRecording = useCallback((): void => {
    controller().stopManual();
  }, [controller]);

  const cancelDictation = useCallback((): void => {
    void controller().cancel();
  }, [controller]);

  const setRepliesEnabled = useCallback(
    (enabled: boolean): void => {
      repliesEnabledRef.current = enabled;
      setRepliesEnabledState(enabled);
      if (enabled) {
        activatedRef.current = true;
        setActivated(true);
        setNotice(null);
        void playbackContext()
          .resume()
          .catch(() => {});
        if (projectionLoaded) {
          selectionRef.current = resetReplyBaseline(selectionRef.current, messages);
        } else {
          // Wait for the trip's own projection before baselining.
          pendingBaselineRef.current = true;
        }
      } else {
        stopSpeaking();
        selectionRef.current = clearInFlightReply(selectionRef.current);
        refreshRef.current = stopReplyRefresh();
        bufferRef.current = null;
        setPlayback(playbackDiscard());
      }
    },
    [messages, projectionLoaded, stopSpeaking],
  );

  const startSource = useCallback(
    (buffer: AudioBuffer, messageId: string, generation: number): void => {
      const context = playbackContext();
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = () => {
        if (generation === replyGenerationRef.current) {
          setPlayback((state) => playbackComplete(state, messageId));
        }
      };
      stopSource();
      setPlayback((state) => playbackStart(state, messageId));
      source.start();
    },
    [stopSource],
  );

  const speakBuffer = useCallback(
    async (audio: ArrayBuffer, messageId: string, generation: number): Promise<void> => {
      const context = playbackContext();
      if (context.state === "suspended") {
        await context.resume().catch(() => {});
      }
      let decoded: AudioBuffer;
      try {
        decoded = await context.decodeAudioData(audio.slice(0));
      } catch {
        if (generation === replyGenerationRef.current) {
          setError("The spoken reply could not be prepared. Try again or type your request.");
        }
        return;
      }
      if (
        generation !== replyGenerationRef.current ||
        !repliesEnabledRef.current ||
        !mountedRef.current
      ) {
        return;
      }
      bufferRef.current = decoded;
      setPlayback((state) => playbackBufferReady(state, messageId));
      if (context.state !== "running") {
        // Autoplay stayed blocked: the retained buffer enables Play reply.
        return;
      }
      startSource(decoded, messageId, generation);
    },
    [startSource],
  );

  const runSynthesis = useCallback(
    async (candidate: { messageId: string; operationId: string }): Promise<void> => {
      const generation = ++replyGenerationRef.current;
      setError(null);
      setPlayback((state) => playbackPrepare(state, candidate.messageId));
      setPhaseSafe("tts-preparing");
      const requestId = crypto.randomUUID();
      const controllerAbort = new AbortController();
      ttsAbortRef.current?.abort();
      ttsAbortRef.current = controllerAbort;
      try {
        const reply = await fetchSynthesizedReply({
          tripId: tripIdRef.current,
          requestId,
          messageId: candidate.messageId,
          signal: controllerAbort.signal,
        });
        if (
          generation !== replyGenerationRef.current ||
          !repliesEnabledRef.current ||
          !mountedRef.current
        ) {
          return;
        }
        selectionRef.current = markReplyProcessed(selectionRef.current, candidate.messageId);
        if (refreshRef.current.operationId === candidate.operationId) {
          refreshRef.current = stopReplyRefresh();
        }
        // A late reply also clears the earlier "not available yet" notice.
        setNotice(null);
        await speakBuffer(reply.audio, candidate.messageId, generation);
      } catch (caught) {
        selectionRef.current = markReplyProcessed(selectionRef.current, candidate.messageId);
        if (!isAbortError(caught) && generation === replyGenerationRef.current) {
          setError(describeVoiceError(caught));
        }
      } finally {
        if (ttsAbortRef.current === controllerAbort) {
          ttsAbortRef.current = null;
        }
        if (generation === replyGenerationRef.current && mountedRef.current) {
          setPhase((current) => (current === "tts-preparing" ? "idle" : current));
          phaseRef.current = phaseRef.current === "tts-preparing" ? "idle" : phaseRef.current;
        }
      }
    },
    [setPhaseSafe, speakBuffer],
  );

  const playReply = useCallback((): void => {
    const buffer = bufferRef.current;
    const messageId = playback.bufferMessageId;
    if (!buffer || !messageId || repliesEnabledRef.current === false) {
      return;
    }
    void playbackContext()
      .resume()
      .catch(() => {});
    startSource(buffer, messageId, replyGenerationRef.current);
  }, [playback.bufferMessageId, startSource]);

  const registerSentOperation = useCallback(
    (operationId: string): void => {
      refreshRef.current = registerReplyRefresh(refreshRef.current, operationId);
      // Sending a new instruction stops old speech (never records it either).
      stopSpeaking();
    },
    [stopSpeaking],
  );

  // Spoken-reply selection over projection updates.
  const wasEnabledRef = useRef(false);
  useEffect(() => {
    if (!repliesEnabled) {
      wasEnabledRef.current = false;
      return;
    }
    if (!projectionLoaded) {
      // Wait for a projection belonging to the CURRENT trip (section 11).
      return;
    }
    if (!wasEnabledRef.current || pendingBaselineRef.current) {
      wasEnabledRef.current = true;
      pendingBaselineRef.current = false;
      selectionRef.current = resetReplyBaseline(selectionRef.current, messages);
    } else {
      selectionRef.current = initializeReplyBaseline(selectionRef.current, messages);
    }
    const captureBusy =
      phase === "preparing" ||
      phase === "recording" ||
      phase === "stopping" ||
      phase === "transcribing";
    if (captureBusy) {
      // Never start playback while the microphone is recording.
      return;
    }
    const { state, candidate } = selectReplyCandidate(selectionRef.current, messages, operations);
    selectionRef.current = state;
    if (candidate) {
      void runSynthesis(candidate);
    }
  }, [messages, operations, phase, projectionLoaded, repliesEnabled, runSynthesis]);

  // Bounded post-completion refresh: anchored when the operation is first seen
  // settled, 1.5 s cadence, one 10 s window per operation.
  useEffect(() => {
    const interval = setInterval(() => {
      const tracker = refreshRef.current;
      if (tracker.operationId === null) {
        return;
      }
      const operation = operations.find((entry) => entry.operationId === tracker.operationId);
      const settled =
        operation !== undefined && operation.status !== "queued" && operation.status !== "running";
      if (tracker.deadlineAt === null) {
        if (!settled) {
          return;
        }
        refreshRef.current = anchorReplyRefresh(tracker, Date.now());
        refreshProjection();
        return;
      }
      const now = Date.now();
      if (replyRefreshActive(tracker, now)) {
        refreshProjection();
        return;
      }
      refreshRef.current = stopReplyRefresh();
      setNotice(VOICE_COPY.replyNotAvailable);
    }, VOICE_REPLY_REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [operations, refreshProjection]);

  // Trip change and unmount tear down capture, playback, selection, and pending work.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    return () => {
      void controllerRef.current?.cancel();
      controllerRef.current = null;
      ttsAbortRef.current?.abort();
      ttsAbortRef.current = null;
      replyGenerationRef.current += 1;
      refreshRef.current = stopReplyRefresh();
      pendingBaselineRef.current = false;
      selectionRef.current = initialReplySelection();
      wasEnabledRef.current = false;
      const source = sourceRef.current;
      sourceRef.current = null;
      if (source) {
        try {
          source.stop();
        } catch {
          // Ignore.
        }
        source.disconnect();
      }
      bufferRef.current = null;
    };
  }, [tripId]);

  // A trip change resets the per-trip voice state too.
  const previousTripRef = useRef(tripId);
  useEffect(() => {
    if (previousTripRef.current === tripId) {
      return;
    }
    previousTripRef.current = tripId;
    stopSpeaking();
    setPlayback(playbackDiscard());
    bufferRef.current = null;
    selectionRef.current = initialReplySelection();
    pendingBaselineRef.current = false;
    refreshRef.current = stopReplyRefresh();
    setNotice(null);
    setError(null);
  }, [stopSpeaking, tripId]);

  const busy =
    phase === "preparing" ||
    phase === "recording" ||
    phase === "stopping" ||
    phase === "transcribing";

  let statusMessage: string | null = null;
  if (phase === "preparing") {
    statusMessage = VOICE_COPY.preparing;
  } else if (phase === "recording") {
    statusMessage = vadUnavailable
      ? VOICE_COPY.vadUnavailable
      : hasConfirmedSpeech
        ? VOICE_COPY.recording
        : VOICE_COPY.listening;
  } else if (phase === "stopping") {
    statusMessage = VOICE_COPY.preparingRecording;
  } else if (phase === "transcribing") {
    statusMessage = VOICE_COPY.transcribing;
  } else if (phase === "tts-preparing") {
    statusMessage = VOICE_COPY.preparingReply;
  } else if (playback.phase === "playing") {
    statusMessage = VOICE_COPY.playing;
  }

  return {
    supported,
    activated,
    repliesEnabled,
    busy,
    phase,
    hasConfirmedSpeech,
    vadUnavailable,
    statusMessage,
    error,
    notice,
    offerPlayReply: canPlayReply(playback),
    dictate,
    stopRecording,
    cancelDictation,
    setRepliesEnabled,
    stopSpeaking,
    playReply,
    registerSentOperation,
  };
}

/**
 * Decode a raw recorder blob through the owned audio context and return mono
 * 16 kHz float samples (downmix + linear resample for non-16 kHz sources).
 */
async function normalizeTo16kMono(blob: Blob, context: BaseAudioContext): Promise<Float32Array> {
  const arrayBuffer = await blob.arrayBuffer();
  const decoded = await context.decodeAudioData(arrayBuffer.slice(0));
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
    channels.push(decoded.getChannelData(channel));
  }
  const mono = downmixToMono(channels);
  if (decoded.sampleRate === VOICE_WAV_SAMPLE_RATE) {
    return mono;
  }
  const targetLength = Math.max(
    1,
    Math.ceil((mono.length * VOICE_WAV_SAMPLE_RATE) / decoded.sampleRate),
  );
  const offline = new OfflineAudioContext(1, targetLength, VOICE_WAV_SAMPLE_RATE);
  const source = offline.createBufferSource();
  const buffer = offline.createBuffer(1, mono.length, decoded.sampleRate);
  // copyToChannel wants an ArrayBuffer-backed view; copy into a fresh one.
  buffer.copyToChannel(new Float32Array(mono), 0);
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}
