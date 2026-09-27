// Sound (Web Audio oscillators, no audio files) and vibration.
// Browsers block audio until a user tap: call unlockAudio() inside a tap handler.

let ctx = null;

export function unlockAudio() {
  try {
    // iPhone: play through the silent switch like an alarm, not like a ringtone.
    if (navigator.audioSession) navigator.audioSession.type = "playback";
  } catch {
    // older Safari: no audioSession, silent switch will mute
  }
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return;
  if (!ctx) ctx = new AudioCtx();
  if (ctx.state !== "running") ctx.resume().catch(() => {});
  // A silent buffer played inside the tap fully unlocks older iOS.
  const buffer = ctx.createBuffer(1, 1, 22050);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.start(0);
}

function tone(freq, startOffset, duration, volume, type = "square") {
  // Scheduled even while resume() is still pending: it plays once the context runs.
  if (!ctx) return;
  const t0 = ctx.currentTime + startOffset;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(volume, t0 + 0.01);
  gain.gain.setValueAtTime(volume, t0 + duration - 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

function vibrate(pattern) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // iPhone has no Vibration API
  }
}

// Full match: loud rising two-tone siren (~1.2 s) + long vibration.
export function alarmFull() {
  for (let i = 0; i < 4; i++) {
    tone(880, i * 0.3, 0.15, 0.9);
    tone(1320, i * 0.3 + 0.15, 0.15, 0.9);
  }
  vibrate([800, 150, 800]);
}

// Every accepted read: one crisp beep like a handheld scanner gun.
export function beep() {
  tone(2700, 0, 0.1, 0.5, "square");
  vibrate(40);
}

export function stopVibration() {
  vibrate(0);
}
