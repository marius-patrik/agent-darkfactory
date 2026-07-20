export const DEFAULT_PPQN = 960;

function assertPositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
}

function assertValidTimeSignature(timeSignature: [number, number]): void {
  if (
    !Array.isArray(timeSignature) ||
    timeSignature.length !== 2 ||
    !Number.isInteger(timeSignature[0]) ||
    !Number.isInteger(timeSignature[1]) ||
    timeSignature[0] <= 0 ||
    timeSignature[1] <= 0
  ) {
    throw new RangeError("timeSignature must be a tuple of two positive integers");
  }
}

export function samplesToSeconds(samples: number, sampleRate: number): number {
  assertPositive(sampleRate, "sampleRate");
  return samples / sampleRate;
}

export function secondsToSamples(seconds: number, sampleRate: number): number {
  assertPositive(sampleRate, "sampleRate");
  return Math.round(seconds * sampleRate);
}

export function samplesToBeats(samples: number, sampleRate: number, tempo: number): number {
  assertPositive(sampleRate, "sampleRate");
  assertPositive(tempo, "tempo");
  const seconds = samplesToSeconds(samples, sampleRate);
  return (seconds * tempo) / 60;
}

export function beatsToSamples(beats: number, sampleRate: number, tempo: number): number {
  assertPositive(sampleRate, "sampleRate");
  assertPositive(tempo, "tempo");
  const seconds = (beats * 60) / tempo;
  return secondsToSamples(seconds, sampleRate);
}

export interface BarsBeatsTicks {
  bars: number;
  beats: number;
  ticks: number;
}

export function samplesToBarsBeatsTicks(
  samples: number,
  sampleRate: number,
  tempo: number,
  timeSignature: [number, number],
  ppqn = DEFAULT_PPQN,
): BarsBeatsTicks {
  assertPositive(sampleRate, "sampleRate");
  assertPositive(tempo, "tempo");
  assertPositive(ppqn, "ppqn");
  assertValidTimeSignature(timeSignature);

  const totalBeats = samplesToBeats(samples, sampleRate, tempo);
  const [numerator] = timeSignature;
  const totalBars = Math.floor(totalBeats / numerator);
  const remainingBeats = totalBeats - totalBars * numerator;
  const beatIndex = Math.floor(remainingBeats);
  const ticks = Math.round((remainingBeats - beatIndex) * ppqn);
  return { bars: totalBars, beats: beatIndex, ticks };
}

export function barsBeatsTicksToSamples(
  position: BarsBeatsTicks,
  sampleRate: number,
  tempo: number,
  timeSignature: [number, number],
  ppqn = DEFAULT_PPQN,
): number {
  assertPositive(sampleRate, "sampleRate");
  assertPositive(tempo, "tempo");
  assertPositive(ppqn, "ppqn");
  assertValidTimeSignature(timeSignature);

  if (
    !Number.isFinite(position.bars) ||
    !Number.isFinite(position.beats) ||
    !Number.isFinite(position.ticks) ||
    position.bars < 0 ||
    position.beats < 0 ||
    position.ticks < 0
  ) {
    throw new RangeError("Bars, beats, and ticks must be non-negative finite numbers");
  }

  const [numerator] = timeSignature;
  const totalBeats = position.bars * numerator + position.beats + position.ticks / ppqn;
  return beatsToSamples(totalBeats, sampleRate, tempo);
}

export function formatBarsBeatsTicks(position: BarsBeatsTicks): string {
  if (
    !Number.isFinite(position.bars) ||
    !Number.isFinite(position.beats) ||
    !Number.isFinite(position.ticks) ||
    position.bars < 0 ||
    position.beats < 0 ||
    position.ticks < 0
  ) {
    throw new RangeError("Bars, beats, and ticks must be non-negative finite numbers");
  }
  const bars = String(position.bars + 1).padStart(2, "0");
  const beats = String(position.beats + 1).padStart(2, "0");
  const ticks = String(position.ticks).padStart(3, "0");
  return `${bars}:${beats}:${ticks}`;
}

export function ppqnToBeats(ticks: number, ppqn = DEFAULT_PPQN): number {
  assertPositive(ppqn, "ppqn");
  return ticks / ppqn;
}

export function beatsToPpqn(beats: number, ppqn = DEFAULT_PPQN): number {
  assertPositive(ppqn, "ppqn");
  return beats * ppqn;
}

export function ppqnToSeconds(ticks: number, bpm: number, ppqn = DEFAULT_PPQN): number {
  assertPositive(bpm, "bpm");
  assertPositive(ppqn, "ppqn");
  return (ticks * 60) / (bpm * ppqn);
}

export function secondsToPpqn(seconds: number, bpm: number, ppqn = DEFAULT_PPQN): number {
  assertPositive(bpm, "bpm");
  assertPositive(ppqn, "ppqn");
  return (seconds * bpm * ppqn) / 60;
}

export function ppqnToBarsBeatsTicks(
  ticks: number,
  timeSignature: [number, number],
  ppqn = DEFAULT_PPQN,
): BarsBeatsTicks {
  assertPositive(ppqn, "ppqn");
  assertValidTimeSignature(timeSignature);

  const totalBeats = ppqnToBeats(ticks, ppqn);
  const [numerator] = timeSignature;
  const totalBars = Math.floor(totalBeats / numerator);
  const remainingBeats = totalBeats - totalBars * numerator;
  const beatIndex = Math.floor(remainingBeats);
  const tickCount = Math.round((remainingBeats - beatIndex) * ppqn);
  return { bars: totalBars, beats: beatIndex, ticks: tickCount };
}

export function barsBeatsTicksToPpqn(
  position: BarsBeatsTicks,
  timeSignature: [number, number],
  ppqn = DEFAULT_PPQN,
): number {
  assertPositive(ppqn, "ppqn");
  assertValidTimeSignature(timeSignature);

  if (
    !Number.isFinite(position.bars) ||
    !Number.isFinite(position.beats) ||
    !Number.isFinite(position.ticks) ||
    position.bars < 0 ||
    position.beats < 0 ||
    position.ticks < 0
  ) {
    throw new RangeError("Bars, beats, and ticks must be non-negative finite numbers");
  }

  const [numerator] = timeSignature;
  const totalBeats = position.bars * numerator + position.beats + position.ticks / ppqn;
  return beatsToPpqn(totalBeats, ppqn);
}
