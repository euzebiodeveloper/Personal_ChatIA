/**
 * Window context detection + file system automation.
 * Uses PowerShell to detect the foreground window process on Windows.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readdir, rename, rm } from 'node:fs/promises';
import { shell } from 'electron';
import { logger } from './logger';

const execAsync = promisify(exec);

export interface ActiveWindow {
  processName: string;   // e.g. "chrome", "explorer", "notepad"
  title: string;         // window title
  isBrowser: boolean;
  isExplorer: boolean;
}

const BROWSER_PROCESSES = new Set([
  'chrome', 'opera', 'opera_gx', 'firefox', 'msedge', 'brave', 'vivaldi', 'arc',
]);

const PS_GET_ACTIVE = `
$h = Add-Type -MemberDefinition '
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
' -Name WinApi -PassThru -ErrorAction SilentlyContinue
$hwnd = $h::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
$h::GetWindowText($hwnd, $sb, 512) | Out-Null
$pid = 0
$h::GetWindowThreadProcessId($hwnd, [ref]$pid) | Out-Null
$p = Get-Process -Id $pid -ErrorAction SilentlyContinue
[PSCustomObject]@{ process = $p.ProcessName; title = $sb.ToString() } | ConvertTo-Json -Compress
`.trim().replace(/\n\s*/g, '; ');

export async function getActiveWindow(): Promise<ActiveWindow | null> {
  if (process.platform !== 'win32') return null;
  try {
    const { stdout } = await execAsync(`powershell -NoProfile -Command "${PS_GET_ACTIVE}"`, { timeout: 2000 });
    const parsed = JSON.parse(stdout.trim()) as { process: string; title: string };
    const processName = (parsed.process ?? '').toLowerCase().replace('.exe', '');
    const title = parsed.title ?? '';
    return {
      processName,
      title,
      isBrowser: BROWSER_PROCESSES.has(processName),
      isExplorer: processName === 'explorer',
    };
  } catch {
    return null;
  }
}

// ── File system automation ───────────────────────────────────────────────────

export interface FileSystemAction {
  kind: 'create_file' | 'create_folder' | 'open_folder' | 'list_folder' | 'delete' | 'rename';
  path: string;
  content?: string;    // for create_file
  newName?: string;    // for rename
}

export async function executeFileSystemAction(action: FileSystemAction): Promise<string> {
  const { kind, path: targetPath } = action;
  logger.info(`[fs] ${kind}: ${targetPath}`);

  switch (kind) {
    case 'create_file': {
      await writeFile(targetPath, action.content ?? '', 'utf8');
      return `Arquivo criado: ${targetPath}`;
    }
    case 'create_folder': {
      await mkdir(targetPath, { recursive: true });
      return `Pasta criada: ${targetPath}`;
    }
    case 'open_folder': {
      await shell.openPath(targetPath);
      return `Pasta aberta: ${targetPath}`;
    }
    case 'list_folder': {
      const entries = await readdir(targetPath, { withFileTypes: true });
      const names = entries.map((e) => (e.isDirectory() ? `[pasta] ${e.name}` : e.name));
      return names.length > 0 ? names.join(', ') : 'Pasta vazia.';
    }
    case 'delete': {
      await rm(targetPath, { recursive: true, force: true });
      return `Removido: ${targetPath}`;
    }
    case 'rename': {
      if (!action.newName) throw new Error('newName obrigatório para rename');
      const dir = targetPath.split(/[\\/]/).slice(0, -1).join('/');
      const dest = `${dir}/${action.newName}`;
      await rename(targetPath, dest);
      return `Renomeado para: ${dest}`;
    }
    default:
      throw new Error(`Ação desconhecida: ${kind}`);
  }
}
