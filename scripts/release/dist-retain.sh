#!/bin/zsh
# Retain exactly the accepted versions in this app's dist/ — current + previous.
#
# The helper never guesses which DMGs to keep: it acts on a trusted pin document naming the versions
# you accepted, their sources, sha256, bytes and acceptance evidence. Run it only AFTER the release
# was accepted. Note `python3 tools/release-dist.py --help` does not exist — a missing pin document
# used to print a bare usage line through `npm run dist:retain` and read like a broken path.
#
# Usage: npm run dist:retain -- <pins.json>
set -u
HELPER="$HOME/Developer/Shared Tools/portfolio/tools/release-dist.py"
if [ ! -f "$HELPER" ]; then
  print -u2 "retention helper not found at: $HELPER"
  print -u2 "fix the path above (README: Shared Tools/portfolio, \"Release dist retention\") before retiring anything"
  exit 2
fi
if [ $# -ne 1 ] || [ ! -f "$1" ]; then
  print -u2 "usage: npm run dist:retain -- <pins.json>"
  print -u2 "the pin document names the accepted versions, their sources, hashes and evidence"
  print -u2 "shape: ~/Developer/Shared Tools/portfolio/README.md, section \"Release dist retention\""
  exit 2
fi
exec python3 -I "$HELPER" "$1"
