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

    try {
      const blob = await recorder.stop();

      if (blob.size < 1000) {
        showStatus('Áudio muito curto, tente novamente.');
        isProcessing = false;
        setTimeout(() => showStatus(''), 3000);
        return;
      }

      const text = await transcribe(blob, (status) => showStatus(status));

      if (!text) {
        showStatus('Não entendi. Tente novamente.');
        isProcessing = false;
        setTimeout(() => showStatus(''), 3000);
        return;
      }

      showStatus(`Você: "${text}"`);
      showBubble(`Você: ${text}`, 4000);

      await window.electronAPI.sendTranscription(text);
    } catch (err) {
      console.error('[renderer] processing error:', err);
      showStatus('Erro ao processar. Tente novamente.');
      character.setState('idle');
      setTimeout(() => showStatus(''), 4000);
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
