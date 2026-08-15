---
name: scientific-image2-visio
description: Rebuild scientific figures created with GPT Image 2 into editable Visio VSDX, SVG, and PNG. Uses manuscript/reference files as structural truth, the generated image as visual truth, and Codex multimodal analysis to author figure_spec.json and scene.json. Best for paper architecture figures, neural-network diagrams, diffusion pipelines, signal panels, tensor cubes, and box-arrow method figures.
---

# Scientific Image 2 → Visio

## Purpose

Use this skill when the team already has:
- a manuscript or method description;
- cited/reference papers or figures;
- a selected image generated with GPT Image 2;
- a requirement for an editable Visio deliverable.

The workflow is semantic reconstruction, not bitmap tracing:

`paper + references + Image 2 prompt + generated image`
→ `figure_spec.json`
→ `scene.json`
→ `validate`
→ `Visio COM render`
→ `VSDX + SVG + PNG`
→ `overlay/review`
→ `region repair`

## Truth priority

Resolve conflicts in this order:

1. Explicit user correction.
2. Manuscript/method facts and figure caption.
3. Reference-paper facts that the manuscript adopts.
4. The Image 2 prompt.
5. The generated image.

The image controls layout, palette, proportions, visual motifs, and styling. It must not override known structural facts such as layer count, module count, equations, labels, or arrow topology.

Do not invent unreadable text. Mark it unresolved in `figure_spec.json`.

## Required outputs

Keep these as the durable source files:
- `source/source_manifest.json`
- `figure_spec.json`
- `scene.json`
- `output/<figure>.vsdx`
- `output/<figure>.svg`
- `output/<figure>.png`
- `review/pair.png`
- `review/overlay.png`
- `review/review_manifest.json`
- `review/acceptance.md`

Do not treat PNG or VSDX as the only source of truth.

## Environment

Final VSDX rendering requires:
- Windows;
- Microsoft Visio desktop;
- Python;
- `pywin32`.

Codex can perform paper/reference/image analysis on any supported host. On non-Windows hosts, complete the spec, scene, validation, and review-plan stages, then render on the Windows Visio host.

## Workflow

### 1. Create a scientific workspace

```powershell
python ${SKILL_DIR}\scripts\create_scientific_workspace.py `
  --image <image2-output.png> `
  --paper <paper.pdf> `
  --reference <reference-1.pdf> `
  --reference <reference-2.pdf> `
  --image2-prompt-file <prompt.txt> `
  --output-dir <workspace>
```

Read `workspace/codex_task.md`. Inspect the paper, references, prompt, and generated image directly with Codex multimodal capabilities.

### 2. Author `figure_spec.json`

Read:
- `schemas/figure_spec.schema.json`
- `references/paper-reference-intake.md`
- `references/scientific-component-contracts.md`
- `templates/scientific/example_multidomain_diffusion.figure.json`

The spec must record:
- source files and hashes;
- figure caption and method facts;
- exact visible labels/formulas;
- semantic modules and parameters;
- connector topology;
- source-image bounding boxes;
- style facts;
- uncertainty;
- locked/accepted regions;
- acceptance constraints.

Prefer source-pixel coordinates for reconstruction.

### 3. Validate and compile the scene

```powershell
python ${SKILL_DIR}\scripts\figure_spec_validate.py <workspace>\figure_spec.json --strict

python ${SKILL_DIR}\scripts\figure_spec_to_scene.py `
  <workspace>\figure_spec.json `
  --output <workspace>\scene.json

python ${SKILL_DIR}\scripts\scene_validate.py <workspace>\scene.json --strict
python ${SKILL_DIR}\scripts\scene_complexity.py <workspace>\scene.json
python ${SKILL_DIR}\scripts\scientific_acceptance.py `
  --spec <workspace>\figure_spec.json `
  --scene <workspace>\scene.json `
  --output <workspace>\review\acceptance.md
```

### 4. Render

```powershell
python ${SKILL_DIR}\scripts\scene_to_visio.py `
  <workspace>\scene.json `
  --output-dir <workspace>\output `
  --basename <figure-id>
```

Never embed the complete source image as the solution. Raster sub-assets are allowed only when the spec explicitly marks them as non-semantic decoration.

### 5. Review against the generated image

```powershell
python ${SKILL_DIR}\scripts\make_review_assets.py `
  --original <workspace>\source\original.png `
  --replica <workspace>\output\<figure-id>.png `
  --scene <workspace>\scene.json `
  --output-dir <workspace>\review
```

Review in this order:
1. structural truth: module counts, labels, formulas, topology;
2. geometry: position, size, alignment, spacing;
3. styling: colors, fonts, line weights, gradients/shadows;
4. editability: semantic grouping and connector glue.

### 6. Repair the smallest valid scope

Use full-scene regeneration only when the semantic decomposition or topology is broadly wrong. For localized errors, use a region patch:

```powershell
python ${SKILL_DIR}\scripts\scene_region_patch.py `
  --scene <workspace>\scene.json `
  --patch <workspace>\repair.patch.json `
  --output <workspace>\scene.repaired.json
```

Read `references/region-repair.md`. Accepted regions should be locked so later rounds do not drift.

## Scientific components

Prefer these semantic components instead of many unrelated primitives:
- `scientific_unet`
- `segmented_cube_grid`
- `multi_domain_signal_panel`
- `noise_cloud`
- `diffusion_timeline`
- `soft_architecture_background`

Use generic existing components for ordinary boxes, matrices, labels, formulas, and connectors.

## Editability contract

A final figure is acceptable only when:
- semantic modules can be moved as groups;
- important subparts remain editable after ungrouping;
- connectors marked `glue: true` stay attached when modules move;
- text remains native Visio text;
- the full source image is not used as a background;
- exact counts and topology match the manuscript/spec;
- unresolved text is explicitly flagged rather than invented.

## Installation behavior

This skill is intentionally explicit. Invoke it as `$scientific-image2-visio`; do not run it implicitly for ordinary diagrams.
