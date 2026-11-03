"""Génération procédurale de jeux de cartes variés.

Chaque "style" tire au hasard : police, taille et position des index, libellés
(K/Q/J international ou R/D/V français, As en "A" ou "1"), teinte du papier,
bordure, index dans 2 ou 4 coins, contenu central (pips / figure factice).

Le but n'est pas d'imiter un jeu précis mais de forcer le détecteur à lire
l'index (valeur + couleur) dans le coin, quel que soit le style du jeu.
"""

from __future__ import annotations

import glob
import math
from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

from cards import CLASSES, RED_SUITS, split

SS = 2  # supersampling

LABELS = {
    "intl": {"J": "J", "Q": "Q", "K": "K", "A": "A"},
    "fr": {"J": "V", "Q": "D", "K": "R", "A": "A"},
    "fr1": {"J": "V", "Q": "D", "K": "R", "A": "1"},
}


def list_fonts() -> list[str]:
    fonts = []
    for pat in ("/usr/share/fonts/**/*.ttf", "/usr/share/fonts/**/*.otf"):
        fonts += glob.glob(pat, recursive=True)
    bad = ("Emoji", "Mono", "IPA", "Symbol", "Loma", "Thin", "ExtraLight", "Hairline", "Italic", "Oblique")
    fonts = [f for f in fonts if not any(b in f for b in bad)]
    return sorted(fonts)


# --------------------------------------------------------------------------
# Symboles de couleur dessinés en vectoriel (indépendant des polices)
# --------------------------------------------------------------------------

def _heart(d: ImageDraw.ImageDraw, cx, cy, s, fill, var):
    r = s * (0.27 + 0.03 * var)
    d.ellipse([cx - 2 * r + s * 0.02, cy - s * 0.32, cx + s * 0.02, cy - s * 0.32 + 2 * r], fill=fill)
    d.ellipse([cx - s * 0.02, cy - s * 0.32, cx + 2 * r - s * 0.02, cy - s * 0.32 + 2 * r], fill=fill)
    d.polygon([(cx - s * 0.5, cy - s * 0.05), (cx + s * 0.5, cy - s * 0.05), (cx, cy + s * (0.48 + 0.05 * var))], fill=fill)


def _diamond(d, cx, cy, s, fill, var):
    w = s * (0.36 + 0.08 * var)
    d.polygon([(cx, cy - s * 0.5), (cx + w, cy), (cx, cy + s * 0.5), (cx - w, cy)], fill=fill)


def _spade(d, cx, cy, s, fill, var):
    r = s * (0.25 + 0.03 * var)
    d.polygon([(cx, cy - s * 0.52), (cx + s * 0.5, cy + s * 0.08), (cx - s * 0.5, cy + s * 0.08)], fill=fill)
    d.ellipse([cx - 2 * r + s * 0.01, cy - s * 0.12, cx + s * 0.01, cy - s * 0.12 + 2 * r], fill=fill)
    d.ellipse([cx - s * 0.01, cy - s * 0.12, cx + 2 * r - s * 0.01, cy - s * 0.12 + 2 * r], fill=fill)
    d.polygon([(cx, cy + s * 0.1), (cx + s * 0.18, cy + s * 0.5), (cx - s * 0.18, cy + s * 0.5)], fill=fill)


def _club(d, cx, cy, s, fill, var):
    r = s * (0.21 + 0.03 * var)
    d.ellipse([cx - r, cy - s * 0.5, cx + r, cy - s * 0.5 + 2 * r], fill=fill)
    d.ellipse([cx - s * 0.48, cy - s * 0.12, cx - s * 0.48 + 2 * r, cy - s * 0.12 + 2 * r], fill=fill)
    d.ellipse([cx + s * 0.48 - 2 * r, cy - s * 0.12, cx + s * 0.48, cy - s * 0.12 + 2 * r], fill=fill)
    d.rectangle([cx - s * 0.06, cy - s * 0.15, cx + s * 0.06, cy + s * 0.2], fill=fill)
    d.polygon([(cx, cy + s * 0.05), (cx + s * 0.2, cy + s * 0.5), (cx - s * 0.2, cy + s * 0.5)], fill=fill)


SUIT_DRAW = {"H": _heart, "D": _diamond, "S": _spade, "C": _club}

# positions des pips (x, y) normalisées dans la zone centrale ; y > 0.5 => retourné
PIPS = {
    "7": [(0, 0), (1, 0), (0.5, 0.25), (0, 0.5), (1, 0.5), (0, 1), (1, 1)],
    "8": [(0, 0), (1, 0), (0.5, 0.25), (0, 0.5), (1, 0.5), (0.5, 0.75), (0, 1), (1, 1)],
    "9": [(0, 0), (1, 0), (0, 1 / 3), (1, 1 / 3), (0.5, 0.5), (0, 2 / 3), (1, 2 / 3), (0, 1), (1, 1)],
    "10": [(0, 0), (1, 0), (0.5, 1 / 6), (0, 1 / 3), (1, 1 / 3), (0, 2 / 3), (1, 2 / 3), (0.5, 5 / 6), (0, 1), (1, 1)],
    "A": [(0.5, 0.5)],
}


