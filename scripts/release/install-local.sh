#!/bin/bash
# Install the built Story Studio bundle, keeping the one it replaces.
#
# **Why this is a script and not a line in the handoff.** The step used to be four commands typed by
# hand, and the second of them moved the installed bundle into `_trash/app/` — a folder that exists
# only because a previous install made it. Twice now that move has failed and the install carried
# on: `ditto` then writes over the bundle in place, so the previous version is **gone**, not trashed.
#
#   * 1.4.232 → recorded in the handoff: *"the install step's `mv` of the old bundle into
#     `_trash/app/` failed because that folder did not exist; `ditto` overwrote the 1.4.231 bundle
#     in place."* The note added afterwards said `_trash/app/` now exists "so the next install moves
#     rather than overwrites" — which is an assumption about a folder, not a guarantee.
#   * 1.4.237 (2026-09-28) → the same `mv` failed the same way and **1.4.236 was overwritten**. The
#     folder was gone because `_trash/` is the owner's to empty, and he had. **That is the point:
#     a procedure that breaks when the owner tidies his own trash is the wrong procedure.**
#
# So the folder is created here, every time, and a move that cannot be done is a **failure** rather
# than something to carry on past. The previous bundle is named with the version it was, so a walk
# back is one `ditto` away.
#
# Usage:
#   bash scripts/release/install-local.sh                       # dist/mac-arm64/… → /Applications
#   bash scripts/release/install-local.sh path/to/Story\ Studio\ KH.app
#
# `STORY_STUDIO_INSTALL_TARGET` and `STORY_STUDIO_INSTALL_TRASH` override the destination and trash,
# which is what the test uses so it never touches the real install, owner trash, or running app.
#
# **Running jobs.** Before quitting, the script asks the running app for `/api/system/queue/status`.
# With jobs running it pauses the queue (running work stops at its next safe point), waits up to
# `STORY_STUDIO_INSTALL_WAIT_SECONDS` (default 1800) for them, installs, relaunches, and presses
# Resume — which releases only the jobs the queue pause held. A queue the owner had already paused,
# and any job he paused by hand, stays paused. `STORY_STUDIO_API` names the app's address instead
# of finding it (the test's fake app).
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SOURCE="${1:-$ROOT/dist/mac-arm64/Story Studio KH.app}"
TARGET="${STORY_STUDIO_INSTALL_TARGET:-/Applications/Story Studio KH.app}"
TRASH="${STORY_STUDIO_INSTALL_TRASH:-$ROOT/_trash/app}"

if [ ! -d "$SOURCE" ]; then
  echo "No built bundle at: $SOURCE"
  echo "Build one first:  npm run dist:smoke"
  exit 1
fi
if [ ! -f "$SOURCE/Contents/Info.plist" ]; then
  echo "Refusing to install $SOURCE: it has no Contents/Info.plist, so it is not an app."
  exit 1
fi

NEW_VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
                "$SOURCE/Contents/Info.plist" 2>/dev/null || echo unknown)
echo "== installing $NEW_VERSION from $SOURCE"

# Only the real install gets to interrupt the app. A test installing into a temp path must not quit
# or replace the copy someone is working in.
REAL_TARGET=no
[ "$TARGET" = "/Applications/Story Studio KH.app" ] && REAL_TARGET=yes

