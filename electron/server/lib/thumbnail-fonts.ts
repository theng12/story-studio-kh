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
}

/** The Fontconfig file path currently in force, or null. */
export function fontconfigFile(): string | null {
  return fontconfigDir ? path.join(fontconfigDir, FONTCONFIG_FILE) : null
}
