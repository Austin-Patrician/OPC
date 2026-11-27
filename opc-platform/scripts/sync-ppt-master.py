#!/usr/bin/env python3
"""Downloads pinned hugohe3/ppt-master release zip, prunes non-runtime bloat,
and packages resources/skill-packs/office-ppt/{payload.zip,SKILL.md}.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

PPT_MASTER_VERSION = "v6.10.0"
RELEASE_ZIP_URL = (
    f"https://github.com/hugohe3/ppt-master/releases/download/"
    f"{PPT_MASTER_VERSION}/ppt-master-skill-{PPT_MASTER_VERSION}.zip"
)

EXCLUDED_PREFIXES = (
    "templates/sounds/",
    "references/ai-image-comparison/",
    "scripts/tests/",
    "scripts/docs/",
)


def is_excluded(rel_posix: str) -> bool:
    if any(rel_posix.startswith(prefix) for prefix in EXCLUDED_PREFIXES):
        return True
    parts = rel_posix.split("/")
    if "__pycache__" in parts or ".git" in parts:
        return True
    if parts[-1] == ".DS_Store":
        return True
    return False


def find_skill_root(extracted_dir: Path) -> Path:
    if (extracted_dir / "SKILL.md").is_file() and (extracted_dir / "LICENSE").is_file():
        return extracted_dir
    for candidate in extracted_dir.rglob("SKILL.md"):
        parent = candidate.parent
        if (parent / "LICENSE").is_file() and (parent / "scripts" / "attribution_guard.py").is_file():
            return parent
    raise FileNotFoundError(f"Could not locate ppt-master skill root in {extracted_dir}")


def main() -> int:
    repo_root = Path(__file__).resolve().parent.parent
    out_dir = repo_root / "resources" / "skill-packs" / "office-ppt"
    out_dir.mkdir(parents=True, exist_ok=True)
    payload_zip = out_dir / "payload.zip"
    skill_md_dest = out_dir / "SKILL.md"

    with tempfile.TemporaryDirectory(prefix="opc-ppt-master-sync-") as tmp:
        tmp_path = Path(tmp)
        download_path = tmp_path / f"ppt-master-skill-{PPT_MASTER_VERSION}.zip"
        extract_dir = tmp_path / "extracted"
        verify_dir = tmp_path / "verify"

        print(f"Downloading {RELEASE_ZIP_URL} ...")
        req = urllib.request.Request(
            RELEASE_ZIP_URL,
            headers={"User-Agent": "opc-platform-sync-script/1.0"},
        )
        with urllib.request.urlopen(req, timeout=120) as resp, download_path.open("wb") as fh:
            shutil.copyfileobj(resp, fh)
        print(f"Downloaded {download_path.stat().st_size / (1024 * 1024):.2f} MB")

        with zipfile.ZipFile(download_path, "r") as zf:
            zf.extractall(extract_dir)

        skill_root = find_skill_root(extract_dir)
        print(f"Located skill root: {skill_root}")

        file_count = 0
        tmp_payload = tmp_path / "payload.zip"
        with zipfile.ZipFile(tmp_payload, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as out_zf:
            for item in sorted(skill_root.rglob("*")):
                if not item.is_file():
                    continue
                rel_posix = item.relative_to(skill_root).as_posix()
                if is_excluded(rel_posix):
                    continue
                out_zf.write(item, arcname=rel_posix)
                file_count += 1

        # Verify integrity in a fresh temp directory before overwriting repo files.
        with zipfile.ZipFile(tmp_payload, "r") as verify_zf:
            verify_zf.extractall(verify_dir)

        guard_script = verify_dir / "scripts" / "attribution_guard.py"
        if not guard_script.is_file():
            raise FileNotFoundError("attribution_guard.py missing from packaged payload")

        env = os.environ.copy()
        env["PYTHONUTF8"] = "1"
        result = subprocess.run(
            [sys.executable, str(guard_script)],
            cwd=str(verify_dir),
            capture_output=True,
            text=True,
            env=env,
        )
        if result.returncode != 0:
            sys.stderr.write(result.stdout)
            sys.stderr.write(result.stderr)
            raise RuntimeError(f"attribution_guard.py failed with exit code {result.returncode}")

        shutil.copy2(skill_root / "SKILL.md", skill_md_dest)
        shutil.copy2(tmp_payload, payload_zip)

        size_mb = payload_zip.stat().st_size / (1024 * 1024)
        print(f"Packaged {payload_zip} ({size_mb:.2f} MB, {file_count} files)")
        print("attribution_guard.py exited cleanly with code 0.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
