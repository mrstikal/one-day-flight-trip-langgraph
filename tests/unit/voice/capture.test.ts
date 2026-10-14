import { describe, expect, it, vi } from "vitest";
import {
  createCaptureController,
  pickRecorderMimeType,
  VOICE_CAPTURE_MAX_BYTES,
  type AudioContextLike,
  type CaptureControllerPorts,
  type MediaStreamLike,
  type RecorderLike,
  type VadCallbacks,
  type VadLike,
} from "../../../apps/web/src/lib/voice-capture.js";
import { VOICE_COPY, type VoicePhase } from "../../../apps/web/src/lib/voice-state.js";

/**
 * Mocked-browser tests for the capture pipeline (VOICE_CONTROLL.md section 15,
 * gate V05): exactly one transcription per finished capture, no early stop
 * before confirmed speech, cancellation discarding without STT, stale-callback
 * isolation, and complete recorder/stream/VAD/context cleanup — all without a
 * DOM test stack.
 */

interface FakeEnvironment {
  readonly ports: CaptureControllerPorts;
  readonly phases: VoicePhase[];
  readonly errors: string[];
  readonly transcripts: string[];
  readonly vadCallbacks: VadCallbacks[];
  readonly stream: { readonly tracks: Array<{ stop: () => void; stopped: () => boolean }> };
  recorderStops(): number;
  recorderCount(): number;
  acquireCount(): number;
  transcribeCount(): number;
  vadPaused(): number;
  vadDestroyed(): number;
  vadDestroyAttempts(): number;
  contextClosed(): number;
  timerHandler(): (() => void) | null;
  fireTimer(): void;
  emitChunk(size?: number): void;
  resolveAcquire(): void;
  rejectAcquire(name: string): void;
  releaseTranscription(text?: string): void;
  readonly transcribeCalls: Array<{ requestId: string; aborted: () => boolean }>;
  destroyVadFailure?: boolean;
  vadUnavailable: boolean;
}

