import { desktopCapturer, shell, app, screen } from 'electron';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AutomationStep } from './types';

const execAsync = promisify(exec);

// Safe set of keyboard keys allowed via automation
const ALLOWED_KEYS = new Set([
  'enter', 'escape', 'tab', 'backspace', 'delete',
  'up', 'down', 'left', 'right',
  'home', 'end', 'pageup', 'pagedown',
  'f5', 'f11', 'f12',
]);

// Whitelisted app launchers per platform
type PlatformCmds = { win32: string; darwin: string; linux: string };
const APP_LAUNCHERS: Record<string, PlatformCmds> = {
  // Browsers
  chrome:        { win32: 'start chrome',              darwin: 'open -a "Google Chrome"',           linux: 'google-chrome' },
  firefox:       { win32: 'start firefox',             darwin: 'open -a Firefox',                   linux: 'firefox' },
  edge:          { win32: 'start msedge',              darwin: 'open -a "Microsoft Edge"',          linux: 'microsoft-edge' },
  // Dev tools
  vscode:        { win32: 'start code',                darwin: 'open -a "Visual Studio Code"',      linux: 'code' },
  terminal:      { win32: 'start cmd',                 darwin: 'open -a Terminal',                  linux: 'x-terminal-emulator' },
  powershell:    { win32: 'start powershell',          darwin: 'open -a Terminal',                  linux: 'x-terminal-emulator' },
  // System
  notepad:       { win32: 'start notepad',             darwin: 'open -a TextEdit',                  linux: 'gedit' },
  calculator:    { win32: 'start calc',                darwin: 'open -a Calculator',                linux: 'gnome-calculator' },
  calculadora:   { win32: 'start calc',                darwin: 'open -a Calculator',                linux: 'gnome-calculator' },
  explorer:      { win32: 'start explorer',            darwin: 'open ~',                            linux: 'nautilus' },
  paint:         { win32: 'start mspaint',             darwin: 'open -a Preview',                   linux: 'gimp' },
  taskmanager:   { win32: 'start taskmgr',             darwin: 'open -a "Activity Monitor"',        linux: 'gnome-system-monitor' },
  // Office
  word:          { win32: 'start winword',             darwin: 'open -a "Microsoft Word"',          linux: 'libreoffice --writer' },
  excel:         { win32: 'start excel',               darwin: 'open -a "Microsoft Excel"',         linux: 'libreoffice --calc' },
  powerpoint:    { win32: 'start powerpnt',            darwin: 'open -a "Microsoft PowerPoint"',    linux: 'libreoffice --impress' },
  outlook:       { win32: 'start outlook',             darwin: 'open -a "Microsoft Outlook"',       linux: 'thunderbird' },
  teams:         { win32: 'start teams',               darwin: 'open -a "Microsoft Teams"',         linux: 'teams' },
  onenote:       { win32: 'start onenote',             darwin: 'open -a "Microsoft OneNote"',       linux: 'xdg-open https://onenote.com' },
  // Communication
  discord:       { win32: 'start discord',             darwin: 'open -a Discord',                   linux: 'discord' },
  whatsapp:      { win32: 'start whatsapp',            darwin: 'open -a WhatsApp',                  linux: 'whatsapp-desktop' },
  telegram:      { win32: 'start telegram',            darwin: 'open -a Telegram',                  linux: 'telegram-desktop' },
  slack:         { win32: 'start slack',               darwin: 'open -a Slack',                     linux: 'slack' },
  zoom:          { win32: 'start zoom',                darwin: 'open -a zoom.us',                   linux: 'zoom' },
  // Media
  spotify:       { win32: 'start spotify',             darwin: 'open -a Spotify',                   linux: 'spotify' },
  vlc:           { win32: 'start vlc',                 darwin: 'open -a VLC',                       linux: 'vlc' },
  obs:           { win32: 'start obs64',               darwin: 'open -a OBS',                       linux: 'obs' },
  // Games
  steam:         { win32: 'start steam',               darwin: 'open -a Steam',                     linux: 'steam' },
  epicgames:     { win32: 'start "Epic Games Launcher"', darwin: 'open -a "Epic Games Launcher"',  linux: 'epic-games-launcher' },
};

