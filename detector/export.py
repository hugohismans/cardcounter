"""Exporte le modèle entraîné en ONNX pour l'appli (onnxruntime-web, hors ligne).

Usage :
    python export.py runs/cards/weights/best.pt --imgsz 640

Produit app/public/model/cards.onnx et app/public/model/meta.json.
"""

import argparse
import json
import shutil
from pathlib import Path

from ultralytics import YOLO

from cards import CLASSES

ROOT = Path(__file__).parent
OUT = ROOT.parent / "app" / "public" / "model"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("weights")
    ap.add_argument("--imgsz", type=int, default=640)
    a = ap.parse_args()
    model = YOLO(a.weights)
    assert [model.names[i] for i in range(len(model.names))] == CLASSES, "ordre des classes incohérent"
    path = Path(model.export(format="onnx", imgsz=a.imgsz, opset=17, simplify=True, dynamic=False))
    OUT.mkdir(parents=True, exist_ok=True)
    shutil.copy(path, OUT / "cards.onnx")
    (OUT / "meta.json").write_text(json.dumps({
        "imgsz": a.imgsz,
        "classes": CLASSES,
        "end2end": bool(getattr(model.model, "end2end", False)),
    }, indent=2))
    print("modèle exporté :", OUT / "cards.onnx", f"({(OUT / 'cards.onnx').stat().st_size / 1e6:.1f} Mo)")


if __name__ == "__main__":
    main()
