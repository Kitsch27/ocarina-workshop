import { transcribeMelody } from './audio-transcription.mjs?v=9';

self.onmessage = ({ data: { samples, enhanced } }) => {
  try {
    const result = transcribeMelody(samples, progress => self.postMessage({ progress }), { enhanced });
    self.postMessage({ result });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
