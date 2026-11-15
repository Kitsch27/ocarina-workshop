import { recognizeStaff } from './staff-engine.mjs?v=13';

self.addEventListener('message', async ({ data: message }) => {
  try {
    const result = await recognizeStaff(message, (progress, ratio) => self.postMessage({ progress, ratio }));
    self.postMessage({ result });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
});

self.postMessage({ ready: true });
