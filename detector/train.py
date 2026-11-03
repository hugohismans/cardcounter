"""Entraîne le détecteur d'index de cartes (YOLO nano) sur le dataset synthétique.

Usage :
    python train.py --data data/synth/data.yaml --epochs 40 --imgsz 640

Notes :
- pas de retournement miroir (fliplr=0) : un "7" ou un "R" en miroir n'existe pas ;
- les rotations sont déjà dans le générateur ;
- --device auto : GPU NVIDIA (cuda) si présent, sinon GPU Apple (mps), sinon CPU.
"""

import argparse
from pathlib import Path

import torch
from ultralytics import YOLO

ROOT = Path(__file__).parent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(ROOT / "data/synth/data.yaml"))
    ap.add_argument("--model", default="yolo26n.pt", help="poids de départ (pré-entraînés COCO)")
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--device", default="auto")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--name", default="cards")
    ap.add_argument("--fraction", type=float, default=1.0, help="fraction du dataset utilisée")
    ap.add_argument("--resume", action="store_true")
    a = ap.parse_args()

    if a.device == "auto":
        if torch.cuda.is_available():
            a.device = "0"
        elif torch.backends.mps.is_available():
            a.device = "mps"
        else:
            a.device = "cpu"
    print("entraînement sur :", a.device)

    model = YOLO(a.model)
    model.train(
        data=a.data,
        epochs=a.epochs,
        imgsz=a.imgsz,
        batch=a.batch,
        device=a.device,
        workers=a.workers,
        project=str(ROOT / "runs"),
        name=a.name,
        exist_ok=True,
        resume=a.resume,
        fraction=a.fraction,
        patience=15,
        cos_lr=True,
        # augmentations
        fliplr=0.0,
        flipud=0.0,
        degrees=0.0,
        scale=0.3,
        translate=0.1,
        mosaic=1.0,
        close_mosaic=5,
        hsv_h=0.02,
        hsv_s=0.5,
        hsv_v=0.4,
        plots=True,
    )


if __name__ == "__main__":
    main()
