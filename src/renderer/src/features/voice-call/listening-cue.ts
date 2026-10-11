/** A short local earcon after microphone capture is ready, immediately before recording. */
export async function playListeningCue(): Promise<void> {
  const context = new AudioContext();
  try {
    await context.resume();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const now = context.currentTime;
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(660, now);
    oscillator.frequency.linearRampToValueAtTime(880, now + 0.08);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.08, now + 0.01);
    gain.gain.linearRampToValueAtTime(0, now + 0.12);
    oscillator.connect(gain);
    gain.connect(context.destination);
    await new Promise<void>((resolve) => {
      oscillator.onended = () => resolve();
      oscillator.start(now);
      oscillator.stop(now + 0.13);
    });
    oscillator.disconnect();
    gain.disconnect();
  } finally {
    await context.close();
  }
}
