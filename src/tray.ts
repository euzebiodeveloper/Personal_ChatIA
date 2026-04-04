import { BrowserWindow, Menu, Tray, app, nativeImage } from 'electron';
import path from 'node:path';

let tray: Tray | null = null;

export function setupTray(win: BrowserWindow): void {
  const iconPath = path.join(__dirname, '../../assets/icons/tray.png');
  let icon: ReturnType<typeof nativeImage.createFromPath>;

  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) {
      icon = nativeImage.createEmpty();
    }
  } catch {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip('AI Assistant — Ctrl+Shift+Space para ativar');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Mostrar / Esconder',
      click: () => {
        if (win.isVisible()) {
          win.hide();
        } else {
          win.show();
          win.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Fechar',
      click: () => app.quit(),
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (win.isVisible()) {
      win.hide();
    } else {
      win.show();
      win.focus();
    }
  });
}

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
}
