# Team workflow: web GPT + Image 2 + Codex

1. Send the paper and references to web ChatGPT.
2. Ask ChatGPT/Image 2 to generate candidate figures.
3. Download the selected PNG.
4. Give Codex the same paper, references, the exact Image 2 prompt, and the PNG.
5. Codex creates `figure_spec.json` with manuscript/reference structural truth.
6. Codex compiles and renders an editable Visio figure.
7. Review the VSDX/PNG against the generated PNG.
8. Correct only the failing region when possible.
9. Store `figure_spec.json`, `scene.json`, SVG, and VSDX together.

The paper/reference inputs are not optional context. They prevent the vector reconstruction from copying Image 2 mistakes.
