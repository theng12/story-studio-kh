#!/usr/bin/env node
/**
 * Measured WCAG contrast for the app's colour tokens.
 *
 * Reads the live values out of frontend/assets/css/main.css (never a copy), so
 * the check follows a token change and cannot drift from what ships.
 *
 *   node scripts/check-contrast.mjs          # print every pair, exit 1 on a failure
 *
 * AA normal text is 4.5:1. Status colours are checked as text (they are used
 * for messages and badges); they are not used as page copy.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const CSS_PATH = resolve(HERE, '../frontend/assets/css/main.css')
const AA = 4.5

export function parseTokens(css) {
  const blocks = {}
  const re = /(:root(?:\[data-theme="light"\])?)\s*\{([^}]*)\}/g
  let match
  while ((match = re.exec(css))) {
    const name = match[1] === ':root' ? 'dark' : 'light'
    const tokens = blocks[name] || (blocks[name] = {})
    const body = match[2].replace(/\/\*[\s\S]*?\*\//g, '')
    for (const line of body.split(';')) {
      const token = /^\s*(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*$/.exec(line)
      if (token) tokens[token[1]] = token[2]
    }
  }
  return blocks
}

export function relativeLuminance(hex) {
  const value = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map(i => parseInt(value.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrastRatio(a, b) {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** The pairs the product actually renders. */
export const PAIRS = [
  { fg: '--text-primary', bg: '--bg-primary', label: 'body text', required: true },
  { fg: '--text-primary', bg: '--bg-secondary', label: 'body text on cards', required: true },
  { fg: '--text-primary', bg: '--bg-tertiary', label: 'body text on raised surfaces', required: true },
  { fg: '--text-primary', bg: '--bg-hover', label: 'body text on hover', required: true },
  { fg: '--text-secondary', bg: '--bg-primary', label: 'secondary text', required: true },
  { fg: '--text-secondary', bg: '--bg-secondary', label: 'secondary text on cards', required: true },
  { fg: '--text-secondary', bg: '--bg-tertiary', label: 'secondary text on raised surfaces', required: true },
  { fg: '--text-muted', bg: '--bg-primary', label: 'muted text', required: true },
  { fg: '--text-muted', bg: '--bg-secondary', label: 'muted text on cards', required: true },
  { fg: '--text-muted', bg: '--bg-tertiary', label: 'muted text on raised surfaces', required: true },
  { fg: '--text-muted', bg: '--bg-hover', label: 'muted text on hover', required: true },
  { fg: '--accent-on', bg: '--accent', label: 'primary button text', required: true },
  { fg: '--accent-on', bg: '--accent-hover', label: 'primary button text (hover)', required: true },
  { fg: '--accent', bg: '--bg-primary', label: 'accent link text', required: true },
  { fg: '--accent', bg: '--bg-secondary', label: 'accent link text on cards', required: true },
  { fg: '--success', bg: '--bg-primary', label: 'success state', required: true },
  { fg: '--success', bg: '--bg-secondary', label: 'success state on cards', required: true },
  { fg: '--error', bg: '--bg-primary', label: 'error state', required: true },
  { fg: '--error', bg: '--bg-secondary', label: 'error state on cards', required: true },
  { fg: '--warning', bg: '--bg-primary', label: 'warning state', required: true },
  { fg: '--warning', bg: '--bg-secondary', label: 'warning state on cards', required: true },
  { fg: '--info', bg: '--bg-primary', label: 'info state', required: true },
  { fg: '--info', bg: '--bg-secondary', label: 'info state on cards', required: true },
]

export function checkTheme(tokens) {
  return PAIRS.map(pair => {
    const fg = tokens[pair.fg]
    const bg = tokens[pair.bg]
    if (!fg || !bg) return { ...pair, ratio: null, pass: false, missing: !fg ? pair.fg : pair.bg }
    const ratio = contrastRatio(fg, bg)
    return { ...pair, fgValue: fg, bgValue: bg, ratio, pass: !pair.required || ratio >= AA }
  })
}

export function formatReport(theme, rows) {
  return [`${theme.toUpperCase()}`]
    .concat(rows.map(row => {
      const value = row.missing ? `missing ${row.missing}` : `${row.ratio.toFixed(2)}:1`
      const verdict = row.pass ? 'PASS' : 'FAIL'
      return `  ${verdict}  ${value.padStart(9)}  ${row.label}  (${row.fg} on ${row.bg})`
    }))
    .join('\n')
}

export function readTokens() {
  return parseTokens(readFileSync(CSS_PATH, 'utf8'))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const themes = readTokens()
  let failed = false
  for (const theme of ['dark', 'light']) {
    const rows = checkTheme(themes[theme] || {})
    if (rows.some(row => !row.pass)) failed = true
    console.log(formatReport(theme, rows))
  }
  if (failed) {
    console.error(`\nContrast check failed: required pairs must reach ${AA}:1 (WCAG AA).`)
    process.exit(1)
  }
  console.log(`\nAll required pairs reach ${AA}:1 or better.`)
}
