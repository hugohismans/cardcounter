// Gestion d'une partie : suite de donnes, score cumulé, litiges, fin de partie.
// Fonctions pures : l'état est un objet JSON simple (sauvegardé tel quel).

export const GAME_TYPES = {
  // belote : partie en points (1000, compté /10)
  belote: { label: 'Belote', target: 100 },
  // manille : partie en un nombre fixe de donnes ("cartés"), avec des roulés
  // (sans atout, comptés double) obligatoires pour chaque équipe
  manille: { label: 'Manille', deals: 12, roules: 2 },
};

const other = (k) => (k === 'us' ? 'them' : 'us');
const posInt = (v, d) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : d);

export function newGame({ type = 'belote', teams = {}, target, deals, roules, firstDealer = 'us' } = {}) {
  const g = {
    id: Date.now().toString(36),
    type,
    teams: { us: teams.us?.trim() || 'Nous', them: teams.them?.trim() || 'Eux' },
    hands: [],
    createdAt: new Date().toISOString(),
  };
  if (type === 'manille') {
    g.deals = posInt(deals, GAME_TYPES.manille.deals);
    g.roules = Math.min(Math.floor(g.deals / 2), Math.max(0, Number(roules ?? GAME_TYPES.manille.roules) || 0));
    g.firstDealer = firstDealer === 'them' ? 'them' : 'us';
  } else {
    g.target = posInt(target, GAME_TYPES.belote.target);
  }
  return g;
}

/** Partie jouée en un nombre fixe de donnes (manille) plutôt qu'en points. */
export const isDealGame = (game) => game.type === 'manille' && game.deals > 0;

/** Équipe qui distribue (et choisit l'atout) à la donne `index` : alterne à chaque donne. */
export function dealerOf(game, index) {
  const first = game.firstDealer ?? 'us';
  return index % 2 === 0 ? first : other(first);
}

/**
 * Suivi des roulés obligatoires.
 * Renvoie, pour chaque équipe, les roulés faits / restant à faire et les donnes
 * qu'il lui reste à distribuer ; et pour la donne suivante, qui distribue et si
 * le roulé est imposé (plus assez de donnes pour faire les roulés manquants).
 */
export function rouleStatus(game) {
  const done = { us: 0, them: 0 };
  const dealt = { us: 0, them: 0 };
  game.hands.forEach((h, i) => {
    const d = dealerOf(game, i);
    dealt[d] += 1;
    if (h.roule) done[d] += 1;
  });
  const perTeam = { us: 0, them: 0 };
  for (let i = 0; i < game.deals; i++) perTeam[dealerOf(game, i)] += 1;
  const teams = {};
  for (const k of ['us', 'them']) {
    const missing = Math.max(0, game.roules - done[k]);
    const dealsLeft = Math.max(0, perTeam[k] - dealt[k]);
    teams[k] = { done: done[k], missing, dealsLeft };
  }
  const next = game.hands.length;
  const nextDealer = next < game.deals ? dealerOf(game, next) : null;
  const forced = !!nextDealer && teams[nextDealer].missing > 0 && teams[nextDealer].missing >= teams[nextDealer].dealsLeft;
  return { teams, nextDealer, forced, next };
}

/**
 * Transforme le résultat d'un calcul de donne (scoreBelote / scoreManille) en
 * donne enregistrée dans la partie.
 */
export function handFromResult(result, extra = {}) {
  return {
    score: { us: result.score.us, them: result.score.them },
    outcome: result.outcome ?? 'made',
    reserved: result.reserved ?? 0,
    taker: result.taker ?? null,
    mode: result.mode,
    trump: result.trump ?? null,
    capot: result.capot ?? null,
    raw: result.final ?? result.raw,
    at: new Date().toISOString(),
    ...extra,
  };
}

/**
 * Rejoue toutes les donnes : totaux, réserve de litige, vainqueur.
 * Litige : les points du preneur sont mis en réserve et vont à l'équipe qui
 * gagne (marque le plus) la donne suivante. Plusieurs litiges s'accumulent.
 */
export function computeGame(game) {
  let reserve = 0;
  const totals = { us: 0, them: 0 };
  const rows = [];
  let winner = null;
  let finishedAt = null;
  game.hands.forEach((hand, index) => {
    const bonus = { us: 0, them: 0 };
    if (hand.outcome === 'litige') {
      reserve += hand.reserved || 0;
    } else if (reserve > 0 && hand.score.us !== hand.score.them) {
      bonus[hand.score.us > hand.score.them ? 'us' : 'them'] = reserve;
      reserve = 0;
    }
    totals.us += hand.score.us + bonus.us;
    totals.them += hand.score.them + bonus.them;
    rows.push({ index, hand, bonus, total: { ...totals }, dealer: isDealGame(game) ? dealerOf(game, index) : null });
    if (isDealGame(game)) {
      if (index === game.deals - 1) {
        winner = totals.us === totals.them ? 'tie' : totals.us > totals.them ? 'us' : 'them';
        finishedAt = index;
      }
    } else if (winner === null && (totals.us >= game.target || totals.them >= game.target) && totals.us !== totals.them) {
      winner = totals.us > totals.them ? 'us' : 'them';
      finishedAt = index;
    }
  });
  return { rows, totals, reserve, winner, finishedAt };
}

export function addHand(game, hand) {
  return { ...game, hands: [...game.hands, hand] };
}

export function removeHand(game, index) {
  return { ...game, hands: game.hands.filter((_, i) => i !== index) };
}

export function editHandScore(game, index, score) {
  const hands = game.hands.map((h, i) => (i === index
    ? { ...h, score: { us: Number(score.us) || 0, them: Number(score.them) || 0 }, edited: true,
        outcome: h.outcome === 'litige' ? 'made' : h.outcome, reserved: 0 }
    : h));
  return { ...game, hands };
}
