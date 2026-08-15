from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
EXAMPLE = ROOT / "templates" / "scientific" / "example_multidomain_diffusion.figure.json"


class ScientificPipelineTests(unittest.TestCase):
    def test_components_registered(self):
        data = json.loads((ROOT / "templates" / "visio_components.json").read_text(encoding="utf-8"))
        for name in (
            "scientific_unet",
            "segmented_cube_grid",
            "multi_domain_signal_panel",
            "noise_cloud",
            "diffusion_timeline",
            "soft_architecture_background",
        ):
            self.assertIn(name, data["node_types"])

    def test_example_spec_validates_and_compiles(self):
        with tempfile.TemporaryDirectory() as td:
            scene = Path(td) / "scene.json"
            result = subprocess.run(
                [sys.executable, str(SCRIPTS / "figure_spec_validate.py"), str(EXAMPLE), "--strict"],
                text=True, capture_output=True,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            result = subprocess.run(
                [sys.executable, str(SCRIPTS / "figure_spec_to_scene.py"), str(EXAMPLE), "--output", str(scene)],
                text=True, capture_output=True,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            payload = json.loads(scene.read_text(encoding="utf-8"))
            nodes = {n["id"]: n for n in payload["nodes"]}
            self.assertEqual(nodes["guidance_grid"]["rows"], 3)
            self.assertEqual(nodes["guidance_grid"]["columns"], 4)
            self.assertEqual(nodes["denoising_net"]["guidance_inputs"], 4)
            self.assertTrue(payload["edges"][0]["glue"])

    def test_locked_region_patch_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            scene = {
                "metadata": {"locked_regions": ["condition"]},
                "nodes": [{"id": "condition_net", "type": "scientific_unet", "semantic_region": "condition"}],
                "edges": [],
            }
            patch = {
                "target_regions": ["condition"],
                "replace_nodes": [{"id": "condition_net", "type": "scientific_unet", "semantic_region": "condition"}],
            }
            scene_path = td / "scene.json"
            patch_path = td / "patch.json"
            scene_path.write_text(json.dumps(scene), encoding="utf-8")
            patch_path.write_text(json.dumps(patch), encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(SCRIPTS / "scene_region_patch.py"), "--scene", str(scene_path), "--patch", str(patch_path), "--output", str(td / "out.json")],
                text=True, capture_output=True,
            )
            self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
