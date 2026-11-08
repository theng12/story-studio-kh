"""Verify a schema-2 composite Story gate proof.

Schema 1 (`story_gate_proof._verify_schema1`) certifies one ten-step gate that exited 0.
Schema 2 certifies the same ten steps when the original gate stopped on a failing test lane:
the original proof is re-read unchanged, every other lane is run separately, and the failed
lane is reconciled file by file against a focused rerun at the candidate source.

Every cited log and coverage file is re-hashed, every expected test file is recomputed from
the candidate git tree, and every test file's bytes must match the candidate commit.  A
product change is still only as safe as the human review mapping that names its callers;
test-byte identity alone proves nothing about behaviour.  This module reads evidence and
never writes it.
"""
import hashlib
import json
import posixpath
import re
import subprocess
from pathlib import Path

import story_gate_proof as sgp

SHA1 = re.compile(r'^[0-9a-f]{40}$')
SHA256 = re.compile(r'^[0-9a-f]{64}$')

# The lane directory IS the floor: the runner reads this directory, non-recursively.
SUITE_LANE_DIRS = {
    '07-test-backend': ('electron/server/__tests__', '.test.ts'),
    '08-test-frontend': ('frontend/__tests__', '.test.ts'),
    '09-test-release': ('scripts/release/__tests__', '.test.mjs'),
    '10-test-content-packs': ('scripts/content-packs/__tests__', '.test.mjs'),
}
COMPOSITE_KIND = 'story-composite-gate-proof'
COMPOSITE_GATE = 'story-final-gate-composite'


def _fail(msg):
    raise sgp.ProofError(msg)


def _read_json(path):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        _fail(f'unreadable JSON {Path(path).name}')


def _git(repo, *args):
    try:
        return subprocess.run(['git', '-C', str(repo), *args], check=True,
                              capture_output=True, text=True).stdout
    except (subprocess.CalledProcessError, OSError):
        _fail(f'git {" ".join(args)} failed in the publishing repo')


def _commit(repo, value, label):
    if not isinstance(value, str) or not SHA1.match(value):
        _fail(f'{label} is not a full commit id')
    try:
        found = _git(repo, 'rev-parse', '--verify', f'{value}^{{commit}}').strip()
    except sgp.ProofError:
        _fail(f'{label} {value} is not a commit in the publishing repo')
    if found != value:
        _fail(f'{label} {value} is not an exact commit id')
    return value


def _ancestor(repo, older, newer):
    try:
        rc = subprocess.run(['git', '-C', str(repo), 'merge-base', '--is-ancestor',
                             older, newer], capture_output=True).returncode
    except OSError:
        _fail('cannot read the publishing repo ancestry')
    if rc not in (0, 1):
        _fail('cannot read the publishing repo ancestry')
    return rc == 0


def _blob(repo, commit, rel):
    found = _git(repo, 'rev-parse', f'{commit}:{rel}').strip()
    if not SHA1.match(found):
        _fail(f'{rel}: no blob at {commit}')
    return found


def _receipt(value, label):
    """A cited evidence file: absolute path plus the sha256 the proof claims for it."""
    if not isinstance(value, dict):
        _fail(f'{label} receipt is missing')
    path, sha = value.get('path'), value.get('sha256')
    if not isinstance(path, str) or not isinstance(sha, str) or not SHA256.match(sha):
        _fail(f'{label} receipt is malformed')
    p = Path(path)
    if not p.is_absolute():
        _fail(f'{label} receipt path is not absolute')
    try:
        raw = p.read_bytes()
    except OSError:
        _fail(f'{label} receipt file is missing')
    if hashlib.sha256(raw).hexdigest() != sha:
        _fail(f'{label} receipt hash mismatch')
    return p


def _expected_sets(repo, commit):
    sets = {}
    for step, (directory, suffix) in SUITE_LANE_DIRS.items():
        raw = _git(repo, 'ls-tree', '-r', '--name-only', '-z', commit, '--', directory)
        names = [name for name in raw.split('\0') if name]
        direct = {name for name in names
                  if posixpath.dirname(name) == directory and name.endswith(suffix)}
        if not direct:
            _fail(f'{step}: candidate tree discovers no {suffix} files in {directory}')
        sets[step] = direct
    return sets


