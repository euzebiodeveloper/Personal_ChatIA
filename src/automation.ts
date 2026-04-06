import { shell } from 'electron';
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
  chrome:      { win32: 'start chrome',           darwin: 'open -a "Google Chrome"',              linux: 'google-chrome' },
  firefox:     { win32: 'start firefox',          darwin: 'open -a Firefox',                      linux: 'firefox' },
  edge:        { win32: 'start msedge',           darwin: 'open -a "Microsoft Edge"',             linux: 'microsoft-edge' },
  vscode:      { win32: 'start code',             darwin: 'open -a "Visual Studio Code"',         linux: 'code' },
  notepad:     { win32: 'start notepad',          darwin: 'open -a TextEdit',                     linux: 'gedit' },
  calculator:  { win32: 'start calc',             darwin: 'open -a Calculator',                   linux: 'gnome-calculator' },
  explorer:    { win32: 'start explorer',         darwin: 'open ~',                               linux: 'nautilus' },
  terminal:    { win32: 'start cmd',              darwin: 'open -a Terminal',                     linux: 'x-terminal-emulator' },
  spotify:     { win32: 'start spotify',          darwin: 'open -a Spotify',                      linux: 'spotify' },
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
    await execAsync(`xdotool key ${key}`).catch(() => {});
  }
}

// ── Screen capture ───────────────────────────────────────────────────────────

export interface ScreenCapture {
  base64: string;
  width: number;
  height: number;
}

export async function captureScreen(): Promise<ScreenCapture> {
  const tmpPath = join(tmpdir(), `ai-assistant-screen-${Date.now()}.png`);
  const metaPath = tmpPath + '.meta.json';

  const script = `
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$screen = [System.Windows.Forms.Screen]::PrimaryScreen
$bounds = $screen.Bounds
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$g.Dispose()
$bmp.Save($env:SCREENSHOT_PATH)
$meta = '{"width":' + $bmp.Width + ',"height":' + $bmp.Height + '}'
[System.IO.File]::WriteAllText($env:META_PATH, $meta)
$bmp.Dispose()
`;
  await runPs(script, { SCREENSHOT_PATH: tmpPath, META_PATH: metaPath });

  const [data, metaRaw] = await Promise.all([readFile(tmpPath), readFile(metaPath, 'utf8')]);
  await Promise.all([rm(metaPath).catch(() => {})]);

  const meta = JSON.parse(metaRaw) as { width: number; height: number };
  console.log(`[captureScreen] screenshot saved at: ${tmpPath} (${meta.width}x${meta.height})`);

  return { base64: data.toString('base64'), width: meta.width, height: meta.height };
}

// ── PowerShell helper: no quoting issues via -EncodedCommand ─────────────────

async function runPs(script: string, env?: Record<string, string>): Promise<void> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const opts = env ? { env: { ...process.env, ...env } } : undefined;
  await execAsync(`powershell -NoProfile -EncodedCommand ${encoded}`, opts);
}

// ── Mouse control ────────────────────────────────────────────────────────────

export async function clickAt(x: number, y: number): Promise<void> {
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
}

// ── Keyboard helpers ─────────────────────────────────────────────────────────

export async function clearField(): Promise<void> {
  await runPs(`
Add-Type -AssemblyName System.Windows.Forms
Start-Sleep -Milliseconds 150
[System.Windows.Forms.SendKeys]::SendWait("^a{DELETE}")
`);
}

export async function typeText(text: string): Promise<void> {
  // Use clipboard + Ctrl+V: reliable in browsers, works with any character
  await runPs(`
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Clipboard]::SetText($env:SEND_TEXT)
Start-Sleep -Milliseconds 150
[System.Windows.Forms.SendKeys]::SendWait("^v")
`, { SEND_TEXT: text });
}

// ── Step executor ────────────────────────────────────────────────────────────

export async function executeSteps(steps: AutomationStep[], screenWidth: number, screenHeight: number): Promise<void> {
  for (const step of steps) {
    const x = Math.round(step.x_pct * screenWidth);
    const y = Math.round(step.y_pct * screenHeight);
    console.log(`[automation] passo: x_pct=${step.x_pct} y_pct=${step.y_pct} → x=${x} y=${y} exclude=${step.need_exclude} text=${step.need_text} insert="${step.insert_text ?? ''}" enter=${step.press_enter ?? false}`);

    await clickAt(x, y);
    await new Promise((r) => setTimeout(r, 500));

    if (step.need_exclude) {
      await clearField();
    }

    if (step.need_text && step.insert_text) {
      await typeText(step.insert_text);
    }

    if (step.press_enter) {
      await new Promise((r) => setTimeout(r, 150));
      await pressKey('enter');
    }
  }
}