@dataclass
class Style:
    font: str
    font_scale: float  # hauteur du rang / hauteur carte
    suit_scale: float  # taille symbole index / hauteur carte
    margin_x: float
    margin_y: float
    labels: str
    paper: tuple
    red: tuple
    black: tuple
    border: int  # 0 aucun, 1 trait fin, 2 cadre intérieur
    four_corners: bool
    suit_beside: bool  # symbole à droite du rang plutôt qu'en dessous
    aspect: float
    radius: float
    var: float
    bold_stroke: int
    face_style: int


def random_style(rng: np.random.Generator, fonts: list[str]) -> Style:
    paper_v = int(rng.integers(225, 256))
    tint = rng.integers(-12, 6, size=3)
    paper = tuple(int(np.clip(paper_v + t, 200, 255)) for t in tint)
    red = (int(rng.integers(170, 235)), int(rng.integers(0, 50)), int(rng.integers(0, 60)))
    k = int(rng.integers(0, 45))
    black = (k, k, int(min(255, k + rng.integers(0, 30))))
    return Style(
        font=str(rng.choice(fonts)),
        font_scale=float(rng.uniform(0.08, 0.14)),
        suit_scale=float(rng.uniform(0.05, 0.09)),
        margin_x=float(rng.uniform(0.025, 0.06)),
        margin_y=float(rng.uniform(0.02, 0.05)),
        labels=str(rng.choice(["intl", "fr", "fr1"], p=[0.45, 0.4, 0.15])),
        paper=paper,
        red=red,
        black=black,
        border=int(rng.choice([0, 1, 2], p=[0.5, 0.3, 0.2])),
        four_corners=bool(rng.random() < 0.3),
        suit_beside=False,
        aspect=float(rng.uniform(1.38, 1.58)),
        radius=float(rng.uniform(0.03, 0.08)),
        var=float(rng.uniform(-1, 1)),
        bold_stroke=int(rng.choice([0, 0, 1, 2])),
        face_style=int(rng.integers(0, 3)),
    )


def _draw_index(img: Image.Image, d: ImageDraw.ImageDraw, label, suit, color, st: Style, W, H):
    """Dessine l'index en haut à gauche, renvoie sa boîte (pixels)."""
    fs = int(st.font_scale * H)
    font = ImageFont.truetype(st.font, fs)
    x0, y0 = st.margin_x * W, st.margin_y * H
    bb = d.textbbox((0, 0), label, font=font, stroke_width=st.bold_stroke * SS)
    tw, th = bb[2] - bb[0], bb[3] - bb[1]
    # "10" étroit : on le compresse si trop large
    max_w = 0.17 * W
    if tw > max_w:
        tmp = Image.new("L", (tw + 4, th + 4), 0)
        ImageDraw.Draw(tmp).text((-bb[0] + 2, -bb[1] + 2), label, font=font, fill=255,
                                 stroke_width=st.bold_stroke * SS, stroke_fill=255)
        tmp = tmp.resize((int(max_w), th + 4), Image.LANCZOS)
        img.paste(Image.new("RGB", tmp.size, color), (int(x0), int(y0)), tmp)
        tw = int(max_w)
    else:
        d.text((x0 - bb[0], y0 - bb[1]), label, font=font, fill=color,
               stroke_width=st.bold_stroke * SS, stroke_fill=color)
    ss = st.suit_scale * H
    if st.suit_beside:
        cx, cy = x0 + tw + ss * 0.65, y0 + th * 0.5
    else:
        cx, cy = x0 + tw / 2, y0 + th + ss * 0.75
    SUIT_DRAW[suit](d, cx, cy, ss, color, st.var)
    bx0 = min(x0, cx - ss / 2)
    by0 = y0
    bx1 = max(x0 + tw, cx + ss / 2)
    by1 = max(y0 + th, cy + ss / 2)
    return [bx0, by0, bx1, by1]


