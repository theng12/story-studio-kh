"""Fail-closed schema-3 verifier: a change-aware release proof built from testctl receipts.

The owner's 2026-11-08 change-aware rule: a release tests the changed work, its callers and
the cheap global checks, plus a packaged launch/update smoke, and reuses an earlier pass only
when the inputs that pass covers are unchanged.  `~/Developer/portfolio/bin/testctl` is the one
tool: it runs lanes and writes a receipt keyed on the lane's tree (or its `paths` input set),
lockfiles, toolchain, host, lane env and commands.

This module does NOT run tests, adds no second runner and no policy of its own.  It verifies a
proof directory that cites testctl receipts and fails closed on anything it cannot re-derive:

- the candidate checkout must be clean (EMPTY diff) and equal to the proof's head/tree/version;
- the cited portfolio config (lanes and their commands) and testctl source are hash-pinned, and
  the config's project path must resolve to this checkout;
- every receipt's key is recomputed from the actual lane inputs and must match, its recorded
  env and commands must equal the configured lane's, its log must re-hash to its recorded
  sha256/bytes, and `testctl plan` must independently report the lane as reusable;
- a receipt that ran on an earlier commit may only be reported `skipped` with that commit as
  `skipped_since` — never `passed` — and its pathspecs must not intersect the changes since
  that commit; a receipt with status other than pass is rejected, not softened;
- changed work must exist; every changed path must be covered by a cited lane's pathspecs, and
  changed `electron/` or `frontend/` code must be covered by a caller lane beyond the two
  required global lanes (`release-cheap`, `packaged-smoke`).

Receipt scoping is a configuration decision that lives in the Developer-owned portfolio config
(hash-pinned here); this verifier never takes a command from the proof itself and never treats
an asserted path as covered without checking it against the lane's actual git pathspecs.
"""
import hashlib
import json
import re
import socket
import subprocess
import sys
from pathlib import Path

from story_gate_proof import EMPTY_DIFF, ProofError, _identity, _inside, _json, _sha, _tracked

PROOF_KIND = 'story-testctl-proof'
GATE_NAME = 'story-change-aware-testctl'
PROJECT_NAME = 'story'
# The two lanes every change-aware proof must cite: cheap global checks and the packaged
# launch/update smoke.  Named, not inferred — the lead configures these lanes in testctl.
REQUIRED_LANES = ('release-cheap', 'packaged-smoke')
# Changed code roots that a caller-level lane (beyond the required globals) must cover.
CALLER_ROOTS = ('electron/', 'frontend/')
HEX40 = re.compile(r'^[0-9a-f]{40}$')
# testctl's LOCKFILES list, pinned: a receipt's lockfile inputs must hash the same files.
LOCKFILES = (
    'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'go.sum', 'Cargo.lock',
    'poetry.lock', 'uv.lock', 'requirements.txt', 'frontend/package-lock.json',
    'electron/package-lock.json', 'ui/package-lock.json',
)
# testctl's artifactPrefixes defaults, pinned so untracked/dirty filtering matches.
ARTIFACT_DEFAULTS = (
    'node_modules', '.git', '.nuxt', '.output', 'dist', 'build', 'target', 'coverage',
    'test-results', 'playwright-report', '.pytest_cache', '__pycache__', '.DS_Store',
)
MAX_HASH_BYTES = 2 * 1024 * 1024
# testctl receipt versions this verifier understands (the field the tool writes).
TESTCTL_VERSIONS = ('1', '2')


def _fail(msg):
    raise ProofError(msg)


def _git(repo, *args):
    r = subprocess.run(['git', '-C', str(repo), *args], capture_output=True, text=True)
    if r.returncode != 0:
        _fail(f'git {" ".join(args)} failed: {(r.stderr or "").strip()}')
    return r.stdout


def _is_ancestor(repo, older, newer):
    r = subprocess.run(['git', '-C', str(repo), 'merge-base', '--is-ancestor', older, newer],
                       capture_output=True, text=True)
    return r.returncode == 0


