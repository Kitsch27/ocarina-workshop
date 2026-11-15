import { transcribeMelody } from './audio-transcription.mjs?v=10';

self.onmessage = ({ data: { samples, options } }) => {
  try {
    const result = transcribeMelody(samples, (progress, stage) => self.postMessage({ progress, stage }), options);
    self.postMessage({ result });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
