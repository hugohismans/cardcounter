"""Transforme des photos de VOTRE jeu de cartes en "deck" pour le générateur.

Photos attendues : cartes posées à plat, sans se toucher, sur un fond uni qui
contraste (table sombre, nappe), photo prise bien du dessus.

Le plus simple : une photo par couleur, les 8 cartes en ligne (ou en 2 lignes de 4)
dans l'ordre 7, 8, 9, 10, Valet, Dame, Roi, As, lecture de gauche à droite puis
de haut en bas. Nommer les fichiers pique.jpg, coeur.jpg, carreau.jpg, trefle.jpg.

    python prepare_deck.py --name monjeu photos/pique.jpg photos/coeur.jpg ...

Autre possibilité : une carte par photo, nommée par son identifiant (10H.jpg, JS.jpg ...).

Produit assets/decks/<nom>/<carte>.png + deck.json (boîtes d'index estimées
automatiquement) + _controle.jpg pour vérifier d'un coup d'œil.
"""

import argparse
import json
from pathlib import Path

import cv2
import numpy as np

from cards import CLASSES, RANKS

ROOT = Path(__file__).parent
SUIT_FILES = {"pique": "S", "coeur": "H", "carreau": "D", "trefle": "C", "s": "S", "h": "H", "d": "D", "c": "C"}
CARD_H = 700


def find_cards(img: np.ndarray, expected: int | None = None) -> list[np.ndarray]:
    """Renvoie les quadrilatères (4x2, ordonnés hg, hd, bd, bg) des cartes de la photo."""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    area_img = img.shape[0] * img.shape[1]
    best = []
    # cartes claires sur fond sombre (Otsu), sinon contours (Canny)
    otsu, th = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    # seuils plus hauts : seul le blanc des cartes reste (table éclairée, reflets)
    white = [((gray > t) * 255).astype(np.uint8) for t in (otsu + (255 - otsu) * f for f in (0.35, 0.55))]
    edges = cv2.dilate(cv2.Canny(gray, 40, 120), np.ones((5, 5), np.uint8))
    k = max(5, int(0.012 * max(img.shape[:2])))  # sépare les cartes presque collées
    candidates = [cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((ks, ks), np.uint8))
                  for m in (th, *white, 255 - th, edges) for ks in (5, k)]
    for mask in candidates:
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        quads = []
        for c in contours:
            a = cv2.contourArea(c)
            if a < area_img * 0.004 or a > area_img * 0.6:
                continue
            rect = cv2.minAreaRect(c)
            (w, h) = rect[1]
            if min(w, h) == 0:
                continue
            ratio = max(w, h) / min(w, h)
            if not 1.25 < ratio < 1.75 or a / (w * h) < 0.85:
                continue
            peri = cv2.arcLength(c, True)
            approx = cv2.approxPolyDP(c, 0.02 * peri, True)
            pts = approx.reshape(-1, 2).astype(np.float32) if len(approx) == 4 else cv2.boxPoints(rect)
            quads.append(order_quad(pts))
        if expected and len(quads) == expected:
            return sort_reading_order(quads)
        if len(quads) > len(best):
            best = quads
    return sort_reading_order(best)


def order_quad(pts: np.ndarray) -> np.ndarray:
    """Ordonne hg, hd, bd, bg avec la carte en portrait."""
    c = pts.mean(0)
    ang = np.arctan2(pts[:, 1] - c[1], pts[:, 0] - c[0])
    pts = pts[np.argsort(ang)]  # sens horaire en coordonnées image, en partant de ~ -180°
    # choisir le point de départ pour que le premier côté (hg->hd) soit le petit côté
    d01 = np.linalg.norm(pts[0] - pts[1])
    d12 = np.linalg.norm(pts[1] - pts[2])
    if d01 > d12:
        pts = np.roll(pts, -1, axis=0)
    # le coin "haut-gauche" = celui le plus haut à gauche parmi les deux candidats
    if pts[0][1] + pts[1][1] > pts[2][1] + pts[3][1]:
        pts = np.roll(pts, 2, axis=0)
    return pts


def sort_reading_order(quads):
    if not quads:
        return quads
    centers = np.array([q.mean(0) for q in quads])
    hs = np.array([np.linalg.norm(q[0] - q[3]) for q in quads])
    rows = []
    for i in np.argsort(centers[:, 1]):
        for r in rows:
            if abs(centers[r[0], 1] - centers[i, 1]) < 0.5 * hs.mean():
                r.append(i)
                break
        else:
            rows.append([i])
    order = [i for r in rows for i in sorted(r, key=lambda k: centers[k, 0])]
    return [quads[i] for i in order]


