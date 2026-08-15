#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from figure_spec_validate import validate

PARAMETER_ALIASES = {
    "depth_x": "depth_x_in",
    "depth_y": "depth_y_in",
    "row_gap": "row_gap_in",
    "column_gap": "column_gap_in",
    "point_radius": "point_radius_in",
}


def load(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("Figure spec must be an object.")
    return value


def normalized_parameters(parameters: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in parameters.items():
        result[PARAMETER_ALIASES.get(key, key)] = value
    return result


def module_to_node(module: dict[str, Any]) -> dict[str, Any]:
    x, y, w, h = [float(v) for v in module["bbox"]]
    node: dict[str, Any] = {
        "id": module["id"],
        "type": module["type"],
        "x": x,
        "y": y,
        "w": w,
        "h": h,
        "z": module.get("z", 10),
    }
    if module.get("label"):
        node["text"] = module["label"]
        node["title"] = module["label"]
    if module.get("region_id"):
        node["container_id"] = module["region_id"]
        node["semantic_region"] = module["region_id"]
    node.update(normalized_parameters(module.get("parameters", {}) if isinstance(module.get("parameters"), dict) else {}))
    if module.get("type") == "soft_architecture_background":
        node["allow_overlap"] = True
        node["semantic_role"] = "background"
    if isinstance(module.get("style"), dict):
        node["style"] = module["style"]
    for field in ("source_bbox_px", "semantic_facts", "uncertainty"):
        if field in module:
            node[field] = module[field]
    return node


def connector_to_edge(connector: dict[str, Any]) -> dict[str, Any]:
    route_value = str(connector.get("route", "auto"))
    scene_route_map = {
        "straight_horizontal": "horizontal",
        "straight_vertical": "vertical",
        "right_angle": "orthogonal",
    }
    scene_route = scene_route_map.get(route_value, route_value)
    edge: dict[str, Any] = {
        "id": connector["id"],
        "type": connector.get("type", "dynamic_connector"),
        "from": connector["from"],
        "to": connector["to"],
        "route": scene_route,
        "glue": connector.get("glue", True),
        "z": connector.get("z", 100),
        "semantic_intent": connector.get("semantic_intent", "data_flow"),
        "certainty": connector.get("certainty", "certain"),
        "arrow_plan_id": connector["id"],
    }
    if scene_route == "rounded_orthogonal":
        edge["corner_radius_in"] = connector.get("corner_radius_in", 0.08)
    if connector.get("allow_cross_container") is not None:
        edge["allow_cross_container"] = bool(connector.get("allow_cross_container"))
    elif connector.get("region_id"):
        edge["allow_cross_container"] = True
    if connector.get("label"):
        edge["label"] = connector["label"]
    if connector.get("region_id"):
        edge["semantic_region"] = connector["region_id"]
    if isinstance(connector.get("style"), dict):
        edge["style"] = connector["style"]
    for field in ("source_bbox_px", "points", "start_tangent_point", "end_tangent_point"):
        if field in connector:
            edge[field] = connector[field]
    return edge


def resolve_source_path(value: object, base_dir: Path) -> object:
    if not isinstance(value, str) or not value:
        return value
    path = Path(value)
    if not path.is_absolute():
        path = (base_dir / path).resolve()
    return str(path)


def build_scene(spec: dict[str, Any], base_dir: Path) -> dict[str, Any]:
    source = dict(spec.get("source", {}) if isinstance(spec.get("source"), dict) else {})
    style = spec.get("style", {})
    regions = [dict(region) for region in spec.get("regions", []) if isinstance(region, dict)]
    source["generated_image"] = resolve_source_path(source.get("generated_image"), base_dir)
    source["source_manifest"] = resolve_source_path(source.get("source_manifest"), base_dir)
    source["image2_prompt_file"] = resolve_source_path(source.get("image2_prompt_file"), base_dir)
    source["paper_files"] = [resolve_source_path(v, base_dir) for v in source.get("paper_files", [])]
    source["reference_files"] = [resolve_source_path(v, base_dir) for v in source.get("reference_files", [])]

    modules = [module for module in spec.get("modules", []) if isinstance(module, dict)]
    connectors = [connector for connector in spec.get("connectors", []) if isinstance(connector, dict)]
    modules_by_region: dict[str, list[dict[str, Any]]] = {}
    connectors_by_region: dict[str, list[dict[str, Any]]] = {}
    for module in modules:
        if module.get("region_id"):
            modules_by_region.setdefault(str(module["region_id"]), []).append(module)
    for connector in connectors:
        if connector.get("region_id"):
            connectors_by_region.setdefault(str(connector["region_id"]), []).append(connector)

    enriched_regions: list[dict[str, Any]] = []
    for region in regions:
        region_id = str(region.get("id", ""))
        item = dict(region)
        source_bbox = item.get("source_bbox_px")
        if source_bbox and not item.get("target_bbox"):
            item["target_bbox"] = list(source_bbox)
        categories = item.get("categories", [])
        if isinstance(categories, list) and categories:
            item.setdefault("crop_type", str(categories[0]))
            item.setdefault("required_crop_types", list(categories))
        region_modules = modules_by_region.get(region_id, [])
        region_connectors = connectors_by_region.get(region_id, [])
        item.setdefault("required_labels", [str(m.get("label")) for m in region_modules if m.get("label")])
        item.setdefault("required_component_motifs", sorted({str(m.get("type")) for m in region_modules if m.get("type")}))
        item.setdefault("required_edge_motifs", [str(c.get("semantic_intent", "data_flow")) for c in region_connectors])
        item.setdefault("required_ports_or_boundaries", [
            f"{c.get('from')} -> {c.get('to')}" for c in region_connectors if c.get("from") and c.get("to")
        ])
        item.setdefault("text_layout_facts", ["preserve source language, line breaks, and math notation"])
        item.setdefault("box_style_facts", ["use source-observed padding, rounding, fill, and proportions"])
        item.setdefault("line_style_facts", ["use source-observed route, line weight, dash, and arrowhead"])
        item.setdefault("shadow_facts", ["preserve source shadow presence or absence"])
        item.setdefault("density_facts", ["preserve source element count and local spacing"])
        enriched_regions.append(item)
    regions = enriched_regions

    arrow_plan = []
    for connector in spec.get("connectors", []):
        if not isinstance(connector, dict):
            continue
        source_endpoint = str(connector.get("from", ""))
        target_endpoint = str(connector.get("to", ""))
        source_bbox = connector.get("source_bbox_px")
        if source_bbox is None:
            source_bbox = [0, 0, 1, 1]
        intent = str(connector.get("semantic_intent", "data_flow"))
        if intent == "conditioning":
            intent = "data_flow"
        arrow_plan.append({
            "id": connector.get("id"),
            "from": source_endpoint,
            "to": target_endpoint,
            "from_visual_object": source_endpoint.split(":", 1)[0],
            "from_anchor_description": source_endpoint.split(":", 1)[1] if ":" in source_endpoint else "source boundary",
            "to_visual_object": target_endpoint.split(":", 1)[0],
            "to_anchor_description": target_endpoint.split(":", 1)[1] if ":" in target_endpoint else "target boundary",
            "route_shape": connector.get("route", "auto"),
            "line_style": (connector.get("style") or {}).get("line_dash", "solid") if isinstance(connector.get("style"), dict) else "solid",
            "arrowhead": (connector.get("style") or {}).get("end_arrow", "triangle") if isinstance(connector.get("style"), dict) else "triangle",
            "semantic_intent": intent,
            "source_bbox_px": source_bbox,
            "must_not_cross": connector.get("must_not_cross", []),
            "relative_position_facts": connector.get("relative_position_facts", [
                f"{source_endpoint} connects to {target_endpoint}"
            ]),
            "direction": connector.get("direction", "unknown"),
            "certainty": connector.get("certainty", "certain"),
        })

    metadata = {
        "title": spec.get("title", spec.get("figure_id")),
        "created_by": "scientific-image2-visio.figure_spec_to_scene",
        "style_profile": style.get("profile", "scientific_pastel") if isinstance(style, dict) else "scientific_pastel",
        "fidelity": "exact",
        "replica_review_mode": "strict_replica",
        "replica_stage": "layout_topology",
        "source_image": source.get("generated_image") if isinstance(source, dict) else None,
        "source_manifest": source.get("source_manifest") if isinstance(source, dict) else None,
        "paper_files": source.get("paper_files", []) if isinstance(source, dict) else [],
        "reference_files": source.get("reference_files", []) if isinstance(source, dict) else [],
        "image2_prompt_file": source.get("image2_prompt_file") if isinstance(source, dict) else None,
        "truth_priority": spec.get("truth_priority", []),
        "method_facts": source.get("method_facts", []) if isinstance(source, dict) else [],
        "reference_facts": source.get("reference_facts", []) if isinstance(source, dict) else [],
        "unresolved_items": source.get("unresolved_items", []) if isinstance(source, dict) else [],
        "region_plan": regions,
        "locked_regions": spec.get("locked_regions", []),
        "arrow_plan": arrow_plan,
        "source_visual_inventory": {
            "analysis_basis": "visual_llm_source_image_with_paper_and_reference_truth",
            "scene_authoring_mode": "fresh_source_inventory_authoring",
            "prior_scene_policy": "do_not_patch_prior_scene_for_capability_evaluation",
            "language_profile": spec.get("language", "source"),
            "do_not_translate": True,
            "unknown_text_policy": "mark_unreadable_do_not_invent",
            "regions": regions,
        },
        "acceptance": spec.get("acceptance", {}),
    }

    page = dict(spec["page"])
    page.setdefault("origin", "top-left")
    page.setdefault("background", "#FFFFFF")

    nodes = [module_to_node(module) for module in modules]
    for region in regions:
        bbox = region.get("target_bbox", region.get("source_bbox_px"))
        if not isinstance(bbox, list) or len(bbox) != 4:
            continue
        left, top, right, bottom = [float(value) for value in bbox]
        nodes.append({
            "id": str(region.get("id")),
            "type": "audit_region",
            "x": left,
            "y": top,
            "w": max(0.001, right - left),
            "h": max(0.001, bottom - top),
            "z": -900,
            "style": {"fill": "none", "line": "none"},
            "allow_overlap": True,
        })
    if page.get("background") and not any(node.get("type") == "page_background" for node in nodes):
        nodes.insert(0, {
            "id": "__page_background__",
            "type": "page_background",
            "x": 0,
            "y": 0,
            "w": page["width"],
            "h": page["height"],
            "z": -1000,
            "style": {"fill": page["background"], "line": "none"},
        })

    assets = []
    if isinstance(source, dict) and source.get("generated_image"):
        assets.append({"id": "source-image", "kind": "source_image", "path": source["generated_image"]})

    return {
        "version": "0.2",
        "metadata": metadata,
        "page": page,
        "nodes": nodes,
        "edges": [connector_to_edge(c) for c in connectors],
        "assets": assets,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Compile figure_spec.json into visiomaster scene.json.")
    parser.add_argument("spec")
    parser.add_argument("--output", required=True)
    parser.add_argument("--allow-warnings", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    spec_path = Path(args.spec).resolve()
    output_path = Path(args.output).resolve()
    spec = load(spec_path)
    errors, warnings = validate(spec, strict=True)
    for warning in warnings:
        print(f"WARNING: {warning}")
    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        return 2
    scene = build_scene(spec, spec_path.parent)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(scene, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote scene: {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
