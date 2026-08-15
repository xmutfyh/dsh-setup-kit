#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any


def load(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"Expected JSON object: {path}")
    return value


def main() -> int:
    parser = argparse.ArgumentParser(description="Check scientific structural/editability acceptance.")
    parser.add_argument("--spec", required=True)
    parser.add_argument("--scene", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    spec = load(Path(args.spec).resolve())
    scene = load(Path(args.scene).resolve())
    failures: list[str] = []
    passes: list[str] = []

    spec_modules = {m.get("id"): m for m in spec.get("modules", []) if isinstance(m, dict) and m.get("id")}
    scene_nodes = {n.get("id"): n for n in scene.get("nodes", []) if isinstance(n, dict) and n.get("id")}
    scene_edges = {e.get("id"): e for e in scene.get("edges", []) if isinstance(e, dict) and e.get("id")}
    acceptance = spec.get("acceptance", {}) if isinstance(spec.get("acceptance"), dict) else {}

    for module_id, module in spec_modules.items():
        node = scene_nodes.get(module_id)
        if not node:
            failures.append(f"Module `{module_id}` is missing from scene.")
            continue
        if node.get("type") != module.get("type"):
            failures.append(f"Module `{module_id}` type mismatch: {node.get('type')} vs {module.get('type')}.")
        else:
            passes.append(f"Module `{module_id}` preserves semantic type `{node.get('type')}`.")

    actual_counts = Counter(n.get("type") for n in scene_nodes.values())
    required_counts = acceptance.get("required_module_counts", {})
    if isinstance(required_counts, dict):
        for node_type, expected in required_counts.items():
            actual = actual_counts.get(node_type, 0)
            if actual != expected:
                failures.append(f"`{node_type}` count expected {expected}, found {actual}.")
            else:
                passes.append(f"`{node_type}` count = {expected}.")

    required_parameters = acceptance.get("required_parameters", {})
    if isinstance(required_parameters, dict):
        for path, expected in required_parameters.items():
            if "." not in str(path):
                continue
            module_id, field = str(path).split(".", 1)
            actual = scene_nodes.get(module_id, {}).get(field)
            if actual != expected:
                failures.append(f"`{path}` expected {expected!r}, found {actual!r}.")
            else:
                passes.append(f"`{path}` = {expected!r}.")

    for edge_id in acceptance.get("required_connectors", []) if isinstance(acceptance.get("required_connectors"), list) else []:
        edge = scene_edges.get(str(edge_id))
        if not edge:
            failures.append(f"Required connector `{edge_id}` is missing.")
        elif acceptance.get("glued_connectors") and edge.get("glue") is not True:
            failures.append(f"Required connector `{edge_id}` is not marked for glue.")
        else:
            passes.append(f"Connector `{edge_id}` exists and is marked for glue.")

    source_assets = [
        asset for asset in scene.get("assets", [])
        if isinstance(asset, dict) and asset.get("kind") == "source_image"
    ]
    image_tiles = [n for n in scene_nodes.values() if n.get("type") == "image_tile"]
    if acceptance.get("no_full_image_background") and image_tiles:
        failures.append("Scene contains `image_tile`; verify it is an explicitly permitted sub-asset, not the full source image.")
    else:
        passes.append("No full-image background node was detected.")

    grouped_types = {
        "scientific_unet",
        "segmented_cube_grid",
        "multi_domain_signal_panel",
        "noise_cloud",
        "diffusion_timeline",
    }
    if acceptance.get("semantic_groups"):
        for node in scene_nodes.values():
            if node.get("type") in grouped_types:
                passes.append(f"`{node.get('id')}` uses a semantic grouped renderer.")

    report = [
        "# Scientific acceptance report",
        "",
        f"- Spec: `{Path(args.spec).resolve()}`",
        f"- Scene: `{Path(args.scene).resolve()}`",
        f"- Result: **{'FAIL' if failures else 'PASS'}**",
        "",
        "## Passes",
    ]
    report.extend([f"- {item}" for item in passes] or ["- None recorded."])
    report.extend(["", "## Failures"])
    report.extend([f"- {item}" for item in failures] or ["- None."])
    report.extend([
        "",
        "## Manual checks still required",
        "- Open the VSDX and move each semantic module to confirm the group moves together.",
        "- Move connected modules to confirm glued connectors remain attached.",
        "- Compare pair/overlay images for geometry and styling.",
        "- Confirm formulas and small labels against manuscript truth.",
    ])
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("\n".join(report) + "\n", encoding="utf-8")
    print(f"Wrote: {output}")
    return 2 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