def _draw_center(img, d, rank, suit, color, st: Style, W, H, rng, face_art):
    inner = [0.33 * W, 0.1 * H, 0.67 * W, 0.9 * H]
    if rank in PIPS:
        s = (0.13 if rank != "A" else rng.uniform(0.2, 0.4)) * W
        s = min(s, 0.12 * H) if rank != "A" else s
        for px, py in PIPS[rank]:
            cx = inner[0] + px * (inner[2] - inner[0])
            cy = inner[1] + s * 0.5 + py * (inner[3] - inner[1] - s)
            if py > 0.5:
                tmp = Image.new("RGBA", (int(s * 1.2), int(s * 1.2)), (0, 0, 0, 0))
                SUIT_DRAW[suit](ImageDraw.Draw(tmp), s * 0.6, s * 0.6, s, color, st.var)
                tmp = tmp.rotate(180)
                img.paste(tmp, (int(cx - s * 0.6), int(cy - s * 0.6)), tmp)
            else:
                SUIT_DRAW[suit](d, cx, cy, s, color, st.var)
        return
    # figure : cadre + art (crop d'une vraie figure si dispo, sinon formes aléatoires)
    fr = [0.26 * W, 0.06 * H, 0.74 * W, 0.94 * H]
    if face_art is not None and st.face_style != 0:
        art = face_art.resize((int(fr[2] - fr[0]), int(fr[3] - fr[1])), Image.BILINEAR)
        img.paste(art.convert("RGB"), (int(fr[0]), int(fr[1])), art.split()[-1] if art.mode == "RGBA" else None)
    else:
        for _ in range(int(rng.integers(6, 16))):
            c = tuple(int(v) for v in rng.integers(0, 255, 3))
            x0 = rng.uniform(fr[0], fr[2]); y0 = rng.uniform(fr[1], fr[3])
            x1 = x0 + rng.uniform(10, 0.4 * W); y1 = y0 + rng.uniform(10, 0.3 * H)
            x1 = min(x1, fr[2]); y1 = min(y1, fr[3])
            if x1 <= x0 or y1 <= y0:
                continue
            if rng.random() < 0.5:
                d.ellipse([x0, y0, x1, y1], fill=c)
            else:
                d.rectangle([x0, y0, x1, y1], fill=c)
    d.rectangle(fr, outline=color, width=2 * SS)


def render_card(card_id: str, st: Style, rng: np.random.Generator, height=520, face_art=None):
    """Renvoie (image RGBA, [boîtes d'index normalisées x0,y0,x1,y1])."""
    rank, suit = split(card_id)
    H = height * SS
    W = int(H / st.aspect)
    img = Image.new("RGB", (W, H), st.paper)
    d = ImageDraw.Draw(img)
    color = st.red if suit in RED_SUITS else st.black
    label = LABELS[st.labels].get(rank, rank)

    _draw_center(img, d, rank, suit, color, st, W, H, rng, face_art)
    if st.border == 1:
        m = int(0.015 * W)
        d.rounded_rectangle([m, m, W - m, H - m], radius=st.radius * W, outline=(60, 60, 60), width=SS)
    elif st.border == 2:
        m = int(0.18 * W)
        d.rectangle([m, int(0.06 * H), W - m, int(0.94 * H)], outline=color, width=SS)

    # index haut-gauche, puis copie tournée de 180° (bas-droite), éventuellement les 4 coins
    patch_box = _draw_index(img, d, label, suit, color, st, W, H)
    pad = 0.008 * W
    bx0, by0, bx1, by1 = patch_box[0] - pad, patch_box[1] - pad, patch_box[2] + pad, patch_box[3] + pad
    crop = img.crop((int(bx0), int(by0), int(math.ceil(bx1)), int(math.ceil(by1))))
    boxes = [(bx0, by0, bx1, by1)]
    rot = crop.rotate(180)
    img.paste(rot, (int(W - math.ceil(bx1)), int(H - math.ceil(by1))))
    boxes.append((W - bx1, H - by1, W - bx0, H - by0))
    if st.four_corners:
        img.paste(crop, (int(W - math.ceil(bx1)), int(by0)))
        boxes.append((W - bx1, by0, W - bx1 + (bx1 - bx0), by1))
        img.paste(rot, (int(bx0), int(H - math.ceil(by1))))
        boxes.append((bx0, H - by1, bx1, H - by0))

    # coins arrondis
    alpha = Image.new("L", (W, H), 0)
    ImageDraw.Draw(alpha).rounded_rectangle([0, 0, W - 1, H - 1], radius=st.radius * W, fill=255)
    if st.border == 0 and rng.random() < 0.5:
        ImageDraw.Draw(img).rounded_rectangle([0, 0, W - 1, H - 1], radius=st.radius * W,
                                              outline=(150, 150, 150), width=SS)
    img = img.convert("RGBA")
    img.putalpha(alpha)
    img = img.resize((W // SS, H // SS), Image.LANCZOS)
    if rng.random() < 0.3:
        img = img.filter(ImageFilter.GaussianBlur(0.6))
    norm = [(x0 / W, y0 / H, x1 / W, y1 / H) for x0, y0, x1, y1 in boxes]
    return img, norm


def render_deck(st: Style, rng, face_arts=None, height=520):
    deck = {}
    for cid in CLASSES:
        art = None
        if face_arts:
            art = face_arts[int(rng.integers(0, len(face_arts)))]
        deck[cid] = render_card(cid, st, rng, height=height, face_art=art)
    return deck
