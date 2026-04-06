/// <reference types="vite/client" />

export type CharacterState = 'idle' | 'listening' | 'talking';

export interface AIResponse {
  text: string;
  action?: string;
}

export interface AutomationStep {
  x_pct: number;
  y_pct: number;
  need_exclude: boolean;
  need_text: boolean;
  insert_text?: string;
  press_enter?: boolean;
}

export interface ElectronAPI {
  // Renderer → Main
  sendTranscription: (text: string) => Promise<AIResponse>;
  transcribeAudio: (buffer: ArrayBuffer) => Promise<string>;
  onReady: () => void;
  getModelsPath: () => Promise<string>;
  writeLog: (level: 'info' | 'warn' | 'error', msg: string) => void;
  getLogPath: () => Promise<string>;

  // Main → Renderer (push events)
  onCharacterState: (callback: (state: CharacterState) => void) => void;
  onShowMessage: (callback: (text: string) => void) => void;
  onHotkeyToggle: (callback: () => void) => void;
  onModelLoading: (callback: (status: string) => void) => void;

  removeAllListeners: (channel: string) => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
