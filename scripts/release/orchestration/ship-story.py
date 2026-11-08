"""Publish a gated Story release through the Gateway and update the Mac mini. Run AFTER the full gate,
main push and main-built `npm run dist:smoke`.  usage: python3 -I ship-story.py 1.4.320 [--observe|--publish-only]

Same safety contract as story-319-gate/{publish-319-compat-landed,mini-319-update-landed}.py, without
per-release copies: main must be clean and equal origin/main; the DMG hash is read, never typed; an
exclusive fsynced intent file is written BEFORE each POST so a POST is never repeated (a leftover
intent means observe only); an already-offered/already-requested release is adopted; the mini update
is the normal guarded check-in (no force/restart/pause change). Receipts go to story-releases/<ver>/.

KH_GATEWAY_URL must be set to an explicit http(s) origin before anything else: there is no local
fallback.  The DMG is staged to the Gateway host at
/build/story-release-staging/<version>-<head8> using known-host SSH, its remote SHA-256 is
verified exactly, and that remote path is what gets published.

Before the FIRST publish or mini-update mutation this refuses to proceed unless a full-gate proof
(tools/story_gate_proof.py) verifies against this exact checkout: all canonical steps exit 0, every
log hash re-derived, test lanes at their discovered coverage floor with no PARTIAL RUN, and the proof
bound to the shipped HEAD/tree/diff.  A schema-2 composite proof is accepted when its original
gate stopped on one failing test lane: every other step and lane is re-verified, and the failed
lane is reconciled file by file against a focused rerun at the candidate source.  There is no
bypass.  `--observe` stays GET-only and needs no proof.  Pass `--gate-proof <dir>` to point at a
proof other than the default.
"""
import hashlib, json, os, shlex, subprocess, sys, time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit


def stop(why):
    print('STOP:', why)
    raise SystemExit(1)


def gateway_origin():
    # Explicit origin only: never fall back to a discovered local setting, and never echo the value.
    raw = os.environ.get('KH_GATEWAY_URL', '')
    try:
        u = urlsplit(raw)
        u.port  # an out-of-range or non-numeric port raises here
    except ValueError:
        stop('KH_GATEWAY_URL must be an explicit http(s) origin')
    if (u.scheme not in ('http', 'https') or not u.hostname
            or u.username is not None or u.password is not None
            or u.path not in ('', '/') or u.query or u.fragment):
        stop('KH_GATEWAY_URL must be an explicit http(s) origin')
    return raw.rstrip('/'), u.hostname


GW_ORIGIN, GW_HOST = gateway_origin()
ORIGIN_SHA = hashlib.sha256(GW_ORIGIN.encode()).hexdigest()

sys.path.insert(0, '/build/Developer/_orchestra/audit-20261011/vision/gateway')
sys.path.insert(0, '/build/Developer/_orchestra/codex-takeover-20261012/tools/recovered-helpers')
sys.path.insert(0, str(Path(__file__).resolve().parent))
import gw, mini_api  # admin / Story keys are read in-process, never printed
import story_gate_proof

VERSION = None
OBSERVE = '--observe' in sys.argv
P = Path('/build/Developer/story-studio-kh')
D = None
INSTANCE = 'macmini-angkor'
SSH_KEY = '/build/.ssh/id_ed25519_gateway1301'
head = tree = diff_sha = None


def arg(flag, default):
    for i, a in enumerate(sys.argv):
        if a == flag and i + 1 < len(sys.argv): return sys.argv[i + 1]
        if a.startswith(flag + '='): return a.split('=', 1)[1]
    return default


GATE_PROOF = None


def now(): return datetime.now(timezone.utc).isoformat()
def record(name, data):
    path = D / f'{name}-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}.json'
    with path.open('x') as f: f.write(json.dumps({'at': now(), **data}, indent=2) + '\n')
    print(name, json.dumps(data)[:400], flush=True)
