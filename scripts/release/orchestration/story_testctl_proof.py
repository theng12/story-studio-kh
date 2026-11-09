"""Thin Story adapter for the portfolio common-core testctl proof verifier.

The portfolio's proof.mjs is the single authority for change-aware testctl proof
verification.  This module does NOT re-derive receipt keys, re-hash logs, or
reimplement any per-receipt validation — it shells out to the trusted installed
CLI and translates the result into the story_gate_proof contract.

Trusted paths are supplied by the caller (ship-story.py or tests); this module
never derives trust from proof content.  The old WIP schema-3 duplicate-hashing
verifier was moved to _trash/wip-schema3-20261109/ on 2026-11-09 and is refused
at publication: a proof carrying proof_kind 'story-testctl-proof' or schema 3
without the common proof_kind is rejected outright.

The portfolio proof uses proof_kind 'testctl-change-aware', schema 2.  This
adapter preserves that identity so story_gate_proof can distinguish it from the
existing schema-2 composite proof (which has no proof_kind field).

Required lanes: release-cheap and packaged-smoke.  packaged-smoke must be 'ran'
at the candidate HEAD (never skipped) — enforced here before delegating, since
the common core treats all lanes uniformly.
"""
import json
import subprocess
from pathlib import Path

from story_gate_proof import ProofError

PROOF_KIND = 'testctl-change-aware'
GATE_NAME = 'story-change-aware-testctl'
REQUIRED_LANES = ('release-cheap', 'packaged-smoke')
# packaged-smoke proves the candidate actually launches; a skipped result means
# the DMG was never built at this HEAD, which is not a valid release candidate.
FRESH_REQUIRED_LANES = ('packaged-smoke',)
DEFAULT_TESTCTL = Path.home() / 'Developer' / 'portfolio' / 'tools' / 'testctl.mjs'


def _fail(msg):
    raise ProofError(msg)


def verify(root, res, head, tree, diff_sha, version, repo,
           config=None, review=None, testctl=None):
    """Verify a common-core testctl-change-aware proof via the installed CLI.

    `config`, `review` and `testctl` are required trusted paths supplied by the
    publisher.  They default to None so existing callers that pass positional
    args still reach this function; the adapter refuses when they are absent.
    """
    root = Path(root).resolve()
    if not isinstance(res, dict):
        _fail('gate-result.json is not an object')
    if res.get('proof_kind') != PROOF_KIND:
        if res.get('kind') == 'story-testctl-proof' or res.get('schema') == 3:
            _fail('old Story schema-3 proof is refused; use the common-core '
                  'testctl-change-aware proof exported by the portfolio CLI')
        _fail(f'proof_kind {res.get("proof_kind")!r} is not {PROOF_KIND!r}')
    if res.get('schema') != 2:
        _fail(f'unsupported schema {res.get("schema")!r} for {PROOF_KIND}')
    if res.get('gate') != GATE_NAME:
        _fail(f'proof gate {res.get("gate")!r} is not {GATE_NAME!r}')

    # Verify supplied identity matches the proof BEFORE delegating.
    # The CLI re-derives identity from the repo; this catches a publisher
    # passing stale head/tree/diff_sha that the CLI would reject anyway,
    # but surfaces the error from the adapter rather than a subprocess.
    if res.get('head') != head:
        _fail(f"proof HEAD {res.get('head')} is not the supplied HEAD {head}")
    if res.get('tree') is not None and res.get('tree') != tree:
        _fail(f"proof tree {res.get('tree')} is not the supplied tree {tree}")
    if res.get('diff_sha256') != diff_sha:
        _fail('proof diff_sha256 does not match the supplied diff')

    # Trusted inputs: the publisher must supply these explicitly.
    if not config:
        _fail('trusted config path is required for testctl-change-aware proof')
    if not review:
        _fail('trusted review path is required for testctl-change-aware proof')
    config_path = Path(config).resolve()
    review_path = Path(review).resolve()
    testctl_path = Path(testctl).resolve() if testctl else DEFAULT_TESTCTL
    if not config_path.is_file():
        _fail(f'trusted config missing: {config_path}')
    if not review_path.is_file():
        _fail(f'trusted review missing: {review_path}')
    if not testctl_path.is_file():
        _fail(f'trusted testctl missing: {testctl_path}')

    # Pre-flight: packaged-smoke must be 'ran' at the candidate HEAD.
    lanes = res.get('lanes')
    if not isinstance(lanes, dict):
        _fail('proof cites no lanes')
    for required in REQUIRED_LANES:
        if required not in lanes:
            _fail(f'proof is missing the required lane {required!r}')
    for fresh in FRESH_REQUIRED_LANES:
        entry = lanes.get(fresh)
        if not isinstance(entry, dict):
            _fail(f'lane {fresh!r} entry is not an object')
        if entry.get('result') != 'ran':
            _fail(f'lane {fresh!r} must be "ran" at the candidate HEAD; '
                  f'got {entry.get("result")!r} (a skipped smoke does not prove '
                  'the candidate builds and launches)')

    # Delegate to the trusted installed CLI — never re-implement its checks.
    cmd = ['node', str(testctl_path), 'proof', 'verify', str(root),
           '--config', str(config_path), '--project', 'story',
           '--repo', str(Path(repo).resolve()),
           '--review', str(review_path)]
    if version is not None:
        cmd.extend(['--version', str(version)])
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        detail = (r.stderr or r.stdout or '').strip()
        _fail(f'common-core proof verify failed: {detail}')

    return {'schema': 2, 'proof_kind': PROOF_KIND, 'proof': str(root),
            'head': head, 'tree': tree, 'gate': GATE_NAME}