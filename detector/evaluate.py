"""Évalue le détecteur comme l'appli l'utilise : la LISTE des cartes trouvées
dans chaque photo est-elle exacte ?

Jeu de test = un dossier de photos, chacune accompagnée d'un .txt listant les
cartes présentes (ex: "10H JS AC 7D"), OU un dossier YOLO (images/ + labels/).

    python evaluate.py runs/cards/weights/best.pt data/real --save out/
    python evaluate.py runs/cards/weights/best.onnx data/synth/images/val --limit 200

Affiche : % de photos parfaites, cartes manquées, cartes en trop, et la liste
des confusions les plus fréquentes.
"""

import argparse
from collections import Counter
from pathlib import Path

import cv2
from ultralytics import YOLO

from cards import CLASSES


def truth_for(img_path: Path):
    txt = img_path.with_suffix(".txt")
    if txt.exists():
        return set(txt.read_text().split())
    # format YOLO : .../images/<split>/x.jpg -> .../labels/<split>/x.txt
    parts = list(img_path.parts)
    if "images" in parts:
        i = len(parts) - 1 - parts[::-1].index("images")
        parts[i] = "labels"
        lab = Path(*parts).with_suffix(".txt")
        if lab.exists():
            return {CLASSES[int(l.split()[0])] for l in lab.read_text().splitlines() if l.strip()}
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("weights")
    ap.add_argument("folder")
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--conf", type=float, default=0.25)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--save", help="dossier où écrire les photos annotées")
    a = ap.parse_args()

    model = YOLO(a.weights, task="detect")
    imgs = sorted(p for p in Path(a.folder).rglob("*") if p.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp"))
    if a.limit:
        imgs = imgs[: a.limit]
    if a.save:
        Path(a.save).mkdir(parents=True, exist_ok=True)

    n = perfect = tot_true = tot_missed = tot_extra = 0
    missed_c, extra_c = Counter(), Counter()
    for p in imgs:
        truth = truth_for(p)
        if truth is None:
            continue
        # comme l'appli : un index = une seule carte (NMS toutes classes confondues)
        r = model.predict(str(p), imgsz=a.imgsz, conf=a.conf, iou=0.6, agnostic_nms=True, verbose=False)[0]
        best = {}
        for b in r.boxes:
            c = CLASSES[int(b.cls)]
            best[c] = max(best.get(c, 0), float(b.conf))
        found = set(best)
        missed, extra = truth - found, found - truth
        n += 1
        perfect += not missed and not extra
        tot_true += len(truth)
        tot_missed += len(missed)
        tot_extra += len(extra)
        missed_c.update(missed)
        extra_c.update(extra)
        if missed or extra:
            print(f"{p.name}: {len(truth)} cartes, manquées {sorted(missed)}, en trop {sorted(extra)}")
        if a.save:
            im = r.plot(line_width=1, font_size=8)
            cv2.imwrite(str(Path(a.save) / p.name), im)

    if not n:
        raise SystemExit("aucune image avec vérité terrain trouvée")
    print(f"\n{n} photos, {tot_true} cartes")
    print(f"photos parfaites : {perfect / n:.1%}")
    print(f"cartes manquées  : {tot_missed} ({tot_missed / max(tot_true, 1):.2%})")
    print(f"cartes en trop   : {tot_extra}")
    if missed_c:
        print("plus souvent manquées :", missed_c.most_common(8))
    if extra_c:
        print("plus souvent en trop  :", extra_c.most_common(8))


if __name__ == "__main__":
    main()