function createEnvironment(): FakeEnvironment {
  const phases: VoicePhase[] = [];
  const errors: string[] = [];
  const transcripts: string[] = [];
  const vadCallbacks: VadCallbacks[] = [];
  const transcribeCalls: Array<{ requestId: string; aborted: () => boolean }> = [];
  const tracks: Array<{ stop: () => void; stopped: () => boolean }> = [];
  let recorderStops = 0;
  let recorderStartCount = 0;
  let acquires = 0;
  let vadPauseCount = 0;
  let vadDestroyCount = 0;
  let vadDestroyAttempts = 0;
  let contextCloseCount = 0;
  let timerHandler: (() => void) | null = null;
  let pendingTranscription: {
    resolve: (result: { text: string }) => void;
    reject: (error: unknown) => void;
  } | null = null;
  let pendingAcquire: {
    resolve: (stream: MediaStreamLike) => void;
    reject: (error: unknown) => void;
  } | null = null;

  const makeTrack = () => {
    let stopped = false;
    return {
      stop: () => {
        stopped = true;
      },
      stopped: () => stopped,
    };
  };

  const makeStream = (): MediaStreamLike => {
    const localTracks = [makeTrack(), makeTrack()];
    tracks.push(...localTracks);
    return { getTracks: () => localTracks };
  };

  const env: FakeEnvironment = {
    phases,
    errors,
    transcripts,
    vadCallbacks,
    stream: { tracks },
    destroyVadFailure: false,
    vadUnavailable: false,
    ports: {
      acquireStream: () => {
        acquires += 1;
        return new Promise<MediaStreamLike>((resolve, reject) => {
          pendingAcquire = { resolve, reject };
        });
      },
      createRecorder: (): RecorderLike => {
        recorderStartCount += 1;
        let state: RecorderLike["state"] = "inactive";
        const recorder: RecorderLike & { emit: (size: number) => void } = {
          get state() {
            return state;
          },
          mimeType: "audio/webm",
          ondataavailable: null,
          onstop: null,
          onerror: null,
          start() {
            state = "recording";
          },
          stop() {
            if (state === "inactive") {
              return;
            }
            recorderStops += 1;
            state = "inactive";
            const onstop = recorder.onstop;
            queueMicrotask(() => onstop?.());
          },
          emit: (size: number) => {
            recorder.ondataavailable?.({ data: { size } as Blob });
          },
        };
        return recorder;
      },
      createContext: (): AudioContextLike => ({
        close: async () => {
          contextCloseCount += 1;
        },
      }),
      loadVad: async (_context, _stream, callbacks) => {
        vadCallbacks.push(callbacks);
        const vad: VadLike = {
          start: async () => {},
          pause: async () => {
            vadPauseCount += 1;
          },
          destroy: async () => {
            vadDestroyAttempts += 1;
            if (env.destroyVadFailure) {
              throw new Error("destroy before init");
            }
            vadDestroyCount += 1;
          },
        };
        return vad;
      },
      normalize: async () => new Uint8Array([1, 2, 3, 4]),
      transcribe: (input) =>
        new Promise<{ text: string }>((resolve, reject) => {
          transcribeCalls.push({
            requestId: input.requestId,
            aborted: () => input.signal.aborted,
          });
          input.signal.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
          pendingTranscription = { resolve, reject };
        }),
      describeError: (error) =>
        error instanceof Error && error.message === "TOO_LONG" ? VOICE_COPY.maxDuration : "boom",
      randomId: () => `request-${String(transcribeCalls.length + 1)}`,
      setTimer: (handler) => {
        timerHandler = handler;
        return setTimeout(() => {}, 0);
      },
      clearTimer: (timer) => clearTimeout(timer),
      isAbort: (error) => error instanceof DOMException && error.name === "AbortError",
      callbacks: {
        onPhase: (phase) => phases.push(phase),
        onConfirmedSpeech: () => {},
        onVadUnavailable: () => {
          env.vadUnavailable = true;
        },
        onError: (message) => errors.push(message),
        onTranscript: (text) => transcripts.push(text),
      },
    },
    recorderStops: () => recorderStops,
    recorderCount: () => recorderStartCount,
    acquireCount: () => acquires,
    transcribeCount: () => transcribeCalls.length,
    vadPaused: () => vadPauseCount,
    vadDestroyed: () => vadDestroyCount,
    vadDestroyAttempts: () => vadDestroyAttempts,
    contextClosed: () => contextCloseCount,
    timerHandler: () => timerHandler,
    fireTimer: () => timerHandler?.(),
    emitChunk: (size = 10) => {
      const recorder = recorderWithEmit();
      recorder?.emit(size);
    },
    resolveAcquire: () => {
      const pending = pendingAcquire;
      pendingAcquire = null;
      pending?.resolve(makeStream());
    },
    rejectAcquire: (name: string) => {
      const pending = pendingAcquire;
      pendingAcquire = null;
      pending?.reject(new DOMException("nope", name));
    },
    releaseTranscription: (text = "hello") => {
      const pending = pendingTranscription;
      pendingTranscription = null;
      pending?.resolve({ text });
    },
    transcribeCalls,
  };
  let lastRecorder: RecorderLike | null = null;
  const originalCreateRecorder = env.ports.createRecorder;
  (env.ports as { createRecorder: CaptureControllerPorts["createRecorder"] }).createRecorder = (
    stream,
  ) => {
    lastRecorder = originalCreateRecorder(stream);
    return lastRecorder;
  };
  function recorderWithEmit(): { emit: (size: number) => void } | null {
    return lastRecorder as unknown as { emit: (size: number) => void } | null;
  }
  return env;
}

async function started(env: FakeEnvironment) {
  const controllers = env.vadCallbacks.length;
  const controller = createCaptureController(env.ports);
  controller.start();
  env.resolveAcquire();
  await vi.waitFor(() => expect(env.phases).toContain("recording"));
  await vi.waitFor(() => expect(env.vadCallbacks).toHaveLength(controllers + 1));
  return controller;
}

describe("pickRecorderMimeType", () => {
  it("prefers opus webm and falls back in order, or null", () => {
    expect(pickRecorderMimeType(() => true)).toBe("audio/webm;codecs=opus");
    expect(pickRecorderMimeType((type) => type === "audio/webm")).toBe("audio/webm");
    expect(pickRecorderMimeType((type) => type === "audio/mp4")).toBe("audio/mp4");
    expect(pickRecorderMimeType(() => false)).toBeNull();
  });
});

