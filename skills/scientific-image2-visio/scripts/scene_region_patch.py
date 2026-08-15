#!/usr/bin/env python3
from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path
from typing import Any


def load(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"Expected JSON object: {path}")
    return value


def region_of(item: dict[str, Any]) -> str | None:
    value = item.get("semantic_region", item.get("container_id", item.get("region_id")))
    return str(value) if value else None


def deep_merge(base: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(base)
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = deep_merge(result[key], value)
        elif isinstance(value, list) and isinstance(result.get(key), list):
            result[key] = result[key] + copy.deepcopy(value)
        else:
            result[key] = copy.deepcopy(value)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Apply a locked-region-aware patch to scene.json.")
    parser.add_argument("--scene", required=True)
    parser.add_argument("--patch", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    scene = load(Path(args.scene).resolve())
    patch = load(Path(args.patch).resolve())
    target_regions = {str(v) for v in patch.get("target_regions", [])}
    locked_regions = set(str(v) for v in scene.get("metadata", {}).get("locked_regions", []))
    locked_regions.update(str(v) for v in patch.get("locked_regions", []))

    nodes = {n["id"]: n for n in scene.get("nodes", []) if isinstance(n, dict) and n.get("id")}
    edges = {e["id"]: e for e in scene.get("edges", []) if isinstance(e, dict) and e.get("id")}

    def ensure_editable(item: dict[str, Any], item_id: str) -> None:
        region = region_of(item)
        if region in locked_regions:
            raise ValueError(f"`{item_id}` belongs to locked region `{region}`.")
        if target_regions and region not in target_regions:
            raise ValueError(f"`{item_id}` belongs to `{region}`, outside target regions {sorted(target_regions)}.")

    for node_id in patch.get("delete_node_ids", []):
        node_id = str(node_id)
        if node_id in nodes:
            ensure_editable(nodes[node_id], node_id)
            del nodes[node_id]
    for edge_id in patch.get("delete_edge_ids", []):
        edge_id = str(edge_id)
        if edge_id in edges:
            ensure_editable(edges[edge_id], edge_id)
            del edges[edge_id]

    for replacement in patch.get("replace_nodes", []):
        if not isinstance(replacement, dict) or not replacement.get("id"):
            raise ValueError("Every replacement node requires an id.")
        node_id = str(replacement["id"])
        old = nodes.get(node_id)
        if old:
            ensure_editable(old, node_id)
        ensure_editable(replacement, node_id)
        nodes[node_id] = replacement

    for replacement in patch.get("replace_edges", []):
        if not isinstance(replacement, dict) or not replacement.get("id"):
            raise ValueError("Every replacement edge requires an id.")
        edge_id = str(replacement["id"])
        old = edges.get(edge_id)
        if old:
            ensure_editable(old, edge_id)
        ensure_editable(replacement, edge_id)
        edges[edge_id] = replacement

    node_ids = set(nodes)
    for edge_id, edge in edges.items():
        for endpoint in ("from", "to"):
            value = edge.get(endpoint)
            if isinstance(value, str):
                node_id = value.split(":", 1)[0]
                if node_id not in node_ids:
                    raise ValueError(f"Edge `{edge_id}` references missing node `{node_id}` after patch.")

    metadata = scene.setdefault("metadata", {})
    metadata["locked_regions"] = sorted(locked_regions)
    if isinstance(patch.get("metadata_patch"), dict):
        scene["metadata"] = deep_merge(metadata, patch["metadata_patch"])

    scene["nodes"] = list(nodes.values())
    scene["edges"] = list(edges.values())
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(scene, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote patched scene: {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
