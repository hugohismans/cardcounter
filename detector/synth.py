"""Génère un dataset YOLO d'éventails de cartes synthétiques.

Chaque image : un fond aléatoire, un ou plusieurs éventails / alignements de
cartes (tirées sans remise parmi les 32), ombres, perspective, éclairage, flou,
bruit, compression JPEG. Les annotations sont les boîtes des INDEX visibles
(valeur + couleur dans les coins), classe = identifiant de la carte.

Usage :
    python synth.py --out data/synth --train 6000 --val 600 --workers 4
    python synth.py --out /tmp/preview --train 0 --val 12 --preview
"""

from __future__ import annotations

import os

# un seul thread par processus : le parallélisme se fait entre processus
for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse
import glob
import json
import math
import pickle
from multiprocessing import Pool
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

import procedural
from cards import CLASSES, CLASS_INDEX

ROOT = Path(__file__).parent
DECKS_DIR = ROOT / "assets" / "decks"
N_PROC_STYLES = 48
DECK_SEED = 1234
MIN_VISIBLE = 0.5  # fraction minimale de l'index visible pour être annoté


# --------------------------------------------------------------------------
# Jeux de cartes
# --------------------------------------------------------------------------

class Deck:
    def __init__(self, name: str, cards: dict, weight: float = 1.0):
        self.name = name
        self.cards = cards  # id -> (RGBA uint8 HxWx4, [(x0,y0,x1,y1) normalisés])
        self.weight = weight


def _rounded_alpha(h, w, radius):
    a = np.zeros((h, w), np.uint8)
    r = max(1, int(radius))
    cv2.rectangle(a, (r, 0), (w - 1 - r, h - 1), 255, -1)
    cv2.rectangle(a, (0, r), (w - 1, h - 1 - r), 255, -1)
    for cx, cy in ((r, r), (w - 1 - r, r), (r, h - 1 - r), (w - 1 - r, h - 1 - r)):
        cv2.circle(a, (cx, cy), r, 255, -1, lineType=cv2.LINE_AA)
    return a


def load_folder_deck(path: Path) -> Deck:
    """Jeu stocké sur disque : <id>.png|jpg + deck.json (index_boxes, weight, corner_radius)."""
    meta = json.loads((path / "deck.json").read_text())
    default_boxes = [tuple(b) for b in meta["index_boxes"]]
    per_card = meta.get("cards", {})
    cards = {}
    for cid in CLASSES:
        files = [f for ext in ("png", "jpg", "jpeg", "webp") for f in path.glob(f"{cid}.{ext}")]
        if not files:
            continue
        img = np.array(Image.open(files[0]).convert("RGBA"))
        h, w = img.shape[:2]
        if h > 700:  # on limite la taille en mémoire
            s = 700 / h
            img = cv2.resize(img, (int(w * s), 700), interpolation=cv2.INTER_AREA)
            h, w = img.shape[:2]
        if img[..., 3].min() == 255 and meta.get("corner_radius"):
            img[..., 3] = _rounded_alpha(h, w, meta["corner_radius"] * w)
        cards[cid] = (img, [tuple(b) for b in per_card.get(cid, default_boxes)])
    missing = set(CLASSES) - set(cards)
    if missing:
        print(f"[{path.name}] cartes manquantes : {sorted(missing)}")
    return Deck(path.name, cards, float(meta.get("weight", 1.0)))


def build_decks() -> list[Deck]:
    decks = []
    if DECKS_DIR.exists():
        for p in sorted(DECKS_DIR.iterdir()):
            if (p / "deck.json").exists():
                decks.append(load_folder_deck(p))
    rng = np.random.default_rng(DECK_SEED)
    fonts = procedural.list_fonts()
    arts = [Image.open(f).convert("RGBA") for f in sorted(glob.glob(str(ROOT / "assets/face_art/*.png")))]
    proc_weight = 1.5 / N_PROC_STYLES  # l'ensemble des jeux procéduraux pèse 1.5 jeu "réel"
    for i in range(N_PROC_STYLES):
        st = procedural.random_style(rng, fonts)
        raw = procedural.render_deck(st, rng, face_arts=arts)
        cards = {cid: (np.array(im), boxes) for cid, (im, boxes) in raw.items()}
        decks.append(Deck(f"proc{i:02d}", cards, proc_weight))
    return decks


