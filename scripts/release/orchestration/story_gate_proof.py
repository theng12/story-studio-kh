"""Fail-closed verifier for a Story full-gate proof directory.

ship-story.py must not publish or request a mini update unless a full gate ran on the exact
source being shipped.  The gate writes a proof directory (see
_orchestra/app-closeout-20261021/story-gate/run-gate.sh) holding, for every canonical step:
an exit file, a log, and a machine-readable record whose log hash can be re-derived.

This module verifies that evidence offline and binds it to one git source: the proof's
HEAD, tree and `git diff --binary` hash must equal the checkout about to be shipped, and the
proof must have been produced with NO uncommitted tracked changes.  A proof made on a
different integrated source (the bd4de6c4 baseline plus the app-update fixture diff, say)
therefore cannot certify a later release; there is no equivalence waiver, no bypass flag and
no historical-version allowance.  Missing or malformed evidence is a rejection, not a pass.

`verify` dispatches on the proof's schema.  Schema 2 is the composite contract in
`story_composite_proof.py`: the original gate may have stopped on one failing test lane, which
must be reconciled file by file against a focused rerun.  Schema 1's contract is unchanged.
Schema 3 is the change-aware testctl contract in `story_testctl_proof.py` (owner 2026-11-08):
testctl receipts prove the changed work, its callers, the cheap global checks and the packaged
smoke; an unchanged suite reads skipped with the commit it last passed on, never passed.

The old Story-specific schema-3 verifier (proof_kind 'story-testctl-proof') was WIP and never
qualified. It was replaced on 2026-11-09 by a thin adapter that delegates to the portfolio
common-core CLI (proof_kind 'testctl-change-aware', schema 2). Proofs carrying the old kind
or bare schema 3 are refused at publication; there is no schema-3 dispatch path.
"""
import hashlib
import json
import re
from pathlib import Path

# Canonical gate steps, in run order: (step id, npm script).  All must be present, once, exit 0.
STEPS = (
    ('01-lint', 'lint'),
    ('02-check-changelog', 'check:changelog'),
    ('03-check-typography', 'check:typography'),
    ('04-check-security', 'check:security'),
    ('05-check-model-drift', 'check:model-drift'),
    ('06-typecheck', 'typecheck'),
    ('07-test-backend', 'test:backend'),
    ('08-test-frontend', 'test:frontend'),
    ('09-test-release', 'test:release'),
    ('10-test-content-packs', 'test:content-packs'),
)
SUITE_STEPS = {'07-test-backend', '08-test-frontend', '09-test-release', '10-test-content-packs'}
COVERAGE = re.compile(
    r'suite coverage: (\d+)/(\d+) file\(s\) completed, (\d+) test\(s\) \+ (\d+) suite\(s\) = (\d+) marks')
# The release lane runs as two invocations (release-contracts, release-adapted) and then prints its
# aggregate floor. That line is authoritative for the whole lane; the per-invocation lines above
# must each be whole and must sum to it.
AGGREGATE = re.compile(
    r'aggregate suite coverage: (\d+)/(\d+) file\(s\) completed')
# The raw node summary the spec (`ℹ`) or TAP (`#`) reporter prints is parsed per invocation by
# `_summary_blocks` below.
# run-backend-tests.mjs fails the run unless this sentinel is true.
BACKEND_SENTINEL = '[test-harness] configured projects root byte-identical: true'
EMPTY_DIFF = hashlib.sha256(b'').hexdigest()


class ProofError(Exception):
    pass


def _fail(msg):
    raise ProofError(msg)


def _sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _inside(root, value):
    """Resolve a proof-referenced path, requiring it to stay inside the proof directory."""
    p = Path(str(value))
    if not p.is_absolute():
        p = root / p
    p = p.resolve()
    if p != root and root not in p.parents:
        _fail(f'proof path escapes the proof directory: {value}')
    if not p.is_file():
        _fail(f'proof path is not a file: {value}')
    return p


def _json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError) as e:
        _fail(f'unreadable JSON {path.name}: {type(e).__name__}')


