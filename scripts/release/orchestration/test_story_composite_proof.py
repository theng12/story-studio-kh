"""Offline checks for the schema-2 composite proof.

Every fixture is a throwaway git repo plus synthetic logs and coverage JSONL.  No Story
suite, no network, no publisher import (it reads credentials at import time).  Run:

    python3 -I scripts/release/orchestration/test_story_composite_proof.py
"""
import ast
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.dont_write_bytecode = True  # -I ignores PYTHONDONTWRITEBYTECODE; keep the checkout clean
import story_gate_proof as sgp

HERE = Path(__file__).resolve().parent
VERSION = '1.4.389'
EMPTY = sgp.EMPTY_DIFF

A = 'electron/server/__tests__/a.test.ts'
B = 'electron/server/__tests__/b.test.ts'
C = 'electron/server/__tests__/c.test.ts'
F = 'frontend/__tests__/f.test.ts'
R = 'scripts/release/__tests__/r.test.mjs'
P = 'scripts/content-packs/__tests__/p.test.mjs'
RUNTIME = 'electron/server/lib/b.ts'
DOC = 'docs/tasks/HANDOFF.md'


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def receipt(path):
    return {'path': str(path), 'sha256': sha(path)}


def identity(head, tree, diff=EMPTY, status=''):
    return (f'head={head}\nhead_tree={tree}\ndiff_sha256={diff}\n'
            f'status_porcelain<<EOF\n{status}\nEOF\n')


def summary(tests, fail=0, suites=0, cancelled=0, skipped=0):
    return (f'ℹ tests {tests}\nℹ suites {suites}\nℹ pass {tests - fail - skipped}\n'
            f'ℹ fail {fail}\nℹ cancelled {cancelled}\nℹ skipped {skipped}\nℹ todo 0\n')


def coverage_line(files, tests, suites=0):
    return (f'[test-harness] worker-1 suite coverage: {files}/{files} file(s) completed, '
            f'{tests} test(s) + {suites} suite(s) = {tests + suites} marks\n')


def aggregate(files, label='worker-1'):
    return (f'[test-harness] aggregate suite coverage: {files}/{files} file(s) completed; '
            f'inputs=[{label}]\n')


