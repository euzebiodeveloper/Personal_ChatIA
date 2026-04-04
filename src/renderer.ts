import './index.css';
import { AnimatedCharacter } from './character';
import { VoiceRecorder } from './recorder';
import { transcribe } from './stt';
import type { CharacterState } from './types';

let character: AnimatedCharacter;
const recorder = new VoiceRecorder();
let isRecording = false;
let isProcessing = false;

// ── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('character-canvas') as HTMLCanvasElement;
  character = new AnimatedCharacter(canvas);

  // Register IPC listeners
  window.electronAPI.onCharacterState((state: CharacterState) => {
    character.setState(state);
  });

  window.electronAPI.onShowMessage((text: string) => {
    showBubble(text, 8000);
  });

  window.electronAPI.onHotkeyToggle(() => {
    handleToggle();
  });

  window.electronAPI.onModelLoading((status: string) => {
    showStatus(status);
  });

  // Allow dragging the character window by holding the top area
  setupDrag();

  // Tell main process the renderer is ready
  window.electronAPI.onReady();

  showStatus('Pressione Ctrl+Shift+Space para falar');
  setTimeout(() => showStatus(''), 4000);
});

// ── Recording toggle ─────────────────────────────────────────────────────────

async function handleToggle(): Promise<void> {
  if (isProcessing) return;

  if (!isRecording) {
    // ── Start recording ─────────────────────────────────────────────────────
    try {
      await recorder.start();
      isRecording = true;
      character.setState('listening');
      showStatus('🎤 Gravando... (pressione novamente para enviar)');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showBubble(`Erro no microfone: ${msg}`, 5000);
    }
  } else {
    // ── Stop → transcribe → send to AI ──────────────────────────────────────
    isRecording = false;
    isProcessing = true;
    character.setState('idle');
    showStatus('⏳ Transcrevendo...');

    // ── Step 1: stop recording ───────────────────────────────────────────
    let blob: Blob;
    try {
      blob = await recorder.stop();
      const info = `blob size=${blob.size} type=${blob.type}`;
      window.electronAPI.writeLog('info', `[step1] ${info}`);
      showStatus(`[1/3] Áudio capturado (${blob.size} bytes)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      window.electronAPI.writeLog('error', `[step1] recorder.stop() failed: ${msg}`);
      showBubble(`❌ Erro na gravação: ${msg}`, 10000);
      character.setState('idle');
      isProcessing = false;
      return;
    }

    if (blob.size < 1000) {
      window.electronAPI.writeLog('warn', `[step1] blob too small: ${blob.size} bytes`);
      showStatus('Áudio muito curto, tente novamente.');
      isProcessing = false;
      setTimeout(() => showStatus(''), 3000);
      return;
    }

    // ── Step 2: transcribe ───────────────────────────────────────────────
    let text: string;
    try {
      showStatus('[2/3] Transcrevendo com Whisper...');
      window.electronAPI.writeLog('info', '[step2] starting transcription');
      text = await transcribe(blob, (status) => {
        showStatus(`[2/3] ${status}`);
        window.electronAPI.writeLog('info', `[step2] ${status}`);
      });
      window.electronAPI.writeLog('info', `[step2] result: "${text}"`);
    } catch (err) {
      const msg = err instanceof Error ? `${err.message}\nstack: ${(err as Error).stack}` : String(err);
      window.electronAPI.writeLog('error', `[step2] transcribe() failed: ${msg}`);
      showBubble(`❌ Erro no Whisper: ${err instanceof Error ? err.message : String(err)}`, 10000);
      showStatus('Erro na transcrição. Veja assistant.log');
      character.setState('idle');
      isProcessing = false;
      return;
    }

    if (!text) {
      window.electronAPI.writeLog('warn', '[step2] empty transcription');
      showStatus('Não entendi. Tente novamente.');
      isProcessing = false;
      setTimeout(() => showStatus(''), 3000);
      return;
    }

    showStatus(`Você: "${text}"`);
    showBubble(`Você: ${text}`, 4000);

    // ── Step 3: send to AI ───────────────────────────────────────────────
    try {
      showStatus('[3/3] Aguardando resposta da IA...');
      window.electronAPI.writeLog('info', `[step3] sending to AI: "${text}"`);
      await window.electronAPI.sendTranscription(text);
      window.electronAPI.writeLog('info', '[step3] AI response received');
    } catch (err) {
      const msg = err instanceof Error ? `${err.message}\nstack: ${(err as Error).stack}` : String(err);
      window.electronAPI.writeLog('error', `[step3] sendTranscription() failed: ${msg}`);
      showBubble(`❌ Erro na IA: ${err instanceof Error ? err.message : String(err)}`, 10000);
      showStatus('Erro ao contactar a IA. Veja assistant.log');
      character.setState('idle');
    } finally {
      isProcessing = false;
    }
  }
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function showBubble(text: string, duration: number): void {
  const bubble = document.getElementById('message-bubble') as HTMLDivElement;
  bubble.textContent = text;
  bubble.classList.remove('hidden');
  clearTimeout((bubble as HTMLDivElement & { _timer?: number })._timer);
  (bubble as HTMLDivElement & { _timer?: number })._timer = window.setTimeout(() => {
    bubble.classList.add('hidden');
  }, duration);
}

function showStatus(text: string): void {
  const el = document.getElementById('status-text') as HTMLSpanElement;
  el.textContent = text;
}

// ── Window drag (CSS -webkit-app-region handled in CSS for the handle) ────────

function setupDrag(): void {
  // The #drag-handle div has -webkit-app-region: drag set in CSS
  // Double-click on character to show/hide bubble
  const canvas = document.getElementById('character-canvas') as HTMLCanvasElement;
  canvas.addEventListener('dblclick', () => {
    const bubble = document.getElementById('message-bubble') as HTMLDivElement;
    bubble.classList.toggle('hidden');
  });
}
