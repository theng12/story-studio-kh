import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// ESM equivalent of __dirname. Nuxt config runs before the repo root
// module-resolution chain kicks in, so we compute the shared path manually.
const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineNuxtConfig({
  compatibilityDate: '2025-05-15',
  ssr: false,
  devtools: { enabled: false },

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
