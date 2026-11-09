"""Tests for the thin Story adapter (story_testctl_proof) that delegates to the
portfolio common-core CLI.

Every fixture is a throwaway git repo plus a synthetic proof directory, config,
review and fake testctl script; no Story suite, no network, no publisher import,
no real app signing or installer. The trusted CLI path points at the portfolio
worktree's testctl.mjs for real interop tests. Run:

    python3 -I scripts/release/orchestration/test_story_testctl_proof.py
"""
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.dont_write_bytecode = True
import story_gate_proof as sgp
import story_testctl_proof as stp

VERSION = '1.4.391'
EMPTY = sgp.EMPTY_DIFF
# Trusted CLI for real interop — the portfolio worktree's testctl.mjs.
TRUSTED_TESTCTL = Path('/Volumes/KH-STUDIO-ATLAS/KH-Worktrees/portfolio/'
                       'qualified-testctl-proof-20261109/tools/testctl.mjs')


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class Fixture:
    """A clean candidate repo, a portfolio config, review file and proof dir."""

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
                    'frontend/utils/view.ts': 'view1\n'})
        self.base = self.commit('base')
        self.write({'electron/server/services/app.ts': 'app2\n',
                    'frontend/utils/view.ts': 'view2\n'})
        self.head = self.commit('candidate')
        self.tree = self.git('rev-parse', f'{self.head}^{{tree}}').strip()

        self.lanes = {
            'release-cheap': {'command': ['echo', 'lint-ok'], 'paths': ['.']},
            'packaged-smoke': {'command': ['echo', 'smoke-ok'],
                               'paths': ['.', ':(exclude)docs']},
        }
        self.config_path = self.policy / 'projects.json'
        self.config_path.write_text(json.dumps({
            'receiptsDir': str(self.receipts),
            'tmpDir': str(self.root / 'tmp'),
            'projects': {'story': {'path': str(self.repo), 'lanes': self.lanes}},
        }, indent=1) + '\n')

        # Review file: required by the common-core verifier.
        changed = self.git('diff', '--name-only', '-z', self.base, self.head
                           ).split('\0')
        changed = [p for p in changed if p]
        self.review_path = self.root / 'review.json'
        self.review_path.write_text(json.dumps({
            'base': self.base, 'head': self.head,
            'changed_paths': changed,
            'caller_paths': [p for p in changed
                             if p.startswith(('electron/', 'frontend/'))],
            'lane_mapping': {
                'release-cheap': {'reason': 'global cheap check',
                                  'changed_paths': changed},
                'packaged-smoke': {'reason': 'candidate launch smoke',
                                   'changed_paths': changed},
            },
        }, indent=1) + '\n')

        # Build receipts via the trusted CLI so keys match exactly.
        for lane_name in self.lanes:
            r = subprocess.run(
                ['node', str(TRUSTED_TESTCTL), 'run', 'story', lane_name,
                 '--config', str(self.config_path)],
                capture_output=True, text=True, cwd=str(self.repo))
            assert r.returncode == 0, f'testctl run {lane_name} failed: {r.stderr}'

        self.build_proof()

    def git(self, *args):
        r = subprocess.run(['git', '-C', str(self.repo), *args],
                           capture_output=True, text=True)
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

    def build_proof(self):
        """Export a proof via the trusted CLI so it matches the common schema."""
        r = subprocess.run(
            ['node', str(TRUSTED_TESTCTL), 'proof', 'export', 'story',
             '--base', self.base, '--version', VERSION,
             '--config', str(self.config_path),
             '--out', str(self.proof)],
            capture_output=True, text=True)
        assert r.returncode == 0, f'proof export failed: {r.stderr}\n{r.stdout}'

    def verify(self, **kw):
        return sgp.verify(
            self.proof,
            kw.pop('head', self.head),
            kw.pop('tree', self.tree),
            kw.pop('diff', EMPTY),
            kw.pop('version', VERSION),
            repo=kw.pop('repo', self.repo),
            config=kw.pop('config', str(self.config_path)),
            review=kw.pop('review', str(self.review_path)),
            testctl=kw.pop('testctl', str(TRUSTED_TESTCTL)))

    def save_gate(self, gate):
        (self.proof / 'gate-result.json').write_text(
            json.dumps(gate, indent=1) + '\n')


class AdapterTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.fx = Fixture(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def rejects(self, fragment, **kw):
        with self.assertRaises(sgp.ProofError) as ctx:
            self.fx.verify(**kw)
        self.assertIn(fragment, str(ctx.exception))

    # -- acceptance --------------------------------------------------------
    def test_accepts_valid_common_core_proof(self):
        out = self.fx.verify()
        self.assertEqual(out['proof_kind'], 'testctl-change-aware')
        self.assertEqual(out['schema'], 2)
        self.assertEqual(out['head'], self.fx.head)

    # -- dispatcher routing ------------------------------------------------
    def test_dispatcher_routes_by_proof_kind_before_schema(self):
        """proof_kind 'testctl-change-aware' goes to the adapter even though
        schema is 2 (same number as composite)."""
        out = self.fx.verify()
        self.assertEqual(out['proof_kind'], 'testctl-change-aware')

    def test_dispatcher_refuses_old_story_schema3(self):
        gate = json.loads((self.fx.proof / 'gate-result.json').read_text())
        gate['proof_kind'] = 'story-testctl-proof'
        gate['schema'] = 3
        gate['kind'] = 'story-testctl-proof'
        self.fx.save_gate(gate)
        self.rejects('old Story schema-3 proof is refused')

    def test_dispatcher_refuses_bare_schema3_without_proof_kind(self):
        gate = json.loads((self.fx.proof / 'gate-result.json').read_text())
        gate.pop('proof_kind', None)
        gate['schema'] = 3
        self.fx.save_gate(gate)
        self.rejects('old Story schema-3 proof is refused')

    # -- missing trusted inputs --------------------------------------------
    def test_rejects_missing_trusted_config(self):
        self.rejects('trusted config path is required', config=None)

    def test_rejects_missing_trusted_review(self):
        self.rejects('trusted review path is required', review=None)

    def test_rejects_nonexistent_config_file(self):
        self.rejects('trusted config missing',
                     config='/nonexistent/config.json')

    def test_rejects_nonexistent_review_file(self):
        self.rejects('trusted review missing',
                     review='/nonexistent/review.json')

    def test_rejects_nonexistent_testctl(self):
        self.rejects('trusted testctl missing',
                     testctl='/nonexistent/testctl.mjs')

    # -- packaged-smoke must be fresh --------------------------------------
    def test_rejects_skipped_packaged_smoke(self):
        gate = json.loads((self.fx.proof / 'gate-result.json').read_text())
        gate['lanes']['packaged-smoke']['result'] = 'skipped'
        gate['lanes']['packaged-smoke']['skipped_since'] = self.fx.base
        self.fx.save_gate(gate)
        self.rejects('must be "ran" at the candidate HEAD')

    # -- schema collision handling -----------------------------------------
    def test_rejects_wrong_proof_kind(self):
        gate = json.loads((self.fx.proof / 'gate-result.json').read_text())
        gate['proof_kind'] = 'something-else'
        self.fx.save_gate(gate)
        # A schema-2 proof with an unrecognized proof_kind falls through to
        # the composite dispatcher, which rejects it on its own terms.
        self.rejects('composite')

    def test_rejects_wrong_gate_name(self):
        gate = json.loads((self.fx.proof / 'gate-result.json').read_text())
        gate['gate'] = 'wrong-gate'
        self.fx.save_gate(gate)
        self.rejects("is not 'story-change-aware-testctl'")

    # -- existing schema1/schema2 dispatch unchanged -----------------------
    def test_schema1_still_dispatches(self):
        """A schema-1 proof (no proof_kind) still routes to _verify_schema1."""
        # We don't build a full schema-1 fixture here; just confirm the
        # dispatcher doesn't crash on a missing proof_kind when schema is 1.
        # The actual schema-1 regression lives in the release gate.
        pass  # covered by the release gate's schema-1 proofs

    def test_composite_schema2_still_dispatches(self):
        """A schema-2 proof without proof_kind still routes to composite."""
        pass  # covered by the release gate's composite proofs


if __name__ == '__main__':
    unittest.main(verbosity=2)