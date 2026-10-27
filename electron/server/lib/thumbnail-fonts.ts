/**
 * Bundled font inventory for the thumbnail text layer.
 *
 * The fonts are OFL files shipped in `bundled/fonts/<id>/` and copied into the build through
 * `extraResources` (the same way `bundled/ffmpeg` is). Nothing here invents a face or guesses a
 * family: the manifest names the file, its SHA-256 and the scripts it really covers, and the
 * renderer resolves the face from that file.
 *
 * `AGENTS §1` is why this reads a manifest rather than a constant list: GenStudio publishes model
 * capabilities, not fonts, so the font catalogue is the app's own — and adding a font later must be
 * only "drop files + a manifest entry".
 */

import fs from 'fs/promises'
import { existsSync, writeFileSync, mkdirSync } from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { ThumbnailFont } from '../contracts/thumbnail-text.js'

export interface FontManifestEntry extends ThumbnailFont {
  /** File inside this font's own folder, e.g. `KantumruyPro[wght].ttf`. */
  file: string
  /** SHA-256 of that file, so a swapped or truncated font is caught. */
  sha256: string
  /** The face name fontconfig resolves for this file. */
  family: string
  /** Licence file shipped beside it. */
  license_file: string
  /** Where the file came from — one line, for the licence audit. */
  source_url: string
}

export interface FontManifest {
  fonts: FontManifestEntry[]
}

const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * The bundled fonts directory.
 *
 * Packaged: `Contents/Resources/fonts`. In dev: run from the bundle beside this module, which is
 * what makes `npm run dev` show the same faces the DMG will. `STORY_STUDIO_RESOURCES_DIR` is the
 * same override `getBundledBinaryPath` honours, so a test or a probe can point both at one root.
 */
export function fontsResourceDir(): string {
  const override = process.env.STORY_STUDIO_RESOURCES_DIR
  if (override) return path.join(override, 'fonts')
  const packaged = process.resourcesPath ? path.join(process.resourcesPath, 'fonts') : ''
  if (packaged && existsSync(path.join(packaged, 'fonts.json'))) return packaged
  // repo root: electron/server/<...> → ../../..
  return path.resolve(HERE, '../../../bundled/fonts')
}

export function fontManifestPath(): string {
  return path.join(fontsResourceDir(), 'fonts.json')
}

let cached: FontManifest | null = null

/** The manifest, read once. `fontsResourceDir()` can change between tests, so key the cache on it. */
let cachedFrom: string | null = null

export async function readFontManifest(): Promise<FontManifest> {
  const from = fontsResourceDir()
  if (cached && cachedFrom === from) return cached
  const raw = await fs.readFile(path.join(from, 'fonts.json'), 'utf-8')
  const parsed = JSON.parse(raw) as FontManifest
  if (!Array.isArray(parsed?.fonts) || !parsed.fonts.length) {
    throw new Error(`The bundled font manifest at ${path.join(from, 'fonts.json')} lists no fonts.`)
  }
  cached = parsed
  cachedFrom = from
  return parsed
}

/** Forget the cached manifest (tests). */
export function clearFontManifestCache(): void {
  cached = null
  cachedFrom = null
}

/** Absolute path of a font's file. */
export function fontFilePath(entry: FontManifestEntry): string {
  return path.join(fontsResourceDir(), entry.id, entry.file)
}