def _map_coverage(rows, expected, label):
    records = {}
    for row in rows:
        if not isinstance(row, dict):
            _fail(f'{label}: coverage record is not an object')
        name = row.get('file')
        if not isinstance(name, str) or not name.startswith('/'):
            _fail(f'{label}: coverage record file is not an absolute path')
        if not isinstance(row.get('success'), bool):
            _fail(f'{label}: coverage success is not a boolean')
        for key in ('tests', 'suites', 'failed'):
            value = row.get(key)
            if not isinstance(value, int) or isinstance(value, bool) or value < 0:
                _fail(f'{label}: coverage {key} is not a non-negative integer')
        if row['tests'] < 1:
            _fail(f'{label}: {name} reached no tests')
        matches = [rel for rel in expected if name == rel or name.endswith('/' + rel)]
        if len(matches) != 1:
            _fail(f'{label}: coverage file {name} matches {len(matches)} expected files')
        rel = matches[0]
        if rel in records:
            _fail(f'{label}: duplicate coverage for {rel}')
        records[rel] = row
    missing = expected - set(records)
    if missing:
        _fail(f'{label}: missing coverage for {len(missing)} file(s): {sorted(missing)[:3]}')
    return records


def _coverage_receipts(value, expected, label):
    if not isinstance(value, list) or not value:
        _fail(f'{label}: no coverage receipts')
    rows = []
    for item in value:
        path = _receipt(item, label)
        try:
            lines = path.read_text().splitlines()
        except OSError:
            _fail(f'{label}: unreadable coverage file')
        for line in lines:
            if not line.strip():
                continue
            try:
                rows.append(json.loads(line))
            except ValueError:
                _fail(f'{label}: non-JSON coverage line')
    return _map_coverage(rows, expected, label)


def _log_coverage_paths(text, label):
    """Coverage paths the log's own aggregate line names, when it names paths."""
    paths = []
    for blob in re.findall(r'aggregate suite coverage: .*?inputs=(\[.*?\])\s*$', text, re.M):
        try:
            items = json.loads(blob)
        except ValueError:
            continue  # bare invocation labels; the log names no paths
        if not isinstance(items, list):
            _fail(f'{label}: aggregate inputs are not a list')
        for item in items:
            if isinstance(item, dict) and isinstance(item.get('coveragePath'), str):
                paths.append(str(Path(item['coveragePath']).resolve()))
    return paths


def _tie_coverage_paths(value, raw, label):
    named = _log_coverage_paths(raw.decode('utf-8', 'replace'), label)
    if not named:
        return
    if not isinstance(value, list) or not value:
        _fail(f'{label}: no coverage receipts')
    cited = [str(_receipt(item, label).resolve()) for item in value]
    if set(cited) != set(named):
        _fail(f'{label}: cited coverage is not the set the log names')


