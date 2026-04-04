import { contextBridge, ipcRenderer } from 'electron';
import type { CharacterState, AIResponse, ElectronAPI } from './types';

const api: ElectronAPI = {
  // ── Renderer → Main ───────────────────────────────────────────────────────
  sendTranscription: (text: string) =>
    ipcRenderer.invoke('process-transcription', text) as Promise<AIResponse>,

  onReady: () => ipcRenderer.send('renderer-ready'),

  getModelsPath: () => ipcRenderer.invoke('get-models-path') as Promise<string>,

  // ── Main → Renderer ───────────────────────────────────────────────────────
  onCharacterState: (cb: (state: CharacterState) => void) => {
    ipcRenderer.on('character-state', (_e, state: CharacterState) => cb(state));
  },

  onShowMessage: (cb: (text: string) => void) => {
    ipcRenderer.on('show-message', (_e, text: string) => cb(text));
  },

  onHotkeyToggle: (cb: () => void) => {
    ipcRenderer.on('hotkey-toggle', () => cb());
  },

  onModelLoading: (cb: (status: string) => void) => {
    ipcRenderer.on('model-loading', (_e, status: string) => cb(status));
  },

  removeAllListeners: (channel: string) => {
    ipcRenderer.removeAllListeners(channel);
  },
};

contextBridge.exposeInMainWorld('electronAPI', api);
