#!/bin/bash
# Story Studio — canonical dev entrypoint.
#
# Runs `npm run dev`, which launches:
#   - Nuxt dev server on :3000
#   - tsc --watch for the Electron + backend sources
#   - Electron, which embeds the Express backend in its main process on :8000
#
# The old script shape (raw backend + frontend with no Electron window)
# predated the Electron-first architecture and was misleading; this wrapper
# is now the one true way to start the app in development.

set -euo pipefail

# Pick up Homebrew on macOS for machines where npm/node aren't on the default PATH.
[ -d "/opt/homebrew/bin" ] && export PATH="/opt/homebrew/bin:$PATH"

cd "$(cd "$(dirname "$0")" && pwd)"
exec npm run dev