def _log_counts(raw, label, expected_count, records, allow_fail=False, allow_partial=False):
    """Re-derive a lane log's floor and raw summary, and tie both to its coverage records."""
    text = raw.decode('utf-8', 'replace')
    if 'PARTIAL RUN' in text and not allow_partial:
        _fail(f'{label}: log carries the PARTIAL RUN banner')
    matches = [(int(a), int(b), int(c), int(d), int(e))
               for a, b, c, d, e in sgp.COVERAGE.findall(text)]
    if not matches:
        _fail(f'{label}: log has no suite coverage line')
    aggregates = sgp.AGGREGATE.findall(text)
    if aggregates:
        for index, (completed, discovered, _, _, _) in enumerate(matches, 1):
            if discovered < 1 or completed != discovered:
                _fail(f'{label}: invocation {index} coverage {completed}/{discovered} '
                      'is below its discovered floor')
        agg_completed, agg_discovered = (int(v) for v in aggregates[-1])
        if agg_discovered < 1 or agg_completed != agg_discovered:
            _fail(f'{label}: aggregate coverage {agg_completed}/{agg_discovered} '
                  'is below the discovered floor')
        if (sum(m[0] for m in matches), sum(m[1] for m in matches)) != \
                (agg_completed, agg_discovered):
            _fail(f'{label}: invocation coverage does not add up to the aggregate')
        completed, discovered = agg_completed, agg_discovered
    else:
        if len(matches) != 1:
            _fail(f'{label}: {len(matches)} per-invocation coverage lines without an aggregate')
        completed, discovered, _, _, _ = matches[0]
        if discovered < 1 or completed != discovered:
            _fail(f'{label}: coverage {completed}/{discovered} is below the discovered floor')
    if (completed, discovered) != (expected_count, expected_count):
        _fail(f'{label}: coverage {completed}/{discovered} is not the exact '
              f'{expected_count}-file floor')
    tests = sum(m[2] for m in matches)
    suites = sum(m[3] for m in matches)
    marks = sum(m[4] for m in matches)
    if tests < 1:
        _fail(f'{label}: suite ran no positive tests')
    if marks != tests + suites:
        _fail(f'{label}: coverage marks {marks} != {tests} tests + {suites} suites')
    blocks = sgp._summary_blocks(text)
    if not blocks:
        _fail(f'{label}: log has no raw node summary (tests/fail)')
    total_fail = 0
    for index, counts in enumerate(blocks, 1):
        if 'tests' not in counts or 'fail' not in counts:
            _fail(f'{label}: raw node summary {index} lacks tests/fail')
        if counts['tests'] < 1:
            _fail(f'{label}: raw node summary {index} reports no positive tests')
        if counts['fail'] != 0 and not allow_fail:
            _fail(f"{label}: raw node summary {index} reports fail={counts['fail']}")
        total_fail += counts['fail']
        if counts.get('cancelled', 0) != 0:
            _fail(f"{label}: raw node summary {index} reports cancelled={counts['cancelled']}")
        if counts.get('pass') is not None:
            accounted = counts['pass'] + counts['fail'] + counts.get('skipped', 0) + \
                counts.get('todo', 0)
            if accounted != counts['tests']:
                _fail(f'{label}: raw node summary {index} does not add up '
                      f'({counts["tests"]} != {accounted})')
    if allow_fail and total_fail < 1:
        _fail(f'{label}: failed lane summary reports no failing test')
    if sum(block['tests'] for block in blocks) != tests:
        _fail(f'{label}: node tests {sum(b["tests"] for b in blocks)} != coverage tests {tests}')
    if all('suites' in block for block in blocks) and \
            sum(block['suites'] for block in blocks) != suites:
        _fail(f'{label}: node suites {sum(b["suites"] for b in blocks)} != coverage suites {suites}')
    if sum(row['tests'] for row in records.values()) != tests:
        _fail(f'{label}: cited coverage tests do not match the log')
    if sum(row['suites'] for row in records.values()) != suites:
        _fail(f'{label}: cited coverage suites do not match the log')
    if sum(row['failed'] for row in records.values()) != total_fail:
        _fail(f'{label}: cited coverage failed count does not match the raw summary')
    if label == '07-test-backend' and sgp.BACKEND_SENTINEL not in text:
        _fail(f'{label}: log lacks the configured projects-root byte-identical: true sentinel')
    return {'tests': tests, 'suites': suites, 'files': completed}


def _focused_partial(text, files):
    selected = re.findall(r'--only .*?— (\d+) file\(s\) SELECTED', text)
    if not selected:
        _fail('focused run log has no PARTIAL RUN selection banner')
    if any(int(count) != len(files) for count in selected):
        _fail('focused run selected a different number of files than its coverage')
    listed = set(re.findall(r'^\[test-harness\]\s+• (.+)$', text, re.M))
    missing = {posixpath.basename(rel) for rel in files} - listed
    if missing:
        _fail(f'focused run banner does not list: {sorted(missing)}')