describe("capture controller (mocked browser)", () => {
  it("finalizes silence exactly once: one stream, one transcription, full cleanup", async () => {
    const env = createEnvironment();
    const controller = await started(env);
    env.emitChunk();
    env.vadCallbacks[0]?.onSpeechRealStart();
    env.vadCallbacks[0]?.onSpeechEnd();
    await vi.waitFor(() => expect(env.transcribeCount()).toBe(1));
    env.releaseTranscription("dictated words");
    await vi.waitFor(() => expect(env.transcripts).toEqual(["dictated words"]));

    expect(env.acquireCount()).toBe(1);
    expect(env.recorderCount()).toBe(1);
    expect(env.recorderStops()).toBe(1);
    expect(env.vadPaused()).toBe(1);
    expect(env.vadDestroyed()).toBe(1);
    expect(env.contextClosed()).toBe(1);
    expect(env.stream.tracks.every((track) => track.stopped())).toBe(true);
    expect(env.errors).toEqual([]);
    expect(env.phases.at(-1)).toBe("idle");

    // Every repeated stop path is a no-op for this finished generation.
    controller.stopManual();
    env.vadCallbacks[0]?.onSpeechEnd();
    env.fireTimer();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(env.transcribeCount()).toBe(1);
    expect(env.recorderStops()).toBe(1);
  });

  it("does not stop on initial silence and misfires keep the recording", async () => {
    const env = createEnvironment();
    await started(env);
    // Unconfirmed speech end and misfires are inert: the recording continues.
    env.vadCallbacks[0]?.onSpeechEnd();
    env.vadCallbacks[0]?.onSpeechEnd();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(env.transcribeCount()).toBe(0);
    expect(env.phases).not.toContain("stopping");
    expect(env.recorderStops()).toBe(0);
  });

  it("manual stop still transcribes a short utterance (VAD false negative)", async () => {
    const env = createEnvironment();
    const controller = await started(env);
    env.emitChunk();
    controller.stopManual();
    await vi.waitFor(() => expect(env.transcribeCount()).toBe(1));
    env.releaseTranscription("short");
    await vi.waitFor(() => expect(env.transcripts).toEqual(["short"]));
  });

  it("duration limit without speech discards with zero STT and the no-speech copy", async () => {
    const env = createEnvironment();
    await started(env);
    env.emitChunk();
    env.fireTimer();
    await vi.waitFor(() => expect(env.phases.at(-1)).toBe("idle"));
    expect(env.transcribeCount()).toBe(0);
    expect(env.errors).toEqual([VOICE_COPY.noSpeech]);
    expect(env.vadDestroyed()).toBe(1);
    expect(env.stream.tracks.every((track) => track.stopped())).toBe(true);
  });

  it("duration limit with confirmed speech finalizes once", async () => {
    const env = createEnvironment();
    await started(env);
    env.emitChunk();
    env.vadCallbacks[0]?.onSpeechRealStart();
    env.fireTimer();
    await vi.waitFor(() => expect(env.transcribeCount()).toBe(1));
    env.releaseTranscription("long but valid");
    await vi.waitFor(() => expect(env.transcripts).toEqual(["long but valid"]));
  });

  it("cancel aborts the in-flight upload, discards, and releases resources", async () => {
    const env = createEnvironment();
    const controller = await started(env);
    env.emitChunk();
    env.vadCallbacks[0]?.onSpeechRealStart();
    env.vadCallbacks[0]?.onSpeechEnd();
    await vi.waitFor(() => expect(env.transcribeCount()).toBe(1));
    controller.cancel();
    await vi.waitFor(() => expect(env.phases.at(-1)).toBe("idle"));
    expect(env.transcribeCalls[0]?.aborted()).toBe(true);
    expect(env.transcripts).toEqual([]);
    // A deliberate cancellation is not a failure of the travel task.
    expect(env.errors).toEqual([]);
    expect(env.stream.tracks.every((track) => track.stopped())).toBe(true);
    expect(env.vadDestroyed()).toBe(1);
  });

  it("a late transcription result after cancel never inserts", async () => {
    const env = createEnvironment();
    const controller = await started(env);
    env.emitChunk();
    env.vadCallbacks[0]?.onSpeechRealStart();
    env.vadCallbacks[0]?.onSpeechEnd();
    await vi.waitFor(() => expect(env.transcribeCount()).toBe(1));
    controller.cancel();
    env.releaseTranscription("too late");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(env.transcripts).toEqual([]);
  });

  it("stale VAD callbacks cannot stop a new capture", async () => {
    const env = createEnvironment();
    const first = await started(env);
    const staleCallbacks = env.vadCallbacks[0];
    const staleGeneration = env.vadCallbacks.length;
    first.cancel();
    await vi.waitFor(() => expect(env.phases.at(-1)).toBe("idle"));

    const controller = await started(env);
    expect(env.vadCallbacks).toHaveLength(staleGeneration + 1);
    // Old-generation callbacks are inert for the new session.
    staleCallbacks?.onSpeechEnd();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(env.transcribeCount()).toBe(0);
    // The new session still works normally.
    env.vadCallbacks[1]?.onSpeechRealStart();
    env.vadCallbacks[1]?.onSpeechEnd();
    await vi.waitFor(() => expect(env.transcribeCount()).toBe(1));
    env.releaseTranscription("second");
    await vi.waitFor(() => expect(env.transcripts).toEqual(["second"]));
    controller.cancel();
  });

  it("VAD initialization failure keeps manual dictation available", async () => {
    const env = createEnvironment();
    (env.ports as { loadVad: CaptureControllerPorts["loadVad"] }).loadVad = async () => {
      throw new Error("worklet unavailable");
    };
    const controller = createCaptureController(env.ports);
    controller.start();
    env.resolveAcquire();
    await vi.waitFor(() => expect(env.phases).toContain("recording"));
    await vi.waitFor(() => expect(env.vadUnavailable).toBe(true));
    env.emitChunk();
    controller.stopManual();
    await vi.waitFor(() => expect(env.transcribeCount()).toBe(1));
    env.releaseTranscription("manual");
    await vi.waitFor(() => expect(env.transcripts).toEqual(["manual"]));
  });

  it("cancelling while the permission prompt is pending stops the late stream", async () => {
    const env = createEnvironment();
    const controller = createCaptureController(env.ports);
    controller.start();
    await vi.waitFor(() => expect(env.phases).toContain("preparing"));
    controller.cancel();
    env.resolveAcquire();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(env.recorderCount()).toBe(0);
    expect(env.stream.tracks.every((track) => track.stopped())).toBe(true);
    expect(env.transcribeCount()).toBe(0);
  });

  it("maps permission failures to the copy and releases partial state", async () => {
    const env = createEnvironment();
    const controller = createCaptureController(env.ports);
    controller.start();
    await vi.waitFor(() => expect(env.phases).toContain("preparing"));
    env.rejectAcquire("NotAllowedError");
    await vi.waitFor(() => expect(env.phases.at(-1)).toBe("idle"));
    expect(env.errors).toEqual([VOICE_COPY.permissionDenied]);
    expect(env.recorderCount()).toBe(0);
  });

  it("stops over-cap recordings before they can be transcribed", async () => {
    const env = createEnvironment();
    await started(env);
    env.emitChunk(VOICE_CAPTURE_MAX_BYTES + 1);
    await vi.waitFor(() => expect(env.phases.at(-1)).toBe("idle"));
    expect(env.transcribeCount()).toBe(0);
    expect(env.errors[0]).toContain("too large");
    expect(env.stream.tracks.every((track) => track.stopped())).toBe(true);
  });

  it("attempts VAD disposal even when destroy throws and still releases the rest", async () => {
    const env = createEnvironment();
    env.destroyVadFailure = true;
    const controller = await started(env);
    controller.cancel();
    await vi.waitFor(() => expect(env.vadPaused()).toBe(1));
    await vi.waitFor(() => expect(env.vadDestroyAttempts()).toBe(1));
    await vi.waitFor(() => expect(env.phases.at(-1)).toBe("idle"));
    // A failed early destroy is attempted (never claimed as success) and the
    // remaining resources are still released.
    expect(env.stream.tracks.every((track) => track.stopped())).toBe(true);
    expect(env.contextClosed()).toBe(1);
    expect(env.errors).toEqual([]);
  });
});
