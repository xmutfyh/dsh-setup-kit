# Region repair

Use region repair after a review round when most of the figure is already correct.

A patch file has this form:

```json
{
  "target_regions": ["guidance"],
  "locked_regions": ["observation", "condition_net", "denoising_net"],
  "delete_node_ids": [],
  "delete_edge_ids": [],
  "replace_nodes": [
    {
      "id": "guidance_grid",
      "type": "segmented_cube_grid",
      "x": 5.1,
      "y": 2.0,
      "w": 2.2,
      "h": 1.0,
      "container_id": "guidance",
      "rows": 3,
      "columns": 4
    }
  ],
  "replace_edges": [],
  "metadata_patch": {
    "repair_history": [
      {"region": "guidance", "reason": "correct 3x4 count"}
    ]
  }
}
```

Rules:
- replacements must stay inside `target_regions`;
- objects in `locked_regions` cannot be replaced or deleted;
- edge endpoints must still resolve after the patch;
- structural/topology failures may require a full rebuild;
- geometry, color, font, and local connector failures should use a regional patch;
- rerun validation and acceptance after every patch.