def _verify_candidate(repo, head, tree, diff_sha, version):
    if not Path(repo).is_dir():
        _fail(f'publishing repo missing: {repo}')
    _commit(repo, head, 'candidate head')
    if not isinstance(tree, str) or not SHA1.match(tree):
        _fail('candidate tree is not a full tree id')
    if not isinstance(diff_sha, str) or not SHA256.match(diff_sha):
        _fail('candidate diff hash is malformed')
    if _git(repo, 'rev-parse', 'HEAD').strip() != head:
        _fail('publishing repo HEAD is not the candidate head')
    if _git(repo, 'rev-parse', 'HEAD^{tree}').strip() != tree:
        _fail('publishing repo tree is not the candidate tree')
    if _git(repo, 'status', '--porcelain', '--untracked-files=no').strip():
        _fail('publishing repo has tracked changes')
    try:
        diff = subprocess.run(['git', '-C', str(repo), 'diff', '--binary', 'HEAD'],
                              check=True, capture_output=True)
    except (subprocess.CalledProcessError, OSError):
        _fail('cannot read the publishing repo diff')
    if hashlib.sha256(diff.stdout).hexdigest() != diff_sha:
        _fail('publishing repo diff is not the proof diff')
    if diff_sha != sgp.EMPTY_DIFF:
        _fail('publishing repo has uncommitted tracked changes; the gate did not certify them')
    if version is not None:
        package = _read_json(Path(repo) / 'package.json')
        if not isinstance(package, dict) or package.get('version') != version:
            _fail(f'package.json version is not {version}')
    return head