export async function executeAction(
  action: string,
  params: Record<string, string>,
): Promise<void> {
  switch (action) {
    case 'open_url': {
      if (!params.url) break;
      try {
        const parsed = new URL(params.url);
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
          await shell.openExternal(parsed.href);
        }
      } catch {
        console.warn('[automation] Invalid URL:', params.url);
      }
      break;
    }

    case 'open_app': {
      const appName = (params.app ?? '').toLowerCase().trim();
      const launcher = APP_LAUNCHERS[appName];
      if (launcher) {
        const plat = process.platform as keyof PlatformCmds;
        const cmd = launcher[plat] ?? launcher.linux;
        await execAsync(cmd).catch((err) =>
          console.warn('[automation] open_app failed:', err.message),
        );
      } else if (process.platform === 'win32') {
        // Fallback: sanitize and try Start-Process (uses PATH + App Paths registry)
        const sanitized = appName.replace(/[^a-z0-9\s\-_.]/gi, '').trim();
        if (sanitized) {
          console.log(`[automation] open_app fallback: Start-Process '${sanitized}'`);
          await execAsync(`powershell -NoProfile -Command "Start-Process '${sanitized}'"`)           .catch((err) => console.warn('[automation] open_app fallback failed:', err.message));
        }
      } else {
        console.warn('[automation] Unknown app:', appName);
      }
      break;
    }

    case 'press_key': {
      const key = (params.key ?? '').toLowerCase();
      if (!ALLOWED_KEYS.has(key)) {
        console.warn('[automation] Key not in allowlist:', key);
        break;
      }
      await pressKey(key);
      break;
    }

    default:
      console.warn('[automation] Unknown action:', action);
  }
}

// ── System info ──────────────────────────────────────────────────────────────

export async function saveSystemInfo(): Promise<void> {
  const display = screen.getPrimaryDisplay();
  const info = {
    platform: process.platform,
    screenWidth: display.size.width,
    screenHeight: display.size.height,
    scaleFactor: display.scaleFactor,
    savedAt: new Date().toISOString(),
  };
  const filePath = join(app.getPath('userData'), 'system-info.json');
  await writeFile(filePath, JSON.stringify(info, null, 2), 'utf8');
  console.log('[system] info salvo em:', filePath);
  console.log('[system]', JSON.stringify(info));
}

async function pressKey(key: string): Promise<void> {
  if (process.platform === 'win32') {
    const ps = `
      Add-Type -AssemblyName System.Windows.Forms
      [System.Windows.Forms.SendKeys]::SendWait('{${key.toUpperCase()}}')
    `;
    await execAsync(`powershell -NoProfile -Command "${ps.replace(/\n\s*/g, '; ')}"`).catch(() => {});
  } else if (process.platform === 'darwin') {
    // osascript approach for simple keys
    const keyMap: Record<string, string> = {
      enter: 'return', escape: 'escape', tab: 'tab',
      backspace: 'delete', delete: 'forwarddelete',
    };
    const key2 = keyMap[key] ?? key;
    await execAsync(`osascript -e 'tell application "System Events" to key code "${key2}"'`).catch(() => {});
  }
  // Linux: xdotool (best-effort)
  else {
    const linuxKeyMap: Record<string, string> = {
      enter: 'Return', escape: 'Escape', tab: 'Tab',
      backspace: 'BackSpace', delete: 'Delete',
      up: 'Up', down: 'Down', left: 'Left', right: 'Right',
      home: 'Home', end: 'End', pageup: 'Page_Up', pagedown: 'Page_Down',
    };
    const xKey = linuxKeyMap[key] ?? key;
    await execAsync(`xdotool key ${xKey}`).catch(() => {});
  }
}