def _identity(path):
    """Parse a `capture_identity` file: key=value lines plus one `key<<EOF ... EOF` block."""
    out = {}
    lines = path.read_text().splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        if '<<EOF' in line:
            key = line.split('<<EOF', 1)[0]
            body = []
            i += 1
            while i < len(lines) and lines[i] != 'EOF':
                body.append(lines[i])
                i += 1
            out[key] = '\n'.join(body)
        elif '=' in line:
            key, value = line.split('=', 1)
            out[key] = value
        i += 1
    return out


def _tracked(status):
    """Porcelain lines that touch tracked files; untracked (`??`) runtime files are ignored."""
    return [line for line in status.splitlines() if line.strip() and not line.startswith('??')]


def verify(proof_dir, head, tree, diff_sha, version=None, repo=None,
           config=None, review=None, testctl=None):
    """Dispatch on gate-result.json's schema: 1 is the single full gate, 2 is a composite
    proof whose original gate stopped on a failing suite lane, or a common-core testctl
    change-aware proof (proof_kind 'testctl-change-aware', also schema 2).  `repo` is the
    publishing checkout; schema 1 ignores it, schema 2 and testctl-change-aware require it.
    `config`, `review` and `testctl` are trusted paths for testctl-change-aware proofs;
    schema 1 and composite callers ignore them.  A schema-1 proof's contract is unchanged."""
    root = Path(proof_dir).resolve()
    if not root.is_dir():
        _fail(f'proof directory missing: {root}')

    res = _json(_inside(root, root / 'gate-result.json'))
    if not isinstance(res, dict):
        _fail('gate-result.json is not an object')
    schema = res.get('schema')
    proof_kind = res.get('proof_kind')
    # Distinguish by proof_kind BEFORE schema number: the common-core testctl
    # proof is schema 2 with proof_kind 'testctl-change-aware', while the older
    # composite proof is also schema 2 but carries no proof_kind.
    if proof_kind == 'testctl-change-aware':
        if repo is None:
            _fail('testctl-change-aware proof requires the publishing repo')
        try:
            from story_testctl_proof import verify as verify_testctl
            return verify_testctl(root, res, head, tree, diff_sha, version, repo,
                                  config=config, review=review, testctl=testctl)
        except ProofError:
            raise
        except (ImportError, OSError, ValueError, TypeError, KeyError, AttributeError) as e:
            _fail(f'testctl-change-aware proof could not be verified: {type(e).__name__}')
    if schema == 1:
        return _verify_schema1(root, res, head, tree, diff_sha, version)
    if schema == 2:
        if repo is None:
            _fail('schema 2 proof requires the publishing repo')
        try:
            from story_composite_proof import verify as verify_composite
            return verify_composite(root, res, head, tree, diff_sha, version, repo)
        except ProofError:
            raise
        except (ImportError, OSError, ValueError, TypeError, KeyError, AttributeError) as e:
            _fail(f'composite proof could not be verified: {type(e).__name__}')
    if schema == 3 or res.get('kind') == 'story-testctl-proof':
        _fail('old Story schema-3 proof is refused; use the common-core '
              'testctl-change-aware proof exported by the portfolio CLI')
    _fail(f'unsupported proof schema {schema!r}')