# The running app's API: the given address, or the loopback port the app listens on.
find_api() {
  if [ -n "${STORY_STUDIO_API:-}" ]; then echo "$STORY_STUDIO_API"; return; fi
  [ "$REAL_TARGET" = yes ] || return
  local pid port
  pid=$(pgrep -x "Story Studio KH" | head -1)
  [ -n "$pid" ] || return
  for port in $(lsof -nP -a -p "$pid" -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR > 1 { sub(/.*:/, "", $9); print $9 }'); do
    if curl -fsS -m 3 "http://127.0.0.1:$port/api/system/queue/status" >/dev/null 2>&1; then
      echo "http://127.0.0.1:$port"
      return
    fi
  done
}
queue_status() { curl -fsS -m 5 "$1/api/system/queue/status" 2>/dev/null; }
json_field() { printf '%s' "$1" | plutil -extract "$2" raw -o - - 2>/dev/null; }

WE_PAUSED=no
API=$(find_api)
if [ -n "$API" ]; then
  STATUS=$(queue_status "$API")
  RUNNING=$(json_field "$STATUS" stats.running)
  RUNNING=${RUNNING:-0}
  if [ "$RUNNING" -gt 0 ]; then
    if [ "$(json_field "$STATUS" paused)" = true ]; then
      echo "== the queue is already paused (yours, left as it is); waiting for $RUNNING running job(s) to stop"
    elif curl -fsS -m 10 -X POST "$API/api/system/queue/pause" >/dev/null 2>&1; then
      WE_PAUSED=yes
      echo "== $RUNNING job(s) running: paused the queue so they stop at a safe point"
    else
      echo "== could not pause the queue; waiting for $RUNNING running job(s) anyway"
    fi
    WAIT=${STORY_STUDIO_INSTALL_WAIT_SECONDS:-1800}
    POLL=${STORY_STUDIO_INSTALL_POLL_SECONDS:-5}
    START=$SECONDS
    while [ "$RUNNING" -gt 0 ] && [ $((SECONDS - START)) -lt "$WAIT" ]; do
      echo "   waiting: $RUNNING job(s) still running ($((SECONDS - START))s of ${WAIT}s)"
      sleep "$POLL"
      RUNNING=$(json_field "$(queue_status "$API")" stats.running)
      RUNNING=${RUNNING:-0}
    done
    if [ "$RUNNING" -gt 0 ]; then
      echo "== $RUNNING job(s) still running after ${WAIT}s; installing anyway. They pick up where they"
      echo "   left off after the relaunch, or show Retry in Jobs. Story Studio asks before it quits."
    fi
  fi
fi
# A failed install must not leave a silent hold behind.
trap '[ "$WE_PAUSED" = yes ] && echo "NOTE: this install paused the queue; press Resume in Jobs once Story Studio is open."' EXIT

if [ "$REAL_TARGET" = yes ]; then
  echo "== stopping any running copy"
  osascript -e 'quit app "Story Studio KH"' >/dev/null 2>&1 || true
  # Never move a bundle that is still running (a Quit question may be waiting for an answer).
  for _ in $(seq 1 60); do pgrep -x "Story Studio KH" >/dev/null || break; sleep 2; done
  if pgrep -x "Story Studio KH" >/dev/null; then
    echo "FAILED: Story Studio KH is still open. Answer its Quit question (or quit it), then run this again."
    echo "        Nothing was replaced."
    exit 1
  fi
fi

if [ -d "$TARGET" ]; then
  OLD_VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
                  "$TARGET/Contents/Info.plist" 2>/dev/null || echo unknown)
  # **Created here, not assumed.** This is the line whose absence lost a bundle twice.
  mkdir -p "$TRASH"
  DEST="$TRASH/Story Studio KH.app-$OLD_VERSION"
  # One copy per version: never a silent overwrite of the previous *trash* entry either.
  [ -e "$DEST" ] && DEST="$DEST-$(date +%Y%m%d%H%M%S)"
  echo "== keeping the installed $OLD_VERSION → ${DEST#"$ROOT"/}"
  # A failure here stops the install. Carrying on is what turns "kept" into "overwritten".
  if ! mv "$TARGET" "$DEST"; then
    echo "FAILED: could not move the installed bundle aside, so nothing was replaced."
    echo "        The installed app is untouched. Fix the move and run this again."
    exit 1
  fi
fi

echo "== copying $NEW_VERSION into place"
if ! ditto "$SOURCE" "$TARGET"; then
  echo "FAILED: the copy did not complete."
  exit 1
fi
xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null || true

INSTALLED=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
              "$TARGET/Contents/Info.plist" 2>/dev/null || echo unknown)
if [ "$INSTALLED" != "$NEW_VERSION" ]; then
  echo "FAILED: $TARGET reports '$INSTALLED', expected '$NEW_VERSION'"
  exit 1
fi
echo "== installed $INSTALLED"

if [ "$REAL_TARGET" = yes ]; then
  # `env -u ELECTRON_RUN_AS_NODE` because a shell that has that set makes the app boot as Node.
  env -u ELECTRON_RUN_AS_NODE open -a "$TARGET" && echo "== launched"
fi

if [ "$WE_PAUSED" = yes ]; then
  # The relaunched app listens on a new port; give it time to boot.
  API=""
  for _ in $(seq 1 60); do
    API=$(find_api)
    [ -n "$API" ] && break
    sleep 2
  done
  if [ -n "$API" ] && curl -fsS -m 10 -X POST "$API/api/system/queue/resume" >/dev/null 2>&1; then
    WE_PAUSED=no
    echo "== resumed the queue (jobs you paused by hand stay paused)"
  fi
fi
