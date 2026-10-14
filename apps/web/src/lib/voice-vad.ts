/**
 * Browser-local VAD configuration (VOICE_CONTROLL.md section 10).
 *
 * Data-only module: the capture hook dynamically imports the pinned
 * `@ricky0123/vad-web` detector only after explicit Dictate activation and
 * passes these options. Both asset paths are explicitly same-origin
 * (`/voice-vad/`, prepared by `scripts/voice-vad-assets.ts`); library defaults
 * and example CDN URLs are never used.
 */

/** Speech pause that ends dictation automatically (documented milliseconds option). */
export const END_OF_DICTATION_SILENCE_MS = 2_000;
/** V5 processes 512 samples at 16 kHz: a 2,000 ms threshold completes ≈2,016 ms. */
export const VOICE_VAD_FRAME_MS = 32;
export const VOICE_VAD_ASSET_PATH = "/voice-vad/";
export const VOICE_VAD_MODEL = "v5";

export interface VoiceVadOptions {
  readonly model: "v5";
  readonly positiveSpeechThreshold: number;
  readonly negativeSpeechThreshold: number;
  readonly redemptionMs: number;
  readonly minSpeechMs: number;
  readonly preSpeechPadMs: number;
  readonly submitUserSpeechOnPause: false;
  readonly startOnLoad: false;
  readonly processorType: "AudioWorklet";
  readonly baseAssetPath: string;
  readonly onnxWASMBasePath: string;
}

/**
 * Initial detector settings from section 10. `redemptionMs` is the documented
 * millisecond silence threshold (never a frame count); the two probability
 * thresholds provide hysteresis. CPU/WASM with one thread and no proxy worker
 * is the compatibility baseline and is configured by the caller.
 */
export const VOICE_VAD_OPTIONS: VoiceVadOptions = {
  model: "v5",
  positiveSpeechThreshold: 0.3,
  negativeSpeechThreshold: 0.25,
  redemptionMs: END_OF_DICTATION_SILENCE_MS,
  minSpeechMs: 100,
  preSpeechPadMs: 300,
  submitUserSpeechOnPause: false,
  startOnLoad: false,
  processorType: "AudioWorklet",
  baseAssetPath: VOICE_VAD_ASSET_PATH,
  onnxWASMBasePath: VOICE_VAD_ASSET_PATH,
};
