#!/bin/bash
# Uninstall Story Studio KH from this Mac: the app, its helper, its login job — never the user's data.
#
# Owner rule 2026-11-12: every app must release everything on quit and on delete. So this removes
#   * the running app (quit first, not killed, so its own cleanup runs),
#   * /Applications/Story Studio KH.app — which carries `Story Studio KH Helper.app` inside it, so the
#     helper goes with the app and cannot be left behind,
#   * the login job `local.storystudio.kh` (booted out of launchd and its plist removed),
# and it leaves the owner's work alone: `~/Documents/Story Studio KH` and the app's data folder in
# `~/Library/Application Support/Story Studio KH` are printed, never touched.
#
# Nothing is deleted outright: the app and the plist are moved to a dated folder, the same way the
# installer keeps the bundle it replaces.
#
# Usage:
#   bash scripts/release/uninstall-local.sh            # this Mac, the real install
#   STORY_STUDIO_UNINSTALL_TARGET=... STORY_STUDIO_UNINSTALL_TRASH=... STORY_STUDIO_UNINSTALL_HOME=... \
#     bash scripts/release/uninstall-local.sh          # what the test uses, on fixtures
set -euo pipefail

LABEL="local.storystudio.kh"
TARGET="${STORY_STUDIO_UNINSTALL_TARGET:-/Applications/Story Studio KH.app}"
TRASH_ROOT="${STORY_STUDIO_UNINSTALL_TRASH:-$HOME/Desktop/_trash/app}"
HOME_DIR="${STORY_STUDIO_UNINSTALL_HOME:-$HOME}"
PLIST="$HOME_DIR/Library/LaunchAgents/$LABEL.plist"
DATA_DIRS=("$HOME_DIR/Documents/Story Studio KH" "$HOME_DIR/Library/Application Support/Story Studio KH")
WAIT_SECONDS="${STORY_STUDIO_UNINSTALL_WAIT_SECONDS:-20}"
STAMP="$(date +"%Y-%m-%d %H%M%S")"
TRASH="$TRASH_ROOT/uninstalled-$STAMP"

moved=0
kept=()

# 1. Quit the running app and let it release its ports and helpers itself.
if pgrep -x "Story Studio KH" >/dev/null 2>&1; then
  echo "== quitting the running app"
  osascript -e 'quit app "Story Studio KH"' >/dev/null 2>&1 || true
  for _ in $(seq 1 $((WAIT_SECONDS * 2))); do pgrep -x "Story Studio KH" >/dev/null 2>&1 || break; sleep 0.5; done
  if pgrep -x "Story Studio KH" >/dev/null 2>&1; then
    echo "FAILED: Story Studio KH is still running; nothing was removed" >&2
    exit 1
  fi
fi

# 2. Unload and remove the login job. Bootout first, so launchd cannot relaunch a job whose
#    executable is about to disappear.
if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  echo "== booted out $LABEL"
fi
if [ -f "$PLIST" ]; then
  mkdir -p "$TRASH"
  mv "$PLIST" "$TRASH/"
  moved=$((moved + 1))
  echo "== login job plist → $TRASH/$LABEL.plist"
fi

# 3. Move the app (helper included) to the trash folder.
if [ -d "$TARGET" ]; then
  VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$TARGET/Contents/Info.plist" 2>/dev/null || echo unknown)
  mkdir -p "$TRASH"
  mv "$TARGET" "$TRASH/Story Studio KH $VERSION.app"
  moved=$((moved + 1))
  echo "== app $VERSION (helper included) → $TRASH/Story Studio KH $VERSION.app"
fi

# 4. Prove nothing of Story's is left behind.
leftovers=0
pgrep -x "Story Studio KH" >/dev/null 2>&1 && { echo "LEFT: a Story Studio KH process" >&2; leftovers=1; }
pgrep -f "Story Studio KH Helper" >/dev/null 2>&1 && { echo "LEFT: a Story Studio KH Helper process" >&2; leftovers=1; }
launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 && { echo "LEFT: launchd job $LABEL" >&2; leftovers=1; }
[ -f "$PLIST" ] && { echo "LEFT: $PLIST" >&2; leftovers=1; }
[ -d "$TARGET" ] && { echo "LEFT: $TARGET" >&2; leftovers=1; }

for dir in "${DATA_DIRS[@]}"; do
  [ -e "$dir" ] && kept+=("$dir")
done
echo "== moved $moved item(s) to $TRASH"
if [ ${#kept[@]} -gt 0 ]; then
  printf '== kept your data: %s\n' "${kept[@]}"
fi
if [ "$leftovers" -ne 0 ]; then
  echo "FAILED: something of Story Studio KH is still installed (see LEFT above)" >&2
  exit 1
fi
echo "== uninstalled; nothing of Story Studio KH is left running, listening or loaded"