def rectify(img, quad):
    w_top = np.linalg.norm(quad[1] - quad[0])
    h_left = np.linalg.norm(quad[3] - quad[0])
    W = int(CARD_H * w_top / h_left)
    dst = np.float32([[0, 0], [W, 0], [W, CARD_H], [0, CARD_H]])
    M = cv2.getPerspectiveTransform(quad.astype(np.float32), dst)
    return cv2.warpPerspective(img, M, (W, CARD_H), flags=cv2.INTER_CUBIC)


def estimate_index_box(card: np.ndarray):
    """Boîte englobant l'encre (valeur + symbole) dans le coin haut-gauche."""
    H, W = card.shape[:2]
    gray = cv2.cvtColor(card, cv2.COLOR_BGR2GRAY)
    x0, y0, x1, y1 = int(0.03 * W), int(0.02 * H), int(0.24 * W), int(0.32 * H)
    sub = gray[y0:y1, x0:x1]
    ink = (sub < (np.median(gray) - 50)).astype(np.uint8)
    ink = cv2.morphologyEx(ink, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))

    def first_block(profile, min_gap):
        """Premier bloc d'encre en partant du bord, jusqu'à un vide de min_gap."""
        on = np.nonzero(profile > 0)[0]
        if len(on) == 0:
            return None
        start = end = on[0]
        for v in on[1:]:
            if v - end > min_gap:
                break
            end = v
        return start, end + 1

    # colonnes : l'index est la première colonne d'encre à partir du bord gauche,
    # séparée des pips / de la figure par une bande vide
    cols = first_block(ink.sum(0) > 1, max(2, int(0.012 * W)))
    if cols is None:
        return None
    rows = first_block(ink[:, cols[0]:cols[1]].sum(1) > 0, max(3, int(0.03 * H)))
    if rows is None:
        return None
    return [(cols[0] + x0) / W, (rows[0] + y0) / H, (cols[1] + x0) / W, (rows[1] + y0) / H]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("photos", nargs="+")
    ap.add_argument("--name", required=True)
    ap.add_argument("--cards", nargs="*", help="identifiants dans l'ordre de lecture (si une seule photo)")
    ap.add_argument("--weight", type=float, default=3.0, help="poids du jeu dans le générateur")
    a = ap.parse_args()

    out = ROOT / "assets" / "decks" / a.name
    out.mkdir(parents=True, exist_ok=True)
    done = {}
    for p in map(Path, a.photos):
        img = cv2.imread(str(p))
        stem = p.stem.lower()
        if a.cards and len(a.photos) == 1:
            ids = a.cards
        elif stem in SUIT_FILES:
            ids = [r + SUIT_FILES[stem] for r in RANKS]
        elif p.stem.upper() in CLASSES:
            ids = [p.stem.upper()]
        else:
            raise SystemExit(f"{p.name} : nom de fichier non reconnu (pique.jpg, 10H.jpg, ...)")
        quads = find_cards(img, expected=len(ids))
        if len(quads) != len(ids):
            raise SystemExit(f"{p.name} : {len(quads)} cartes trouvées, {len(ids)} attendues")
        for cid, q in zip(ids, quads):
            card = rectify(img, q)
            cv2.imwrite(str(out / f"{cid}.png"), card)
            done[cid] = card
        print(f"{p.name} : {', '.join(ids)}")

    boxes = [b for b in (estimate_index_box(c) for c in done.values()) if b]
    b = np.median(np.array(boxes), axis=0) if boxes else np.array([0.03, 0.02, 0.18, 0.26])
    b = [float(b[0]) - 0.01, float(b[1]) - 0.01, float(b[2]) + 0.01, float(b[3]) + 0.01]
    meta = {"source": "photos utilisateur", "weight": a.weight, "corner_radius": 0.05,
            "index_boxes": [b, [1 - b[2], 1 - b[3], 1 - b[0], 1 - b[1]]]}
    (out / "deck.json").write_text(json.dumps(meta, indent=2))

    # planche de contrôle
    tiles = []
    for cid in CLASSES:
        if cid not in done:
            continue
        c = cv2.resize(done[cid], (200, int(200 * CARD_H / done[cid].shape[1])))
        H, W = c.shape[:2]
        for bx in meta["index_boxes"]:
            cv2.rectangle(c, (int(bx[0] * W), int(bx[1] * H)), (int(bx[2] * W), int(bx[3] * H)), (0, 200, 0), 2)
        cv2.putText(c, cid, (60, H // 2), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 0, 255), 2)
        tiles.append(c)
    h = min(t.shape[0] for t in tiles)
    tiles = [t[:h] for t in tiles] + [np.zeros_like(tiles[0][:h])] * ((-len(tiles)) % 8)
    sheet = np.vstack([np.hstack(tiles[i:i + 8]) for i in range(0, len(tiles), 8)])
    cv2.imwrite(str(out / "_controle.jpg"), sheet)
    print(f"{len(done)}/32 cartes -> {out} (vérifier {out / '_controle.jpg'})")


if __name__ == "__main__":
    main()
