// Feedback without sound: vibration only (Android). iPhone has no Vibration API,
// so there the screen (pop-in read, flash, green "Ketemu!") is the only signal.
// No audio on purpose: Web Audio made iPhone show a music player on the lock screen.

function vibrate(pattern) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // iPhone has no Vibration API
  }
}

// Full match: long double vibration.
export function alarmFull() {
  vibrate([800, 150, 800]);
}

// Every accepted read: one short tick.
export function readPulse() {
  vibrate(40);
}

export function stopVibration() {
  vibrate(0);
}
