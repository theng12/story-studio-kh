import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { buildMenuTemplate, type MenuHandlers } from '../../menu-template.js'

function handlers(overrides: Partial<MenuHandlers> = {}): MenuHandlers {
  return {
    appName: 'Story Studio KH',
    platform: 'darwin',
    logsDir: '/tmp/logs',
    quit: () => {},
    unlockCredentials: () => {},
    showLogs: () => {},
    showUserData: () => {},
    ...overrides,
  }
}

// A real quit must always be one visible item away: the owner asked for the
// exact label and ⌘Q because quitting otherwise means Activity Monitor.
describe('application menu Quit item', () => {
  test('the app menu ends with a visible "Quit Story Studio KH" bound to ⌘Q', () => {
    let quitCalls = 0
    const template = buildMenuTemplate(handlers({ quit: () => { quitCalls += 1 } }))
    const appMenu = template[0]
    assert.equal(appMenu.label, 'Story Studio KH')
    const items = appMenu.submenu as any[]
    const quit = items.at(-1)
    assert.equal(quit.label, 'Quit Story Studio KH')
    assert.equal(quit.accelerator, 'Command+Q')
    assert.equal(quit.visible, true)
    quit.click()
    assert.equal(quitCalls, 1)
  })

  test('the stock app-menu roles survive next to the explicit Quit item', () => {
    const roles = (buildMenuTemplate(handlers())[0].submenu as any[])
      .map(item => item.role).filter(Boolean)
    for (const role of ['about', 'services', 'hide', 'hideOthers', 'unhide']) {
      assert.ok(roles.includes(role), role)
    }
  })

  test('Help keeps the credential unlock on macOS only, and its items call their handlers', () => {
    const calls: string[] = []
    const help = buildMenuTemplate(handlers({
      unlockCredentials: () => calls.push('unlock'),
      showLogs: () => calls.push('logs'),
      showUserData: () => calls.push('userdata'),
    })).at(-1)!
    const items = help.submenu as any[]
    assert.deepEqual(items.map(item => item.label), ['Unlock credentials…', 'Show Logs', 'Show User Data'])
    for (const item of items) item.click()
    assert.deepEqual(calls, ['unlock', 'logs', 'userdata'])

    const linux = buildMenuTemplate(handlers({ platform: 'linux' })).at(-1)!
    assert.deepEqual((linux.submenu as any[]).map(item => item.label), ['Show Logs', 'Show User Data'])
  })
})
