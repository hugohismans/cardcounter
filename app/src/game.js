// Gestion d'une partie : suite de donnes, score cumulé, litiges, fin de partie.
// Fonctions pures : l'état est un objet JSON simple (sauvegardé tel quel).

export const GAME_TYPES = {
  belote: { label: 'Belote', target: 100 }, // 1000 points, compté /10
  manille: { label: 'Manille', target: 101 },
};

export function newGame({ type = 'belote', teams = {}, target } = {}) {
  return {
    id: Date.now().toString(36),
    type,
    teams: { us: teams.us?.trim() || 'Nous', them: teams.them?.trim() || 'Eux' },
    target: Number(target) > 0 ? Number(target) : GAME_TYPES[type].target,
    hands: [],
    createdAt: new Date().toISOString(),
  };
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
    rows.push({ index, hand, bonus, total: { ...totals } });
    if (winner === null && (totals.us >= game.target || totals.them >= game.target) && totals.us !== totals.them) {
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
