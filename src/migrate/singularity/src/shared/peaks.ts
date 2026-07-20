export interface PeakPoint {
  min: number;
  max: number;
  rms: number;
}

export interface PeakOptions {
  samplesPerPeak: number;
  channel?: number;
}

function validateSamplesPerPeak(samplesPerPeak: number): void {
  if (!Number.isInteger(samplesPerPeak) || samplesPerPeak <= 0) {
    throw new RangeError("samplesPerPeak must be a positive integer");
  }
}

function validateAudioBuffer(buffer: AudioBuffer): void {
  if (!buffer || typeof buffer !== "object") {
    throw new TypeError("Invalid AudioBuffer");
  }
  if (
    !Number.isInteger(buffer.numberOfChannels) ||
    buffer.numberOfChannels <= 0 ||
    !Number.isInteger(buffer.length) ||
    buffer.length < 0
  ) {
    throw new RangeError("AudioBuffer has invalid dimensions");
  }
}

function getChannelData(buffer: AudioBuffer, channel?: number): Float32Array {
  validateAudioBuffer(buffer);

  if (channel === undefined) {
    const frames = buffer.length;
    const data = new Float32Array(frames);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const channelData = buffer.getChannelData(c);
      if (!channelData || channelData.length !== frames) {
        throw new RangeError(`Channel ${c} data is inconsistent with buffer length`);
      }
      for (let i = 0; i < frames; i++) {
        data[i] += channelData[i];
      }
    }
    for (let i = 0; i < frames; i++) {
      data[i] /= buffer.numberOfChannels;
    }
    return data;
  }

  if (!Number.isInteger(channel) || channel < 0 || channel >= buffer.numberOfChannels) {
    throw new RangeError(`Invalid channel ${channel}`);
  }
  const channelData = buffer.getChannelData(channel);
  if (!channelData || channelData.length !== buffer.length) {
    throw new RangeError(`Channel ${channel} data is inconsistent with buffer length`);
  }
  return channelData;
}

export function generatePeaksFromAudioBuffer(
  buffer: AudioBuffer,
  options: PeakOptions,
): PeakPoint[] {
  const { samplesPerPeak } = options;
  validateSamplesPerPeak(samplesPerPeak);

  const data = getChannelData(buffer, options.channel);
  return generatePeaksFromFloat32ArrayInternal(data, samplesPerPeak);
}

export function generatePeaksFromFloat32Array(
  data: Float32Array,
  samplesPerPeak: number,
): PeakPoint[] {
  if (!(data instanceof Float32Array)) {
    throw new TypeError("Data must be a Float32Array");
  }
  validateSamplesPerPeak(samplesPerPeak);
  return generatePeaksFromFloat32ArrayInternal(data, samplesPerPeak);
}

function generatePeaksFromFloat32ArrayInternal(
  data: Float32Array,
  samplesPerPeak: number,
): PeakPoint[] {
  const totalFrames = data.length;
  if (totalFrames === 0) {
    return [];
  }

  const peakCount = Math.ceil(totalFrames / samplesPerPeak);
  const peaks: PeakPoint[] = [];

  for (let i = 0; i < peakCount; i++) {
    const start = i * samplesPerPeak;
    const end = Math.min(start + samplesPerPeak, totalFrames);

    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let sumSquares = 0;

    for (let j = start; j < end; j++) {
      const sample = data[j];
      if (sample < min) min = sample;
      if (sample > max) max = sample;
      sumSquares += sample * sample;
    }

    const count = end - start;
    peaks.push({
      min: min === Number.POSITIVE_INFINITY ? 0 : min,
      max: max === Number.NEGATIVE_INFINITY ? 0 : max,
      rms: Math.sqrt(sumSquares / count),
    });
  }

  return peaks;
}

export function downsamplePeaks(peaks: PeakPoint[], targetCount: number): PeakPoint[] {
  if (!Array.isArray(peaks)) {
    throw new TypeError("peaks must be an array");
  }
  if (!Number.isInteger(targetCount) || targetCount <= 0) {
    throw new RangeError("targetCount must be a positive integer");
  }
  if (peaks.length === 0) {
    return [];
  }
  if (targetCount >= peaks.length) {
    return peaks.slice();
  }

  const blockSize = peaks.length / targetCount;
  const downsampled: PeakPoint[] = [];

  for (let i = 0; i < targetCount; i++) {
    const start = Math.floor(i * blockSize);
    const end = Math.min(Math.floor((i + 1) * blockSize), peaks.length);

    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let sumSquares = 0;
    let count = 0;

    for (let j = start; j < end; j++) {
      const point = peaks[j];
      if (point.min < min) min = point.min;
      if (point.max > max) max = point.max;
      sumSquares += point.rms * point.rms;
      count++;
    }

    downsampled.push({
      min: min === Number.POSITIVE_INFINITY ? 0 : min,
      max: max === Number.NEGATIVE_INFINITY ? 0 : max,
      rms: Math.sqrt(sumSquares / count),
    });
  }

  return downsampled;
}
