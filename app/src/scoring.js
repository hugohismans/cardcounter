// Calcul des points d'une donne à la belote et à la manille.
//
// Principe : on photographie les plis d'UNE équipe ("nous"), l'autre équipe
// ("eux") est déduite par soustraction du total de la donne.

import { parseCard } from './cards.js';

// ---------------------------------------------------------------------------
// Belote
// ---------------------------------------------------------------------------

export const BELOTE_TRUMP_VALUES = { J: 20, '9': 14, A: 11, '10': 10, K: 4, Q: 3, '8': 0, '7': 0 };
export const BELOTE_PLAIN_VALUES = { A: 11, '10': 10, K: 4, Q: 3, J: 2, '9': 0, '8': 0, '7': 0 };
export const BELOTE_CARD_TOTAL = 152;
export const DIX_DE_DER = 10;
export const BELOTE_HAND_TOTAL = BELOTE_CARD_TOTAL + DIX_DE_DER; // 162
export const CAPOT_POINTS = 250;
export const BELOTE_REBELOTE = 20;

// Annonces faites pendant la main (hors belote-rebelote, gérée à part).
export const ANNOUNCEMENTS = {
  tierce: { label: 'Tierce', points: 20 },
  cinquante: { label: 'Cinquante (quarte)', points: 50 },
  cent: { label: 'Cent (quinte)', points: 100 },
  carre_J: { label: 'Carré de valets', points: 200 },
  carre_9: { label: 'Carré de 9', points: 150 },
  carre_A: { label: "Carré d'as", points: 100 },
  carre_10: { label: 'Carré de 10', points: 100 },
  carre_K: { label: 'Carré de rois', points: 100 },
  carre_Q: { label: 'Carré de dames', points: 100 },
};

export function beloteCardValue(id, trump) {
  const { rank, suit } = parseCard(id);
  return suit === trump ? BELOTE_TRUMP_VALUES[rank] : BELOTE_PLAIN_VALUES[rank];
}

/** Arrondi à la dizaine puis division par 10 (62 -> 6, 166 -> 17). */
export function toGamePoints(points, rounding = 'half-up') {
  const q = points / 10;
  const floor = Math.floor(q);
  const frac = q - floor;
  if (Math.abs(frac - 0.5) < 1e-9) return rounding === 'half-down' ? floor : floor + 1;
  return Math.round(q);
}

const other = (team) => (team === 'us' ? 'them' : 'us');

function sumAnnouncements(list = []) {
  return list.reduce((acc, type) => {
    const a = ANNOUNCEMENTS[type];
    if (!a) throw new Error(`Annonce inconnue: ${type}`);
    return acc + a.points;
  }, 0);
}

/** Contrôles communs aux deux jeux sur les cartes détectées. */
export function checkCards(cards) {
  const warnings = [];
  const seen = new Set();
  for (const c of cards) {
    if (seen.has(c)) warnings.push({ code: 'duplicate', card: c, message: `Carte en double : ${c}` });
    seen.add(c);
  }
  if (cards.length % 4 !== 0) {
    warnings.push({
      code: 'count',
      message: `${cards.length} cartes : ce n'est pas un multiple de 4 (un pli = 4 cartes), il manque ou il y a une carte en trop.`,
    });
  }
  return warnings;
}

/**
 * Score d'une donne de belote.
 *
 * @param {object} p
 * @param {string} p.trump            couleur d'atout : 'S' | 'H' | 'D' | 'C'
 * @param {string[]} p.cards          cartes des plis de l'équipe photographiée ("us")
 * @param {'us'|'them'} p.lastTrick   équipe qui a fait le dernier pli (10 de der)
 * @param {{us?: string[], them?: string[]}} [p.announcements] annonces (clés de ANNOUNCEMENTS)
 * @param {'us'|'them'|null} [p.belote]  équipe qui a annoncé belote-rebelote
 * @param {'us'|'them'|null} [p.taker]   équipe qui a pris (pour gérer la chute / le litige)
 * @param {'half-up'|'half-down'} [p.rounding]
 */
