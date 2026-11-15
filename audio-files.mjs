import { MAX_AUDIO_SECONDS, SAMPLE_RATE } from './audio-transcription.mjs?v=10';

export async function readAudio(file, signal) {
  const OfflineContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OfflineContext) throw new Error('当前浏览器无法解码音频。');
  const bytes = await file.arrayBuffer();
  signal.throwIfAborted();
  let buffer;
  try {
    buffer = await new OfflineContext(1, 1, SAMPLE_RATE).decodeAudioData(bytes);
  } catch {
    throw new Error('无法打开这份音频。请检查文件，或另存为 MP3 或 WAV 后重试。');
  }
  signal.throwIfAborted();
  if (buffer.duration > MAX_AUDIO_SECONDS) throw new Error('音频最长 3 分钟，请截取一段旋律后重试。');

  let strongest = buffer.getChannelData(0);
  let maxEnergy = -1;
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const samples = buffer.getChannelData(channel);
    let energy = 0;
    for (const sample of samples) energy += sample * sample;
    if (energy > maxEnergy) {
      strongest = samples;
      maxEnergy = energy;
    }
  }
  return strongest.slice();
}