def _verify_schema1(root, res, head, tree, diff_sha, version):
    if res.get('overall_exit') != 0:
        _fail(f"gate overall_exit {res.get('overall_exit')!r} is not 0")
    if res.get('source_identity_unchanged') is not True:
        _fail('gate reports source identity changed during the run')
    if res.get('partial_run') is not False:
        _fail(f"gate partial_run {res.get('partial_run')!r} is not false")
    if res.get('head') != head:
        _fail(f"proof HEAD {res.get('head')} is not the shipped HEAD {head}")
    if res.get('tree') is not None and res.get('tree') != tree:
        _fail(f"proof tree {res.get('tree')} is not the shipped tree {tree}")
    if res.get('diff_sha256') != diff_sha:
        _fail('proof diff hash is not the shipped checkout diff')
    if res.get('version') is not None and version is not None and res.get('version') != version:
        _fail(f"proof version {res.get('version')} is not {version}")
    if diff_sha != EMPTY_DIFF:
        _fail('shipped checkout has uncommitted tracked changes; the gate did not certify them')
    expected = dict(STEPS)
    if res.get('steps_expected') != len(STEPS) or res.get('steps_completed') != len(STEPS):
        _fail(f"gate ran {res.get('steps_completed')!r}/{res.get('steps_expected')!r} steps, not {len(STEPS)}")

    before = _identity(_inside(root, res.get('identity_before')))
    after = _identity(_inside(root, res.get('identity_after')))
    for label, ident in (('before', before), ('after', after)):
        if ident.get('head') != head or ident.get('head_tree') != tree \
                or ident.get('diff_sha256') != diff_sha:
            _fail(f'identity-{label} does not match the shipped source')
        dirty = _tracked(ident.get('status_porcelain', ''))
        if dirty:
            _fail(f'identity-{label} has tracked changes: {dirty[:3]}')
    if (before.get('head'), before.get('head_tree'), before.get('diff_sha256')) != \
            (after.get('head'), after.get('head_tree'), after.get('diff_sha256')):
        _fail('identity before/after disagree')

    records = []
    for line in _inside(root, res.get('per_step_records')).read_text().splitlines():
        if line.strip():
            try:
                records.append(json.loads(line))
            except ValueError:
                _fail('per-step manifest has a non-JSON line')
    if len(records) != len(STEPS):
        _fail(f'manifest has {len(records)} records, expected {len(STEPS)}')

    seen = set()
    for rec in records:
        if not isinstance(rec, dict):
            _fail('per-step manifest has a non-object record')
        step = rec.get('step')
        if step not in expected or step in seen:
            _fail(f'unexpected or duplicate step {step!r}')
        seen.add(step)
        if rec.get('command') != f"npm run {expected[step]}":
            _fail(f'{step}: command {rec.get("command")!r} is not the canonical script')
        if not isinstance(rec.get('exit'), int) or isinstance(rec.get('exit'), bool) or rec['exit'] != 0:
            _fail(f'{step}: exit {rec.get("exit")!r} is not 0')
        if rec.get('head') != head or rec.get('diff_sha256') != diff_sha:
            _fail(f'{step}: record is not bound to the shipped source')
        log = _inside(root, rec.get('log'))
        if log.name != f'{step}.log':
            _fail(f'{step}: log name {log.name!r} is not {step}.log')
        raw = log.read_bytes()
        if _sha(log) != rec.get('log_sha256'):
            _fail(f'{step}: log hash does not match log_sha256')
        exit_file = _inside(root, log.with_name(f'{step}.exit'))
        if exit_file.read_text().strip() != str(rec['exit']):
            _fail(f'{step}: exit file disagrees with the record')
        if step in SUITE_STEPS:
            _check_suite(step, rec, raw)
    if seen != set(expected):
        _fail(f'manifest is missing steps: {sorted(set(expected) - seen)}')

    return {'schema': 1, 'proof': str(root), 'head': head, 'tree': tree,
            'diff_sha256': diff_sha, 'steps': len(records), 'suite_lanes': len(SUITE_STEPS)}


def _summary_blocks(text):
    """Split the raw spec/TAP summary into one dict per invocation.

    `run-lane-tests.mjs` runs the release lane as two invocations, each ending its own raw summary;
    every block must be clean, and their sums must match the coverage totals. One contiguous block
    (backend and every single-invocation lane) behaves exactly as the old last-occurrence parse.
    """
    line_re = re.compile(
        r'^[#ℹ]\s+(tests|suites|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$')
    blocks = []
    current = None
    for line in text.splitlines():
        match = line_re.match(line)
        if not match:
            if current is not None:
                blocks.append(current)
                current = None
            continue
        key = match.group(1)
        if key == 'tests' and current is not None and 'tests' in current:
            blocks.append(current)
            current = None
        if current is None:
            current = {}
        current[key] = int(match.group(2))
    if current is not None:
        blocks.append(current)
    return blocks


