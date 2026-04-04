import { spawn, ChildProcess } from 'node:child_process';
import { app } from 'electron';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const TEMP_WAV = path.join(os.tmpdir(), 'ai-assistant-tts.wav');

let currentPiper: ChildProcess | null = null;
let currentPlayer: ChildProcess | null = null;

function getPiperDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'piper');
  }
  return path.join(app.getAppPath(), 'assets', 'piper');
}

export function speak(text: string): Promise<void> {
  return new Promise((resolve) => {
    stopSpeaking();

    const piperDir = getPiperDir();
    const piperExe = path.join(piperDir, 'piper.exe');
    const model    = path.join(piperDir, 'pt_BR-faber-medium.onnx');

    currentPiper = spawn(piperExe, ['--model', model, '--output_file', TEMP_WAV], {
      cwd: piperDir,
    });

    currentPiper.stdin?.write(text);
    currentPiper.stdin?.end();

    currentPiper.on('error', (err) => {
      console.error('[tts] piper error:', err);
      resolve();
    });

    currentPiper.on('close', (code) => {
      currentPiper = null;
      if (code !== 0) {
        console.error(`[tts] piper exited with code ${code}`);
        resolve();
        return;
      }

      // Play WAV via PowerShell SoundPlayer — path passed via env to avoid quoting issues
      currentPlayer = spawn(
        'powershell',
        [
          '-NoProfile', '-NonInteractive', '-Command',
          '$p = New-Object System.Media.SoundPlayer; $p.SoundLocation = $env:SOUND_PATH; $p.PlaySync()',
        ],
        { env: { ...process.env, SOUND_PATH: TEMP_WAV } },
      );

      currentPlayer.on('error', (err) => {
        console.error('[tts] player error:', err);
        resolve();
      });

      currentPlayer.on('close', () => {
        currentPlayer = null;
        fs.unlink(TEMP_WAV, () => {});
        resolve();
      });
    });
  });
}

export function stopSpeaking(): void {
  if (currentPlayer) { currentPlayer.kill(); currentPlayer = null; }
  if (currentPiper)  { currentPiper.kill();  currentPiper  = null; }
}
