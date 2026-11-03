"""Télécharge un jeu de cartes libre (SVG-cards, LGPL-2.1, D. Bellot / H. de Beer)
et le convertit au format "deck" du générateur :

    assets/decks/<nom>/<carte>.png   (ex: 10H.png, JS.png, AC.png)
    assets/decks/<nom>/deck.json     ({"index_boxes": [[x0,y0,x1,y1], ...]} normalisés)

Extrait aussi des morceaux de figures (assets/face_art/) pour habiller les cartes
procédurales.

Usage : python fetch_assets.py
"""

import io
import json
import tarfile
import urllib.request
from pathlib import Path

from PIL import Image

from cards import CLASSES, split

ROOT = Path(__file__).parent
URL = "https://registry.npmjs.org/svg-cards/-/svg-cards-4.0.2.tgz"
SUIT = {"S": "spade", "H": "heart", "D": "diamond", "C": "club"}
RANK = {"7": "7", "8": "8", "9": "9", "10": "10", "J": "jack", "Q": "queen", "K": "king", "A": "1"}


def main():
    out = ROOT / "assets" / "decks" / "svgcards"
    art_dir = ROOT / "assets" / "face_art"
    out.mkdir(parents=True, exist_ok=True)
    art_dir.mkdir(parents=True, exist_ok=True)
    print("téléchargement", URL)
    data = urllib.request.urlopen(URL).read()
    tar = tarfile.open(fileobj=io.BytesIO(data))
    files = {Path(m.name).name: m for m in tar.getmembers() if "/png/2x/" in m.name}
    for cid in CLASSES:
        r, s = split(cid)
        name = f"{SUIT[s]}_{RANK[r]}.png"
        img = Image.open(tar.extractfile(files[name])).convert("RGBA")
        img.save(out / f"{cid}.png")
        if r in ("J", "Q", "K"):
            w, h = img.size
            img.crop((int(0.2 * w), int(0.04 * h), int(0.8 * w), int(0.96 * h))).save(art_dir / f"{cid}.png")
    (out / "deck.json").write_text(json.dumps({
        "source": "SVG-cards 4.0.2 (LGPL-2.1)",
        "index_boxes": [[0.02, 0.01, 0.165, 0.24], [0.835, 0.76, 0.98, 0.99]],
    }, indent=2))
    print("ok :", out)


if __name__ == "__main__":
    main()