def _check_suite(step, rec, raw):
    suite = rec.get('suite')
    if not isinstance(suite, dict):
        _fail(f'{step}: test lane has no suite evidence')
    if suite.get('partial') is not False:
        _fail(f'{step}: suite is marked partial')
    text = raw.decode('utf-8', 'replace')
    if 'PARTIAL RUN' in text:
        _fail(f'{step}: log carries the PARTIAL RUN banner')
    matches = [(int(a), int(b), int(c), int(d), int(e))
               for a, b, c, d, e in COVERAGE.findall(text)]
    if not matches:
        _fail(f'{step}: log has no suite coverage line')
    aggregates = AGGREGATE.findall(text)
    if aggregates:
        # Partitioned lane: each invocation must be whole on its own, and the partitions must add
        # up to the aggregate the runner itself printed. The aggregate, not the last partition, is
        # the floor being certified.
        for index, (completed, discovered, _, _, _) in enumerate(matches, 1):
            if discovered < 1 or completed != discovered:
                _fail(f'{step}: invocation {index} coverage {completed}/{discovered} '
                      'is below its discovered floor')
        agg_completed, agg_discovered = (int(v) for v in aggregates[-1])
        if agg_discovered < 1 or agg_completed != agg_discovered:
            _fail(f'{step}: aggregate coverage {agg_completed}/{agg_discovered} '
                  'is below the discovered floor')
        if (sum(m[0] for m in matches), sum(m[1] for m in matches)) != \
                (agg_completed, agg_discovered):
            _fail(f'{step}: invocation coverage does not add up to the aggregate')
        completed, discovered = agg_completed, agg_discovered
    else:
        if len(matches) != 1:
            _fail(f'{step}: {len(matches)} per-invocation coverage lines without an aggregate')
        completed, discovered, _, _, _ = matches[0]
        if discovered < 1 or completed != discovered:
            _fail(f'{step}: coverage {completed}/{discovered} is below the discovered floor')
    tests = sum(m[2] for m in matches)
    suites = sum(m[3] for m in matches)
    marks = sum(m[4] for m in matches)
    if tests < 1:
        _fail(f'{step}: suite ran no positive tests')
    if marks != tests + suites:
        _fail(f'{step}: coverage marks {marks} != {tests} tests + {suites} suites')
    # The raw summaries are the evidence; a null node_summary in the manifest is not. Every
    # invocation block is checked, then their sums must equal the coverage totals.
    blocks = _summary_blocks(text)
    if not blocks:
        _fail(f'{step}: log has no raw node summary (tests/fail)')
    for index, counts in enumerate(blocks, 1):
        if 'tests' not in counts or 'fail' not in counts:
            _fail(f'{step}: raw node summary {index} lacks tests/fail')
        if counts['tests'] < 1:
            _fail(f'{step}: raw node summary {index} reports no positive tests')
        if counts['fail'] != 0:
            _fail(f"{step}: raw node summary {index} reports fail={counts['fail']}")
        if counts.get('cancelled', 0) != 0:
            _fail(f"{step}: raw node summary {index} reports cancelled={counts['cancelled']}")
        if counts.get('pass') is not None:
            accounted = counts['pass'] + counts['fail'] + counts.get('skipped', 0) + \
                counts.get('todo', 0)
            if accounted != counts['tests']:
                _fail(f'{step}: raw node summary {index} does not add up '
                      f'({counts["tests"]} != {accounted})')
    if sum(block['tests'] for block in blocks) != tests:
        _fail(f'{step}: node tests {sum(b["tests"] for b in blocks)} != coverage tests {tests}')
    if all('suites' in block for block in blocks) and \
            sum(block['suites'] for block in blocks) != suites:
        _fail(f'{step}: node suites {sum(b["suites"] for b in blocks)} != coverage suites {suites}')
    if (suite.get('coverage_completed'), suite.get('coverage_discovered'),
            suite.get('coverage_at_floor')) != (completed, discovered, True):
        _fail(f'{step}: suite coverage fields do not match the log')
    if (suite.get('tests'), suite.get('suites'), suite.get('marks')) != (tests, suites, marks):
        _fail(f'{step}: suite counts do not match the log')
    if step == '07-test-backend' and BACKEND_SENTINEL not in text:
        _fail(f'{step}: log lacks the configured projects-root byte-identical: true sentinel')
