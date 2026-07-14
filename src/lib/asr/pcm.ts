/**
 * Downmix + resample captured audio into the 16 kHz mono PCM `Float32Array`
 * Whisper (via transformers.js) expects. `MicRecorder` (`recorder.ts`)
 * records at whatever rate/channel count the device and `MediaRecorder`
 * container give us, so this conversion always runs before transcription.
 *
 * `downmixToMono`/`resampleLinear` take a plain `DecodedAudio` shape rather
 * than a real `AudioBuffer` so they're pure and unit-testable without a
 * browser (jsdom has no Web Audio API). `decodeToMono16k` is the only part
 * that touches `AudioContext`/`decodeAudioData` and is intentionally kept
 * to a thin wrapper around the two pure functions.
 */

export const WHISPER_SAMPLE_RATE = 16000;

export interface DecodedAudio {
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly length: number;
  getChannelData(channel: number): Float32Array;
}

export function downmixToMono(audio: DecodedAudio): Float32Array {
  if (audio.numberOfChannels === 1) return audio.getChannelData(0).slice();

  const mono = new Float32Array(audio.length);
  for (let channel = 0; channel < audio.numberOfChannels; channel++) {
    const data = audio.getChannelData(channel);
    for (let i = 0; i < audio.length; i++) {
      mono[i] = (mono[i] ?? 0) + (data[i] ?? 0) / audio.numberOfChannels;
    }
  }
  return mono;
}

/** Linear-interpolation resampling — good enough for speech; no external deps. */
export function resampleLinear(
  input: Float32Array,
  sourceRate: number,
  targetRate: number,
): Float32Array {
  if (sourceRate === targetRate || input.length === 0) return input;

  const ratio = sourceRate / targetRate;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const sourcePosition = i * ratio;
    const lowerIndex = Math.floor(sourcePosition);
    const upperIndex = Math.min(lowerIndex + 1, input.length - 1);
    const fraction = sourcePosition - lowerIndex;
    output[i] = (input[lowerIndex] ?? 0) * (1 - fraction) + (input[upperIndex] ?? 0) * fraction;
  }
  return output;
}

export async function decodeToMono16k(arrayBuffer: ArrayBuffer): Promise<Float32Array> {
  const AudioContextCtor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const context = new AudioContextCtor();
  try {
    const audioBuffer = await context.decodeAudioData(arrayBuffer);
    return resampleLinear(downmixToMono(audioBuffer), audioBuffer.sampleRate, WHISPER_SAMPLE_RATE);
  } finally {
    await context.close();
  }
}
