import path from 'node:path'
import { resolveAppSettingsPath } from './server-mode.js'

export function dataDir(): string { return path.dirname(resolveAppSettingsPath()) }
export function updateDir(): string { return path.join(dataDir(), 'app-update') }
export function trashDir(): string { return path.join(dataDir(), '_trash') }
export function previousAppsDir(): string { return path.join(dataDir(), 'previous-apps') }