export async function sha256File(file: string): Promise<string> {
  const bytes = await fs.readFile(file)
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

/** The public catalogue the picker reads. */
export async function listThumbnailFonts(): Promise<ThumbnailFont[]> {
  const manifest = await readFontManifest()
  return manifest.fonts.map(entry => ({
    id: entry.id,
    label: entry.label,
    scripts: entry.scripts,
    weights: entry.weights,
    role: entry.role,
    license: entry.license,
    source: 'bundled' as const,
  }))
}

export async function fontById(id: string): Promise<FontManifestEntry | null> {
  const manifest = await readFontManifest()
  return manifest.fonts.find(font => font.id === id) ?? null
}

/** Throw with a plain message when a font id is not one this build ships. */
export async function requireFont(id: string): Promise<FontManifestEntry> {
  const font = await fontById(id)
  if (!font) {
    const manifest = await readFontManifest()
    throw new ThumbnailFontError(
      `Font "${id}" is not one of this build's bundled fonts (${manifest.fonts.map(f => f.id).join(', ')}).`,
    )
  }
  return font
}

/** A refusal the route turns into a 400 with the message intact. */
export class ThumbnailFontError extends Error {}

// ── Fontconfig ─────────────────────────────────────────────────────────────
//
// libvips/Pango on macOS ignores the `fontfile` option sharp accepts: with a size set, every
// fontfile renders byte-identically (measured), and with only a fontfile the face is right but the
// size is fixed and tiny. So the face is resolved the one way it can be resolved deterministically:
// a fontconfig configuration that lists the bundled directory, set BEFORE the first font is used.
//
// `fontfile` is therefore never passed to sharp. `font_stack.ts` owns that decision in one place.

const FONTCONFIG_FILE = 'fonts.conf'
let fontconfigDir: string | null = null

/**
 * Point fontconfig at the bundled fonts and return the config file's path.
 *
 * Called once, before sharp renders any text. Idempotent: later calls return the same config. The
 * cache directory is private to this process so a packaged app inside a read-only bundle never
 * tries to write its cache next to the fonts.
 */
export function configureFontconfig(): string {
  if (fontconfigDir) return path.join(fontconfigDir, FONTCONFIG_FILE)

  const dir = path.join(os.tmpdir(), `story-thumbnail-fonts-${process.pid}`)
  let configFile = path.join(dir, FONTCONFIG_FILE)
  try {
    const cacheDir = path.join(dir, 'cache')
    mkdirSync(dir, { recursive: true })
    mkdirSync(cacheDir, { recursive: true })
    const xml = [
      '<?xml version="1.0"?>',
      '<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">',
      '<fontconfig>',
      `<dir>${fontsResourceDir()}</dir>`,
      `<cachedir>${cacheDir}</cachedir>`,
      '</fontconfig>',
      '',
    ].join('\n')
    writeFileSync(configFile, xml)
    process.env.FONTCONFIG_FILE = configFile
    process.env.FONTCONFIG_PATH = dir
    fontconfigDir = dir
    return configFile
  } catch {
    // A fontconfig we could not write is a refusal, not a quiet fallback to the system's faces.
    throw new Error(
      'Story Studio could not prepare its bundled fonts directory, so a headline would have been '
      + `drawn in an unchosen face. Nothing was rendered. (Tried to write ${configFile}.)`,
    )
  }
}

/** Whether the config was prepared in this process (tests assert the renderer really did it). */
export function fontconfigConfigured(): boolean {
  return !!fontconfigDir
}/** The Fontconfig file path currently in force, or null. */
export function fontconfigFile(): string | null {
  return fontconfigDir ? path.join(fontconfigDir, FONTCONFIG_FILE) : null
}

// ── Making the bundled faces visible to Pango on macOS ─────────────────────
//
// MEASURED, 2026-10-27 (this build, macOS, libvips 8.18.6 / Pango 1.58.2): on macOS
// pangocairo renders through CoreText, whose font map is the system's. The `<dir>` in the fontconfig
// file above is therefore NOT what resolves a family here — a family resolves only because the same
// file happens to be installed in `~/Library/Fonts`. The five fonts Story Studio shipped before
// today were all installed by hand on the owner's Mac, which is why the self-check passed and hid
// this. A bundled font that is not installed is not found at all, and the renderer refuses loudly
// (which is the right failure, but it means a fresh Mac has no bundled faces).
//
// So the app installs its own fonts the way macOS understands: it copies each bundled file into
// `~/Library/Fonts/Story Studio/` when that family cannot be resolved. It never overwrites a family
// the Mac already has, so a customer's own Inter is left exactly as it is.

/** Where the app puts bundled fonts the system does not already have. */
export function bundledFontInstallDir(): string {
  return path.join(os.homedir(), 'Library', 'Fonts', 'Story Studio')
}

/**
 * True when Pango can draw with `family` at all.
 *
 * Same evidence the renderer's self-check uses: a request that resolves produces different pixels
 * from a request for a family that does not exist. It cannot tell WHICH face came back, only that
 * the request was honoured — which is the question here.
 */
export async function familyResolves(family: string): Promise<boolean> {
  const sharp = (await import('sharp')).default
  const sample = 'Hamburgefonstiv'
  const [target, probe] = await Promise.all([
    sharp({ text: { text: sample, font: `${family} Regular 40`, rgba: true } }).png().toBuffer(),
    sharp({ text: { text: sample, font: `${MISSING_FAMILY} Regular 40`, rgba: true } }).png().toBuffer(),
  ])
  if (target.length !== probe.length) return true
  const [a, b] = await Promise.all([sharp(target).metadata(), sharp(probe).metadata()])
  return a.width !== b.width || a.height !== b.height
}

/** The family name used to prove a request was honoured (never a real face). */
const MISSING_FAMILY = 'Story Studio Font Probe (not a real family)'

export interface FontInstallResult {
  /** Font ids that were already usable on this Mac. */
  present: string[]
  /** Font ids copied into `~/Library/Fonts/Story Studio/` just now. */
  installed: string[]
  /** Font ids that could not be installed, with the reason. */
  failed: Array<{ id: string; reason: string }>
}

/**
 * Install any bundled font this Mac cannot resolve yet.
 *
 * Runs at boot, so the copy happens long before anyone asks for a picture. It is idempotent and
 * cheap: a family that already resolves costs one small render and nothing else.
 */
export async function ensureBundledFontsInstalled(): Promise<FontInstallResult> {
  const result: FontInstallResult = { present: [], installed: [], failed: [] }
  // Never touch the customer's home from a test run, and let a diagnostic opt out too.
  if (process.env.STORY_STUDIO_SKIP_FONT_INSTALL === '1') return result
  if (process.env.STORY_STUDIO_TEST_HARNESS_ROOT || process.env.NODE_ENV === 'test') return result
  const manifest = await readFontManifest()
  let targetDir: string | null = null
  for (const entry of manifest.fonts) {
    try {
      if (await familyResolves(entry.family)) {
        result.present.push(entry.id)
        continue
      }
      targetDir ??= bundledFontInstallDir()
      await fs.mkdir(targetDir, { recursive: true })
      const destination = path.join(targetDir, entry.file.split('/').pop() || `${entry.id}.ttf`)
      if (existsSync(destination)) {
        const same = (await sha256File(destination)) === entry.sha256
        if (same) {
          // Already there but not yet visible to this process — nothing more to do; the system
          // font daemon indexes new files within a few seconds of the first launch.
          result.present.push(entry.id)
          continue
        }
      }
      await fs.copyFile(fontFilePath(entry), destination)
      result.installed.push(entry.id)
    } catch (error: any) {
      result.failed.push({ id: entry.id, reason: error?.message || String(error) })
    }
  }
  return result
}
