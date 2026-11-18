#!/bin/zsh
# One release gate, driven by a config file.
#
#   scripts/gate-run.sh <config>
#
# The config is a small shell file sourced here, kept with that release's records, for example:
#   APP_LABEL       short app id used in the evidence file names      (story)
#   WORKTREE        the checkout to gate                              (required)
#   EXPECTED_HEAD   the exact commit this gate is allowed to prove    (required)
#   EVIDENCE_DIR    where logs and summary.txt go                     (required)
#   LANE_APP        app name for app-test-lock.sh                     (APP_LABEL)
#   LOCK_HOLDER     holder name recorded on the lane                  (lead name)
#   STEPS           which steps to run, in order  (default: lint build dist:smoke test)
#   ISOLATE_TRASH   1 = unset STORY_STUDIO_RETAINED_FIXTURES_ROOT so the harness uses its own
#
# The guard is the point: it refuses a dirty tree or the wrong commit before and after, so a green
# line always names the commit and tree it proved. A step that fails stops the gate; nothing is
# retried silently and no bar is lowered.
set -uo pipefail
CONF="${1:?usage: scripts/gate-run.sh <config>}"
[ -r "$CONF" ] || { echo "no config at $CONF" >&2; exit 1; }
source "$CONF"
: "${WORKTREE:?WORKTREE missing}" "${EXPECTED_HEAD:?EXPECTED_HEAD missing}" "${EVIDENCE_DIR:?EVIDENCE_DIR missing}"
APP_LABEL="${APP_LABEL:-story}"; LANE_APP="${LANE_APP:-$APP_LABEL}"; LOCK_HOLDER="${LOCK_HOLDER:-$APP_LABEL-lead}"
STEPS="${STEPS:-lint build dist:smoke test}"
[ "${ISOLATE_TRASH:-1}" = "1" ] && unset STORY_STUDIO_RETAINED_FIXTURES_ROOT

LOCK_SH="/build/Developer/_orchestra/tools/app-test-lock.sh"
LANE_MEM="/build/Developer/_orchestra/tools/lane-mem.sh"
mkdir -p "$EVIDENCE_DIR"
S() { echo "=== $1 $(date '+%H:%M:%S') ===" | tee -a "$EVIDENCE_DIR/summary.txt"; }

cd "$WORKTREE" || exit 1

tree_now() { git rev-parse 'HEAD^{tree}'; }
identity_ok() {
  [ "$(git rev-parse --short HEAD)" = "$EXPECTED_HEAD" ] || { S "ABORT HEAD=$(git rev-parse --short HEAD) != $EXPECTED_HEAD"; return 1; }
  [ -z "$(git status --porcelain)" ] || { S "ABORT dirty tree"; git status --porcelain; return 1; }
}
identity_ok || exit 1
S "before: HEAD=$EXPECTED_HEAD TREE=$(tree_now) CLEAN"

# One heavy lane per app. A killed run leaves a dead pid on the lane, so sweep only a pid that is
# really gone; `release` itself refuses while a build or test for this app is live.
LOCKED=0
cleanup() { [ "$LOCKED" = "1" ] && { zsh "$LOCK_SH" release "$LANE_APP" || true; LOCKED=0; } }
trap cleanup EXIT
attempts=0
while :; do
  wait_rc=0
  wait_out="$(zsh "$LOCK_SH" wait "$LANE_APP" "$LOCK_HOLDER" --minutes 30)" || wait_rc=$?
  printf '%s\n' "$wait_out" | tee -a "$EVIDENCE_DIR/00-lock-wait.log"
  printf '%s\n' "$wait_out" | grep -q '^ACQUIRED:' && break
  [ "$wait_rc" -eq 3 ] && { S "ABORT wait withdrawn"; exit 1; }
  holder=$(sed -n 's/.*holder-pid \([0-9]*\).*/\1/p' /build/Developer/_orchestra/tools/ui-acceptance.lock/heavy/owner 2>/dev/null)
  if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
    echo "stale holder $holder is not running — sweeping it" | tee -a "$EVIDENCE_DIR/00-lock-wait.log"
    zsh "$LOCK_SH" release "$LANE_APP" 2>&1 | tee -a "$EVIDENCE_DIR/00-lock-wait.log"
  fi
  attempts=$((attempts+1)); [ "$attempts" -ge 16 ] && { S "ABORT gave up waiting"; exit 1; }
done
LOCKED=1

[ -L "$WORKTREE/frontend/dist" ] && rm -f "$WORKTREE/frontend/dist"
node -e "import('./scripts/release/release-utils.mjs').then(m => { const e = m.packagingTreeErrors('.'); if (e.length) { console.error(e.join('\n')); process.exit(1) } })" \
  || { S "FAILED packagingTreeErrors"; exit 1; }

n=0
for step in ${=STEPS}; do
  n=$((n+1)); id=$(printf '%02d-%s' "$n" "${step//:/_}")
  S "$id $step"
  rc=0
  case "$step" in
    lint)          npm run lint > "$EVIDENCE_DIR/$id.log" 2>&1 || rc=$? ;;
    fetch:ffmpeg)  npm run fetch:ffmpeg > "$EVIDENCE_DIR/$id.log" 2>&1 || rc=$? ;;
    build)         /build/Developer/_orchestra/tools/lane-mem.sh "$APP_LABEL-build" -- npm run build > "$EVIDENCE_DIR/$id.log" 2>&1 || rc=$? ;;
    dist:smoke)    /build/Developer/_orchestra/tools/lane-mem.sh "$APP_LABEL-dist-smoke" -- npm run dist:smoke > "$EVIDENCE_DIR/$id.log" 2>&1 || rc=$? ;;
    test)          /build/Developer/_orchestra/tools/lane-mem.sh "$APP_LABEL-test" -- npm test > "$EVIDENCE_DIR/$id.log" 2>&1 || rc=$? ;;
    *)             S "ABORT unknown step $step"; exit 1 ;;
  esac
  peak=$(grep -E '^PEAK ' "$EVIDENCE_DIR/$id.log" 2>/dev/null | tail -1)
  echo "$id rc=$rc ${peak:+$peak}" | tee -a "$EVIDENCE_DIR/summary.txt"
  [ "$rc" -eq 0 ] || { S "GATE-FAILED $step"; exit 1; }
done

rm -f "$WORKTREE/frontend/dist" 2>/dev/null || true
S "post-gate clean-tree guard"
identity_ok || exit 1
echo "after-gate: HEAD=$EXPECTED_HEAD TREE=$(tree_now) CLEAN" | tee -a "$EVIDENCE_DIR/summary.txt"
echo "GATE-OK $(date '+%Y-%m-%d %H:%M:%S %z') steps=[$STEPS]" | tee -a "$EVIDENCE_DIR/summary.txt"
