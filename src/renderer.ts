import './index.css';
import { AnimatedCharacter } from './character';
import { VadRecorder } from './recorder';
import type { CharacterState } from './types';

let character: AnimatedCharacter;
const recorder = new VadRecorder();
let micEnabled      = false;
let isProcessing    = false;

// ── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('character-canvas') as HTMLCanvasElement;
  character = new AnimatedCharacter(canvas);

  recorder
    .onSpeech((blob) => handleSpeech(blob))
    .onError((err) => window.electronAPI.writeLog('error', `[vad] ${err.message}`));

  window.electronAPI.onCharacterState((state: CharacterState) => {
    character.setState(state);
  });

  window.electronAPI.onShowMessage((_text: string) => { /* disabled */ });

  window.electronAPI.onHotkeyToggle(() => handleToggle());

  window.electronAPI.onModelLoading((status: string) => showStatus(status));

  setupDrag();
  window.electronAPI.onReady();
  setDot('off');
});

// ── Mic toggle ────────────────────────────────────────────────────────────────

async function handleToggle(): Promise<void> {
  if (micEnabled) {
    recorder.disable();
    micEnabled = false;
    character.setState('idle');
    setDot('off');
  } else {
    try {
      await recorder.enable();
      micEnabled = true;
      setDot('on');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      window.electronAPI.writeLog('error', `[mic] enable failed: ${msg}`);
      showStatus(`Erro no microfone: ${msg}`);
      setTimeout(() => showStatus(''), 4000);
      setDot('off');
    }
  }
}

// ── Speech handler (called by VAD when a speech clip is ready) ────────────────

async function handleSpeech(blob: Blob): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;
  setDot('speaking');
  character.setState('listening');

  // Step 1: transcribe via Groq Whisper API
  let text: string;
  try {
    const arrayBuffer = await blob.arrayBuffer();
    window.electronAPI.writeLog('info', `[step2] transcribing blob size=${blob.size}`);
    text = await window.electronAPI.transcribeAudio(arrayBuffer);
    window.electronAPI.writeLog('info', `[step2] result: "${text}"`);
  } catch (err) {
    const msg = err instanceof Error ? `${err.message}\nstack: ${(err as Error).stack}` : String(err);
    window.electronAPI.writeLog('error', `[step2] transcribe() failed: ${msg}`);
    character.setState('idle');
    setDot('on');
    isProcessing = false;
    return;
  }

  if (!text) {
    window.electronAPI.writeLog('warn', '[step2] empty transcription');
    character.setState('idle');
    isProcessing = false;
    return;
  }

  // Step 2: send to AI
  setDot('processing');
  try {
    window.electronAPI.writeLog('info', `[step3] sending to AI: "${text}"`);
    await window.electronAPI.sendTranscription(text);
    window.electronAPI.writeLog('info', '[step3] AI response received');
  } catch (err) {
    const msg = err instanceof Error ? `${err.message}\nstack: ${(err as Error).stack}` : String(err);
    window.electronAPI.writeLog('error', `[step3] sendTranscription() failed: ${msg}`);
    character.setState('idle');
  } finally {
    isProcessing = false;
    setDot('on');
  }
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function setDot(state: 'on' | 'off' | 'speaking' | 'processing'): void {
  const dot = document.getElementById('mic-dot') as HTMLDivElement;
  const map: Record<typeof state, string> = {
    on: 'dot-green',
    off: 'dot-red',
    speaking: 'dot-blue',
    processing: 'dot-yellow',
  };
  dot.className = map[state];
}

function showStatus(text: string): void {
  const el = document.getElementById('status-text') as HTMLSpanElement;
  el.textContent = text;
}

// ── Window drag ───────────────────────────────────────────────────────────────

function setupDrag(): void {
  // #drag-handle has -webkit-app-region: drag set in CSS
}
