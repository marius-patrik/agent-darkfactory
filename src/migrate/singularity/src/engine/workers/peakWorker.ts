/**
 * Web Worker that computes waveform peaks from raw Float32Array audio frames.
 *
 * Messages posted to this worker:
 * {
 *   id: string;
 *   frames: Float32Array[]; // one array per channel
 *   numberOfFrames: number;
 *   numberOfChannels: number;
 *   sampleRate: number;
 *   width: number;          // number of horizontal pixels/buckets
 *   channel?: number;       // default 0
 * }
 *
 * Response:
 * {
 *   id: string;
 *   sampleId?: string;
 *   channel: number;
 *   peaks: Float32Array;    // flattened [min0, max0, min1, max1, ...]
 *   sampleRate: number;
 *   numberOfChannels: number;
 *   numberOfFrames: number;
 * }
 */

export interface PeakWorkerRequest {
  id: string;
  sampleId?: string;
  frames: Float32Array[];
  numberOfFrames: number;
  numberOfChannels: number;
  sampleRate: number;
  width: number;
  channel?: number;
}

export interface PeakWorkerResponse {
  id: string;
  sampleId?: string;
  channel: number;
  peaks: Float32Array;
  sampleRate: number;
  numberOfChannels: number;
  numberOfFrames: number;
}

function generatePeaks(
  frames: ReadonlyArray<Float32Array>,
  width: number,
  channel: number,
): Float32Array {
  const ch = Math.min(channel, frames.length - 1);
  const data = frames[ch];
  const framesPerPixel = Math.max(1, Math.floor(data.length / width));
  const out = new Float32Array(width * 2);
  for (let i = 0; i < width; i++) {
    const start = i * framesPerPixel;
    const end = Math.min(start + framesPerPixel, data.length);
    let min = 0;
    let max = 0;
    for (let j = start; j < end; j++) {
      const v = data[j];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    out[i * 2] = min;
    out[i * 2 + 1] = max;
  }
  return out;
}

self.addEventListener("message", (event: MessageEvent<PeakWorkerRequest>) => {
  const {
    id,
    sampleId,
    frames,
    numberOfFrames,
    numberOfChannels,
    sampleRate,
    width,
    channel = 0,
  } = event.data;

  try {
    const peaks = generatePeaks(frames, width, channel);
    const response: PeakWorkerResponse = {
      id,
      sampleId,
      channel,
      peaks,
      sampleRate,
      numberOfChannels,
      numberOfFrames,
    };
    self.postMessage(response, [peaks.buffer as ArrayBuffer]);
  } catch (error) {
    self.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
