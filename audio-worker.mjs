import { transcribeMelody } from './audio-transcription.mjs?v=8';

self.onmessage = ({ data }) => {
  try {
    const result = transcribeMelody(data, progress => self.postMessage({ progress }));
    self.postMessage({ result });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