def _verify_original(root, res, version, repo, expected_sets):
    """Re-read the original schema-1 proof without changing its failed verdict."""
    og = res.get('original_gate')
    if not isinstance(og, dict):
        _fail('composite proof has no original_gate')
    proof_dir = og.get('proof_dir')
    if not isinstance(proof_dir, str):
        _fail('original_gate proof_dir is missing')
    proof_dir = Path(proof_dir).resolve()
    if not proof_dir.is_dir():
        _fail(f'original proof directory missing: {proof_dir}')
    gate_path = proof_dir / 'gate-result.json'
    if not gate_path.is_file():
        _fail('original proof has no gate-result.json')
    if hashlib.sha256(gate_path.read_bytes()).hexdigest() != og.get('gate_result_sha256'):
        _fail('original gate-result hash does not match the proof')
    orig = _read_json(gate_path)
    if not isinstance(orig, dict) or orig.get('schema') != 1:
        _fail('original gate proof is not schema 1')

    head = _commit(repo, og.get('head'), 'original gate head')
    tree, og_version = og.get('tree'), og.get('version')
    diff = og.get('diff_sha256')
    if not isinstance(tree, str) or not SHA1.match(tree):
        _fail('original_gate tree is not a full tree id')
    if not isinstance(og_version, str):
        _fail('original_gate version is missing')
    if not isinstance(diff, str) or not SHA256.match(diff):
        _fail('original_gate diff hash is malformed')
    if (orig.get('head'), orig.get('tree'), orig.get('version'), orig.get('diff_sha256')) != \
            (head, tree, og_version, diff):
        _fail('original gate-result does not match the cited original_gate identity')
    if og_version != version:
        _fail(f'original gate version {og_version} is not the candidate version {version}')
    if diff != sgp.EMPTY_DIFF:
        _fail('original gate was not run on a clean tracked tree')
    if orig.get('overall_exit') != og.get('overall_exit'):
        _fail('original gate exit does not match the proof')
    if not isinstance(og.get('overall_exit'), int) or isinstance(og.get('overall_exit'), bool) \
            or og['overall_exit'] == 0:
        _fail('original gate is not a failed run')
    if orig.get('partial_run') is not False:
        _fail('original gate is marked partial')
    if orig.get('source_identity_unchanged') is not True:
        _fail('original gate source identity changed during the run')
    if orig.get('steps_expected') != len(sgp.STEPS):
        _fail('original gate did not expect ten steps')
    if orig.get('steps_completed') != og.get('steps_completed'):
        _fail('original gate completed-step count does not match the proof')

    before = sgp._identity(sgp._inside(proof_dir, orig.get('identity_before')))
    after = sgp._identity(sgp._inside(proof_dir, orig.get('identity_after')))
    for label, ident in (('before', before), ('after', after)):
        if ident.get('head') != head or ident.get('head_tree') != tree \
                or ident.get('diff_sha256') != diff:
            _fail(f'original identity-{label} does not match the cited source')
        dirty = sgp._tracked(ident.get('status_porcelain', ''))
        if dirty:
            _fail(f'original identity-{label} has tracked changes: {dirty[:3]}')
    if (before.get('head'), before.get('head_tree'), before.get('diff_sha256')) != \
            (after.get('head'), after.get('head_tree'), after.get('diff_sha256')):
        _fail('original identity before/after disagree')

    manifest_path = sgp._inside(proof_dir, orig.get('per_step_records'))
    if hashlib.sha256(manifest_path.read_bytes()).hexdigest() != og.get('manifest_sha256'):
        _fail('original manifest hash does not match the proof')
    records = []
    for line in manifest_path.read_text().splitlines():
        if line.strip():
            try:
                records.append(json.loads(line))
            except ValueError:
                _fail('original manifest has a non-JSON line')
    if len(records) != orig.get('steps_completed'):
        _fail('original manifest record count does not match steps_completed')
    if not 1 <= len(records) <= len(sgp.STEPS):
        _fail('original manifest record count is out of range')
    expected_steps = [step for step, _ in sgp.STEPS[:len(records)]]
    if [rec.get('step') for rec in records] != expected_steps:
        _fail('original manifest steps are not the canonical prefix in run order')

    for index, rec in enumerate(records):
        step = rec['step']
        command = dict(sgp.STEPS)[step]
        if rec.get('command') != f'npm run {command}':
            _fail(f'{step}: command {rec.get("command")!r} is not the canonical script')
        if rec.get('head') != head or rec.get('diff_sha256') != diff:
            _fail(f'{step}: record is not bound to the original source')
        if not isinstance(rec.get('exit'), int) or isinstance(rec.get('exit'), bool):
            _fail(f'{step}: exit is not an integer')
        log = sgp._inside(proof_dir, rec.get('log'))
        if log.name != f'{step}.log':
            _fail(f'{step}: log name {log.name!r} is not {step}.log')
        raw = log.read_bytes()
        if hashlib.sha256(raw).hexdigest() != rec.get('log_sha256'):
            _fail(f'{step}: log hash does not match log_sha256')
        exit_file = sgp._inside(proof_dir, log.with_name(f'{step}.exit'))
        if exit_file.read_text().strip() != str(rec['exit']):
            _fail(f'{step}: exit file disagrees with the record')
        if index < len(records) - 1:
            if rec['exit'] != 0:
                _fail(f'{step}: an earlier step did not exit 0')
            if step in sgp.SUITE_STEPS:
                sgp._check_suite(step, rec, raw)

    failed = records[-1]
    failed_step = failed['step']
    if failed['exit'] != og['overall_exit']:
        _fail('original failing step exit does not match the gate exit')
    if failed_step != og.get('failed_step'):
        _fail('original failing step is not the cited failed_step')
    if failed_step not in sgp.SUITE_STEPS:
        _fail('a failed non-test step cannot be reconciled by file')
    lane = res.get('lanes', {}).get(failed_step) if isinstance(res.get('lanes'), dict) else None
    if not isinstance(lane, dict):
        _fail(f'composite proof has no lane for {failed_step}')
    records_cov = _coverage_receipts(lane.get('coverage'), expected_sets[failed_step],
                                     f'{failed_step} original coverage')
    failed_raw = sgp._inside(proof_dir, failed['log']).read_bytes()
    _tie_coverage_paths(lane.get('coverage'), failed_raw, f'{failed_step} original coverage')
    _log_counts(failed_raw, failed_step, len(expected_sets[failed_step]), records_cov,
                allow_fail=True)

    return {'proof_dir': proof_dir, 'head': head, 'tree': tree, 'version': og_version,
            'diff_sha256': diff, 'overall_exit': og['overall_exit'],
            'failed_step': failed_step, 'steps_completed': len(records), 'records': records}