def _tool(cmd, args):
    """testctl's toolVersion: first line of stdout (else stderr), or 'missing'."""
    try:
        r = subprocess.run([cmd, *args], capture_output=True, text=True)
    except OSError:
        return 'missing'
    if r.returncode != 0:
        return 'missing'
    out = r.stdout or r.stderr or ''
    return out.strip().split('\n')[0]


def _arch():
    import platform
    m = platform.machine().lower()
    return {'x86_64': 'x64', 'amd64': 'x64', 'aarch64': 'arm64'}.get(m, m)


def _env_state(lane):
    return {'node': _tool('node', ['-v']), 'python': _tool('python3', ['-V']),
            'go': _tool('go', ['version']), 'cargo': _tool('cargo', ['-V']),
            'swift': _tool('swift', ['--version']),
            'platform': sys.platform, 'arch': _arch(), 'host': socket.gethostname(),
            'env': lane.get('env') or {}}


def _commands(lane):
    if isinstance(lane.get('commands'), list) and lane['commands']:
        return lane['commands']
    if isinstance(lane.get('command'), list) and lane['command']:
        return [lane['command']]
    _fail('configured lane has no command(s)')


def _prefixes(project_cfg):
    out = [s.rstrip('/') for s in ARTIFACT_DEFAULTS]
    for key in ('clean', 'build'):
        out += [str(s).rstrip('/') for s in (project_cfg.get(key) or []) if str(s).rstrip('/')]
    return out


def _excluded(rel, prefixes):
    return any(rel == p or rel.startswith(p + '/') for p in prefixes)


def _hash_file(path):
    """testctl's hashFile semantics: missing / notfile / big markers, else sha256."""
    try:
        st = path.stat()
    except OSError:
        return 'missing'
    if not path.is_file():
        return f'notfile:{st.st_size}'
    if st.st_size > MAX_HASH_BYTES:
        return f'big:{st.st_size}'
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _sha_str(text):
    return hashlib.sha256(text.encode()).hexdigest()


def _lockfiles(repo):
    out = {}
    for rel in LOCKFILES:
        p = repo / rel
        if p.exists():
            out[rel] = _hash_file(p)
    return out


def _input_state(repo, paths, prefixes):
    """testctl's inputState: index blob ids, unstaged diff and untracked files under pathspecs."""
    spec = ['--', *paths]
    untracked = sorted(
        f'file:{rel}:{_hash_file(repo / rel)}'
        for rel in _git(repo, 'ls-files', '-o', '--exclude-standard', '-z', *spec).split('\0')
        if rel and not _excluded(rel, prefixes))
    return {'paths': list(paths),
            'indexHash': _sha_str(_git(repo, 'ls-files', '-s', '-z', *spec)),
            'worktreeHash': _sha_str(_git(repo, 'diff', '--binary', *spec)),
            'untracked': untracked}


def _tree_state(repo, prefixes):
    """testctl's treeState for an unscoped lane (head, full status/diff hashes, untracked)."""
    head = _git(repo, 'rev-parse', 'HEAD').strip() or 'no-head'
    status = _git(repo, 'status', '--porcelain=v1', '-z')
    diff = _git(repo, 'diff', 'HEAD', '--binary')
    untracked, kept = [], []
    for entry in [e for e in status.split('\0') if e]:
        if entry.startswith('?? '):
            rel = entry[3:]
            if _excluded(rel, prefixes):
                continue
            p = repo / rel
            untracked.append(f'dir:{rel}' if p.is_dir() else f'file:{rel}:{_hash_file(p)}')
        else:
            kept.append(entry)
    untracked.sort()
    return {'head': head, 'statusHash': _sha_str('\0'.join(kept)),
            'diffHash': _sha_str(diff), 'untracked': untracked,
            'lockfiles': _lockfiles(repo), 'dirty': bool(kept)}


