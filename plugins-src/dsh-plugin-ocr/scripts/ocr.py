#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""OCR helper for dsh-plugin-ocr: recognize text in an image via RapidOCR (ONNX, local).

Usage:
    python ocr.py <image_path> [--lang zh|en|auto] [--json <out.json>]

Prints detected text lines to stdout (one per line, reading order) unless --json is given,
in which case a JSON object {lines: [{text, score, box}]} is written to stdout.
"""
import argparse
import io
import json
import sys

# Force UTF-8 stdout on Windows consoles
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description="Local OCR via RapidOCR")
    ap.add_argument("image_path", help="Path to the image file (png/jpg/webp/bmp/tiff)")
    ap.add_argument("--lang", default="auto", choices=["auto", "zh", "en"],
                    help="Language hint (RapidOCR detects both by default)")
    ap.add_argument("--json", action="store_true", help="Emit JSON instead of plain lines")
    args = ap.parse_args()

    try:
        from rapidocr_onnxruntime import RapidOCR
    except ImportError as exc:
        print(f"ERROR: RapidOCR is not installed: {exc}", file=sys.stderr)
        return 2

    engine = RapidOCR()
    result, _elapse = engine(args.image_path)
    lines = []
    if result:
        for item in result:
            box, text, score = item[0], item[1], item[2]
            lines.append({
                "text": str(text),
                "score": round(float(score), 4),
                "box": [[float(p[0]), float(p[1])] for p in box],
            })

    if args.json:
        print(json.dumps({"lines": lines}, ensure_ascii=False))
    else:
        for ln in lines:
            print(ln["text"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
