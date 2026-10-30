#!/bin/bash
set -u

KIT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="${STORY_STUDIO_INSTALL_TARGET:-/Applications/Story Studio KH.app}"
TRASH="${STORY_STUDIO_INSTALL_TRASH:-$HOME/.Trash}"
DATA="${STORY_STUDIO_DATA_DIR:-$HOME/Library/Application Support/Story Studio KH}"
SOURCE="${STORY_STUDIO_INSTALL_SOURCE:-}"
PGREP="${STORY_STUDIO_INSTALL_PGREP:-/usr/bin/pgrep}"
DEVICE=""
STAGE=""
OLD=""
WORK="$(mktemp -d "${TMPDIR:-/tmp}/story-kit.XXXXXXXX")" || exit 1
mkdir -p "$TRASH" || { printf 'FAILED: Cannot access Trash: %s\n' "$TRASH"; exit 1; }
keep() {
  local name="$1" dest="$TRASH/$(basename "$1")"
  [ -e "$name" ] || return 0
  while [ -e "$dest" ]; do dest="$TRASH/$(basename "$1")-$(date +%s)-$RANDOM"; done
  mv "$name" "$dest"
}
cleanup() {
  if [ -n "$DEVICE" ]; then
    /usr/bin/hdiutil info -plist > "$WORK/info.plist" 2>/dev/null
    if /usr/libexec/PlistBuddy -c Print "$WORK/info.plist" 2>/dev/null | /usr/bin/grep -E "^[[:space:]]*dev-entry = ${DEVICE}$" >/dev/null; then
      /usr/bin/hdiutil detach "$DEVICE" || printf 'Could not detach %s; eject that disk device later.\n' "$DEVICE"
    else
      printf 'Could not confirm attached device %s; it was not detached.\n' "$DEVICE"
    fi
  fi
  [ -z "$STAGE" ] || keep "$STAGE" || printf 'Could not move unfinished staging copy to Trash: %s\n' "$STAGE"
  keep "$WORK" || printf 'Temporary installer files remain at %s\n' "$WORK"
}
trap cleanup EXIT
fail() { printf 'FAILED: %s\n' "$1" >&2; exit 1; }

if "$PGREP" -x 'Story Studio KH' >/dev/null 2>&1; then
  fail 'Story Studio is running. Quit it and run this installer again. Nothing was replaced.'
fi

if [ -z "$SOURCE" ]; then
  DMG=""
  for candidate in "$KIT_DIR"/Story\ Studio\ KH\ *-arm64.dmg; do
    [ -f "$candidate" ] || continue
    if [ -z "$DMG" ] || [ "$candidate" -nt "$DMG" ]; then DMG="$candidate"; fi
  done
  [ -n "$DMG" ] || fail 'No Story Studio KH *-arm64.dmg was found beside this installer.'
  /usr/bin/hdiutil attach -readonly -nobrowse -plist "$DMG" > "$WORK/attach.plist" || fail 'Could not attach the DMG read-only.'
  index=0
  MOUNT=""
  while entry=$(/usr/libexec/PlistBuddy -c "Print :system-entities:$index:dev-entry" "$WORK/attach.plist" 2>/dev/null); do
    if [[ "$entry" =~ ^/dev/disk[0-9]+$ ]]; then DEVICE="$entry"; fi
    mount=$(/usr/libexec/PlistBuddy -c "Print :system-entities:$index:mount-point" "$WORK/attach.plist" 2>/dev/null || true)
    [ -z "$mount" ] || MOUNT="$mount"
    index=$((index + 1))
  done
  [ -n "$DEVICE" ] && [ -n "$MOUNT" ] || fail 'Could not identify the attached disk device and app volume.'
  SOURCE="$MOUNT/Story Studio KH.app"
