#!/usr/bin/env python3
"""
Reconcile duplicate episode folders in a Story Studio KH output root.

Symptom this fixes: after a buggy Pipeline batch run (before the
title-handling fix), every batched episode got a second folder named
`{code} - Gentle Whispers on the Ferris Wheel` — inheriting the stale
title from a saved script preset. The real titled folders still exist
alongside the ghosts.

What this script does:
  1. Reads the project's accepted ideas to learn each episode's canonical
     title.
  2. Groups episode folders under Season 001/ by their `{code}` prefix.
  3. For each code that has >1 matching folder:
       - identifies the canonical folder by matching the idea's title
       - for every stale sibling: walks its file tree, moves any file
         whose relative path is MISSING from the canonical folder, and
         archives duplicates under canonical/.archive/ rather than
         silently discarding them
       - deletes the stale folder if it becomes empty; otherwise leaves
         it for manual review
  4. If a code has only one folder AND it's mis-named (canonical title
     differs from the folder's suffix), renames it to the canonical name.

Safety: run with --dry-run first. `.DS_Store` is ignored. All overwrites
go through a same-size-or-larger check; the losing copy is archived
(never deleted) so nothing is lost without a trail.
"""

import argparse
import json
import os
import re
import shutil
import sys
from pathlib import Path

FOLDER_RE = re.compile(r"^(TN\d+)\s*-\s*(.+?)\s*$")


def load_canonical_titles(userdata_projects_dir: Path, slug: str) -> dict[str, str]:
    """Read {episode_code: title} from the project's ideas.json (accepted only)."""
    ideas_path = userdata_projects_dir / slug / "ideas.json"
    if not ideas_path.exists():
        raise SystemExit(f"ideas.json not found at {ideas_path}")
    raw = json.loads(ideas_path.read_text())
    ideas = raw.get("ideas") if isinstance(raw, dict) else raw
    titles: dict[str, str] = {}
    for i in ideas:
        code = i.get("episode_code")
        title = i.get("title")
        status = i.get("status", "")
        if code and title and status == "accepted":
            titles[code] = title
    return titles


def scan_season_folders(season_root: Path):
    """Yield (code, title_suffix, folder_path) for every TN#### - ... subfolder."""
    for entry in sorted(season_root.iterdir()):
        if not entry.is_dir():
            continue
        # Strip a possible ✅ prefix — episodes marked done carry it.
        stripped = entry.name.replace("\u2705", "").strip()
        m = FOLDER_RE.match(stripped)
        if m:
            yield m.group(1), m.group(2).strip(), entry


def merge_folder_into(src: Path, dst: Path, dry_run: bool) -> dict:
    """
    Move every file in `src` into `dst` at the same relative path.

    Conflict rule: the canonical side (`dst`) is always authoritative.
    When both sides have the same relative path, the canonical file is
    kept as-is and the stale file is moved to `dst/.archive/<rel>/dup_<name>`
    — never deleted outright. This matters because a stale batch may have
    produced same-named but DIFFERENT-CONTENT files (e.g. an audio chunk
    voicing the wrong story); picking the "larger" file could silently
    overwrite the correct canonical asset with the wrong one.
    """
    moved = 0
    archived_from_src = 0
    for root, _dirs, files in os.walk(src):
        root_path = Path(root)
        rel = root_path.relative_to(src)
        for fname in files:
            if fname == ".DS_Store":
                # macOS clutter; remove so the source dir can become empty.
                if not dry_run:
                    try:
                        (root_path / fname).unlink()
                    except OSError:
                        pass
                continue
            s = root_path / fname
            d = dst / rel / fname
            if not d.exists():
                # Safe to adopt — canonical didn't have this file.
                if not dry_run:
                    d.parent.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(s), str(d))
                moved += 1
            else:
                # Both sides have this file. Canonical wins; archive stale
                # so no data is lost without a trail.
                arch = dst / ".archive" / rel / f"dup_{fname}"
                if not dry_run:
                    arch.parent.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(s), str(arch))
                archived_from_src += 1
    return {"moved": moved, "archived_from_src": archived_from_src}