def _lane_log(lane, label):
    exit_code = lane.get('exit')
    if not isinstance(exit_code, int) or isinstance(exit_code, bool):
        _fail(f'{label}: exit is not an integer')
    log = _receipt(lane.get('log'), f'{label} log')
    exit_file = _receipt(lane.get('exit_receipt'), f'{label} exit')
    if exit_file.read_text().strip() != str(exit_code):
        _fail(f'{label}: exit receipt disagrees with the lane exit')
    return exit_code, log, log.read_bytes()


def _verify_lanes(res, expected_sets, repo, candidate, original):
    lanes = res.get('lanes')
    if not isinstance(lanes, dict) or set(lanes) != set(SUITE_LANE_DIRS):
        _fail('lanes must name exactly the four suite steps')
    evidence, summaries, bases = {}, {}, {original['head']}
    for step in SUITE_LANE_DIRS:
        expected = expected_sets[step]
        lane = lanes[step]
        if not isinstance(lane, dict):
            _fail(f'{step}: lane is not an object')
        status = lane.get('status')
        source = _commit(repo, lane.get('source_commit'), f'{step} source_commit')
        if status in ('original', 'reconciled') and source != original['head']:
            _fail(f'{step}: {status} lane must cite the original gate head as its source')
        if not _ancestor(repo, source, candidate):
            _fail(f'{step}: source commit {source} is not an ancestor of the candidate')
        exit_code, log, raw = _lane_log(lane, step)
        records = _coverage_receipts(lane.get('coverage'), expected, f'{step} coverage')
        _tie_coverage_paths(lane.get('coverage'), raw, f'{step} coverage')
        bases.add(source)

        if status == 'original':
            rec = next((r for r in original['records'] if r['step'] == step), None)
            if rec is None:
                _fail(f'{step}: original gate has no record for this lane')
            if exit_code != 0 or rec['exit'] != exit_code:
                _fail(f'{step}: original lane is not a clean pass')
            if log.resolve() != sgp._inside(original['proof_dir'], rec['log']).resolve() \
                    or lane['log'].get('sha256') != rec.get('log_sha256'):
                _fail(f'{step}: original lane log is not the gate log')
            _log_counts(raw, step, len(expected), records)
            for rel, row in records.items():
                if not row['success'] or row['failed'] != 0:
                    _fail(f'{step}: original file {rel} did not pass')
                evidence[rel] = (row, source)
        elif status == 'ran':
            if exit_code != 0:
                _fail(f'{step}: separate lane exit {exit_code} is not 0')
            _log_counts(raw, step, len(expected), records)
            for rel, row in records.items():
                if not row['success'] or row['failed'] != 0:
                    _fail(f'{step}: separate lane file {rel} did not pass')
                evidence[rel] = (row, source)
        elif status == 'reconciled':
            if step != original['failed_step']:
                _fail(f'{step}: only the original failing lane may be reconciled')
            if exit_code != original['overall_exit']:
                _fail(f'{step}: original lane exit does not match the gate')
            failed_rec = original['records'][-1]
            if log.resolve() != sgp._inside(original['proof_dir'], failed_rec['log']).resolve() \
                    or lane['log'].get('sha256') != failed_rec.get('log_sha256'):
                _fail(f'{step}: reconciled lane log is not the gate log')
            _log_counts(raw, step, len(expected), records, allow_fail=True)
            failed = {rel for rel, row in records.items()
                      if not row['success'] or row['failed'] != 0}
            if not failed:
                _fail(f'{step}: failed lane has no failed file to reconcile')
            replacement = lane.get('replacement')
            if not isinstance(replacement, dict):
                _fail(f'{step}: reconciled lane has no replacement')
            files = replacement.get('files')
            if not isinstance(files, list) or not files or \
                    any(not isinstance(name, str) for name in files):
                _fail(f'{step}: replacement files are missing')
            if len(set(files)) != len(files):
                _fail(f'{step}: replacement files contain a duplicate')
            unknown = set(files) - expected
            if unknown:
                _fail(f'{step}: replacement names unknown files: {sorted(unknown)[:3]}')
            if not failed <= set(files):
                _fail(f'{step}: failed files are not all replaced: '
                      f'{sorted(failed - set(files))[:3]}')
            extra = set(files) - failed
            review = replacement.get('review')
            if extra and (not isinstance(review, str) or not review.strip()):
                _fail(f'{step}: re-run callers need a replacement.review')
            focused_source = _commit(repo, replacement.get('source_commit'),
                                     f'{step} replacement source_commit')
            if not _ancestor(repo, focused_source, candidate):
                _fail(f'{step}: replacement source is not an ancestor of the candidate')
            focused_exit, focused_log, focused_raw = _lane_log(replacement, f'{step} replacement')
            if focused_exit != 0:
                _fail(f'{step}: replacement exit {focused_exit} is not 0')
            focused_records = _coverage_receipts(replacement.get('coverage'), set(files),
                                                 f'{step} replacement coverage')
            _tie_coverage_paths(replacement.get('coverage'), focused_raw,
                                f'{step} replacement coverage')
            _log_counts(focused_raw, step, len(files), focused_records, allow_partial=True)
            _focused_partial(focused_raw.decode('utf-8', 'replace'), files)
            for rel, row in focused_records.items():
                if not row['success'] or row['failed'] != 0:
                    _fail(f'{step}: replacement file {rel} did not pass')
            bases.add(focused_source)
            for rel in files:
                evidence[rel] = (focused_records[rel], focused_source)
            for rel, row in records.items():
                if rel not in set(files):
                    if not row['success'] or row['failed'] != 0:
                        _fail(f'{step}: unreplaced file {rel} did not pass')
                    evidence[rel] = (row, source)
        else:
            _fail(f'{step}: unknown lane status {status!r}')

        summaries[step] = {'status': status, 'source_commit': source, 'exit': exit_code,
                           'files': len(expected)}

    all_expected = set().union(*expected_sets.values())
    if set(evidence) != all_expected:
        _fail('per-file evidence does not cover exactly the four expected file sets')
    for rel, (row, source) in evidence.items():
        if _blob(repo, source, rel) != _blob(repo, candidate, rel):
            _fail(f'{rel}: test bytes at {source} are not the candidate bytes')
    return evidence, summaries, bases


