// Définition du jeu de 32 cartes (belote / manille).
// Une carte est identifiée par une chaîne "<rang><couleur>", ex: "10H", "JS", "AC".
// Ces identifiants sont aussi les noms de classes du détecteur (voir detector/cards.py).

export const RANKS = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
export const SUITS = ['S', 'H', 'D', 'C']; // pique, coeur, carreau, trèfle

export const SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };
export const SUIT_NAME = { S: 'Pique', H: 'Cœur', D: 'Carreau', C: 'Trèfle' };
export const RANK_NAME = {
  '7': '7', '8': '8', '9': '9', '10': '10', J: 'Valet', Q: 'Dame', K: 'Roi', A: 'As',
};
export const RANK_SHORT = { '7': '7', '8': '8', '9': '9', '10': '10', J: 'V', Q: 'D', K: 'R', A: 'A' };

// Ordre des classes = ordre utilisé à l'entraînement du détecteur. Ne pas modifier
// sans régénérer le modèle.
export const ALL_CARDS = SUITS.flatMap((s) => RANKS.map((r) => r + s));

export function parseCard(id) {
  const suit = id.slice(-1);
  const rank = id.slice(0, -1);
  if (!RANKS.includes(rank) || !SUITS.includes(suit)) {
    throw new Error(`Carte inconnue: ${id}`);
  }
  return { rank, suit };
}

export function cardLabel(id) {
  const { rank, suit } = parseCard(id);
  return `${RANK_SHORT[rank]}${SUIT_SYMBOL[suit]}`;
}
