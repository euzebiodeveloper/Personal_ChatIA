import say from 'say';

export function speak(text: string): Promise<void> {
  return new Promise((resolve) => {
    say.speak(text, undefined, 1.0, (err) => {
      if (err) console.error('[tts] say.js error:', err);
      resolve();
    });
  });
}

export function stopSpeaking(): void {
  say.stop();
}
