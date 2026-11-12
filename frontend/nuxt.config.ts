import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import {
  resolveDevApiProxy,
  formatDevApiProxyLog,
  formatDevApiProxyWarning,
} from '../electron/server/lib/dev-backend'
import tailwindcss from '@tailwindcss/vite'

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

// Where Nitro's `/api` devProxy forwards to. Resolved, never guessed:
// STORY_STUDIO_API_PROXY → server mode's configured port (read from the same
// app-settings.json the backend binds from) → the dev backend default. The
// resolver lives next to the backend that owns those ports so the two can't
// drift; see electron/server/lib/dev-backend.ts for the full story. It reads
// files but never throws, so a broken settings file can't take down the dev
// server — it downgrades to the default and says so on stderr.
const apiProxy = resolveDevApiProxy()
const apiProxyWarning = formatDevApiProxyWarning(apiProxy)
// eslint-disable-next-line no-console
if (apiProxyWarning) console.error(apiProxyWarning)
// eslint-disable-next-line no-console
console.log(formatDevApiProxyLog(apiProxy))
const apiProxyTarget = apiProxy.target

export default defineNuxtConfig({
  compatibilityDate: '2025-05-15',
  ssr: false,
  devtools: { enabled: false },

  modules: ['shadcn-nuxt'],
  shadcn: {
    // Ui prefix keeps generic names like Button from colliding with the
    // app's own auto-imported components.
    prefix: 'Ui',
    componentDir: '@/components/ui',
  },

  runtimeConfig: {
    public: {
      // Surfaced in the renderer via `useRuntimeConfig().public.appVersion`.
      // Set at build time from the root package.json, so a fresh dmg always
      // reports the version it was packaged from. `buildDate` is an ISO
      // YYYY-MM-DD stamp captured at frontend build time so beta testers can
      // tell two builds of the same version apart.
      appVersion,
      buildDate,
      // Product name surfaced in browser tab titles via `useAppTitle()`.
      // Centralised here so a future rebrand / whitelabel touches one place
      // instead of nineteen `useHead({ title: '... — Story Studio KH' })`
      // calls across pages.
      appName: 'Story Studio KH',
    },
  },

  devServer: {
    port: 3000,
  },

  // `@shared` → electron/server/contracts — one source of truth for wire
  // shapes and cross-boundary constants. `@shared/contracts` carries the zod
  // wire schemas; frontend uses `import type` only there, so zod never ships
  // to the renderer bundle. Plain-value constants with no dependencies of
  // their own (e.g. `@shared/pacing`) live in their own sibling module
  // instead, so frontend runtime code can import the actual value without
  // dragging zod along with it — see electron/server/contracts/pacing.ts.
  alias: {
    '@shared': resolve(__dirname, '..', 'electron', 'server', 'contracts'),
  },

  nitro: {
    devProxy: {
      '/api': {
        target: apiProxyTarget,
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
      // v1.0.147+ — sync inline boot script that resolves the user's
      // chosen theme (localStorage → matchMedia fallback) and stamps
      // <html data-theme> + color-scheme BEFORE the bundle parses and
      // any stylesheet applies. Without this, light-mode users would
      // see a brief dark flash on every page load because main.css's
      // :root defaults paint before the .client.ts plugin runs.
      // Keep the storage key + media query in sync with
      // composables/useTheme.ts (the runtime owner).
      script: [
        {
          tagPosition: 'head',
          type: 'text/javascript',
          innerHTML:
            "(function(){try{" +
              "var k='story-studio:theme';" +
              "var m=localStorage.getItem(k);" +
              "if(m!=='light'&&m!=='dark'&&m!=='system')m='system';" +
              "var r=m==='system'?(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'):m;" +
              "var d=document.documentElement;" +
              "d.setAttribute('data-theme',r);" +
              "d.style.colorScheme=r;" +
            "}catch(e){}})();",
        },
      ],
    },
  },

  // fonts.css must come before main.css so @font-face rules resolve
  // before any element with `font-family: Inter` is styled. Inter WOFF2
  // ships locally at /fonts/inter/ — no CDN round-trip, no bandwidth
  // hit after first build, and the UI renders correctly offline.
  css: [
    // Tailwind first: its preflight is overridden by the app's own unlayered
    // CSS below, and its utilities are used only by the new ui/ components.
    '~/assets/css/tailwind.css',
    '~/assets/css/fonts.css',
    '~/assets/css/main.css',
    '~/assets/css/design-system.css',
  ],

  vite: {
    plugins: [tailwindcss()],
  },
})
