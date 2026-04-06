import { app, BrowserWindow, globalShortcut, ipcMain, screen } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import dotenv from 'dotenv';
import { setupTray } from './tray';
import { processLayeredMessage, transcribeAudio } from './ai';
import { logger } from './logger';

// Load API keys from project root .env (development) and userData/.env (production)
dotenv.config();
dotenv.config({ path: path.join(app.getPath('userData'), '.env'), override: false });

if (started) {
  app.quit();
}

// Declared by Electron Forge Vite plugin
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 320,
    height: 480,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Position bottom-right of the primary display
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  mainWindow.setPosition(width - 340, height - 500);

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
}

app.on('ready', () => {
  createWindow();

  if (!mainWindow) return;
  setupTray(mainWindow);

  // Toggle recording with Ctrl+Shift+Space
  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    mainWindow?.webContents.send('hotkey-toggle');
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// ── IPC handlers ────────────────────────────────────────────────────────────

ipcMain.handle('process-transcription', async (_e, text: string) => {
  if (!mainWindow) return { text: 'Janela não encontrada.' };
  return processLayeredMessage(text, mainWindow);
});

ipcMain.handle('get-models-path', () =>
  path.join(app.getPath('userData'), 'models'),
);

ipcMain.on('renderer-ready', () => {
  mainWindow?.webContents.send('character-state', 'idle');
  logger.info('Renderer ready. Log file: ' + logger.path());
});

ipcMain.on('write-log', (_e, level: 'info' | 'warn' | 'error', msg: string) => {
  logger[level](msg);
});

ipcMain.handle('transcribe-audio', async (_e, buffer: Buffer) => {
  return transcribeAudio(buffer);
});

ipcMain.handle('get-log-path', () => logger.path());
