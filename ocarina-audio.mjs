// Indexed by the fingering chart's written MIDI pitches. Frequencies and
// harmonic levels are measured from the five unmodified in-game notes.
const GAME_NOTES = new Map([
  [62, { hz: 596.14, peak: 0.17, sustain: 0.167, harmonics: [0.011, 0.008, 0.003] }],
  [65, { hz: 700.42, peak: 0.145, sustain: 0.135, harmonics: [0.001, 0.007] }],
  [69, { hz: 894.88, peak: 0.16, sustain: 0.139, harmonics: [0.002, 0.006, 0, 0.001] }],
  [71, { hz: 1001.21, peak: 0.153, sustain: 0.135, harmonics: [0.002, 0.003, 0, 0.001] }],
  [74, { hz: 1190.77, peak: 0.155, sustain: 0.131, harmonics: [0.003, 0.001] }],
]);
const REFERENCE_HARMONICS = [0.1];
const contextWaves = new WeakMap();

function voiceWave(context, harmonics) {
  let waves = contextWaves.get(context);
  if (!waves) {
    waves = new Map();
    contextWaves.set(context, waves);
  }
  if (!waves.has(harmonics)) {
    const sine = Float32Array.of(0, 1, ...harmonics);
    waves.set(harmonics, context.createPeriodicWave(new Float32Array(sine.length), sine, { disableNormalization: true }));
  }
  return waves.get(harmonics);
}

export function previewVoice(context, pitch, start, seconds, basePitch) {
  const profile = GAME_NOTES.get(basePitch);
  const oscillator = context.createOscillator();
  const envelope = context.createGain();
  const duration = Math.max(0.05, seconds);
  const end = start + duration;
  oscillator.frequency.value = profile ? profile.hz * 2 ** ((pitch - basePitch) / 12) : 440 * 2 ** ((pitch - 69) / 12);
  oscillator.setPeriodicWave(voiceWave(context, profile?.harmonics ?? REFERENCE_HARMONICS));
  oscillator.connect(envelope).connect(context.destination);
  const gain = envelope.gain;
  if (profile) {
    const attack = Math.min(0.008, duration * 0.15);
    const settle = Math.min(0.11, duration * 0.55);
    const release = Math.min(0.035, duration * 0.38);
    gain.setValueAtTime(0, start);
    gain.linearRampToValueAtTime(profile.peak, start + attack);
    gain.linearRampToValueAtTime(profile.sustain, start + settle);
    gain.setValueAtTime(profile.sustain, end - release);
    gain.exponentialRampToValueAtTime(profile.sustain * 0.24, end - 0.006);
    gain.linearRampToValueAtTime(0, end);
  } else {
    gain.setValueAtTime(0.0001, start);
    gain.exponentialRampToValueAtTime(0.185, start + 0.024);
    gain.setValueAtTime(0.17, Math.max(start + 0.028, end - 0.05));
    gain.exponentialRampToValueAtTime(0.0001, end);
  }
  oscillator.addEventListener('ended', () => envelope.disconnect(), { once: true });
  oscillator.start(start);
  oscillator.stop(end + 0.01);
  return { oscillator, envelope };
}