export async function pressKeyCombo(combo: string): Promise<void> {
  // combo format: "alt+left", "alt+right", "f5", "ctrl+w", "ctrl+t"
  if (process.platform === 'win32') {
    // SendKeys notation: % = Alt, ^ = Ctrl, + = Shift
    const sendKeysMap: Record<string, string> = {
      'alt+left':  '%{LEFT}',
      'alt+right': '%{RIGHT}',
      'f5':        '{F5}',
      'ctrl+w':    '^w',
      'ctrl+t':    '^t',
      'ctrl+r':    '^r',
    };
    const sk = sendKeysMap[combo.toLowerCase()];
    if (!sk) return;
    const ps = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${sk}')`;
    await execAsync(`powershell -NoProfile -Command "${ps}"`).catch(() => {});
  } else if (process.platform === 'darwin') {
    const osascriptMap: Record<string, string> = {
      'alt+left':  'keystroke (ASCII character 28) using {option down}',
      'alt+right': 'keystroke (ASCII character 29) using {option down}',
      'f5':        'key code 96',
      'ctrl+w':    'keystroke "w" using {command down}',
      'ctrl+t':    'keystroke "t" using {command down}',
      'ctrl+r':    'keystroke "r" using {command down}',
    };
    const cmd = osascriptMap[combo.toLowerCase()];
    if (!cmd) return;
    await execAsync(`osascript -e 'tell application "System Events" to ${cmd}'`).catch(() => {});
  } else {
    const xdoMap: Record<string, string> = {
      'alt+left':  'alt+Left',
      'alt+right': 'alt+Right',
      'f5':        'F5',
      'ctrl+w':    'ctrl+w',
      'ctrl+t':    'ctrl+t',
      'ctrl+r':    'ctrl+r',
    };
    const xk = xdoMap[combo.toLowerCase()];
    if (!xk) return;
    await execAsync(`xdotool key ${xk}`).catch(() => {});
  }
}

// ── Screen capture ───────────────────────────────────────────────────────────

export interface ScreenCapture {
  base64: string;
  width: number;
  height: number;
}

export async function captureScreen(): Promise<ScreenCapture> {
  const { width, height } = screen.getPrimaryDisplay().size;
  const thumbW = 960;
  const thumbH = Math.round(height * 960 / width);

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: thumbW, height: thumbH },
  });

  const source = sources[0];
  if (!source) throw new Error('desktopCapturer: nenhuma fonte de tela encontrada');

  const jpegBuffer = source.thumbnail.toJPEG(75);
  console.log(`[captureScreen] ${thumbW}x${thumbH} (tela real: ${width}x${height})`);
  return { base64: jpegBuffer.toString('base64'), width, height };
}

// ── PowerShell helper: writes script to a temp .ps1 file to avoid AV false positives ──

async function runPs(script: string, env?: Record<string, string>): Promise<void> {
  const psPath = join(tmpdir(), `ai-ps-${Date.now()}.ps1`);
  await writeFile(psPath, script, 'utf8');
  const opts = env ? { env: { ...process.env, ...env } } : undefined;
  try {
    await execAsync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psPath}"`, opts);
  } finally {
    await rm(psPath).catch(() => {});
  }
}

// ── Mouse control ────────────────────────────────────────────────────────────

export async function clickAt(x: number, y: number): Promise<void> {
  if (process.platform === 'win32') {
    await runPs(`
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class MouseOps {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, int dwExtraInfo);
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP   = 0x0004;
}
"@
[MouseOps]::SetCursorPos(${x}, ${y})
Start-Sleep -Milliseconds 80
[MouseOps]::mouse_event([MouseOps]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
Start-Sleep -Milliseconds 80
[MouseOps]::mouse_event([MouseOps]::MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
`);
  } else {
    await execAsync(`xdotool mousemove ${x} ${y} click 1`).catch(() => {});
  }
}