def git(*a): return subprocess.check_output(['git', *a], cwd=P, text=True).strip()
_proof = None
def require_gate_proof():
    global _proof
    if _proof is None:
        try: _proof = story_gate_proof.verify(GATE_PROOF, head, tree, diff_sha, VERSION, repo=P)
        except story_gate_proof.ProofError as e: stop(f'full-gate proof rejected: {e}')
        record('gate-proof', _proof)
    return _proof
def intent(name, data):
    fd = os.open(D / name, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write(json.dumps({'at': now(), **data}) + '\n'); f.flush(); os.fsync(f.fileno())
    dfd = os.open(D, os.O_RDONLY); os.fsync(dfd); os.close(dfd)
def state():
    code, s = gw.call('GET', '/admin/api/story/instances')
    if code != 200 or not isinstance(s, dict): stop(f'instances read HTTP {code}')
    row = next((r for r in s.get('instances', []) if r.get('instance_id') == INSTANCE), {})
    rel = {k: (s.get('release') or {}).get(k) for k in ('version', 'sha256', 'bytes', 'filename')}
    upd = row.get('update') or {}
    return rel, {'version': row.get('version'), 'request': row.get('update_request_id'),
                 'phase': upd.get('phase'), 'error_present': bool(upd.get('error')),
                 'queue': {k: (row.get('queue') or {}).get(k) for k in ('held', 'paused', 'queued', 'running')}}
def health():
    # The mini restarts while it installs: a refused or timed-out connection is "not up yet", not a failure.
    try: code, h = mini_api.get('/health')
    except OSError as e: return {'http': None, 'unreachable': type(e).__name__, 'status': None, 'version': None, 'boot_complete': None}
    h = h if isinstance(h, dict) else {}
    return {'http': code, **{k: h.get(k) for k in ('status', 'version', 'boot_complete')}}


def sh(args):
    # Known-host SSH only; fail closed without echoing the command, URL or key.
    try:
        return subprocess.check_output(args, text=True, stderr=subprocess.DEVNULL).strip()
    except (subprocess.SubprocessError, OSError) as e:
        stop(f'Gateway staging command failed ({type(e).__name__}); no retry')


def stage(version, artifact, sha, head):
    remote_dir = f'/build/story-release-staging/{version}-{head[:8]}'
    remote_artifact = remote_dir + '/' + Path(artifact).name
    target = 'vengtheng@' + GW_HOST
    opts = ['-i', SSH_KEY, '-o', 'StrictHostKeyChecking=yes',
            '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=10']
    identity = {'version': version, 'sha256': sha, 'remote_artifact': remote_artifact,
                'origin_sha256': ORIGIN_SHA}
    intent_path = D / 'stage.intent'
    if intent_path.exists():
        prior = json.loads(intent_path.read_text()); prior.pop('at', None)
        if prior != identity: stop('staging identity mismatch: observe only')
    else:
        intent('stage.intent', identity)
        sh(['ssh', *opts, target, 'test ! -e ' + shlex.quote(remote_dir)
            + ' && mkdir ' + shlex.quote(remote_dir)])
        sh(['scp', *opts, str(artifact), target + ':' + shlex.quote(remote_dir) + '/'])
    if sh(['ssh', *opts, target, 'shasum -a 256 ' + shlex.quote(remote_artifact)]).split()[:1] != [sha]:
        stop('Gateway staged artifact hash mismatch')
    return remote_artifact


def publish(version, head, art, sha, size):
    rel, mini = state()
    if rel['version'] == version:
        if (rel['sha256'], rel['bytes']) != (sha, size): stop('a DIFFERENT artifact is offered under this version')
        record('publish-adopted', {'release': rel})
        return rel, mini
    if (D / 'publish.intent').exists(): stop('publish intent exists from an earlier run: observe only')
    require_gate_proof()
    remote_artifact = stage(version, art, sha, head)
    intent('publish.intent', {'version': version, 'artifact': art, 'sha256': sha, 'bytes': size,
                              'origin_sha256': ORIGIN_SHA, 'remote_artifact': remote_artifact})
    code, ans = gw.call('POST', '/admin/api/story/release/publish', {'artifact_path': remote_artifact})
    record('publish', {'http': code})
    if code != 200: stop('publication answer not 200; NO retry; use --observe')
    rel, mini = state()
    if (rel['version'], rel['sha256'], rel['bytes']) != (version, sha, size): stop(f'readback mismatch {rel}')
    record('published-verified', {'release': rel})
    return rel, mini


def observe():
    rel, mini = state(); record('observe', {'release': rel, 'mini': mini, 'health': health()})


def main():
    global VERSION, GATE_PROOF, D, head, tree, diff_sha
    VERSION = sys.argv[1]
    D = Path(__file__).resolve().parent.parent / 'story-releases' / VERSION
    D.mkdir(parents=True, exist_ok=True)
    GATE_PROOF = Path(arg('--gate-proof', '/build/Developer/_orchestra/app-closeout-20261021/story-gate'))

    if OBSERVE:
        observe(); return

    # 1. identity: clean main == origin/main at VERSION; DMG hashed from disk
    if git('rev-parse', '--abbrev-ref', 'HEAD') != 'main': stop('main checkout not on main')
    head = git('rev-parse', 'HEAD')
    tree = git('rev-parse', 'HEAD^{tree}')
    if head != git('rev-parse', 'origin/main'): stop('HEAD is not origin/main (push first)')
    if git('status', '--porcelain', '--untracked-files=no'): stop('tracked changes in main checkout')
    diff_sha = hashlib.sha256(subprocess.check_output(['git', 'diff', '--binary'], cwd=P)).hexdigest()
    if json.loads((P / 'package.json').read_text())['version'] != VERSION: stop('package.json version mismatch')
    dmgs = sorted((P / 'dist').glob(f'*{VERSION}*arm64*.dmg'))
    if len(dmgs) != 1: stop(f'expected one {VERSION} arm64 DMG in dist/, found {len(dmgs)}')
    art = str(dmgs[0]); blob = dmgs[0].read_bytes()
    sha, size = hashlib.sha256(blob).hexdigest(), len(blob)
    record('identity', {'head': head, 'tree': tree, 'artifact': art, 'sha256': sha, 'bytes': size, 'diff_sha256': diff_sha})

    # 2. stage on the Gateway host, then publish once (adopt if already offered)
    rel, mini = publish(VERSION, head, art, sha, size)

    # 3. mini: one normal update request, then bounded observation
    if '--publish-only' in sys.argv: print('publish-only: no mini update request'); return
    if mini['version'] != VERSION and not mini['request']:
        if (D / 'mini-update.intent').exists(): stop('mini update intent exists: observe only')
        require_gate_proof()
        record('mini-before', {'mini': mini, 'health': health()})
        intent('mini-update.intent', {'instance': INSTANCE, 'mode': 'normal guarded check-in; no force'})
        try:
            code, ans = gw.call('POST', f'/admin/api/story/instances/{INSTANCE}/update', {})
        except Exception as e:
            record('mini-update-unknown', {'error_type': type(e).__name__}); stop('update outcome unknown; NO retry')
        record('mini-update', {'http': code})
        if code != 200: stop('update answer not 200; NO retry; use --observe')
    deadline = time.monotonic() + 45 * 60
    while time.monotonic() < deadline:
        h = health()
        if h['http'] == 200 and h['version'] == VERSION and h['boot_complete'] is True:
            record('mini-installed', {'health': h, 'mini': state()[1]}); return
        time.sleep(30)
    record('mini-timeout', {'health': health(), 'mini': state()[1]}); stop('mini not on VERSION within 45 min')


if __name__ == '__main__':
    main()
