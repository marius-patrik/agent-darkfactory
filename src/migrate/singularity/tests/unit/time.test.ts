import {
  barsBeatsTicksToSamples,
  beatsToSamples,
  formatBarsBeatsTicks,
  samplesToBarsBeatsTicks,
  samplesToBeats,
  samplesToSeconds,
  secondsToSamples,
} from "../../src/shared/time.js";

describe("time conversion", () => {
  const sampleRate = 48000;
  const tempo = 120;

  test("samplesToSeconds converts correctly", () => {
    expect(samplesToSeconds(48000, sampleRate)).toBeCloseTo(1);
    expect(samplesToSeconds(0, sampleRate)).toBe(0);
  });

  test("samplesToSeconds rejects non-positive sample rate", () => {
    expect(() => samplesToSeconds(100, 0)).toThrow(RangeError);
    expect(() => samplesToSeconds(100, -48000)).toThrow(RangeError);
  });

  test("secondsToSamples converts correctly", () => {
    expect(secondsToSamples(1, sampleRate)).toBe(48000);
    expect(secondsToSamples(0.5, sampleRate)).toBe(24000);
  });

  test("secondsToSamples rejects non-positive sample rate", () => {
    expect(() => secondsToSamples(1, 0)).toThrow(RangeError);
  });

  test("samplesToBeats at 120 BPM", () => {
    const oneBeatInSamples = sampleRate * 0.5;
    expect(samplesToBeats(oneBeatInSamples, sampleRate, tempo)).toBeCloseTo(1);
    expect(samplesToBeats(oneBeatInSamples * 4, sampleRate, tempo)).toBeCloseTo(4);
  });

  test("beatsToSamples round-trips with samplesToBeats", () => {
    for (const beats of [0, 1, 4, 7.5]) {
      const samples = beatsToSamples(beats, sampleRate, tempo);
      expect(samplesToBeats(samples, sampleRate, tempo)).toBeCloseTo(beats, 5);
    }
  });

  test("samplesToBarsBeatsTicks for whole bars", () => {
    const oneBarInSamples = beatsToSamples(4, sampleRate, tempo);
    expect(samplesToBarsBeatsTicks(oneBarInSamples, sampleRate, tempo, [4, 4])).toEqual({
      bars: 1,
      beats: 0,
      ticks: 0,
    });
  });

  test("barsBeatsTicksToSamples round-trips", () => {
    const original = { bars: 2, beats: 1, ticks: 480 };
    const samples = barsBeatsTicksToSamples(original, sampleRate, tempo, [4, 4]);
    const result = samplesToBarsBeatsTicks(samples, sampleRate, tempo, [4, 4]);
    expect(result).toEqual(original);
  });

  test("formatBarsBeatsTicks zero-pads values", () => {
    expect(formatBarsBeatsTicks({ bars: 0, beats: 0, ticks: 0 })).toBe("01:01:000");
    expect(formatBarsBeatsTicks({ bars: 11, beats: 3, ticks: 60 })).toBe("12:04:060");
  });
});
