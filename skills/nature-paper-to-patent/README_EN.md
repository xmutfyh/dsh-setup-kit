# `nature-paper-to-patent` Skill

[中文说明](README.md)

`nature-paper-to-patent` converts papers, theses, technical reports, source code, figures, or inventor notes into evidence-constrained Chinese invention patent drafts.

## What To Use It For

- Identify patentable technical contributions from papers or technical materials.
- Build source IDs and an evidence ledger before drafting claims.
- Route algorithm, device, system, process, material, or hybrid inventions to the right drafting rules.
- Generate claims, specification, abstract, abstract drawing, and full review draft.
- Check whether every claim feature can be traced back to source evidence.

## Typical Requests

- "Convert this paper into a Chinese invention patent disclosure and claim draft."
- "Extract only the patentable points first; do not write the full specification yet."
- "Compare the paper claims and patent claims, and find features without evidence."

## What You Need To Provide

- Paper PDF, technical report, code, figures, experiment records, or inventor notes.
- Protection target: method, system, device, material, process, or software workflow.
- Known prior art, confidential information, and terms that must be preserved.

## Outputs

- Technical problem, technical solution, implementation chain, and beneficial-effect analysis.
- Claim draft with evidence mapping for each feature.
- Specification, abstract, drawing description, and black-and-white flowchart.
- Optional DOCX, SVG, PNG, and review report.

## Runtime and Dependencies

- Full functionality depends on the skill directory's `manifest.yaml`, `static/`, `references/`, `scripts/`, and `requirements.txt`.
- DOCX, formula, or flowchart generation uses local Python dependencies and scripts.

## Boundaries

- This is technical drafting support, not a replacement for a patent attorney or legal opinion.
- The skill does not invent embodiments, experimental data, claim features, or prior-art comparisons.
- Features without evidence are marked as gaps rather than written into the independent claim.

## Related Skills

- `nature-reader`: turn the paper into traceable reading material first.
- `nature-writing`: extract contribution and technical narrative.
- `nature-figure`: draft patent flowcharts or structural schematics.
