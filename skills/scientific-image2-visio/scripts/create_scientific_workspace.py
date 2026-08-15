#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path
from typing import Iterable

from PIL import Image


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_copy(path: Path, target_dir: Path, preferred_name: str | None = None) -> Path:
    target_dir.mkdir(parents=True, exist_ok=True)
    name = preferred_name or path.name
    target = target_dir / name
    if target.exists() and target.resolve() != path.resolve():
        stem, suffix = target.stem, target.suffix
        index = 2
        while (target_dir / f"{stem}-{index}{suffix}").exists():
            index += 1
        target = target_dir / f"{stem}-{index}{suffix}"
    if target.resolve() != path.resolve():
        shutil.copy2(path, target)
    return target


def records(paths: Iterable[str], source_dir: Path, prefix: str) -> tuple[list[str], list[dict]]:
    relative_paths: list[str] = []
    items: list[dict] = []
    for index, raw in enumerate(paths, 1):
        source = Path(raw).expanduser().resolve()
        if not source.exists():
            raise FileNotFoundError(source)
        copied = safe_copy(source, source_dir, f"{prefix}-{index:02d}{source.suffix.lower()}")
        relative = copied.relative_to(source_dir.parent).as_posix()
        relative_paths.append(relative)
        items.append({"kind": prefix, "path": relative, "sha256": sha256(copied), "bytes": copied.stat().st_size})
    return relative_paths, items


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create a paper/reference/Image-2 scientific reconstruction workspace.")
    parser.add_argument("--image", required=True, help="Selected GPT Image 2 output.")
    parser.add_argument("--paper", action="append", default=[], help="Manuscript file. Repeatable.")
    parser.add_argument("--reference", action="append", default=[], help="Reference file. Repeatable.")
    parser.add_argument("--image2-prompt-file", help="Exact Image 2 prompt text file.")
    parser.add_argument("--figure-id", default="scientific_figure")
    parser.add_argument("--title", default="")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--overwrite", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    workspace = Path(args.output_dir).expanduser().resolve()
    if workspace.exists() and any(workspace.iterdir()) and not args.overwrite:
        raise FileExistsError(f"Workspace is not empty: {workspace}")
    workspace.mkdir(parents=True, exist_ok=True)
    source_dir = workspace / "source"
    output_dir = workspace / "output"
    review_dir = workspace / "review"
    source_dir.mkdir(exist_ok=True)
    output_dir.mkdir(exist_ok=True)
    review_dir.mkdir(exist_ok=True)

    image_source = Path(args.image).expanduser().resolve()
    if not image_source.exists():
        raise FileNotFoundError(image_source)
    image_target = safe_copy(image_source, source_dir, f"original{image_source.suffix.lower()}")
    with Image.open(image_target) as image:
        width, height = image.size

    papers, paper_records = records(args.paper, source_dir, "paper")
    references, reference_records = records(args.reference, source_dir, "reference")
    prompt_relative = None
    prompt_record = None
    if args.image2_prompt_file:
        prompt_source = Path(args.image2_prompt_file).expanduser().resolve()
        if not prompt_source.exists():
            raise FileNotFoundError(prompt_source)
        prompt_target = safe_copy(prompt_source, source_dir, "image2_prompt.txt")
        prompt_relative = prompt_target.relative_to(workspace).as_posix()
        prompt_record = {
            "kind": "image2_prompt",
            "path": prompt_relative,
            "sha256": sha256(prompt_target),
            "bytes": prompt_target.stat().st_size,
        }

    image_relative = image_target.relative_to(workspace).as_posix()
    manifest_items = [
        {"kind": "generated_image", "path": image_relative, "sha256": sha256(image_target), "bytes": image_target.stat().st_size}
    ] + paper_records + reference_records
    if prompt_record:
        manifest_items.append(prompt_record)

    manifest = {
        "version": "1.0",
        "figure_id": args.figure_id,
        "items": manifest_items,
    }
    manifest_path = source_dir / "source_manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")

    starter = {
        "version": "1.0",
        "figure_id": args.figure_id,
        "title": args.title,
        "language": "source",
        "truth_priority": ["user_corrections", "manuscript", "references", "image2_prompt", "generated_image"],
        "source": {
            "generated_image": image_relative,
            "paper_files": papers,
            "reference_files": references,
            "image2_prompt_file": prompt_relative,
            "source_manifest": manifest_path.relative_to(workspace).as_posix(),
            "caption": "",
            "method_facts": [],
            "reference_facts": [],
            "unresolved_items": []
        },
        "page": {
            "width": width,
            "height": height,
            "units": "px",
            "origin": "top-left",
            "target_width_in": 13.333,
            "background": "#FFFFFF"
        },
        "style": {"profile": "scientific_pastel", "font_roles": {}, "palette": {}, "global_notes": []},
        "regions": [],
        "modules": [],
        "connectors": [],
        "locked_regions": [],
        "acceptance": {
            "no_full_image_background": True,
            "native_text": True,
            "semantic_groups": True,
            "glued_connectors": True,
            "required_module_counts": {},
            "required_parameters": {},
            "required_connectors": [],
            "notes": []
        }
    }
    spec_path = workspace / "figure_spec.json"
    spec_path.write_text(json.dumps(starter, indent=2, ensure_ascii=False), encoding="utf-8")

    task = f"""# Codex task: {args.figure_id}

Inspect all files in `source/` directly with multimodal capabilities.

1. Treat the manuscript and explicit user corrections as structural truth.
2. Treat references as supporting evidence.
3. Treat the exact Image 2 prompt as requested-count/style evidence.
4. Treat `{image_relative}` as visual-layout truth.
5. Fill `figure_spec.json`; do not invent unreadable labels.
6. Validate and compile it into `scene.json`.
7. Render on Windows with Visio.
8. Produce pair/overlay review assets and repair only failing regions when possible.

The durable source is `figure_spec.json + scene.json`, not the PNG alone.
"""
    (workspace / "codex_task.md").write_text(task, encoding="utf-8")

    print(f"Created workspace: {workspace}")
    print(f"Figure spec: {spec_path}")
    print(f"Source manifest: {manifest_path}")
    print(f"Codex task: {workspace / 'codex_task.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
