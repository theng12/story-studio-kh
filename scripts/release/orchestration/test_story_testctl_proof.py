"""Offline checks for the schema-3 change-aware testctl proof (story_testctl_proof).

Every fixture is a throwaway git repo plus synthetic testctl receipts, logs, a pinned config
and a fake testctl script; `testctl plan` is stubbed to its reuse verdict so the suite needs no
lane to actually run.  No Story suite, no network, no publisher import.  Run:

    python3 -I scripts/release/orchestration/test_story_testctl_proof.py
"""
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.dont_write_bytecode = True  # -I ignores PYTHONDONTWRITEBYTECODE; keep the checkout clean
import story_gate_proof as sgp
import story_testctl_proof as stp

VERSION = '1.4.391'
EMPTY = sgp.EMPTY_DIFF


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class Fixture:
    """A clean candidate repo, a portfolio config with Story lanes, and a passing proof."""

    def __init__(self, root):
        self.root = Path(root)
        self.repo = self.root / 'checkout'
        self.policy = self.root / 'test-policy'
        self.receipts = self.root / 'test-receipts'
        self.proof = self.root / 'proof'
        for d in (self.repo, self.policy, self.receipts / 'story', self.proof):
            d.mkdir(parents=True, exist_ok=True)
        self.git('init', '-b', 'main')
        self.git('config', 'user.email', 'story-tests@example.invalid')
        self.git('config', 'user.name', 'Story Tests')
        self.git('config', 'commit.gpgsign', 'false')
        self.write({'package.json': json.dumps({'version': VERSION}) + '\n',
                    'electron/server/services/app.ts': 'app1\n',
                    'electron/server/__tests__/app.test.ts': 'test1\n',
                    'frontend/utils/view.ts': 'view1\n',
                    'frontend/__tests__/view.test.ts': 'vtest1\n',
                    'scripts/content-packs/keep.mjs': 'keep1\n',
                    'docs/tasks/HANDOFF.md': 'handoff1\n',
                    'orphan.txt': 'orphan1\n'})
        self.base = self.commit('base')
        self.write({'electron/server/services/app.ts': 'app2\n',
                    'electron/server/__tests__/app.test.ts': 'test2\n',
                    'frontend/utils/view.ts': 'view2\n',
                    'docs/tasks/HANDOFF.md': 'handoff2\n'})
        self.head = self.commit('candidate')
        self.tree = self.git('rev-parse', f'{self.head}^{{tree}}').strip()

        self.lanes = {
            'release-cheap': {'command': ['npm', 'run', 'lint'], 'paths': ['.'], 'timeoutMin': 20},
            'packaged-smoke': {'command': ['npm', 'run', 'dist:smoke'],
                               'paths': ['.', ':(exclude)docs'], 'timeoutMin': 40},
            'timeline-backend': {'command': ['node', 'runner.mjs', '--only', 'app'],
                                 'paths': ['electron'], 'timeoutMin': 15},
            'timeline-frontend': {'command': ['node', 'runner.mjs', 'frontend'],
                                  'paths': ['frontend'], 'timeoutMin': 15},
            'content-packs': {'command': ['node', 'runner.mjs', 'packs'],
                              'paths': ['scripts/content-packs'], 'timeoutMin': 10},
        }
        self.config_path = self.policy / 'projects.json'
        self.config_path.write_text(json.dumps({
            'receiptsDir': '../test-receipts',
            'tmpDir': '../tmp',
            'projects': {'story': {'path': str(self.repo), 'lanes': self.lanes,
                                   'clean': ['coverage'], 'build': ['dist']}},
        }, indent=1) + '\n')
        self.testctl = self.root / 'testctl.mjs'
        self.testctl.write_text('// fake testctl source pinned by the proof\n')
        self.config = json.loads(self.config_path.read_text())

        # Receipts: the changed-work lanes ran on the candidate; the untouched lane was last
        # passed at the base commit and is cited as skipped.
        self.receipt_of = {}
        for name in ('release-cheap', 'packaged-smoke', 'timeline-backend', 'timeline-frontend'):
            self.receipt_of[name] = self.make_receipt(name, self.head, status='pass')
        self.receipt_of['content-packs'] = self.make_receipt('content-packs', self.base,
                                                             status='pass')
        self.build_proof()

    # -- git helpers -------------------------------------------------------
    def git(self, *args):
        r = subprocess.run(['git', '-C', str(self.repo), *args], capture_output=True, text=True)
        assert r.returncode == 0, r.stderr
        return r.stdout

    def write(self, files):
        for rel, text in files.items():
            p = self.repo / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text)

    def commit(self, message):
        self.git('add', '-A')
        self.git('commit', '-m', message)
        return self.git('rev-parse', 'HEAD').strip()

    # -- receipts ----------------------------------------------------------
    def make_receipt(self, lane_name, receipt_head, status='pass', exit_code=0, log_body=None):
        lanes = json.loads(self.config_path.read_text())['projects']['story']['lanes']
        lane = lanes[lane_name]
        env = stp._env_state(lane)
        key = stp._compute_key(self.repo, {'clean': ['coverage'], 'build': ['dist']}, lane, env)
        path = self.receipts / 'story' / f'{lane_name}.json'
        log = path.with_suffix('.log')
        if isinstance(log_body, bytes):
            body = log_body
        else:
            body = (log_body or f'$ {" ".join(lane["command"])}\nall green\n').encode()
        log.write_bytes(body)
        receipt = {'project': 'story', 'lane': lane_name, 'key': key, 'status': status,
                   'exitCode': exit_code, 'commands': stp._commands(lane),
                   'tree': {'head': receipt_head, 'dirty': False}, 'env': env,
                   'startedAt': '2026-11-09T00:00:00.000Z', 'durationMs': 1000,
                   'host': env['host'], 'testctl': '2',
                   'log': {'file': str(log), 'sha256': hashlib.sha256(body).hexdigest(),
                           'bytes': len(body)}}
        path.write_text(json.dumps(receipt, indent=1) + '\n')
        return path

    def build_proof(self):
        self.config = json.loads(self.config_path.read_text())
        identity = (f'head={self.head}\nhead_tree={self.tree}\ndiff_sha256={EMPTY}\n'
                    'status_porcelain<<EOF\nEOF\n')
        (self.proof / 'identity.txt').write_text(identity)
        lanes = {}
        for name, receipt in self.receipt_of.items():
            entry = {'receipt': str(receipt), 'sha256': sha(receipt)}
            if receipt == self.receipt_of['content-packs']:
                entry.update(result='skipped', skipped_since=self.base)
            else:
                entry['result'] = 'ran'
            lanes[name] = entry
        self.gate = {'schema': 3, 'kind': stp.PROOF_KIND, 'gate': stp.GATE_NAME,
                     'version': VERSION, 'head': self.head, 'tree': self.tree,
                     'diff_sha256': EMPTY, 'base': self.base,
                     'identity': str(self.proof / 'identity.txt'),
                     'config': {'path': str(self.config_path), 'sha256': sha(self.config_path),
                                'origin': '586ac11d00000000000000000000000000000000',
                                'testctl': str(self.testctl),
                                'testctl_sha256': sha(self.testctl)},
                     'lanes': lanes}
        (self.proof / 'gate-result.json').write_text(json.dumps(self.gate, indent=1) + '\n')

    # -- verification ------------------------------------------------------
    def verify(self, **kw):
        """Verify with `testctl plan` stubbed to report every cited lane reusable."""
        reuse = set(kw.pop('reuse', None) or self.gate['lanes'])
        with mock.patch.object(stp, '_plan_reuse', return_value=reuse):
            return sgp.verify(self.proof, kw.pop('head', self.head), kw.pop('tree', self.tree),
                              kw.pop('diff', EMPTY), kw.pop('version', VERSION),
                              repo=kw.pop('repo', self.repo))

    def save(self):
        (self.proof / 'gate-result.json').write_text(json.dumps(self.gate, indent=1) + '\n')

    def refresh(self, name):
        """Re-point the proof at a receipt file after a test rewrites it."""
        lane = self.gate['lanes'][name]
        lane['sha256'] = sha(lane['receipt'])
        self.save()


class TestctlProofTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.fx = Fixture(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def rejects(self, fragment, **kw):
        with self.assertRaises(sgp.ProofError) as ctx:
            self.fx.verify(**kw)
        self.assertIn(fragment, str(ctx.exception))

    # -- acceptance --------------------------------------------------------
    def test_accepts_a_complete_change_aware_proof(self):
        out = self.fx.verify()
        self.assertEqual(out['schema'], 3)
        self.assertEqual((out['changed'], out['lanes'], out['ran'], out['skipped']), (4, 5, 4, 1))
        self.assertEqual(out['skipped_since'], [self.fx.base])

    def test_dispatcher_routes_schema_three(self):
        out = self.fx.verify()
        self.assertEqual(out['lanes'], 5)

    def test_dispatcher_requires_repo_for_schema_three(self):
        self.rejects('requires the publishing repo', repo=None)

    # -- candidate binding --------------------------------------------------
    def test_rejects_unclean_shipped_checkout(self):
        self.rejects('uncommitted tracked changes', diff='c' * 40)

    def test_rejects_proof_head_mismatch(self):
        self.rejects('is not the shipped HEAD', head='d' * 40)

    def test_rejects_identity_with_tracked_change(self):
        (self.fx.proof / 'identity.txt').write_text(
            f'head={self.fx.head}\nhead_tree={self.fx.tree}\ndiff_sha256={EMPTY}\n'
            'status_porcelain<<EOF\n M electron/server/services/app.ts\nEOF\n')
        self.rejects('identity has tracked changes')

    def test_rejects_no_changed_work(self):
        base_tree = self.fx.git('rev-parse', f'{self.fx.base}^{{tree}}').strip()
        self.fx.gate.update(head=self.fx.base, tree=base_tree, base=self.fx.base)
        (self.fx.proof / 'identity.txt').write_text(
            f'head={self.fx.base}\nhead_tree={base_tree}\ndiff_sha256={EMPTY}\n'
            'status_porcelain<<EOF\nEOF\n')
        self.fx.save()
        self.rejects('no changed work between base and candidate',
                     head=self.fx.base, tree=base_tree)

    def test_rejects_base_that_is_not_an_ancestor(self):
        self.fx.git('commit', '--allow-empty', '-m', 'orphan')
        empty = self.fx.git('rev-parse', 'HEAD').strip()
        self.fx.git('checkout', '--detach', 'HEAD~1')
        self.fx.gate['base'] = empty
        self.fx.save()
        self.rejects('is not an ancestor')

    # -- config pinning -----------------------------------------------------
    def test_rejects_edited_config(self):
        self.fx.config_path.write_text(self.fx.config_path.read_text() + '\n')
        self.rejects('config sha256 does not match')

    def test_rejects_edited_testctl_source(self):
        self.fx.testctl.write_text('// tampered\n')
        self.rejects('testctl sha256 does not match')

    def test_rejects_config_pointing_at_another_checkout(self):
        cfg = json.loads(self.fx.config_path.read_text())
        cfg['projects']['story']['path'] = '/tmp/some-other-checkout'
        self.fx.config_path.write_text(json.dumps(cfg))
        self.fx.gate['config']['sha256'] = sha(self.fx.config_path)
        self.fx.save()
        self.rejects('is not this checkout')

    def test_rejects_receipt_outside_the_receipts_directory(self):
        stray = self.fx.root / 'stray.json'
        stray.write_text(self.fx.receipt_of['content-packs'].read_text())
        self.fx.gate['lanes']['content-packs']['receipt'] = str(stray)
        self.fx.save()
        self.rejects('outside the configured receipts directory')

    # -- receipts -----------------------------------------------------------
    def test_rejects_failed_receipt(self):
        self.fx.make_receipt('content-packs', self.fx.base, status='fail', exit_code=1,
                             log_body=b'boom\n')
        self.fx.refresh('content-packs')
        self.rejects('stays failed')

    def test_rejects_tampered_log(self):
        log = self.fx.receipt_of['timeline-backend'].with_suffix('.log')
        log.write_text('$ node runner.mjs --only app\nred\n')
        self.fx.refresh('timeline-backend')
        self.rejects('log sha256 does not match')

    def test_rejects_tampered_key(self):
        path = self.fx.receipt_of['timeline-backend']
        rec = json.loads(path.read_text())
        rec['key'] = 'e' * 64
        path.write_text(json.dumps(rec))
        self.fx.refresh('timeline-backend')
        self.rejects('does not match the lane')

    def test_rejects_commands_that_differ_from_the_configured_lane(self):
        path = self.fx.receipt_of['timeline-backend']
        rec = json.loads(path.read_text())
        rec['commands'] = [['npm', 'test', '--anything-else']]
        path.write_text(json.dumps(rec))
        self.fx.refresh('timeline-backend')
        self.rejects('differ from the configured lane')

    def test_rejects_receipt_from_another_toolchain(self):
        path = self.fx.receipt_of['timeline-backend']
        rec = json.loads(path.read_text())
        rec['env']['node'] = 'v0.0.1'
        path.write_text(json.dumps(rec))
        self.fx.refresh('timeline-backend')
        self.rejects('toolchain/host/env differs')

    def test_rejects_receipt_when_testctl_plan_says_inputs_changed(self):
        with self.assertRaises(sgp.ProofError) as ctx:
            self.fx.verify(reuse={'release-cheap', 'packaged-smoke', 'timeline-frontend'})
        self.assertIn('testctl plan', str(ctx.exception))

    # -- skipped never passed ------------------------------------------------
    def test_rejects_a_claimed_pass_for_a_reused_result(self):
        self.fx.gate['lanes']['content-packs']['result'] = 'passed'
        self.fx.save()
        self.rejects('never passed')

    def test_rejects_skipped_claim_for_a_receipt_ran_on_the_candidate(self):
        lane = self.fx.gate['lanes']['content-packs']
        lane.update(receipt=str(self.fx.make_receipt('content-packs', self.fx.head)),
                    result='skipped', skipped_since=self.fx.base)
        self.fx.refresh('content-packs')
        self.rejects('but the receipt ran on')

    def test_rejects_ran_claim_for_a_receipt_from_an_earlier_commit(self):
        path = self.fx.make_receipt('timeline-backend', self.fx.base)
        lane = self.fx.gate['lanes']['timeline-backend']
        lane.update(receipt=str(path), sha256=sha(path), result='ran')
        lane.pop('skipped_since', None)
        self.fx.save()
        self.rejects("derived 'skipped'")

    def test_rejects_skipped_lane_whose_pathspecs_cover_changed_work(self):
        # timeline-backend's receipt is from the base commit, but `electron` changed since.
        path = self.fx.make_receipt('timeline-backend', self.fx.base)
        lane = self.fx.gate['lanes']['timeline-backend']
        lane.update(receipt=str(path), sha256=sha(path), result='skipped',
                    skipped_since=self.fx.base)
        self.fx.save()
        self.rejects('its pathspecs cover changes since the receipt ran')

    def test_rejects_skipped_without_skipped_since(self):
        lane = self.fx.gate['lanes']['content-packs']
        lane.pop('skipped_since')
        self.fx.save()
        self.rejects('skipped_since must name the commit')

    # -- coverage ------------------------------------------------------------
    def test_rejects_changed_path_covered_by_no_cited_lane(self):
        cfg = json.loads(self.fx.config_path.read_text())
        cfg['projects']['story']['lanes'] = {
            'release-cheap': {'command': ['npm', 'run', 'lint'], 'paths': ['package.json']},
            'packaged-smoke': {'command': ['npm', 'run', 'dist:smoke'],
                               'paths': ['scripts']},
        }
        self.fx.config_path.write_text(json.dumps(cfg))
        for name in cfg['projects']['story']['lanes']:
            self.fx.make_receipt(name, self.fx.head)
            self.fx.gate['lanes'][name]['sha256'] = sha(self.fx.receipt_of[name])
        self.fx.save()
        gate = json.loads((self.fx.proof / 'gate-result.json').read_text())
        for name in list(gate['lanes']):
            if name not in cfg['projects']['story']['lanes']:
                gate['lanes'].pop(name)
        gate['config']['sha256'] = sha(self.fx.config_path)
        (self.fx.proof / 'gate-result.json').write_text(json.dumps(gate))
        with mock.patch.object(stp, '_plan_reuse',
                               return_value=set(gate['lanes'])):
            with self.assertRaises(sgp.ProofError) as ctx:
                sgp.verify(self.fx.proof, self.fx.head, self.fx.tree, EMPTY, VERSION,
                           repo=self.fx.repo)
        self.assertIn('covered by no cited lane', str(ctx.exception))

    def test_rejects_app_code_covered_only_by_required_global_lanes(self):
        gate = json.loads((self.fx.proof / 'gate-result.json').read_text())
        for name in list(gate['lanes']):
            if name not in stp.REQUIRED_LANES:
                gate['lanes'].pop(name)
        (self.fx.proof / 'gate-result.json').write_text(json.dumps(gate))
        with mock.patch.object(stp, '_plan_reuse',
                               return_value=set(stp.REQUIRED_LANES)):
            with self.assertRaises(sgp.ProofError) as ctx:
                sgp.verify(self.fx.proof, self.fx.head, self.fx.tree, EMPTY, VERSION,
                           repo=self.fx.repo)
        self.assertIn('caller lane', str(ctx.exception))

    def test_rejects_missing_required_lane(self):
        self.fx.gate['lanes'].pop('packaged-smoke')
        self.fx.save()
        self.rejects("missing the required lane 'packaged-smoke'")

    def test_rejects_lane_not_defined_in_the_config(self):
        self.fx.gate['lanes']['made-up'] = dict(self.fx.gate['lanes']['content-packs'])
        self.fx.save()
        self.rejects('does not define lane')


if __name__ == '__main__':
    unittest.main(verbosity=2)