# --------------------------------------------------------------------------
# Fonds
# --------------------------------------------------------------------------

def _smooth_noise(rng, h, w, cells):
    small = rng.random((max(2, cells), max(2, int(cells * w / h)))).astype(np.float32)
    return cv2.resize(small, (w, h), interpolation=cv2.INTER_CUBIC)


def background(rng, h, w) -> np.ndarray:
    kind = rng.integers(0, 8)
    if kind >= 6:  # intérieur flou (photo de cartes tenues en main) : grands aplats + gros flou
        img = np.ones((h, w, 3), np.float32) * (0.4 + 0.5 * rng.random(3)).astype(np.float32)
        for _ in range(int(rng.integers(3, 12))):
            col = (rng.random(3) * rng.uniform(0.2, 1.0)).astype(np.float32)
            x0, y0 = int(rng.integers(-w // 4, w)), int(rng.integers(-h // 4, h))
            cv2.rectangle(img, (x0, y0), (x0 + int(rng.integers(w // 10, w)), y0 + int(rng.integers(h // 10, h))),
                          tuple(float(c) for c in col), -1)
        k = int(rng.integers(5, 25)) * 2 + 1
        img = cv2.GaussianBlur(img, (k, k), 0)
        return np.clip(img + rng.normal(0, 0.01, (h, w, 1)).astype(np.float32), 0, 1)
    c1 = rng.random(3).astype(np.float32)
    c2 = rng.random(3).astype(np.float32)
    if kind == 0:  # uni + bruit
        img = np.ones((h, w, 3), np.float32) * c1
    elif kind == 1:  # nuages / marbre
        n = sum(_smooth_noise(rng, h, w, c) * (1 / (k + 1)) for k, c in enumerate((3, 8, 24, 64)))
        n = (n - n.min()) / (np.ptp(n) + 1e-6)
        img = c1 * n[..., None] + c2 * (1 - n[..., None])
    elif kind == 2:  # bois
        c1 = np.array([rng.uniform(0.35, 0.75), rng.uniform(0.2, 0.5), rng.uniform(0.05, 0.3)], np.float32)
        y = np.linspace(0, 1, h, dtype=np.float32)[:, None]
        x = np.linspace(0, 1, w, dtype=np.float32)[None, :]
        warp = _smooth_noise(rng, h, w, 6) * rng.uniform(2, 8)
        f = rng.uniform(20, 80)
        g = 0.5 + 0.5 * np.sin((y * f + warp + x * rng.uniform(-2, 2)) * 2 * np.pi / 4)
        img = c1 * (0.75 + 0.35 * g[..., None])
        if rng.random() < 0.5:
            img = np.transpose(img, (1, 0, 2))
            img = cv2.resize(img, (w, h))
    elif kind == 3:  # nappe : rayures / carreaux
        p = int(rng.integers(8, 80))
        yy, xx = np.mgrid[0:h, 0:w]
        pat = ((xx // p) % 2) ^ ((yy // p) % 2) if rng.random() < 0.5 else (xx // p) % 2
        img = np.where(pat[..., None] > 0, c1, c2).astype(np.float32)
    elif kind == 4:  # tapis de jeu vert / feutrine
        c1 = np.array([rng.uniform(0, 0.2), rng.uniform(0.3, 0.6), rng.uniform(0.1, 0.35)], np.float32)
        img = np.ones((h, w, 3), np.float32) * c1
    else:  # dégradé
        t = np.linspace(0, 1, h if rng.random() < 0.5 else w, dtype=np.float32)
        t = t[:, None] if len(t) == h else t[None, :]
        img = (c1 * t[..., None] + c2 * (1 - t[..., None])) * np.ones((h, w, 1), np.float32)
    img = img + rng.normal(0, rng.uniform(0.005, 0.05), (h, w, 1)).astype(np.float32)
    # objets parasites
    for _ in range(int(rng.integers(0, 5))):
        col = tuple(float(v) for v in rng.random(3))
        cx, cy = int(rng.integers(0, w)), int(rng.integers(0, h))
        if rng.random() < 0.5:
            ax = (int(rng.integers(10, w // 4)), int(rng.integers(10, h // 4)))
            cv2.ellipse(img, (cx, cy), ax, float(rng.uniform(0, 180)), 0, 360, col, -1)
        else:
            cv2.line(img, (cx, cy), (int(rng.integers(0, w)), int(rng.integers(0, h))), col,
                     int(rng.integers(2, 20)))
    return np.clip(img, 0, 1)


# --------------------------------------------------------------------------
# Dispositions des cartes (coordonnées "layout" : 1 unité = hauteur d'une carte)
# --------------------------------------------------------------------------

def _place(cx, cy, angle_deg, w, h):
    """Affine 2x3 : pixels carte -> layout, carte de hauteur 1 centrée en (cx,cy)."""
    s = 1.0 / h
    a = math.radians(angle_deg)
    c, si = math.cos(a) * s, math.sin(a) * s
    # rotation autour du centre de la carte
    tx = cx - (c * w / 2 - si * h / 2)
    ty = cy - (si * w / 2 + c * h / 2)
    return np.array([[c, -si, tx], [si, c, ty]], np.float64)


def layout_arc(rng, n, aspect):
    R = rng.uniform(0.3, 1.0)
    dmin = math.degrees(rng.uniform(0.07, 0.2) / (R + 0.4))
    delta = min(rng.uniform(dmin, dmin * 2.2), 170 / max(1, n - 1))
    out = []
    for i in range(n):
        th = (i - (n - 1) / 2) * delta + rng.normal(0, 0.7)
        r = R + rng.normal(0, 0.015)
        t = math.radians(th)
        out.append((r * math.sin(t), -r * math.cos(t), th))
    return out


def layout_line(rng, n, aspect, origin=(0.0, 0.0)):
    step = rng.uniform(0.09, max(0.1, min(0.3, 4.0 / max(n, 1))))
    phi = rng.normal(0, 8)
    t = math.radians(phi)
    out = []
    for i in range(n):
        d = i * step + rng.normal(0, 0.01)
        perp = rng.normal(0, 0.015)
        out.append((origin[0] + d * math.cos(t) - perp * math.sin(t),
                    origin[1] + d * math.sin(t) + perp * math.cos(t),
                    phi + rng.normal(0, 2.0)))
    return out


def layout_rows(rng, n, aspect):
    k = int(rng.integers(2, 4)) if n >= 8 else 1
    sizes = np.array_split(np.arange(n), k)
    out = []
    gap = rng.uniform(0.55, 1.15)
    for j, idx in enumerate(sizes):
        out += layout_line(rng, len(idx), aspect, origin=(rng.normal(0, 0.1), j * gap))
    return out


def layout_pile(rng, n, aspect):
    spread = 0.5 + 0.25 * math.sqrt(n)
    return [(rng.uniform(0, spread), rng.uniform(0, spread * 0.7), rng.uniform(-180, 180)) for _ in range(n)]


def layout_multi_arc(rng, n, aspect):
    k = 2 if n >= 6 else 1
    out = []
    for j, idx in enumerate(np.array_split(np.arange(n), k)):
        for x, y, a in layout_arc(rng, len(idx), aspect):
            out.append((x + j * rng.uniform(1.0, 1.8), y + rng.normal(0, 0.2), a))
    return out


LAYOUTS = [(layout_arc, 0.3), (layout_line, 0.25), (layout_rows, 0.25), (layout_multi_arc, 0.1), (layout_pile, 0.1)]


# --------------------------------------------------------------------------
# Composition d'une scène
# --------------------------------------------------------------------------

def _apply_affine_pts(M, pts):
    pts = np.asarray(pts, np.float64)
    return pts @ M[:, :2].T + M[:, 2]


def _poly_area(p):
    x, y = p[:, 0], p[:, 1]
    return 0.5 * abs(np.dot(x, np.roll(y, 1)) - np.dot(y, np.roll(x, 1)))


def make_scene(rng, decks: list[Deck], W: int, H: int):
    weights = np.array([d.weight for d in decks])
    deck = decks[rng.choice(len(decks), p=weights / weights.sum())]
    ids = [c for c in CLASSES if c in deck.cards]
    n = int(rng.integers(3, min(32, len(ids)) + 1)) if rng.random() < 0.85 else int(rng.integers(1, 6))
    chosen = list(rng.choice(ids, n, replace=False))

    sample_img = deck.cards[chosen[0]][0]
    aspect = sample_img.shape[1] / sample_img.shape[0]
    fns, ps = zip(*LAYOUTS)
    layout = fns[rng.choice(len(fns), p=np.array(ps) / sum(ps))]
    poses = layout(rng, n, aspect)
    # Ordre de pose inversé (cartes visibles sur leur bord droit) : réaliste pour
    # un alignement sur la table (index bas-droit visible), rare pour un éventail.
    p_rev = 0.15 if layout in (layout_arc, layout_multi_arc) else 0.5
    if rng.random() < p_rev:
        poses = poses[::-1]

    mats = []
    for cid, (x, y, a) in zip(chosen, poses):
        img = deck.cards[cid][0]
        flip = 180 if rng.random() < 0.5 else 0  # plis ramassés dans tous les sens
        mats.append(_place(x, y, a + flip, img.shape[1], img.shape[0]))

    # rotation globale + mise à l'échelle dans l'image
    corners = []
    for cid, M in zip(chosen, mats):
        h, w = deck.cards[cid][0].shape[:2]
        corners.append(_apply_affine_pts(M, [[0, 0], [w, 0], [w, h], [0, h]]))
    corners = np.concatenate(corners)
    rot = rng.uniform(-25, 25) if rng.random() < 0.6 else rng.uniform(-180, 180)
    t = math.radians(rot)
    R = np.array([[math.cos(t), -math.sin(t)], [math.sin(t), math.cos(t)]])
    rc = corners @ R.T
    mn, mx = rc.min(0), rc.max(0)
    fill = rng.uniform(0.55, 0.95) if rng.random() < 0.9 else rng.uniform(0.95, 1.3)
    scale = fill * min(W / (mx[0] - mn[0]), H / (mx[1] - mn[1]))
    # une photo cadre les cartes : hauteur de carte >= ~17% du petit côté
    scale = max(scale, rng.uniform(0.19, 0.27) * min(W, H))
    size = (mx - mn) * scale
    off = np.array([rng.uniform(min(0, W - size[0]), max(0, W - size[0])),
                    rng.uniform(min(0, H - size[1]), max(0, H - size[1]))])
    G = np.zeros((2, 3))
    G[:, :2] = R * scale
    G[:, 2] = off - mn * scale
    full = [np.hstack([G[:, :2] @ M[:, :2], (G[:, :2] @ M[:, 2] + G[:, 2])[:, None]]) for M in mats]

    canvas = background(rng, H, W)
    region_map = np.full((H, W), -1, np.float32)
    hand = None
    if rng.random() < 0.45:
        pts = np.concatenate([_apply_affine_pts(M, [[0, 0], [deck.cards[c][0].shape[1], 0],
                                                    [deck.cards[c][0].shape[1], deck.cards[c][0].shape[0]],
                                                    [0, deck.cards[c][0].shape[0]]]) for c, M in zip(chosen, full)])
        hand = hand_params(rng, pts)
        draw_hand(hand, canvas, region_map, "palm")
    regions = []  # (classe, polygone dans le canvas)
    sh_dx, sh_dy = rng.normal(0, 4, 2)
    sh_blur = int(rng.integers(1, 6)) * 2 + 1
    sh_strength = rng.uniform(0.1, 0.45)

    for cid, M in zip(chosen, full):
        img, boxes = deck.cards[cid]
        h, w = img.shape[:2]
        quad = _apply_affine_pts(M, [[0, 0], [w, 0], [w, h], [0, h]])
        pad = sh_blur + int(abs(sh_dx) + abs(sh_dy)) + 2
        x0 = max(0, int(math.floor(quad[:, 0].min())) - pad)
        y0 = max(0, int(math.floor(quad[:, 1].min())) - pad)
        x1 = min(W, int(math.ceil(quad[:, 0].max())) + pad)
        y1 = min(H, int(math.ceil(quad[:, 1].max())) + pad)
        if x1 - x0 < 2 or y1 - y0 < 2:
            continue
        M2 = M.copy()
        M2[:, 2] -= (x0, y0)
        warped = cv2.warpAffine(img, M2, (x1 - x0, y1 - y0), flags=cv2.INTER_LINEAR,
                                borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0, 0))
        alpha = warped[..., 3:4].astype(np.float32) / 255
        rgb = warped[..., :3].astype(np.float32) / 255
        roi = canvas[y0:y1, x0:x1]
        # ombre portée
        Ms = M2.copy()
        Ms[:, 2] += (sh_dx, sh_dy)
        sh = cv2.warpAffine(img[..., 3], Ms, (x1 - x0, y1 - y0)).astype(np.float32) / 255
        sh = cv2.GaussianBlur(sh, (sh_blur, sh_blur), 0)[..., None]
        roi *= 1 - sh_strength * sh
        roi[:] = roi * (1 - alpha) + rgb * alpha
        # carte opaque => elle masque les index en dessous
        card_mask = alpha[..., 0] > 0.5
        rm = region_map[y0:y1, x0:x1]
        rm[card_mask] = -1
        for bx0, by0, bx1, by1 in boxes:
            poly = _apply_affine_pts(M, [[bx0 * w, by0 * h], [bx1 * w, by0 * h], [bx1 * w, by1 * h], [bx0 * w, by1 * h]])
            m = np.zeros(card_mask.shape, np.uint8)
            cv2.fillConvexPoly(m, np.round((poly - (x0, y0)) * 16).astype(np.int32), 1, shift=4)
            rid = len(regions)
            regions.append((CLASS_INDEX[cid], poly))
            rm[(m > 0) & card_mask] = rid

    if hand:
        draw_hand(hand, canvas, region_map, "thumb")

    # perspective (photo prise de biais)
    j = rng.uniform(0, 0.12)
    src = np.float32([[0, 0], [W, 0], [W, H], [0, H]])
    dst = (src + rng.uniform(-j, j, (4, 2)) * (W, H)).astype(np.float32)
    Hm = cv2.getPerspectiveTransform(src, dst)
    canvas = cv2.warpPerspective(canvas, Hm, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT101)
    region_map = cv2.warpPerspective(region_map, Hm, (W, H), flags=cv2.INTER_NEAREST,
                                     borderMode=cv2.BORDER_CONSTANT, borderValue=-1)

    labels = []
    for rid, (cls, poly) in enumerate(regions):
        p = cv2.perspectiveTransform(poly.reshape(-1, 1, 2).astype(np.float64), Hm).reshape(-1, 2)
        area = _poly_area(p)
        if area < 20:
            continue
        bx0 = max(0, int(p[:, 0].min()) - 1); by0 = max(0, int(p[:, 1].min()) - 1)
        bx1 = min(W, int(p[:, 0].max()) + 2); by1 = min(H, int(p[:, 1].max()) + 2)
        if bx1 <= bx0 or by1 <= by0:
            continue
        ys, xs = np.nonzero(region_map[by0:by1, bx0:bx1] == rid)
        if len(xs) < 25 or len(xs) / area < MIN_VISIBLE:
            continue
        x_min, x_max = xs.min() + bx0, xs.max() + bx0 + 1
        y_min, y_max = ys.min() + by0, ys.max() + by0 + 1
        if x_max - x_min < 4 or y_max - y_min < 4:
            continue
        labels.append((cls, (x_min + x_max) / 2 / W, (y_min + y_max) / 2 / H, (x_max - x_min) / W, (y_max - y_min) / H))

    canvas = photometric(rng, canvas)
    return (np.clip(canvas, 0, 1) * 255).astype(np.uint8), labels


def hand_params(rng, card_pts):
    mn, mx = card_pts.min(0), card_pts.max(0)
    size = float(max(mx - mn)) + 1
    skin = np.array([rng.uniform(0.75, 0.98), rng.uniform(0.55, 0.78), rng.uniform(0.45, 0.68)], np.float32)
    skin *= rng.uniform(0.5, 1.1)
    if rng.random() < 0.7:  # bas de l'éventail
        base = np.array([rng.uniform(mn[0], mx[0]), mx[1] - rng.uniform(0, 0.25) * (mx[1] - mn[1])])
    else:
        base = card_pts[rng.integers(0, len(card_pts))] + rng.normal(0, 0.05 * size, 2)
    return dict(
        skin=skin, base=base, size=size,
        palm_c=base + rng.normal(0, 0.05 * size, 2) + (0, rng.uniform(0.1, 0.3) * size),
        palm_ax=(int(rng.uniform(0.15, 0.3) * size), int(rng.uniform(0.2, 0.35) * size)),
        palm_ang=float(rng.uniform(-40, 40)),
        thumb_ang=math.radians(rng.uniform(-150, -30)),
        thumb_len=rng.uniform(0.15, 0.3) * size,
        thumb_w=rng.uniform(0.035, 0.06) * size,
        noise_seed=int(rng.integers(0, 2**31)),
    )


def draw_hand(hp, canvas, region_map, part):
    """Main qui tient les cartes : la paume (part='palm') est dessinée AVANT les cartes,
    le pouce (part='thumb') APRÈS, posé sur l'éventail."""
    H, W = canvas.shape[:2]
    m = np.zeros((H, W), np.float32)
    if part == "palm":
        c = hp["palm_c"]
        cv2.ellipse(m, (int(c[0]), int(c[1])), hp["palm_ax"], hp["palm_ang"], 0, 360, 1.0, -1)
        # avant-bras qui sort de l'image vers le bas
        cv2.line(m, (int(c[0]), int(c[1])), (int(c[0] + 0.2 * hp["size"]), H + 50), 1.0, int(hp["palm_ax"][0] * 1.4))
    else:
        b = hp["base"]
        tip = b + np.array([math.cos(hp["thumb_ang"]), math.sin(hp["thumb_ang"])]) * hp["thumb_len"]
        cv2.line(m, (int(b[0]), int(b[1])), (int(tip[0]), int(tip[1])), 1.0, max(2, int(2 * hp["thumb_w"])))
        cv2.circle(m, (int(tip[0]), int(tip[1])), max(1, int(hp["thumb_w"])), 1.0, -1)
    m = cv2.GaussianBlur(m, (5, 5), 0)
    shade = 0.75 + 0.35 * _smooth_noise(np.random.default_rng(hp["noise_seed"]), H, W, 3)
    canvas[:] = canvas * (1 - m[..., None]) + (hp["skin"] * shade[..., None]) * m[..., None]
    region_map[m > 0.5] = -1


def photometric(rng, img):
    H, W = img.shape[:2]
    # éclairage non uniforme
    light = _smooth_noise(rng, H, W, int(rng.integers(2, 5)))
    img = img * (rng.uniform(0.55, 0.9) + rng.uniform(0.1, 0.5) * light[..., None])
    # dominante de couleur (lumière chaude / froide)
    img = img * rng.uniform(0.85, 1.15, 3).astype(np.float32)
    # ombre d'une main / du téléphone
    if rng.random() < 0.3:
        m = np.zeros((H, W), np.float32)
        pts = rng.uniform(0, 1, (int(rng.integers(3, 7)), 2)) * (W, H)
        cv2.fillPoly(m, [cv2.convexHull(pts.astype(np.int32))], 1.0)
        k = int(rng.integers(10, 60)) * 2 + 1
        m = cv2.GaussianBlur(m, (k, k), 0)
        img = img * (1 - rng.uniform(0.2, 0.55) * m[..., None])
    # reflets (cartes plastifiées)
    if rng.random() < 0.35:
        for _ in range(int(rng.integers(1, 3))):
            m = np.zeros((H, W), np.float32)
            cx, cy = int(rng.integers(0, W)), int(rng.integers(0, H))
            ax = (int(rng.integers(10, W // 5)), int(rng.integers(5, H // 8)))
            cv2.ellipse(m, (cx, cy), ax, float(rng.uniform(0, 180)), 0, 360, 1.0, -1)
            m = cv2.GaussianBlur(m, (31, 31), 0)
            img = img + rng.uniform(0.2, 0.7) * m[..., None]
    # contraste / gamma
    img = np.clip(img, 0, 1) ** rng.uniform(0.75, 1.35)
    # flou de mise au point ou de bougé
    r = rng.random()
    if r < 0.35:
        s = rng.uniform(0.3, 1.6)
        img = cv2.GaussianBlur(img, (0, 0), s)
    elif r < 0.5:
        k = int(rng.integers(3, 9))
        kern = np.zeros((k, k), np.float32)
        kern[k // 2, :] = 1 / k
        rot = cv2.getRotationMatrix2D((k / 2 - 0.5, k / 2 - 0.5), float(rng.uniform(0, 180)), 1)
        kern = cv2.warpAffine(kern, rot, (k, k))
        kern /= kern.sum() + 1e-6
        img = cv2.filter2D(img, -1, kern)
    # bruit capteur
    img = img + rng.normal(0, rng.uniform(0, 0.035), img.shape).astype(np.float32)
    return img


# --------------------------------------------------------------------------
# Écriture du dataset
# --------------------------------------------------------------------------

_DECKS = None
DECK_CACHE = ROOT / "data" / "decks_cache.pkl"


def _deck_signature():
    """Change quand un jeu sur disque ou le code procédural change -> cache invalidé."""
    files = sorted(DECKS_DIR.rglob("*")) if DECKS_DIR.exists() else []
    sig = [(str(f.relative_to(ROOT)), f.stat().st_mtime_ns) for f in files if f.is_file()]
    sig.append(("procedural.py", (ROOT / "procedural.py").stat().st_mtime_ns))
    sig.append(("styles", N_PROC_STYLES, DECK_SEED))
    return sig


def load_decks_cached():
    sig = _deck_signature()
    # on stocke des tuples simples (pas la classe Deck) : le cache se relit quel que
    # soit le module qui l'a écrit (script lancé directement ou importé)
    if DECK_CACHE.exists():
        try:
            with open(DECK_CACHE, "rb") as f:
                cached_sig, raw = pickle.load(f)
            if cached_sig == sig:
                return [Deck(n, c, w) for n, c, w in raw]
        except Exception:
            pass  # cache d'une ancienne version : on le reconstruit
    decks = build_decks()
    DECK_CACHE.parent.mkdir(parents=True, exist_ok=True)
    with open(DECK_CACHE, "wb") as f:
        pickle.dump((sig, [(d.name, d.cards, d.weight) for d in decks]), f, protocol=pickle.HIGHEST_PROTOCOL)
    return decks


def _init_worker():
    global _DECKS
    cv2.setNumThreads(1)
    _DECKS = load_decks_cached()


SIZES = [(960, 720), (720, 960), (832, 832), (1024, 768), (768, 1024)]


def _job(args):
    split, i, out, seed, preview = args
    rng = np.random.default_rng([seed, i, 0 if split == "train" else 1])
    W, H = SIZES[rng.integers(0, len(SIZES))]
    img, labels = make_scene(rng, _DECKS, W, H)
    name = f"{split}_{i:06d}"
    q = int(rng.integers(35, 96))
    cv2.imwrite(str(out / "images" / split / f"{name}.jpg"), cv2.cvtColor(img, cv2.COLOR_RGB2BGR),
                [cv2.IMWRITE_JPEG_QUALITY, q])
    with open(out / "labels" / split / f"{name}.txt", "w") as f:
        for c, x, y, w, h in labels:
            f.write(f"{c} {x:.6f} {y:.6f} {w:.6f} {h:.6f}\n")
    if preview:
        vis = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
        for c, x, y, w, h in labels:
            p0 = (int((x - w / 2) * W), int((y - h / 2) * H))
            p1 = (int((x + w / 2) * W), int((y + h / 2) * H))
            cv2.rectangle(vis, p0, p1, (0, 255, 0), 1)
            cv2.putText(vis, CLASSES[c], (p0[0], p0[1] - 2), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 255, 255), 1)
        cv2.imwrite(str(out / "preview" / f"{name}.jpg"), vis)
    return len(labels)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "data" / "synth"))
    ap.add_argument("--train", type=int, default=6000)
    ap.add_argument("--val", type=int, default=600)
    ap.add_argument("--workers", type=int, default=os.cpu_count())
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--preview", action="store_true", help="écrit aussi les images annotées")
    a = ap.parse_args()
    out = Path(a.out)
    for s in ("train", "val"):
        (out / "images" / s).mkdir(parents=True, exist_ok=True)
        (out / "labels" / s).mkdir(parents=True, exist_ok=True)
    if a.preview:
        (out / "preview").mkdir(parents=True, exist_ok=True)
    (out / "data.yaml").write_text(
        f"path: {out.resolve()}\ntrain: images/train\nval: images/val\n"
        f"names:\n" + "".join(f"  {i}: '{c}'\n" for i, c in enumerate(CLASSES)))
    jobs = [("train", i, out, a.seed, a.preview) for i in range(a.train)]
    jobs += [("val", i, out, a.seed, a.preview) for i in range(a.val)]
    print("préparation des jeux de cartes…", flush=True)
    load_decks_cached()  # construit le cache une fois, partagé par les processus
    total = 0
    with Pool(a.workers, initializer=_init_worker) as pool:
        for k, n in enumerate(pool.imap_unordered(_job, jobs, chunksize=8)):
            total += n
            if (k + 1) % 200 == 0:
                print(f"{k + 1}/{len(jobs)} images, {total / (k + 1):.1f} index/image", flush=True)
    print(f"terminé : {len(jobs)} images dans {out}")


if __name__ == "__main__":
    main()
