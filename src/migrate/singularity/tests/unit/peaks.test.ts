import {
  downsamplePeaks,
  generatePeaksFromAudioBuffer,
  generatePeaksFromFloat32Array,
} from "../../src/shared/peaks.js";

function createAudioBuffer(channelData: Float32Array[]): AudioBuffer {
  return {
    length: channelData[0]?.length ?? 0,
    numberOfChannels: channelData.length,
    sampleRate: 48000,
    duration: (channelData[0]?.length ?? 0) / 48000,
    getChannelData: (channel: number) => channelData[channel],
  } as unknown as AudioBuffer;
}

describe("peaks", () => {
  test("generatePeaksFromFloat32Array produces expected min/max/rms", () => {
    const data = new Float32Array([0.5, -0.5, 0.25, -0.25, 1.0, -1.0]);
    const peaks = generatePeaksFromFloat32Array(data, 2);
    expect(peaks).toHaveLength(3);
    expect(peaks[0]).toEqual({ min: -0.5, max: 0.5, rms: 0.5 });
    expect(peaks[1]).toEqual({ min: -0.25, max: 0.25, rms: 0.25 });
    expect(peaks[2]).toEqual({ min: -1, max: 1, rms: 1 });
  });

  test("generatePeaksFromAudioBuffer averages channels", () => {
    const left = new Float32Array([1, 0, 1, 0]);
    const right = new Float32Array([0, 1, 0, 1]);
    const buffer = createAudioBuffer([left, right]);
    const peaks = generatePeaksFromAudioBuffer(buffer, { samplesPerPeak: 4 });
    expect(peaks).toHaveLength(1);
    expect(peaks[0].rms).toBeCloseTo(Math.sqrt(0.25));
  });

  test("generatePeaksFromAudioBuffer selects channel", () => {
    const left = new Float32Array([1, 1, 1, 1]);
    const right = new Float32Array([0, 0, 0, 0]);
    const buffer = createAudioBuffer([left, right]);
    const peaks = generatePeaksFromAudioBuffer(buffer, { samplesPerPeak: 4, channel: 1 });
    expect(peaks[0].rms).toBe(0);
  });

  test("generatePeaksFromAudioBuffer rejects invalid channel", () => {
    const buffer = createAudioBuffer([new Float32Array([0, 0])]);
    expect(() => generatePeaksFromAudioBuffer(buffer, { samplesPerPeak: 2, channel: 5 })).toThrow(
      RangeError,
    );
  });

  test("peak functions reject invalid samplesPerPeak", () => {
    expect(() => generatePeaksFromFloat32Array(new Float32Array(4), 0)).toThrow(RangeError);
    expect(() => generatePeaksFromFloat32Array(new Float32Array(4), 1.5)).toThrow(RangeError);
  });

  test("downsamplePeaks reduces target count", () => {
    const data = new Float32Array([1, -1, 0.5, -0.5]);
    const peaks = generatePeaksFromFloat32Array(data, 1);
    const downsampled = downsamplePeaks(peaks, 2);
    expect(downsampled).toHaveLength(2);
    expect(downsampled[0].max).toBe(1);
    expect(downsampled[0].min).toBe(-1);
    expect(downsampled[1].max).toBe(0.5);
    expect(downsampled[1].min).toBe(-0.5);
  });

  test("downsamplePeaks handles edge cases", () => {
    expect(downsamplePeaks([], 5)).toEqual([]);
    expect(downsamplePeaks([{ min: -1, max: 1, rms: 0.5 }], 5)).toHaveLength(1);
    expect(() => downsamplePeaks([], 0)).toThrow(RangeError);
  });
});
