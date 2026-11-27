/**
 * Nov 27, 2026: short alert sounds, made in the browser (Web Audio), so there
 * is no sound file to host or load.
 *
 *   'hold'      two falling tones, played twice — "your order is on hold"
 *   'approval'  three rising tones — "an order is waiting for you to approve"
 *
 * Browsers only let a page make sound after the person has clicked or typed
 * on it once. unlockAlertSound() is wired to the first click / key press, so
 * a tab someone has used plays the sound even while it is in the background.
 *
 * On/off is per browser (localStorage), switched in the notifications menu.
 */
const STORAGE_KEY = 'gm_alert_sound';
let ctx = null;

function audioContext() {
  if (ctx) return ctx;
  const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  if (!AC) return null;
  try { ctx = new AC(); } catch { ctx = null; }
  return ctx;
}

export function unlockAlertSound() {
  const c = audioContext();
  if (c && c.state === 'suspended') c.resume().catch(() => {});
}

export function isAlertSoundOn() {
  try { return window.localStorage.getItem(STORAGE_KEY) !== 'off'; } catch { return true; }
}

export function setAlertSoundOn(on) {
  try { window.localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off'); } catch { /* private mode: stays on */ }
}

function tone(c, freq, start, duration, type = 'sine', volume = 0.25) {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(gain).connect(c.destination);
  osc.start(start);
  osc.stop(start + duration + 0.05);
}

const PATTERNS = {
  hold: [
    [880, 0, 0.18, 'triangle'], [622, 0.2, 0.28, 'triangle'],
    [880, 0.6, 0.18, 'triangle'], [622, 0.8, 0.28, 'triangle'],
  ],
  approval: [
    [660, 0, 0.16, 'sine'], [880, 0.15, 0.16, 'sine'], [1175, 0.3, 0.32, 'sine'],
  ],
};

/** Play one of the alerts. `force` plays it even when sound is switched off (the preview). */
export function playAlertSound(kind = 'approval', { force = false } = {}) {
  if (!force && !isAlertSoundOn()) return;
  const c = audioContext();
  if (!c) return;
  const go = () => {
    const t0 = c.currentTime + 0.02;
    for (const [freq, at, dur, type] of PATTERNS[kind] || PATTERNS.approval) tone(c, freq, t0 + at, dur, type);
  };
  if (c.state === 'suspended') c.resume().then(go).catch(() => {});
  else go();
}
