# Scientific component contracts

## `scientific_unet`

Parameters:
- `levels`: encoder and decoder depth;
- `skip_connections`: usually equal to `levels`;
- `guidance_inputs`: optional bottom/top guidance ports;
- `encoder_labels`, `decoder_labels`;
- `palette`: list or style fills;
- `background_visible`;
- `title`.

The renderer creates grouped encoder blocks, bottleneck, decoder blocks, skip paths, and optional guidance arrows.

## `segmented_cube_grid`

Parameters:
- `rows`, `columns`;
- `row_gap`, `column_gap`;
- `depth_x_in`, `depth_y_in`;
- `row_fills` or `cell_fills`;
- `labels`;
- `group_cells`.

Use it for guidance variables, multiscale tensors, and fusion distributions. Counts are semantic truth and must match the spec.

## `multi_domain_signal_panel`

Parameters:
- `domains`;
- `domain_labels`;
- `wave_samples` or deterministic `seed`;
- `cycles`;
- `row_fills`, `wave_colors`;
- `panel_visible`.

Use native text for domain labels. Waveforms may be editable vector paths.

## `noise_cloud`

Parameters:
- `point_count`;
- deterministic `seed`;
- `point_radius`;
- `distribution`: `uniform`, `gaussian`, or `bands`;
- `point_fills`.

Never use unseeded randomness in a reproducible figure.

## `diffusion_timeline`

Parameters:
- `states`;
- `state_labels`;
- `state_kinds`: `signal`, `noise`, `cube`, or `box`;
- `ellipsis_after`;
- `feedback`;
- `process_label`.

The whole timeline is grouped while cards, labels, and arrows remain editable after ungrouping.

## `soft_architecture_background`

Parameters:
- `shape`: `rounded`, `polygon`, or `blob`;
- `points` for custom polygon/blob;
- `fill`, `transparency_pct`;
- optional `title`.

Use this for pale pink/purple U-shaped or regional backgrounds. It must not replace semantic modules.
