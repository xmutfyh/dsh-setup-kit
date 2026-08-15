#!/usr/bin/env python3
from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path


def run(command: list[str]) -> None:
    print("$", " ".join(command))
    subprocess.run(command, check=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Windows + Microsoft Visio integration test for the scientific skill.")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--visible", action="store_true")
    args = parser.parse_args()

    root = Path(__file__).resolve().parents[1]
    spec = root / "templates" / "scientific" / "example_multidomain_diffusion.figure.json"
    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="scientific_visio_test_") as temp:
        scene = Path(temp) / "example.scene.json"
        run([sys.executable, str(root / "scripts" / "figure_spec_validate.py"), str(spec), "--strict"])
        run([sys.executable, str(root / "scripts" / "figure_spec_to_scene.py"), str(spec), "--output", str(scene)])
        run([sys.executable, str(root / "scripts" / "scene_validate.py"), str(scene), "--strict"])
        render_command = [
            sys.executable,
            str(root / "scripts" / "scene_to_visio.py"),
            str(scene),
            "--output-dir",
            str(output_dir),
            "--basename",
            "scientific_integration_test",
        ]
        if args.visible:
            render_command.append("--visible")
        run(render_command)

    expected = [
        output_dir / "scientific_integration_test.vsdx",
        output_dir / "scientific_integration_test.svg",
        output_dir / "scientific_integration_test.png",
    ]
    missing = [str(path) for path in expected if not path.exists() or path.stat().st_size == 0]
    if missing:
        raise FileNotFoundError(f"Integration outputs missing or empty: {missing}")

    print("Integration render completed.")
    print("Manual check: move each semantic group and confirm glued connectors stay attached.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