def prune_empty(folder: Path, dry_run: bool) -> bool:
    """Remove empty subdirs inside `folder`, then folder itself if it ends up empty. Returns whether folder was deleted."""
    # Bottom-up walk.
    for root, _dirs, files in os.walk(folder, topdown=False):
        root_path = Path(root)
        if root_path == folder:
            continue
        remaining = [p for p in root_path.iterdir() if p.name != ".DS_Store"]
        if not remaining:
            # Clear .DS_Store if any, then rmdir.
            if not dry_run:
                for p in root_path.iterdir():
                    try: p.unlink()
                    except OSError: pass
                try: root_path.rmdir()
                except OSError: pass
    if not folder.exists():
        return True
    remaining = [p for p in folder.iterdir() if p.name != ".DS_Store"]
    if not remaining:
        if not dry_run:
            for p in folder.iterdir():
                try: p.unlink()
                except OSError: pass
            try:
                folder.rmdir()
                return True
            except OSError:
                return False
        return True
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--slug", default="terranash-sleep-stories")
    ap.add_argument("--output-root", required=True, help="Path to the Season folder, e.g. '/Users/you/Downloads/Story Studio/TerraNash Sleep Stories/Season 001'")
    ap.add_argument("--userdata",
                    default=str(Path.home() / "Library/Application Support/Story Studio KH/projects"),
                    help="Path to the userData projects folder (default: ~/Library/Application Support/Story Studio KH/projects)")
    ap.add_argument("--dry-run", action="store_true", help="Preview actions without making changes")
    args = ap.parse_args()

    season_root = Path(args.output_root)
    if not season_root.is_dir():
        raise SystemExit(f"Output root is not a directory: {season_root}")

    titles = load_canonical_titles(Path(args.userdata), args.slug)
    print(f"[info] loaded {len(titles)} accepted episode titles from {args.userdata}/{args.slug}/ideas.json")

    folders_by_code: dict[str, list[tuple[str, Path]]] = {}
    for code, suffix, folder in scan_season_folders(season_root):
        folders_by_code.setdefault(code, []).append((suffix, folder))

    print(f"[info] scanning {len(folders_by_code)} episode codes under {season_root}")

    total_renamed = 0
    total_merged = 0
    total_stale_removed = 0
    total_left_for_review = 0

    for code in sorted(folders_by_code):
        folders = folders_by_code[code]
        canonical_title = titles.get(code)

        # No title known → leave alone (user's ideas.json may be missing this).
        if not canonical_title:
            print(f"[skip] {code}: no accepted title in ideas.json; leaving {len(folders)} folder(s) alone")
            continue

        canonical_name = f"{code} - {canonical_title}"

        # Case A: exactly one folder — rename if mislabeled, else do nothing.
        if len(folders) == 1:
            suffix, folder = folders[0]
            if folder.name == canonical_name or folder.name == f"\u2705 {canonical_name}":
                continue
            # Mislabeled solo folder → rename in place.
            target = season_root / canonical_name
            if target.exists():
                print(f"[skip] {code}: target {target.name!r} already exists; manual review needed")
                continue
            print(f"[rename] {code}: {folder.name!r} → {canonical_name!r}")
            if not args.dry_run:
                folder.rename(target)
            total_renamed += 1
            continue

        # Case B: multiple folders — keep the canonical one, merge the rest in.
        canonical_folder = None
        stale = []
        for suffix, folder in folders:
            if suffix.strip() == canonical_title.strip():
                canonical_folder = folder
            else:
                stale.append(folder)

        if canonical_folder is None:
            # Canonical title doesn't match any folder. Pick the folder that
            # best overlaps by content size (biggest = most stuff generated),
            # rename it to canonical, and merge the others into it.
            biggest = max(folders, key=lambda x: sum(
                p.stat().st_size for p in x[1].rglob("*") if p.is_file()
            ))
            canonical_folder = biggest[1]
            target = season_root / canonical_name
            if not target.exists() and canonical_folder != target:
                print(f"[rename] {code}: {canonical_folder.name!r} → {canonical_name!r} (best-content match)")
                if not args.dry_run:
                    canonical_folder.rename(target)
                canonical_folder = target
                total_renamed += 1
            stale = [f for _, f in folders if f != biggest[1]]

        print(f"[merge] {code}: keeping {canonical_folder.name!r}; merging {len(stale)} stale folder(s)")
        for stale_folder in stale:
            summary = merge_folder_into(stale_folder, canonical_folder, args.dry_run)
            print(f"        from {stale_folder.name!r}: moved={summary['moved']} "
                  f"archived_from_src={summary['archived_from_src']}")
            total_merged += summary["moved"]
            deleted = prune_empty(stale_folder, args.dry_run)
            if deleted:
                print(f"        removed empty {stale_folder.name!r}")
                total_stale_removed += 1
            else:
                print(f"        ⚠ {stale_folder.name!r} still contains files — left for manual review")
                total_left_for_review += 1

    print()
    print(f"[summary] renamed={total_renamed} moved_files={total_merged} "
          f"stale_folders_removed={total_stale_removed} left_for_review={total_left_for_review}")
    if args.dry_run:
        print("[summary] DRY-RUN — no changes were made. Re-run without --dry-run to apply.")


if __name__ == "__main__":
    main()
