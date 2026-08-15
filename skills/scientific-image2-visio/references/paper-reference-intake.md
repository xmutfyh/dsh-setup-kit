# Paper and reference intake

Codex already has multimodal capabilities. Use the source files directly; do not reduce the workflow to OCR.

## Extract from the manuscript

Record only figure-relevant facts:
- module names and ordering;
- exact number of stages/layers/branches;
- equations and variable notation;
- input/output modalities;
- skip, feedback, merge, fork, and conditioning relations;
- figure caption wording;
- statements such as “four scales”, “three domains”, or “shared weights”.

## Extract from references

References are supporting evidence, not automatic truth. Record:
- a component definition adopted by the manuscript;
- conventional visual grammar for a named mechanism;
- exact notation that the manuscript reuses;
- a reference figure whose style or structure was explicitly requested.

When references disagree with the manuscript, the manuscript wins unless the user corrects it.

## Extract from the Image 2 prompt

The prompt is especially useful for:
- exact requested counts;
- “do not invent” constraints;
- palette and style;
- layout order;
- labels that Image 2 rendered incorrectly.

## Extract from the generated image

Use the image for:
- source bounding boxes;
- relative sizes and alignment;
- color values and gradients;
- 3D offsets;
- typography appearance;
- line routing appearance;
- decorative motifs.

Do not use the image to silently change known structural facts.

## Uncertainty

For unreadable labels, use:
- `uncertainty: "unreadable"`
- add the item to `source.unresolved_items`
- preserve a placeholder only when the user supplied one.

Never invent plausible scientific text.