def _verify_reviews(res, repo, candidate, bases, expected_sets, evidence):
    reviewed = res.get('reviewed_changes')
    if not isinstance(reviewed, dict):
        _fail('composite proof has no reviewed_changes')
    changed = set()
    for base in bases:
        if base == candidate:
            continue
        if not _ancestor(repo, base, candidate):
            _fail(f'source commit {base} is not an ancestor of the candidate')
        for line in _git(repo, 'diff', '--name-only', base, candidate).splitlines():
            if line.strip():
                changed.add(line.strip())
    if set(reviewed) != changed:
        missing, extra = changed - set(reviewed), set(reviewed) - changed
        _fail(f'reviewed_changes is not the exact source diff '
              f'(unreviewed={sorted(missing)[:3]}, stale={sorted(extra)[:3]})')
    all_expected = set().union(*expected_sets.values())
    for path in sorted(changed):
        entry = reviewed[path]
        if not isinstance(entry, dict):
            _fail(f'{path}: review entry is not an object')
        review = entry.get('review')
        if not isinstance(review, str) or not review.strip():
            _fail(f'{path}: review text is missing')
        covered = entry.get('covered_by', [])
        if not isinstance(covered, list) or any(not isinstance(dep, str) for dep in covered):
            _fail(f'{path}: covered_by is not a list of test paths')
        if path in all_expected:
            if path not in covered:
                _fail(f'{path}: changed test file must name itself in covered_by')
        elif not path.startswith('docs/'):
            if not covered:
                _fail(f'{path}: changed product path has no reviewed caller test')
            for dep in covered:
                if dep not in all_expected or dep not in evidence:
                    _fail(f'{path}: covered_by {dep} is not a certified test file')
        else:
            for dep in covered:
                if dep not in all_expected or dep not in evidence:
                    _fail(f'{path}: covered_by {dep} is not a certified test file')


