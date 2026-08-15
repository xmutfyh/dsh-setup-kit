# Scientific optimization release notes

## Added
- Dual-source truth protocol: manuscript/references/prompt for structure; Image 2 PNG for visual design.
- `figure_spec.json` schema, validator, compiler, acceptance report, and regional patch workflow.
- Scientific semantic components: U-Net, segmented cube grid, multi-domain signal panel, deterministic noise cloud, diffusion timeline, and soft architecture background.
- Best-effort native Visio grouping for new semantic components.
- Best-effort connector glue for edges marked `glue: true`.
- `scientific_pastel` style profile.
- Explicit Codex invocation policy.
- Non-Windows tests for the spec/scene pipeline.

## Retained
- Original scene validator, audit, review asset generation, Visio COM export, SVG/PNG export, and legacy components.

## Important
- Actual VSDX rendering and glue/group behavior must be integration-tested on the team's Windows + Microsoft Visio environment.
- The package does not call GPT Image APIs. It consumes the selected downloaded Image 2 output plus the exact prompt and paper/reference files.