fi
[ -f "$SOURCE/Contents/Info.plist" ] || fail "No valid app bundle at $SOURCE."
version() { /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$1/Contents/Info.plist" 2>/dev/null; }
NEW_VERSION=$(version "$SOURCE") || fail 'The installer app has no version.'
mkdir -p "$(dirname "$TARGET")" || fail 'Cannot create the app destination.'
STAGE="$(mktemp -d "$(dirname "$TARGET")/.story-install.XXXXXXXX")" || fail 'Cannot create an app staging folder.'
/bin/cp -Rp "$SOURCE" "$STAGE/Story Studio KH.app" || fail 'The app copy failed; the existing app was not replaced.'
/usr/bin/diff -qr "$SOURCE" "$STAGE/Story Studio KH.app" >/dev/null || fail 'The staged app differs from the source; the existing app was not replaced.'
[ "$(version "$STAGE/Story Studio KH.app")" = "$NEW_VERSION" ] || fail 'The staged app version could not be verified.'
if "$PGREP" -x 'Story Studio KH' >/dev/null 2>&1; then fail 'Story Studio opened during installation. Quit it and retry.'; fi
if [ -e "$TARGET" ]; then
  OLD_VERSION=$(version "$TARGET" || printf unknown)
  OLD="$TRASH/Story Studio KH $OLD_VERSION.app"
  while [ -e "$OLD" ]; do OLD="$TRASH/Story Studio KH $OLD_VERSION-$(date +%s)-$RANDOM.app"; done
  mv "$TARGET" "$OLD" || fail 'Could not move the previous app to Trash; nothing was replaced.'
fi
if ! mv "$STAGE/Story Studio KH.app" "$TARGET"; then
  [ -z "$OLD" ] || mv "$OLD" "$TARGET" || printf 'Restore the previous app from %s\n' "$OLD"
  fail 'Could not put the staged app in place.'
fi
/usr/bin/xattr -cr "$TARGET" || fail "App $NEW_VERSION was installed, but its attributes could not be cleared."
printf 'Installed Story Studio %s.\n' "$NEW_VERSION"
[ -z "$OLD" ] || printf 'Previous app kept in Trash: %s\n' "$OLD"

MODEL="$KIT_DIR/EmbeddingGemma"
if [ ! -d "$MODEL" ]; then
  printf 'EmbeddingGemma is not in this kit. It will need to download when you choose to use duplicate screening.\n'
  exit 0
fi
[ -f "$MODEL/SHA256SUMS" ] || fail 'App installed, but EmbeddingGemma/SHA256SUMS is missing.'
[ -f "$MODEL/FILECOUNT" ] || fail 'App installed, but EmbeddingGemma/FILECOUNT is missing.'
expected_count=$(< "$MODEL/FILECOUNT")
[[ "$expected_count" =~ ^[1-9][0-9]*$ ]] || fail 'App installed, but the model file count is invalid.'
count=0
copied=0
skipped=0
while IFS= read -r line || [ -n "$line" ]; do
  [[ "$line" =~ ^([0-9a-f]{64})\ \ (embedding-models/[a-zA-Z0-9._/-]+)$ ]] || fail 'App installed, but the model hash list has an invalid line.'
  expected="${BASH_REMATCH[1]}"
  relative="${BASH_REMATCH[2]}"
  [[ "/$relative/" != *'/../'* && "/$relative/" != *'/./'* && "$relative" != *'//'* ]] || fail "Invalid model path: $relative"
  src="$MODEL/$relative"
  dst="$DATA/$relative"
  count=$((count + 1))
  if [ -f "$dst" ] && [ "$(/usr/bin/shasum -a 256 "$dst" | /usr/bin/cut -d ' ' -f 1)" = "$expected" ]; then
    skipped=$((skipped + 1)); continue
  fi
  [ -f "$src" ] || fail "App installed, but model file is missing: $relative"
  [ "$(/usr/bin/shasum -a 256 "$src" | /usr/bin/cut -d ' ' -f 1)" = "$expected" ] || fail "App installed, but model file failed SHA-256: $relative"
  mkdir -p "$(dirname "$dst")" || fail "Cannot create the folder for $relative"
  temp=$(mktemp "$(dirname "$dst")/.story-model.XXXXXXXX") || fail "Cannot stage $relative"
  if ! /bin/cp -p "$src" "$temp" || [ "$(/usr/bin/shasum -a 256 "$temp" | /usr/bin/cut -d ' ' -f 1)" != "$expected" ]; then
    keep "$temp" || true
    fail "App installed, but model copy failed verification: $relative"
  fi
  if [ -e "$dst" ]; then keep "$dst" || fail "Cannot preserve the existing file: $relative"; fi
  mv "$temp" "$dst" || fail "Cannot install model file: $relative"
  copied=$((copied + 1))
done < "$MODEL/SHA256SUMS"
[ "$count" -eq "$expected_count" ] || fail "App installed, but the model hash list has $count entries; expected $expected_count."
printf 'EmbeddingGemma ready: %s copied, %s already correct. Duplicate screening settings were not changed.\n' "$copied" "$skipped"