def verify(root, res, head, tree, diff_sha, version, repo):
    """Verify a schema-2 composite proof against the publishing checkout."""
    repo = Path(repo).resolve()
    if not isinstance(version, str) or not version:
        _fail('schema 2 proof requires the shipped version')
    _verify_candidate(repo, head, tree, diff_sha, version)
    if res.get('schema') != 2:
        _fail(f"unsupported proof schema {res.get('schema')!r}")
    if res.get('kind') != COMPOSITE_KIND:
        _fail(f"unsupported composite proof kind {res.get('kind')!r}")
    if res.get('gate') != COMPOSITE_GATE:
        _fail(f"unsupported composite gate {res.get('gate')!r}")
    if res.get('overall_exit') != 0:
        _fail(f"composite overall_exit {res.get('overall_exit')!r} is not 0")
    if res.get('partial_run') is not False:
        _fail(f"composite partial_run {res.get('partial_run')!r} is not false")
    if res.get('source_identity_unchanged') is not True:
        _fail('composite reports source identity changed during the run')
    if res.get('head') != head:
        _fail(f"composite HEAD {res.get('head')} is not the shipped HEAD {head}")
    if res.get('tree') != tree:
        _fail(f"composite tree {res.get('tree')} is not the shipped tree {tree}")
    if res.get('diff_sha256') != diff_sha:
        _fail('composite diff hash is not the shipped checkout diff')
    if version is not None and res.get('version') != version:
        _fail(f"composite version {res.get('version')} is not {version}")
    if res.get('steps_expected') != len(sgp.STEPS) or \
            res.get('steps_completed') != len(sgp.STEPS):
        _fail('composite does not account for all ten steps')

    before = sgp._identity(sgp._inside(root, res.get('identity_before')))
    after = sgp._identity(sgp._inside(root, res.get('identity_after')))
    for label, ident in (('before', before), ('after', after)):
        if ident.get('head') != head or ident.get('head_tree') != tree \
                or ident.get('diff_sha256') != diff_sha:
            _fail(f'composite identity-{label} does not match the shipped source')
        dirty = sgp._tracked(ident.get('status_porcelain', ''))
        if dirty:
            _fail(f'composite identity-{label} has tracked changes: {dirty[:3]}')
    if (before.get('head'), before.get('head_tree'), before.get('diff_sha256')) != \
            (after.get('head'), after.get('head_tree'), after.get('diff_sha256')):
        _fail('composite identity before/after disagree')

    expected_sets = _expected_sets(repo, head)
    lanes = res.get('lanes')
    if not isinstance(lanes, dict) or set(lanes) != set(SUITE_LANE_DIRS):
        _fail('lanes must name exactly the four suite steps')
    original = _verify_original(root, res, version, repo, expected_sets)
    ran = sum(1 for step in SUITE_LANE_DIRS if lanes[step].get('status') == 'ran')
    if original['steps_completed'] + ran != len(sgp.STEPS):
        _fail('original steps plus separate lane runs do not account for all ten steps')
    evidence, summaries, bases = _verify_lanes(res, expected_sets, repo, head, original)
    _verify_reviews(res, repo, head, bases, expected_sets, evidence)
    return {'schema': 2, 'kind': COMPOSITE_KIND, 'proof': str(root), 'head': head,
            'tree': tree, 'diff_sha256': diff_sha, 'steps': len(sgp.STEPS),
            'suite_lanes': len(SUITE_LANE_DIRS), 'original_gate_exit': original['overall_exit'],
            'failed_lane': original['failed_step'],
            'reconciled_files': sorted(lanes[original['failed_step']]['replacement']['files']),
            'lanes': summaries}
