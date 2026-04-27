import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { readFileSync } from 'node:fs'

// ESM equivalent of __dirname. Nuxt config runs before the repo root
// module-resolution chain kicks in, so we compute the shared path manually.
const __dirname = dirname(fileURLToPath(import.meta.url))

// Read the app version from the parent package.json at build time so the
// renderer can display it (sidebar footer + Settings → About). Static read
// is fine — version only changes between builds, and we don't otherwise need
// an IPC bridge from the renderer to Electron's `app.getVersion()`. Falls
// back to '0.0.0' if the file can't be read so the build never crashes.
let appVersion = '0.0.0'
try {
  const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8'))
  appVersion = pkg.version || appVersion
} catch (e) {
  // eslint-disable-next-line no-console
  console.warn('[nuxt.config] could not read parent package.json version:', e)
}
const buildDate = new Date().toISOString().slice(0, 10)

export default defineNuxtConfig({
  compatibilityDate: '2025-05-15',
  ssr: false,
  devtools: { enabled: false },

  runtimeConfig: {
    public: {
      // Surfaced in the renderer via `useRuntimeConfig().public.appVersion`.
      // Set at build time from the root package.json, so a fresh dmg always
      // reports the version it was packaged from. `buildDate` is an ISO
      // YYYY-MM-DD stamp captured at frontend build time so beta testers can
      // tell two builds of the same version apart.
      appVersion,
      buildDate,
    },
  },

  devServer: {
    port: 3000,
  },

  // `@shared` → electron/server/contracts — one source of truth for wire
  // shapes. Frontend uses `import type` only, so zod never ships to the
  // renderer bundle.
  alias: {
    '@shared': resolve(__dirname, '..', 'electron', 'server', 'contracts'),
  },

  nitro: {
    devProxy: {
      '/api': {
        target: 'http://localhost:8000/api',
        changeOrigin: true,
      },
    },
  },

  app: {
    head: {
      title: 'Story Studio KH',
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'description', content: 'Story production dashboard' },
      ],
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
      ],
    },
  },

  // fonts.css must come before main.css so @font-face rules resolve
  // before any element with `font-family: Inter` is styled. Inter WOFF2
  // ships locally at /fonts/inter/ — no CDN round-trip, no bandwidth
  // hit after first build, and the UI renders correctly offline.
  css: ['~/assets/css/fonts.css', '~/assets/css/main.css'],
})
