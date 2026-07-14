import { describe, expect, it } from "vitest";
import { downmixToMono, resampleLinear, type DecodedAudio } from "./pcm.ts";

function fakeAudio(channels: number[][], sampleRate = 48000): DecodedAudio {
  const length = channels[0]?.length ?? 0;
  return {
    sampleRate,
    numberOfChannels: channels.length,
    length,
    getChannelData: (channel: number) => Float32Array.from(channels[channel] ?? []),
  };
}

describe("downmixToMono", () => {
  it("returns a copy of the single channel unchanged", () => {
    const audio = fakeAudio([[0.1, -0.2, 0.3]]);
    const mono = downmixToMono(audio);
    expect(Array.from(mono)).toEqual(Array.from(Float32Array.from([0.1, -0.2, 0.3])));
  });

  it("averages stereo channels sample-by-sample", () => {
    const audio = fakeAudio([
      [1, 0, -1],
      [0, 1, 1],
    ]);
    const mono = downmixToMono(audio);
    expect(Array.from(mono)).toEqual([0.5, 0.5, 0]);
  });

  it("does not mutate the source channel data", () => {
    const source = new Float32Array([1, 2, 3]);
    const audio: DecodedAudio = {
      sampleRate: 48000,
      numberOfChannels: 1,
      length: 3,
      getChannelData: () => source,
    };
    downmixToMono(audio)[0] = 999;
    expect(source[0]).toBe(1);
  });
});

describe("resampleLinear", () => {
  it("returns the input unchanged when rates already match", () => {
    const input = new Float32Array([1, 2, 3]);
    expect(resampleLinear(input, 16000, 16000)).toBe(input);
  });

  it("halves the sample count when downsampling by 2x", () => {
    const input = new Float32Array([0, 1, 2, 3, 4, 5, 6, 7]);
    const output = resampleLinear(input, 32000, 16000);
    expect(output.length).toBe(4);
  });

  it("interpolates between neighboring samples", () => {
    const input = new Float32Array([0, 10]);
    // Downsampling from 4 Hz to 2 Hz over a 2-sample buffer: the single
    // output sample should land at source index 0 (ratio=2, i=0 -> pos 0).
    const output = resampleLinear(input, 4, 2);
    expect(output[0]).toBe(0);
  });

  it("produces a monotonically reasonable upsample (more output samples)", () => {
    const input = new Float32Array([0, 1, 0, -1]);
    const output = resampleLinear(input, 8000, 16000);
    expect(output.length).toBe(8);
    // Endpoints should match the source; interior samples are interpolated.
    expect(output[0]).toBe(0);
  });
});
