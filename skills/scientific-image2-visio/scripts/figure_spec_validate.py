#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any

SCIENTIFIC_TYPES = {
    "scientific_unet",
    "segmented_cube_grid",
    "multi_domain_signal_panel",
    "noise_cloud",
    "diffusion_timeline",
    "soft_architecture_background",
}


def load(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("Figure spec must be a JSON object.")
    return value


def endpoint_node_id(value: object) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    return value.split(":", 1)[0]


def validate(spec: dict[str, Any], strict: bool = False) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []

    for key in ("version", "figure_id", "source", "page", "modules", "connectors", "acceptance"):
        if key not in spec:
            errors.append(f"Missing required field `{key}`.")

    page = spec.get("page", {})
    if not isinstance(page, dict):
        errors.append("`page` must be an object.")
    else:
        for key in ("width", "height"):
            value = page.get(key)
            if not isinstance(value, (int, float)) or value <= 0:
                errors.append(f"`page.{key}` must be positive.")
        if page.get("units") not in {"px", "in"}:
            errors.append("`page.units` must be `px` or `in`.")

    modules = spec.get("modules", [])
    if not isinstance(modules, list):
        errors.append("`modules` must be a list.")
        modules = []
    module_ids: set[str] = set()
    module_by_id: dict[str, dict[str, Any]] = {}
    regions = spec.get("regions", [])
    if not isinstance(regions, list):
        errors.append("`regions` must be a list.")
        regions = []
    region_ids = {str(r.get("id")) for r in regions if isinstance(r, dict) and r.get("id")}
    if strict:
        required_region_categories = {"global", "input", "core", "output", "arrow_dense", "small_text"}
        covered_categories: set[str] = set()
        for region in regions:
            if not isinstance(region, dict):
                errors.append("Each strict review region must be an object.")
                continue
            region_id = str(region.get("id", "")).strip()
            if not region_id:
                errors.append("A strict review region is missing `id`.")
                continue
            bbox = region.get("source_bbox_px")
            if not isinstance(bbox, list) or len(bbox) != 4 or not all(isinstance(v, (int, float)) for v in bbox):
                errors.append(f"Region `{region_id}` requires numeric source_bbox_px [left,top,right,bottom].")
            if not region.get("target_bbox"):
                errors.append(f"Region `{region_id}` requires target_bbox for review alignment.")
            categories = region.get("categories", [])
            crop_types = region.get("required_crop_types", [])
            if isinstance(categories, list):
                covered_categories.update(str(v) for v in categories)
            if isinstance(crop_types, list):
                covered_categories.update(str(v) for v in crop_types)
            visible_contract = any(
                isinstance(region.get(key), list) and bool(region.get(key))
                for key in ("required_labels", "required_formulas", "required_component_motifs",
                            "required_edge_motifs", "required_ports_or_boundaries")
            )
            if not visible_contract:
                errors.append(f"Region `{region_id}` needs labels/formulas/component/edge/port source facts.")
            style_contract = any(
                isinstance(region.get(key), list) and bool(region.get(key))
                for key in ("box_style_facts", "line_style_facts", "shadow_facts", "density_facts")
            )
            if not style_contract:
                errors.append(f"Region `{region_id}` needs source-visible box/line/shadow/density facts.")
        missing_categories = sorted(required_region_categories - covered_categories)
        if missing_categories:
            errors.append(f"Strict regions miss review categories: {', '.join(missing_categories)}.")
    for module in modules:
        if not isinstance(module, dict):
            errors.append("Each module must be an object.")
            continue
        module_id = str(module.get("id", "")).strip()
        if not module_id:
            errors.append("A module is missing `id`.")
            continue
        if module_id in module_ids:
            errors.append(f"Duplicate module id `{module_id}`.")
        module_ids.add(module_id)
        module_by_id[module_id] = module
        bbox = module.get("bbox")
        if not isinstance(bbox, list) or len(bbox) != 4 or not all(isinstance(v, (int, float)) for v in bbox):
            errors.append(f"Module `{module_id}` requires numeric bbox [x,y,w,h].")
        elif bbox[2] <= 0 or bbox[3] <= 0:
            errors.append(f"Module `{module_id}` bbox width/height must be positive.")
        region_id = module.get("region_id")
        if region_id and region_ids and str(region_id) not in region_ids:
            warnings.append(f"Module `{module_id}` references undeclared region `{region_id}`.")

        node_type = str(module.get("type", "")).strip()
        params = module.get("parameters", {}) if isinstance(module.get("parameters"), dict) else {}
        if node_type == "scientific_unet":
            levels = params.get("levels", 4)
            skips = params.get("skip_connections", levels)
            if not isinstance(levels, int) or levels < 2:
                errors.append(f"`{module_id}.levels` must be an integer >= 2.")
            if not isinstance(skips, int) or skips < 0 or (isinstance(levels, int) and skips > levels):
                errors.append(f"`{module_id}.skip_connections` must be between 0 and levels.")
            guidance = params.get("guidance_inputs", 0)
            if not isinstance(guidance, int) or guidance < 0:
                errors.append(f"`{module_id}.guidance_inputs` must be a non-negative integer.")
        elif node_type == "segmented_cube_grid":
            for field in ("rows", "columns"):
                value = params.get(field)
                if not isinstance(value, int) or value < 1:
                    errors.append(f"`{module_id}.{field}` must be a positive integer.")
        elif node_type == "multi_domain_signal_panel":
            domains = params.get("domains")
            if not isinstance(domains, int) or domains < 1:
                errors.append(f"`{module_id}.domains` must be a positive integer.")
            labels = params.get("domain_labels")
            if isinstance(labels, list) and isinstance(domains, int) and len(labels) != domains:
                errors.append(f"`{module_id}.domain_labels` length must equal domains.")
        elif node_type == "noise_cloud":
            count = params.get("point_count", 80)
            if not isinstance(count, int) or count < 1:
                errors.append(f"`{module_id}.point_count` must be a positive integer.")
            if "seed" not in params:
                warnings.append(f"Noise cloud `{module_id}` should set a deterministic seed.")
        elif node_type == "diffusion_timeline":
            states = params.get("states")
            if not isinstance(states, list) or len(states) < 2:
                errors.append(f"`{module_id}.states` must contain at least two states.")
        elif node_type == "soft_architecture_background":
            pass
        elif strict and not node_type:
            errors.append(f"Module `{module_id}` is missing type.")

    connectors = spec.get("connectors", [])
    if not isinstance(connectors, list):
        errors.append("`connectors` must be a list.")
        connectors = []
    connector_ids: set[str] = set()
    for connector in connectors:
        if not isinstance(connector, dict):
            errors.append("Each connector must be an object.")
            continue
        connector_id = str(connector.get("id", "")).strip()
        if not connector_id:
            errors.append("A connector is missing `id`.")
            continue
        if connector_id in connector_ids:
            errors.append(f"Duplicate connector id `{connector_id}`.")
        connector_ids.add(connector_id)
        for endpoint in ("from", "to"):
            node_id = endpoint_node_id(connector.get(endpoint))
            if not node_id:
                errors.append(f"Connector `{connector_id}` has invalid `{endpoint}` endpoint.")
            elif node_id not in module_ids:
                errors.append(f"Connector `{connector_id}` references missing module `{node_id}`.")

    acceptance = spec.get("acceptance", {})
    if isinstance(acceptance, dict):
        counts = acceptance.get("required_module_counts", {})
        if isinstance(counts, dict):
            actual = Counter(str(m.get("type")) for m in modules if isinstance(m, dict))
            for node_type, expected in counts.items():
                if actual.get(str(node_type), 0) != expected:
                    errors.append(
                        f"Acceptance count mismatch for `{node_type}`: expected {expected}, found {actual.get(str(node_type), 0)}."
                    )
        required_connectors = acceptance.get("required_connectors", [])
        if isinstance(required_connectors, list):
            for item in required_connectors:
                if str(item) not in connector_ids:
                    errors.append(f"Required connector `{item}` is missing.")
        required_parameters = acceptance.get("required_parameters", {})
        if isinstance(required_parameters, dict):
            for path, expected in required_parameters.items():
                if "." not in str(path):
                    warnings.append(f"Unsupported required-parameter path `{path}`.")
                    continue
                module_id, field = str(path).split(".", 1)
                module = module_by_id.get(module_id)
                actual = (module.get("parameters", {}) if isinstance(module, dict) else {}).get(field)
                if actual != expected:
                    errors.append(f"Required parameter `{path}` expected {expected!r}, found {actual!r}.")

        for flag in ("no_full_image_background", "native_text", "semantic_groups", "glued_connectors"):
            if strict and acceptance.get(flag) is not True:
                errors.append(f"Strict mode requires `acceptance.{flag}: true`.")

    source = spec.get("source", {})
    if isinstance(source, dict) and strict:
        if not source.get("generated_image"):
            errors.append("Strict mode requires `source.generated_image`.")
        if not source.get("paper_files"):
            warnings.append("No manuscript file is recorded; structural truth may be incomplete.")
        if not source.get("image2_prompt_file"):
            warnings.append("No Image 2 prompt is recorded; requested counts/style may be harder to verify.")

    return errors, warnings


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate a scientific figure_spec.json.")
    parser.add_argument("spec")
    parser.add_argument("--strict", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    spec = load(Path(args.spec).resolve())
    errors, warnings = validate(spec, args.strict)
    for item in warnings:
        print(f"WARNING: {item}")
    for item in errors:
        print(f"ERROR: {item}")
    if errors:
        return 2
    print(f"Figure spec valid: {args.spec}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