def _compute_key(repo, project_cfg, lane, env):
    """testctl's computeKey.  Serialization must match JS JSON.stringify exactly:
    insertion order of these literals and ensure_ascii=False are load-bearing."""
    prefixes = _prefixes(project_cfg)
    scoped = isinstance(lane.get('paths'), list) and bool(lane['paths'])
    if scoped:
        key_tree = {'inputs': _input_state(repo, lane['paths'], prefixes),
                    'lockfiles': _lockfiles(repo)}
    else:
        t = _tree_state(repo, prefixes)
        key_tree = {'head': t['head'], 'statusHash': t['statusHash'],
                    'diffHash': t['diffHash'], 'untracked': t['untracked'],
                    'lockfiles': t['lockfiles']}
    blob = json.dumps({'tree': key_tree, 'env': env, 'commands': _commands(lane)},
                      ensure_ascii=False, separators=(',', ':'))
    return hashlib.sha256(blob.encode()).hexdigest()


def _plan_reuse(testctl, config_path, project):
    """Run the real `testctl plan` and take its reuse verdict — an independent cross-check."""
    r = subprocess.run(['node', str(testctl), 'plan', project, '--config', str(config_path)],
                       capture_output=True, text=True)
    if r.returncode != 0:
        _fail(f'testctl plan failed: {(r.stderr or r.stdout or "").strip()}')
    return set(re.findall(r'^\s*✔\s+(\S+)\s+reuse', r.stdout or '', re.M))


def _changed_for(repo, base, head, pathspecs):
    """Changed paths in the release range that a lane's git pathspecs match (diff honours
    `:(exclude)` magic, which ls-tree does not)."""
    out = _git(repo, 'diff', '--name-only', '-z', base, head, '--', *pathspecs).split('\0')
    return {p for p in out if p}


def _read_lane_entry(root, entry, receipts_dir, repo, project_cfg, lane_cfg, head):
    """Verify one cited lane.  Returns ('ran'|'skipped', receipt_tree_head)."""
    if not isinstance(entry, dict):
        _fail('lane entry is not an object')
    receipt_path = Path(str(entry.get('receipt', ''))).resolve()
    try:
        receipt_path.relative_to(receipts_dir)
    except ValueError:
        _fail(f'receipt is outside the configured receipts directory: {receipt_path}')
    if not receipt_path.is_file():
        _fail(f'receipt file missing: {receipt_path}')
    if entry.get('sha256') != _sha(receipt_path):
        _fail(f'{receipt_path.name}: receipt sha256 does not match the cited hash')
    rec = _json(receipt_path)
    if not isinstance(rec, dict):
        _fail(f'{receipt_path.name}: receipt is not an object')
    if rec.get('project') != PROJECT_NAME or rec.get('lane') != entry.get('lane'):
        _fail(f'{receipt_path.name}: receipt does not name this project/lane')
    if str(rec.get('testctl')) not in TESTCTL_VERSIONS:
        _fail(f'{receipt_path.name}: unknown testctl receipt version {rec.get("testctl")!r}')
    if rec.get('commands') != _commands(lane_cfg):
        _fail(f'{receipt_path.name}: receipt commands differ from the configured lane '
              '(the proof may not substitute its own commands)')
    env = _env_state(lane_cfg)
    if rec.get('env') != env:
        _fail(f'{receipt_path.name}: receipt toolchain/host/env differs from this machine now')
    if rec.get('key') != _compute_key(repo, project_cfg, lane_cfg, env):
        _fail(f'{receipt_path.name}: receipt key does not match the lane\'s actual inputs '
              '(tree/pathspecs, lockfiles, toolchain, commands)')
    if rec.get('status') != 'pass' or rec.get('exitCode') != 0:
        _fail(f'{receipt_path.name}: receipt status is {rec.get("status")!r} exit '
              f'{rec.get("exitCode")!r}; a failed receipt stays failed')
    log = rec.get('log')
    if not isinstance(log, dict):
        _fail(f'{receipt_path.name}: receipt has no log record')
    log_path = Path(str(log.get('file', ''))).resolve()
    if log_path != receipt_path.with_suffix('.log'):
        _fail(f'{receipt_path.name}: log file {log_path} is not the lane\'s own .log')
    if not log_path.is_file():
        _fail(f'log file missing: {log_path}')
    raw = log_path.read_bytes()
    if log.get('sha256') != hashlib.sha256(raw).hexdigest():
        _fail(f'{log_path.name}: log sha256 does not match the receipt')
    if log.get('bytes') != len(raw):
        _fail(f'{log_path.name}: log byte count does not match the receipt')
    receipt_head = (rec.get('tree') or {}).get('head')
    if not isinstance(receipt_head, str) or not HEX40.match(receipt_head):
        _fail(f'{receipt_path.name}: receipt tree head is not a commit id')
    derived = 'ran' if receipt_head == head else 'skipped'
    return derived, receipt_head


