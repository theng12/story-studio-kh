"""Offline proof check for story_gate_proof.verify.  Builds a synthetic full-gate proof in a
temp directory and asserts the verifier accepts it, then that each tamper is rejected.  No
network, no repo, no gate.  Run only when the coordinator grants the lane:

    python3 -I ~/Developer/_orchestra/codex-takeover-20261012/tools/test_story_gate_proof.py
"""
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.dont_write_bytecode = True  # -I ignores PYTHONDONTWRITEBYTECODE; keep the checkout clean
import story_gate_proof as sgp

HEAD = 'a' * 40
TREE = 'b' * 40
VERSION = '1.4.350'
EMPTY = sgp.EMPTY_DIFF
COV = '[test-harness] backend suite coverage: 2/2 file(s) completed, 68 test(s) + 12 suite(s) = 80 marks'


def build(root, head=HEAD, tree=TREE, diff=EMPTY, status='', version=VERSION):
    root = Path(root)
    logs = root / 'logs'
    logs.mkdir(parents=True, exist_ok=True)
    records = []
    for step, script in sgp.STEPS:
        if step in sgp.SUITE_STEPS:
            lines = [COV, 'ℹ tests 68', 'ℹ suites 12', 'ℹ pass 68', 'ℹ fail 0',
                     'ℹ cancelled 0', 'ℹ skipped 0', 'ℹ todo 0']
            if step == '07-test-backend':
                lines.append(sgp.BACKEND_SENTINEL)
            text = '\n'.join(lines) + '\n'
        else:
            text = f'> story-studio-kh@1.4.350 {script}\n> ok\n'
        log = logs / f'{step}.log'
        log.write_text(text)
        (logs / f'{step}.exit').write_text('0\n')
        suite = None
        if step in sgp.SUITE_STEPS:
            suite = {'coverage_completed': 2, 'coverage_discovered': 2, 'coverage_at_floor': True,
                     'tests': 68, 'suites': 12, 'marks': 80, 'partial': False}
        records.append({'step': step, 'command': f'npm run {script}', 'exit': 0, 'log': str(log),
                        'log_sha256': hashlib.sha256(log.read_bytes()).hexdigest(), 'head': head,
                        'diff_sha256': diff, 'suite': suite,
                        'node_summary': {'tests': 68, 'suites': 12, 'pass': 68, 'fail': 0,
                                         'cancelled': 0, 'skipped': 0, 'todo': 0}})
    manifest = root / 'manifest.jsonl'
    manifest.write_text(''.join(json.dumps(r) + '\n' for r in records))
    ident = ('captured_at=2026-10-21T00:00:00Z\nworktree=/tmp/w\n'
             f'head={head}\nhead_tree={tree}\ndiff_sha256={diff}\n'
             f'status_porcelain<<EOF\n{status}\nEOF\n')
    (root / 'identity-before.txt').write_text(ident)
    (root / 'identity-after.txt').write_text(ident)
    gate = {'schema': 1, 'gate': 'story-baseline', 'worktree': '/tmp/w', 'head': head, 'tree': tree,
            'diff_sha256': diff, 'version': version, 'source_identity_unchanged': True,
            'overall_exit': 0, 'steps_completed': len(records), 'steps_expected': len(records),
            'partial_run': False, 'identity_before': str(root / 'identity-before.txt'),
            'identity_after': str(root / 'identity-after.txt'), 'per_step_records': str(manifest)}
    (root / 'gate-result.json').write_text(json.dumps(gate, indent=2) + '\n')
    return records, gate


def rehash_log(root, step):
    log = Path(root) / 'logs' / f'{step}.log'
    for path in (Path(root) / 'manifest.jsonl',):
        records = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
        for r in records:
            if r['step'] == step:
                r['log_sha256'] = hashlib.sha256(log.read_bytes()).hexdigest()
        path.write_text(''.join(json.dumps(r) + '\n' for r in records))


def set_suite(root, step, text, suite_update=None):
    log = Path(root) / 'logs' / f'{step}.log'
    log.write_text(text)
    path = Path(root) / 'manifest.jsonl'
    records = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    for r in records:
        if r['step'] == step:
            r['log_sha256'] = hashlib.sha256(log.read_bytes()).hexdigest()
            if suite_update:
                r['suite'].update(suite_update)
    path.write_text(''.join(json.dumps(r) + '\n' for r in records))


NODE_OK = 'ℹ tests 68\nℹ suites 12\nℹ pass 68\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\n'


class ProofTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def verify(self, **kw):
        return sgp.verify(self.root, kw.pop('head', HEAD), kw.pop('tree', TREE),
                          kw.pop('diff', EMPTY), kw.pop('version', VERSION))

    def test_accepts_a_complete_proof(self):
        build(self.root)
        out = self.verify()
        self.assertEqual((out['steps'], out['suite_lanes']), (10, 4))

    def test_accepts_untracked_runtime_file(self):
        build(self.root, status='?? runtime.json')
        self.verify()

    def test_rejects_tracked_change_in_proof(self):
        build(self.root, status=' M electron/server/__tests__/app-update.test.ts')
        with self.assertRaises(sgp.ProofError):
            self.verify()

    def test_rejects_different_integrated_source(self):
        build(self.root)
        with self.assertRaises(sgp.ProofError):
            self.verify(head='c' * 40)
        with self.assertRaises(sgp.ProofError):
            self.verify(tree='d' * 40)

    def test_rejects_uncommitted_tracked_diff(self):
        build(self.root, diff='f' * 64)
        with self.assertRaises(sgp.ProofError):
            self.verify(diff='f' * 64)

    def test_rejects_nonzero_exit(self):
        records, _ = build(self.root)
        (self.root / 'logs' / '09-test-release.exit').write_text('1\n')
        records = [r if r['step'] != '09-test-release' else {**r, 'exit': 1}
                   for r in records]
        (self.root / 'manifest.jsonl').write_text(''.join(json.dumps(r) + '\n' for r in records))
        with self.assertRaises(sgp.ProofError):
            self.verify()

    def test_rejects_missing_step(self):
        records, _ = build(self.root)
        (self.root / 'manifest.jsonl').write_text(
            ''.join(json.dumps(r) + '\n' for r in records[:-1]))
        with self.assertRaises(sgp.ProofError):
            self.verify()

    def test_rejects_tampered_log(self):
        build(self.root)
        with (self.root / 'logs' / '01-lint.log').open('a') as f:
            f.write('tampered\n')
        with self.assertRaises(sgp.ProofError):
            self.verify()

    def test_rejects_partial_run_banner(self):
        build(self.root)
        log = self.root / 'logs' / '07-test-backend.log'
        log.write_text(log.read_text() + '[test-harness] ==================== PARTIAL RUN ====================\n')
        rehash_log(self.root, '07-test-backend')
        with self.assertRaises(sgp.ProofError):
            self.verify()

    def test_rejects_coverage_below_floor(self):
        build(self.root)
        log = self.root / 'logs' / '08-test-frontend.log'
        log.write_text(COV.replace('2/2', '1/2'))
        rehash_log(self.root, '08-test-frontend')
        records = [json.loads(l) for l in (self.root / 'manifest.jsonl').read_text().splitlines()]
        for r in records:
            if r['step'] == '08-test-frontend':
                r['suite'].update({'coverage_completed': 1, 'coverage_at_floor': False})
        (self.root / 'manifest.jsonl').write_text(''.join(json.dumps(r) + '\n' for r in records))
        with self.assertRaises(sgp.ProofError):
            self.verify()

    def test_rejects_manufactured_summary(self):
        build(self.root)
        log = self.root / 'logs' / '09-test-release.log'
        log.write_text(COV.replace('2/2', '1/2'))
        rehash_log(self.root, '09-test-release')  # record still claims 2/2
        with self.assertRaises(sgp.ProofError):
            self.verify()

    def test_rejects_missing_raw_summary(self):
        build(self.root)
        set_suite(self.root, '07-test-backend', COV + '\n')
        with self.assertRaises(sgp.ProofError):
            self.verify()

    def test_rejects_nonzero_fail(self):
        build(self.root)
        set_suite(self.root, '08-test-frontend',
                  COV + '\nℹ tests 68\nℹ suites 12\nℹ pass 67\nℹ fail 1\nℹ cancelled 0\n')
        with self.assertRaises(sgp.ProofError):
            self.verify()

    def test_rejects_cancelled(self):
        build(self.root)
        set_suite(self.root, '09-test-release',
                  COV + '\nℹ tests 68\nℹ suites 12\nℹ pass 68\nℹ fail 0\nℹ cancelled 2\n')
        with self.assertRaises(sgp.ProofError):
            self.verify()

    def test_rejects_marks_arithmetic(self):
        build(self.root)
        set_suite(self.root, '10-test-content-packs',
                  COV.replace('= 80 marks', '= 81 marks') + '\n' + NODE_OK, {'marks': 81})
        with self.assertRaises(sgp.ProofError):
            self.verify()

    def test_rejects_node_coverage_tests_mismatch(self):
        build(self.root)
        set_suite(self.root, '09-test-release',
                  COV.replace('68 test(s)', '67 test(s)').replace('= 80 marks', '= 79 marks')
                  + '\n' + NODE_OK, {'tests': 67, 'marks': 79})
        with self.assertRaises(sgp.ProofError):
            self.verify()

    def test_rejects_node_coverage_suites_mismatch(self):
        build(self.root)
        set_suite(self.root, '08-test-frontend',
                  COV + '\nℹ tests 68\nℹ suites 11\nℹ pass 68\nℹ fail 0\nℹ cancelled 0\n')
        with self.assertRaises(sgp.ProofError):
            self.verify()

    def test_rejects_backend_sentinel_missing(self):
        build(self.root)
        set_suite(self.root, '07-test-backend', COV + '\n' + NODE_OK)
        with self.assertRaises(sgp.ProofError):
            self.verify()

    def test_rejects_wrong_schema_or_partial_flag(self):
        _, gate = build(self.root)
        gate['schema'] = 2
        (self.root / 'gate-result.json').write_text(json.dumps(gate) + '\n')
        with self.assertRaises(sgp.ProofError):
            self.verify()
        gate['schema'] = 1
        gate['partial_run'] = True
        (self.root / 'gate-result.json').write_text(json.dumps(gate) + '\n')
        with self.assertRaises(sgp.ProofError):
            self.verify()

    def test_rejects_missing_proof(self):
        with self.assertRaises(sgp.ProofError):
            sgp.verify(self.root / 'absent', HEAD, TREE, EMPTY, VERSION)

    def test_rejects_version_mismatch(self):
        build(self.root, version='1.4.349')
        with self.assertRaises(sgp.ProofError):
            self.verify()


if __name__ == '__main__':
    unittest.main(verbosity=2)
