import type { MenuItemConstructorOptions } from 'electron'

export interface MenuHandlers {
  appName: string
  platform: NodeJS.Platform
  logsDir: string
  showLogs: () => void
  showUserData: () => void
  quit: () => void
}

// The application menu is spelled out instead of using the `appMenu` role so the
// Quit item keeps its exact label and ⌘Q binding even if Electron's role
// defaults change: quitting is the only way out without Activity Monitor.
export function buildMenuTemplate(h: MenuHandlers): MenuItemConstructorOptions[] {
  const appMenu: MenuItemConstructorOptions = {
    label: h.appName,
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      {
        label: `Quit ${h.appName}`,
        accelerator: 'Command+Q',
        visible: true,
        click: () => h.quit(),
      },
    ],
  }

  return [
    appMenu,
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'Show Logs',
          click: () => h.showLogs(),
        },
        {
          label: 'Show User Data',
          click: () => h.showUserData(),
        },
      ],
    },
  ]
}
