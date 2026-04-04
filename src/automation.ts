import { shell } from 'electron';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

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
