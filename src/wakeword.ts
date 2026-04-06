// Web Speech API — built into Chromium/Electron, no registration needed.
// Runs a continuous recognition stream solely for wake word detection.

// Common mishearings of "Bruno" in pt-BR
const WAKE_VARIANTS = ['bruno', 'bruna', 'buno'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let recognition: any = null;

export function initWakeWord(onDetected: () => void): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  const SR = w.SpeechRecognition ?? w.webkitSpeechRecognition;

  if (!SR) {
    console.warn('[wakeword] SpeechRecognition não disponível');
    return;
  }

  recognition = new SR();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'pt-BR';
  recognition.maxAlternatives = 3;

  recognition.onresult = (event: any) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      for (let j = 0; j < event.results[i].length; j++) {
        const t: string = event.results[i][j].transcript.toLowerCase().trim();
        if (WAKE_VARIANTS.some(v => t.includes(v))) {
          console.log(`[wakeword] detectado: "${t}"`);
          onDetected();
          return;
        }
      }
    }
  };

  recognition.onerror = (event: any) => {
    if (event.error !== 'no-speech' && event.error !== 'aborted') {
      console.error('[wakeword] erro:', event.error);
    }
  };

  // Auto-restart so detection is always active while mic is enabled
  recognition.onend = () => {
    if (recognition) {
      try { recognition.start(); } catch { /* ignore duplicate-start errors */ }
    }
  };

  recognition.start();
}

export function destroyWakeWord(): void {
  if (recognition) {
    recognition.onend = null; // prevent auto-restart
    try { recognition.stop(); } catch { /* ignore */ }
    recognition = null;
  }
}