// ── Keyboard helpers ─────────────────────────────────────────────────────────

export async function clearField(): Promise<void> {
  if (process.platform === 'win32') {
    await runPs(`
Add-Type -AssemblyName System.Windows.Forms
Start-Sleep -Milliseconds 150
[System.Windows.Forms.SendKeys]::SendWait("^a{DELETE}")
`);
  } else {
    await new Promise((r) => setTimeout(r, 150));
    await execAsync(`xdotool key ctrl+a Delete`).catch(() => {});
  }
}

export async function typeText(text: string): Promise<void> {
  if (process.platform === 'win32') {
    // Use clipboard + Ctrl+V: reliable in browsers, works with any character
    await runPs(`
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Clipboard]::SetText($env:SEND_TEXT)
Start-Sleep -Milliseconds 150
[System.Windows.Forms.SendKeys]::SendWait("^v")
`, { SEND_TEXT: text });
  } else {
    // Linux: write to temp file → xclip → Ctrl+V (safe with arbitrary characters)
    const tmpTextPath = join(tmpdir(), `ai-text-${Date.now()}.txt`);
    await writeFile(tmpTextPath, text, 'utf8');
    await execAsync(`xclip -selection clipboard < "${tmpTextPath}"`).catch(() =>
      execAsync(`xsel --clipboard --input < "${tmpTextPath}"`)
    );
    await rm(tmpTextPath).catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
    await execAsync(`xdotool key ctrl+v`).catch(() => {});
  }
}

// Types text character by character via SendKeys — required for date inputs
// where Ctrl+V paste does not work (browser date pickers consume keys individually)
export async function typeTextCharByChar(text: string): Promise<void> {
  if (process.platform === 'win32') {
    // Escape SendKeys special chars: + ^ % ~ { } [ ] ( )
    const escaped = text.replace(/([+^%~{}[\]()])/g, '{$1}');
    await runPs(`
Add-Type -AssemblyName System.Windows.Forms
$chars = [System.Text.RegularExpressions.Regex]::Matches($env:SEND_TEXT, '.')
foreach ($c in $chars) {
  [System.Windows.Forms.SendKeys]::SendWait($c.Value)
  Start-Sleep -Milliseconds 80
}
`, { SEND_TEXT: escaped });
  } else {
    for (const char of text) {
      await execAsync(`xdotool type --clearmodifiers --delay 80 '${char.replace("'", "'\\''")}' `).catch(() => {});
    }
  }
}

// ── Step executor ────────────────────────────────────────────────────────────

export async function executeSteps(steps: AutomationStep[], screenWidth: number, screenHeight: number): Promise<void> {
  for (const step of steps) {
    const x = Math.round(Math.min(Math.max(step.x_pct, 0.0), 1.0) * screenWidth);
    const y = Math.round(Math.min(Math.max(step.y_pct, 0.0), 1.0) * screenHeight);
    console.log(`[automation] passo: x_pct=${step.x_pct} y_pct=${step.y_pct} → x=${x} y=${y} exclude=${step.need_exclude} text=${step.need_text} insert="${step.insert_text ?? ''}" enter=${step.press_enter ?? false}`);

    await clickAt(x, y);
    await new Promise((r) => setTimeout(r, 500));

    if (step.need_exclude) {
      await clearField();
    }

    if (step.need_text && step.insert_text) {
      // Date fields (e.g. "01/01/1990", "2026-04-06") require char-by-char input
      // because the browser date picker does not accept clipboard paste
      const isDateValue = /^\d{1,4}[\/-]\d{1,2}[\/-]\d{2,4}$/.test(step.insert_text.trim());
      if (isDateValue) {
        await typeTextCharByChar(step.insert_text);
      } else {
        await typeText(step.insert_text);
      }
    }

    if (step.press_enter) {
      await new Promise((r) => setTimeout(r, 150));
      await pressKey('enter');
    }
  }
}