class Fixture:
    """A clean candidate repo with one failed backend lane, its focused rerun and three lanes."""

    def __init__(self, root):
        self.root = Path(root)
        self.repo = self.root / 'repo'
        self.evidence = self.root / 'evidence'
        self.proof = self.root / 'proof'
        self.repo.mkdir()
        self.evidence.mkdir()
        self.proof.mkdir()
        self.git('init', '-b', 'main')
        self.git('config', 'user.email', 'story-tests@example.invalid')
        self.git('config', 'user.name', 'Story Tests')
        self.git('config', 'commit.gpgsign', 'false')
        self.write({'package.json': json.dumps({'version': VERSION}) + '\n',
                    A: 'a1\n', B: 'b1\n', C: 'c1\n', F: 'f1\n', R: 'r1\n', P: 'p1\n',
                    RUNTIME: 'runtime1\n', DOC: 'docs1\n'})
        self.base = self.commit('base')
        self.write({B: 'b2\n', RUNTIME: 'runtime2\n', DOC: 'docs2\n'})
        self.source = self.commit('source')
        self.write({DOC: 'docs3\n'})
        self.candidate = self.commit('candidate')
        self.candidate_tree = self.git('rev-parse', f'{self.candidate}^{{tree}}').strip()
        self.build_original()
        self.build_focused()
        self.build_remaining()
        self.gate = self.build_composite()
        self.write_gate()

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.repo), *args], check=True,
                              capture_output=True, text=True).stdout

    def write(self, files):
        for rel, text in files.items():
            path = self.repo / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)

    def commit(self, message):
        self.git('add', '-A')
        self.git('commit', '-m', message)
        return self.git('rev-parse', 'HEAD').strip()

    def write_log(self, name, text):
        path = self.evidence / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        exit_path = path.with_suffix('.exit')
        exit_path.write_text('0\n')
        return path, exit_path

    def write_coverage(self, name, rows):
        path = self.evidence / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(''.join(json.dumps(row) + '\n' for row in rows))
        return path

    def row(self, rel, tests, success=True, failed=0, suites=0):
        return {'file': str(self.evidence / 'files' / rel), 'success': success,
                'tests': tests, 'suites': suites, 'failed': failed}

    def build_original(self):
        self.gate_dir = self.evidence / 'gate-r1'
        self.gate_dir.mkdir()
        records = []
        for step, script in sgp.STEPS[:7]:
            if step == '07-test-backend':
                log, exit_path = self.write_log(
                    'gate-r1/07-test-backend.log',
                    coverage_line(3, 3) + aggregate(3) + summary(3, fail=1) +
                    sgp.BACKEND_SENTINEL + '\n')
                exit_path.write_text('1\n')
            else:
                log, exit_path = self.write_log(f'gate-r1/{step}.log', f'> {script}\n> ok\n')
            records.append({'step': step, 'command': f'npm run {script}',
                            'exit': 1 if step == '07-test-backend' else 0,
                            'log': str(log), 'log_sha256': sha(log), 'head': self.base,
                            'diff_sha256': EMPTY, 'suite': None, 'node_summary': None})
        manifest = self.gate_dir / 'manifest.jsonl'
        manifest.write_text(''.join(json.dumps(row) + '\n' for row in records))
        (self.gate_dir / 'identity-before.txt').write_text(
            identity(self.base, self.git('rev-parse', f'{self.base}^{{tree}}').strip()))
        (self.gate_dir / 'identity-after.txt').write_text(
            (self.gate_dir / 'identity-before.txt').read_text())
        self.original_coverage = self.write_coverage(
            'coverage/original.jsonl',
            [self.row(A, 1), self.row(B, 1, success=False, failed=1), self.row(C, 1)])
        gate = {'schema': 1, 'gate': 'story-final-gate',
                'worktree': str(self.repo), 'head': self.base,
                'tree': self.git('rev-parse', f'{self.base}^{{tree}}').strip(),
                'version': VERSION, 'diff_sha256': EMPTY,
                'source_identity_unchanged': True, 'overall_exit': 1,
                'steps_completed': 7, 'steps_expected': 10, 'partial_run': False,
                'identity_before': str(self.gate_dir / 'identity-before.txt'),
                'identity_after': str(self.gate_dir / 'identity-after.txt'),
                'per_step_records': str(manifest)}
        (self.gate_dir / 'gate-result.json').write_text(json.dumps(gate) + '\n')

    def build_focused(self):
        banner = ('[test-harness] ==================== PARTIAL RUN ====================\n'
                  '[test-harness] --only "b.test.ts", "c.test.ts" — 2 file(s) SELECTED, '
                  '1 file(s) SKIPPED\n'
                  '[test-harness]   • b.test.ts\n[test-harness]   • c.test.ts\n'
                  '[test-harness] THIS IS NOT THE RELEASE GATE. The full backend suite was NOT run.\n'
                  '[test-harness] ============== END PARTIAL RUN (about to run) ==============\n')
        self.focused_log, self.focused_exit = self.write_log(
            'focused.log', banner + coverage_line(2, 2) + aggregate(2) + summary(2) +
            sgp.BACKEND_SENTINEL + '\n')
        self.focused_coverage = self.write_coverage(
            'coverage/focused.jsonl', [self.row(B, 1), self.row(C, 1)])

    def build_remaining(self):
        self.remaining = {}
        for lane, rel, directory in (
                ('08-test-frontend', F, 'frontend'),
                ('09-test-release', R, 'release'),
                ('10-test-content-packs', P, 'content-packs')):
            log, exit_path = self.write_log(
                f'{lane}.log', coverage_line(1, 1) + aggregate(1) + summary(1))
            cov = self.write_coverage(f'coverage/{directory}.jsonl', [self.row(rel, 1)])
            self.remaining[lane] = (log, exit_path, cov)

    def original_gate(self):
        return {'proof_dir': str(self.gate_dir),
                'gate_result_sha256': sha(self.gate_dir / 'gate-result.json'),
                'manifest_sha256': sha(self.gate_dir / 'manifest.jsonl'),
                'head': self.base,
                'tree': self.git('rev-parse', f'{self.base}^{{tree}}').strip(),
                'version': VERSION, 'diff_sha256': EMPTY, 'overall_exit': 1,
                'failed_step': '07-test-backend', 'steps_completed': 7}

    def build_composite(self):
        lanes = {'07-test-backend': {
            'status': 'reconciled', 'source_commit': self.base, 'exit': 1,
            'log': receipt(self.gate_dir / '07-test-backend.log'),
            'exit_receipt': receipt(self.gate_dir / '07-test-backend.exit'),
            'coverage': [receipt(self.original_coverage)],
            'replacement': {
                'source_commit': self.source, 'files': [B, C], 'exit': 0,
                'review': 'b is the failed file; c is the changed caller re-run',
                'log': receipt(self.focused_log),
                'exit_receipt': receipt(self.focused_exit),
                'coverage': [receipt(self.focused_coverage)]}}}
        for lane, (log, exit_path, cov) in self.remaining.items():
            lanes[lane] = {'status': 'ran', 'source_commit': self.source, 'exit': 0,
                           'log': receipt(log), 'exit_receipt': receipt(exit_path),
                           'coverage': [receipt(cov)]}
        return {
            'schema': 2, 'kind': 'story-composite-gate-proof',
            'gate': 'story-final-gate-composite', 'version': VERSION,
            'head': self.candidate, 'tree': self.candidate_tree, 'diff_sha256': EMPTY,
            'source_identity_unchanged': True, 'overall_exit': 0, 'partial_run': False,
            'steps_expected': 10, 'steps_completed': 10,
            'identity_before': str(self.proof / 'identity-before.txt'),
            'identity_after': str(self.proof / 'identity-after.txt'),
            'original_gate': self.original_gate(), 'lanes': lanes,
            'reviewed_changes': {
                B: {'review': 'focused replacement covers the diagnostic', 'covered_by': [B]},
                RUNTIME: {'review': 'runtime diagnostic change, caller tests named',
                          'covered_by': [B, C]},
                DOC: {'review': 'docs only', 'covered_by': []}},
            'limits': ['not a successful rerun of the original full backend gate']}

    def write_gate(self):
        (self.proof / 'identity-before.txt').write_text(
            identity(self.candidate, self.candidate_tree))
        (self.proof / 'identity-after.txt').write_text(
            (self.proof / 'identity-before.txt').read_text())
        (self.proof / 'gate-result.json').write_text(json.dumps(self.gate) + '\n')

    def verify(self):
        return sgp.verify(self.proof, self.candidate, self.candidate_tree, EMPTY,
                          VERSION, repo=self.repo)

    def refresh(self, item):
        item['sha256'] = sha(Path(item['path']))


class CompositeTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.f = Fixture(self._tmp.name)

    def reject(self):
        with self.assertRaises(sgp.ProofError):
            self.f.verify()

    def test_accepts_a_valid_composite_proof(self):
        out = self.f.verify()
        self.assertEqual((out['schema'], out['steps'], out['suite_lanes']), (2, 10, 4))
        self.assertEqual(out['original_gate_exit'], 1)
        self.assertEqual(out['failed_lane'], '07-test-backend')
        self.assertEqual(out['reconciled_files'], sorted([B, C]))

    def test_rejects_unreplaced_failed_file(self):
        self.f.gate['lanes']['07-test-backend']['replacement']['files'] = [C]
        self.f.write_gate()
        self.reject()

    def test_rejects_stale_log_hash(self):
        with self.f.focused_log.open('a') as handle:
            handle.write('tampered\n')
        self.reject()

    def test_rejects_forged_log_hash(self):
        self.f.gate['lanes']['07-test-backend']['replacement']['log']['sha256'] = '0' * 64
        self.f.write_gate()
        self.reject()

    def test_rejects_missing_coverage(self):
        self.f.gate['lanes']['07-test-backend']['replacement']['coverage'] = []
        self.f.write_gate()
        self.reject()

    def test_rejects_forged_coverage_counts(self):
        rows = [json.loads(line) for line in self.f.focused_coverage.read_text().splitlines()]
        rows[0]['tests'] = 2
        self.f.focused_coverage.write_text(''.join(json.dumps(r) + '\n' for r in rows))
        self.f.refresh(self.f.gate['lanes']['07-test-backend']['replacement']['coverage'][0])
        self.f.write_gate()
        self.reject()

    def test_rejects_skipped_claimed_pass(self):
        rows = [json.loads(line) for line in self.f.focused_coverage.read_text().splitlines()]
        rows[0].update({'success': True, 'tests': 0, 'failed': 0})
        self.f.focused_coverage.write_text(''.join(json.dumps(r) + '\n' for r in rows))
        self.f.refresh(self.f.gate['lanes']['07-test-backend']['replacement']['coverage'][0])
        self.f.write_gate()
        self.reject()

    def test_rejects_extra_coverage(self):
        with self.f.focused_coverage.open('a') as handle:
            handle.write(json.dumps(self.f.row('electron/server/__tests__/zzz.test.ts', 1)) + '\n')
        self.f.refresh(self.f.gate['lanes']['07-test-backend']['replacement']['coverage'][0])
        self.f.write_gate()
        self.reject()

    def test_rejects_duplicate_coverage(self):
        rows = self.f.focused_coverage.read_text().splitlines()
        self.f.focused_coverage.write_text('\n'.join(rows + [rows[0]]) + '\n')
        self.f.refresh(self.f.gate['lanes']['07-test-backend']['replacement']['coverage'][0])
        self.f.write_gate()
        self.reject()

    def test_rejects_source_commit_not_an_ancestor(self):
        orphan = self.f.git('commit-tree', f'{self.f.candidate}^{{tree}}', '-m', 'orphan').strip()
        self.f.gate['lanes']['08-test-frontend']['source_commit'] = orphan
        self.f.write_gate()
        self.reject()

    def test_rejects_coverage_not_named_by_log(self):
        log = self.f.remaining['08-test-frontend'][0]
        named = json.dumps([{'name': 'frontend',
                             'coveragePath': str(self.f.focused_coverage),
                             'exitCode': 0}])
        log.write_text(log.read_text().replace('inputs=[worker-1]', f'inputs={named}'))
        self.f.refresh(self.f.gate['lanes']['08-test-frontend']['log'])
        self.f.write_gate()
        self.reject()

    def test_rejects_bogus_source_commit(self):
        self.f.gate['lanes']['09-test-release']['source_commit'] = 'f' * 40
        self.f.write_gate()
        self.reject()

    def test_rejects_original_lane_source_descendant(self):
        # A retained test changed after the original gate.  Claiming the later commit as the
        # lane's source would satisfy a blob check while the original log result is for old
        # bytes; the source must be the original gate head.
        path = self.f.repo / A
        path.write_text('drift\n')
        drift = self.f.commit('drift')
        (self.f.repo / DOC).write_text('candidate2\n')
        candidate = self.f.commit('candidate2')
        tree = self.f.git('rev-parse', f'{candidate}^{{tree}}').strip()
        self.f.candidate, self.f.candidate_tree = candidate, tree
        self.f.gate['head'], self.f.gate['tree'] = candidate, tree
        self.f.gate['reviewed_changes'][A] = {'review': 'changed test', 'covered_by': [A]}
        self.f.gate['lanes']['07-test-backend']['source_commit'] = drift
        self.f.write_gate()
        self.reject()

    def test_rejects_failed_count_mismatch(self):
        rows = [json.loads(line) for line in self.f.original_coverage.read_text().splitlines()]
        for row in rows:
            if row['file'].endswith(B):
                row['failed'] = 0
        self.f.original_coverage.write_text(''.join(json.dumps(r) + '\n' for r in rows))
        self.f.refresh(self.f.gate['lanes']['07-test-backend']['coverage'][0])
        self.f.write_gate()
        self.reject()

    def test_rejects_missing_manifest(self):
        (self.f.gate_dir / 'manifest.jsonl').unlink()
        self.reject()

    def test_rejects_nonobject_lane(self):
        self.f.gate['lanes']['08-test-frontend'] = []
        self.f.write_gate()
        self.reject()

    def test_rejects_dirty_candidate(self):
        path = self.f.repo / RUNTIME
        path.write_text(path.read_text() + 'dirty\n')
        self.reject()

    def test_rejects_changed_test_bytes(self):
        path = self.f.repo / A
        path.write_text('changed\n')
        drift = self.f.commit('drift')
        tree = self.f.git('rev-parse', f'{drift}^{{tree}}').strip()
        self.f.candidate, self.f.candidate_tree = drift, tree
        self.f.gate['head'], self.f.gate['tree'] = drift, tree
        self.f.gate['reviewed_changes'][A] = {'review': 'changed test', 'covered_by': [A]}
        self.f.write_gate()
        self.reject()

    def test_rejects_unreviewed_change(self):
        del self.f.gate['reviewed_changes'][DOC]
        self.f.write_gate()
        self.reject()

    def test_rejects_product_change_without_caller(self):
        self.f.gate['reviewed_changes'][RUNTIME]['covered_by'] = []
        self.f.write_gate()
        self.reject()

    def test_rejects_original_gate_hash_mismatch(self):
        with (self.f.gate_dir / 'gate-result.json').open('a') as handle:
            handle.write(' ')
        self.reject()

    def test_rejects_relabelled_original_gate(self):
        self.f.gate['original_gate']['overall_exit'] = 0
        self.f.write_gate()
        self.reject()

    def test_schema1_still_accepts_without_using_repo(self):
        import test_story_gate_proof as old
        with tempfile.TemporaryDirectory() as tmp:
            old.build(tmp)
            out = sgp.verify(tmp, old.HEAD, old.TREE, old.EMPTY, old.VERSION,
                             repo='/not/a/repo')
        self.assertEqual(out['schema'], 1)

    def test_publisher_passes_repo_and_normalizes_proof_error(self):
        source = (HERE / 'ship-story.py').read_text()
        tree = ast.parse(source)
        calls = [node for node in ast.walk(tree) if isinstance(node, ast.Call)
                 and isinstance(node.func, ast.Attribute) and node.func.attr == 'verify']
        self.assertTrue(calls)
        self.assertTrue(any(any(keyword.arg == 'repo' for keyword in call.keywords)
                            for call in calls))
        self.assertIn('full-gate proof rejected', source)
        self.assertIn('except story_gate_proof.ProofError as e: stop', source)


if __name__ == '__main__':
    unittest.main(verbosity=2)
