"""Classes du détecteur : les 32 cartes d'un jeu de belote / manille.

L'ordre DOIT rester identique à ALL_CARDS dans app/src/cards.js.
"""

RANKS = ["7", "8", "9", "10", "J", "Q", "K", "A"]
SUITS = ["S", "H", "D", "C"]  # pique, coeur, carreau, trèfle
RED_SUITS = {"H", "D"}

CLASSES = [r + s for s in SUITS for r in RANKS]
CLASS_INDEX = {c: i for i, c in enumerate(CLASSES)}


def split(card_id: str) -> tuple[str, str]:
    return card_id[:-1], card_id[-1]
