#!/bin/bash
# Host-side publish guard for Story Studio KH — never run from a Story session.
#
# A Story session cannot publish: ssh to the updater host is refused by its key policy (2026-11-12).
# Story's step ends at the artifact — build, verify, publish nothing, hand the Developer the DMG path
# with its sha256 and byte count. The Developer runs this (or khu directly) on the host and returns the
# served-feed readback, which Story records as attributed to them.
#
# `~/Library/KHUpdater/feed` is a mirror. Writing it makes `khu publish` say "published", changes
# nothing any Mac reads, and is indistinguishable from success — 1.4.393 was first "published" that
# way on 2026-11-12 and served nothing. So this script refuses any feed path under $HOME, and it
# verifies the result by reading the feed back from wherever the host serves it, not from disk here.
#
# Usage (on the updater host, or over ssh on the host's own filesystem):
#   bash scripts/release/publish-story.sh <version> <dmg> --host-feed <feed dir on the host> \
#     [--changelog <repo>] [--readback <served release.json URL>]
#
# Exits non-zero and says why when the path is the local mirror, when the DMG's version does not match,
# or when the readback does not advertise that version and hash.
set -euo pipefail

VERSION="${1:?usage: publish-story.sh <version> <dmg> --host-feed <dir> [--changelog <repo>] [--readback <url>]}"
DMG="${2:?the DMG path is required}"
shift 2
FEED=""; CHANGELOG="."; READBACK=""
while [ $# -gt 0 ]; do
  case "$1" in
    --host-feed) FEED="${2:?}"; shift 2 ;;
    --changelog) CHANGELOG="${2:?}"; shift 2 ;;
    --readback)  READBACK="${2:?}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$FEED" ] || { echo "refusing: --host-feed is required (the host's feed directory)" >&2; exit 2; }
[ -f "$DMG" ] || { echo "refusing: no such DMG: $DMG" >&2; exit 2; }

# The mirror trap: a feed path under $HOME on this Mac is never the host's live feed.
# abspath, not `cd`, so a path that does not exist yet is still judged.
FEED_ABS=$(python3 -I -c 'import os,sys; print(os.path.abspath(sys.argv[1]))' "$FEED")
HOME_ABS=$(python3 -I -c 'import os,sys; print(os.path.abspath(sys.argv[1]))' "$HOME")
case "$FEED_ABS" in
  "$HOME_ABS"/*)
    echo "refusing: '$FEED' is inside \$HOME — that is this Mac's mirror, not the updater host's feed." >&2
    echo "A write there reports success and serves nothing. Pass the host's feed directory instead." >&2
    exit 2 ;;
esac

# Prove the artifact names the version being published; the caller has already verified its contents.
case "$(basename "$DMG")" in
  *"$VERSION"*) ;;
  *) echo "refusing: $DMG does not name version $VERSION" >&2; exit 2 ;;
esac

KHU="${KHU_BIN:-$HOME/Library/KHUpdater/bin/khu}"
KEY="${KHU_KEY:-$HOME/Library/KHUpdater/keys/private.key}"
echo "== publishing $VERSION from $DMG to $FEED"
"$KHU" publish --feed "$FEED" --key "$KEY" --app story --version "$VERSION" \
  --artifact "$DMG" --changelog "$CHANGELOG"

# A publish is only done when the SERVED feed changes.
if [ -n "$READBACK" ]; then
  echo "== reading the served feed back from $READBACK"
  python3 -I - "$READBACK" "$VERSION" "$(shasum -a 256 "$DMG" | awk '{print $1}')" <<'PY'
import base64, json, sys, urllib.request
url, version, sha = sys.argv[1:4]
with urllib.request.urlopen(url, timeout=20) as response:
    body = json.load(response)
feed = json.loads(base64.b64decode(body['feed']).decode()) if isinstance(body.get('feed'), str) else body
story = feed['apps']['story']
if story['version'] != version or story['sha256'] != sha:
    sys.exit(f"FAILED: served feed advertises {story['version']} {story['sha256'][:12]}…, not {version} {sha[:12]}…")
print(f"served: story {story['version']} {story['sha256'][:12]}… {story['bytes']} bytes")
PY
else
  echo "== verify by hand: read release.json FROM THE HOST and match version, sha256 and bytes" >&2
fi