export function scoreBelote({
  trump,
  cards,
  lastTrick,
  announcements = {},
  belote = null,
  taker = null,
  rounding = 'half-up',
}) {
  const warnings = checkCards(cards);
  const unique = [...new Set(cards)];

  const detail = unique.map((id) => ({ id, points: beloteCardValue(id, trump) }));
  const usCards = detail.reduce((a, c) => a + c.points, 0);

  let capot = null;
  if (unique.length === 32) capot = 'us';
  else if (unique.length === 0) capot = 'them';

  if (!capot && lastTrick !== 'us' && lastTrick !== 'them') {
    warnings.push({ code: 'der', message: 'Indiquer quelle équipe a fait le dernier pli (10 de der).' });
  }

  // Points de cartes + 10 de der, ou 250 pour un capot.
  const base = { us: 0, them: 0 };
  if (capot) {
    base[capot] = CAPOT_POINTS;
  } else {
    base.us = usCards + (lastTrick === 'us' ? DIX_DE_DER : 0);
    base.them = BELOTE_CARD_TOTAL - usCards + (lastTrick === 'them' ? DIX_DE_DER : 0);
  }

  const ann = {
    us: sumAnnouncements(announcements.us),
    them: sumAnnouncements(announcements.them),
  };
  if (ann.us > 0 && ann.them > 0) {
    warnings.push({
      code: 'announcements',
      message: "Les deux équipes ont des annonces : normalement seule l'équipe qui a la meilleure annonce les marque.",
    });
  }
  const bel = { us: belote === 'us' ? BELOTE_REBELOTE : 0, them: belote === 'them' ? BELOTE_REBELOTE : 0 };

  const raw = {
    us: base.us + ann.us + bel.us,
    them: base.them + ann.them + bel.them,
  };

  // Contrat : le preneur doit faire plus que la défense, sinon il est "dedans".
  let outcome = 'made';
  let final = { ...raw };
  if (taker) {
    const def = other(taker);
    if (raw[taker] < raw[def]) {
      outcome = 'dedans';
      final = { us: 0, them: 0 };
      // La défense prend les points de la donne et toutes les annonces ;
      // la belote reste à l'équipe qui l'a annoncée.
      final[def] = (capot ? CAPOT_POINTS : BELOTE_HAND_TOTAL) + ann.us + ann.them + bel[def];
      final[taker] = bel[taker];
    } else if (raw[taker] === raw[def]) {
      // Litige : la défense marque ses points, ceux du preneur sont mis en
      // réserve et iront à l'équipe qui gagne la donne suivante.
      outcome = 'litige';
      final = { us: 0, them: 0 };
      final[def] = raw[def];
    }
  }

  return {
    game: 'belote',
    trump,
    cards: detail,
    cardCount: unique.length,
    cardPoints: { us: usCards, them: BELOTE_CARD_TOTAL - usCards },
    capot,
    lastTrick,
    announcements: ann,
    belote: bel,
    raw,
    outcome,
    final,
    score: { us: toGamePoints(final.us, rounding), them: toGamePoints(final.them, rounding) },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Manille
// ---------------------------------------------------------------------------

export const MANILLE_VALUES = { '10': 5, A: 4, K: 3, Q: 2, J: 1, '9': 0, '8': 0, '7': 0 };
export const MANILLE_TOTAL = 60;
export const MANILLE_HALF = 30;

/**
 * Score d'une donne de manille : chaque équipe marque ce qu'elle a au-delà de 30.
 *
 * @param {object} p
 * @param {string[]} p.cards      cartes des plis de l'équipe photographiée ("us")
 * @param {string|null} [p.trump] atout (sans effet sur la valeur des cartes, gardé pour le récap)
 * @param {number} [p.multiplier] multiplicateur (sans atout, contré, ...)
 */
export function scoreManille({ cards, trump = null, multiplier = 1 }) {
  const warnings = checkCards(cards);
  const unique = [...new Set(cards)];
  const detail = unique.map((id) => ({ id, points: MANILLE_VALUES[parseCard(id).rank] }));
  const us = detail.reduce((a, c) => a + c.points, 0);
  const raw = { us, them: MANILLE_TOTAL - us };
  const score = {
    us: Math.max(0, raw.us - MANILLE_HALF) * multiplier,
    them: Math.max(0, raw.them - MANILLE_HALF) * multiplier,
  };
  return { game: 'manille', trump, cards: detail, cardCount: unique.length, raw, multiplier, score, warnings };
}