def verify(root, res, head, tree, diff_sha, version, repo):
    """Verify a schema-3 change-aware proof against the candidate checkout."""
    if repo is None:
        _fail('schema 3 proof requires the publishing repo')
    root = Path(root).resolve()
    repo = Path(repo).resolve()
    if not isinstance(res, dict) or res.get('kind') != PROOF_KIND:
        _fail(f'gate-result.json is not a {PROOF_KIND} proof')
    if res.get('gate') != GATE_NAME:
        _fail(f'proof gate {res.get("gate")!r} is not {GATE_NAME!r}')
    if diff_sha != EMPTY_DIFF:
        _fail('shipped checkout has uncommitted tracked changes; the change-aware proof '
              'did not certify them')
    if res.get('head') != head:
        _fail(f"proof HEAD {res.get('head')} is not the shipped HEAD {head}")
    if res.get('tree') is not None and res.get('tree') != tree:
        _fail(f"proof tree {res.get('tree')} is not the shipped tree {tree}")
    if res.get('diff_sha256') != diff_sha:
        _fail('proof diff hash is not the shipped checkout diff')
    if res.get('version') is not None and version is not None and res.get('version') != version:
        _fail(f"proof version {res.get('version')} is not {version}")

    # The candidate must be this checkout, clean, at this head.
    ident = _identity(_inside(root, res.get('identity')))
    if ident.get('head') != head or ident.get('head_tree') != tree \
            or ident.get('diff_sha256') != diff_sha:
        _fail('identity does not match the shipped source')
    dirty = _tracked(ident.get('status_porcelain', ''))
    if dirty:
        _fail(f'identity has tracked changes: {dirty[:3]}')

    # The config pins every lane's commands and pathspecs; testctl source is pinned too.
    cfg_rec = res.get('config')
    if not isinstance(cfg_rec, dict):
        _fail('proof has no config record')
    for field in ('path', 'sha256', 'origin', 'testctl', 'testctl_sha256'):
        if not cfg_rec.get(field):
            _fail(f'config record is missing {field!r}')
    if not HEX40.match(str(cfg_rec['origin'])) or not re.fullmatch(r'[0-9a-f]{64}',
                                                              str(cfg_rec['testctl_sha256'])):
        _fail('config provenance ids are not commit/sha256 hashes')
    cfg_path = Path(str(cfg_rec['path'])).resolve()
    if not cfg_path.is_file():
        _fail(f'config file missing: {cfg_path}')
    if _sha(cfg_path) != cfg_rec['sha256']:
        _fail('config sha256 does not match the cited config file')
    testctl_path = Path(str(cfg_rec['testctl'])).resolve()
    if not testctl_path.is_file():
        _fail(f'testctl source missing: {testctl_path}')
    if _sha(testctl_path) != cfg_rec['testctl_sha256']:
        _fail('testctl sha256 does not match the cited testctl source')
    config = _json(cfg_path)
    project_cfg = (config.get('projects') or {}).get(PROJECT_NAME)
    if not isinstance(project_cfg, dict):
        _fail(f'config has no {PROJECT_NAME!r} project')
    project_path = Path(str(project_cfg.get('path', '')))
    if not project_path.is_absolute():
        project_path = (cfg_path.parent / project_path)
    if project_path.resolve() != repo:
        _fail(f'config project path {project_path.resolve()} is not this checkout {repo}')
    receipts_dir = Path(str(config.get('receiptsDir') or '../test-receipts'))
    if not receipts_dir.is_absolute():
        receipts_dir = cfg_path.parent / receipts_dir
    receipts_dir = receipts_dir.resolve()
    lanes_cfg = project_cfg.get('lanes') or {}

    # Changed work must exist and be an ancestor range of the candidate.
    base = res.get('base')
    if not isinstance(base, str) or not HEX40.match(base):
        _fail('proof base is not a commit id')
    if not _is_ancestor(repo, base, head):
        _fail(f'base {base} is not an ancestor of candidate {head}')
    changed = [p for p in _git(repo, 'diff', '--name-only', '-z', base, head).split('\0') if p]
    if not changed:
        _fail('no changed work between base and candidate; a change-aware proof needs a change')

    lanes = res.get('lanes')
    if not isinstance(lanes, dict) or not lanes:
        _fail('proof cites no testctl lanes')
    for required in REQUIRED_LANES:
        if required not in lanes:
            _fail(f'proof is missing the required lane {required!r}')

    reuse = _plan_reuse(testctl_path, cfg_path, PROJECT_NAME)
    results = {}
    skipped_heads = []
    for name, entry in lanes.items():
        lane_cfg = lanes_cfg.get(name)
        if not isinstance(lane_cfg, dict):
            _fail(f'config does not define lane {name!r}')
        if not isinstance(entry, dict):
            _fail(f'lane {name!r} entry is not an object')
        entry['lane'] = name
        derived, receipt_head = _read_lane_entry(
            root, entry, receipts_dir, repo, project_cfg, lane_cfg, head)
        if name not in reuse:
            _fail(f'lane {name!r}: testctl plan does not report this receipt as reusable '
                  '(inputs, toolchain or commands changed since it ran)')
        claimed = entry.get('result')
        if claimed not in ('ran', 'skipped'):
            _fail(f'lane {name!r}: result {claimed!r} is not "ran" or "skipped"; a reused '
                  'result reads skipped, never passed')
        if claimed != derived:
            _fail(f'lane {name!r}: claimed {claimed!r} but the receipt ran on '
                  f'{receipt_head} (derived {derived!r})')
        if derived == 'skipped':
            if entry.get('skipped_since') != receipt_head:
                _fail(f'lane {name!r}: skipped_since must name the commit the receipt ran on '
                      f'({receipt_head})')
            paths = lane_cfg.get('paths')
            if not isinstance(paths, list) or not paths:
                _fail(f'lane {name!r}: an unscoped lane cannot be reused across commits')
            touched = [p for p in _git(repo, 'diff', '--name-only', '-z', receipt_head, head,
                                       '--', *paths).split('\0') if p]
            if touched:
                _fail(f'lane {name!r}: its pathspecs cover changes since the receipt ran: '
                      f'{touched[:3]}')
            skipped_heads.append(receipt_head)
        elif entry.get('skipped_since'):
            _fail(f'lane {name!r}: a receipt that ran on the candidate carries no skipped_since')
        results[name] = derived

    # Coverage: every changed path must sit inside some cited lane's pathspecs, and changed
    # app code needs a caller lane beyond the two required globals.
    coverage = {name: _changed_for(repo, base, head, lanes_cfg[name]['paths'])
                for name in lanes if lanes_cfg.get(name, {}).get('paths')}
    caller_names = [n for n in lanes if n not in REQUIRED_LANES]
    for path in changed:
        if not any(path in files for files in coverage.values()):
            _fail(f'changed path {path!r} is covered by no cited lane\'s pathspecs')
        if path.startswith(CALLER_ROOTS) and not any(
                path in coverage.get(n, set()) for n in caller_names):
            _fail(f'changed code {path!r} is covered only by the required global lanes; '
                  'cite a caller lane for it')

    return {'schema': 3, 'proof': str(root), 'head': head, 'tree': tree,
            'base': base, 'changed': len(changed), 'lanes': len(lanes),
            'ran': sum(1 for v in results.values() if v == 'ran'),
            'skipped': sum(1 for v in results.values() if v == 'skipped'),
            'skipped_since': sorted(set(skipped_heads))}