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

if [ "$REAL_TARGET" = yes ]; then
  echo "== stopping any running copy"
  osascript -e 'quit app "Story Studio KH"' >/dev/null 2>&1 || true
  sleep 3
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
