#!/bin/bash
# Focused test driver for sleep title metadata and placement repairs (388).
# CRITICAL: DO NOT RUN during 387 release qualification.
# Run only after test slot is granted.
set -euo pipefail

WORKTREE="/build/Developer/_worktrees/story-studio-kh/sleep-title-metadata-388"
cd "$WORKTREE"

echo "=== Running focused sleep-title tests ==="
node --test \
  electron/server/__tests__/sleep-title-placement.test.ts \
  electron/server/__tests__/formula-legacy-alias-read-time.test.ts

echo "=== Focused sleep-title tests passed ==="
