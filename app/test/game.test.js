import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newGame, addHand, computeGame, handFromResult, removeHand, editHandScore, dealerOf, rouleStatus,
} from '../src/game.js';
import { scoreBelote, scoreManille } from '../src/scoring.js';

const H = (us, them, extra = {}) => ({ score: { us, them }, outcome: 'made', reserved: 0, ...extra });

test('nouvelle partie : valeurs par défaut', () => {
  const g = newGame({ type: 'belote', teams: { us: '  Hugo & Max ', them: '' } });
  assert.equal(g.target, 100);
  assert.deepEqual(g.teams, { us: 'Hugo & Max', them: 'Eux' });
  assert.equal(newGame({ type: 'manille' }).deals, 12);
  assert.equal(newGame({ type: 'belote', target: 50 }).target, 50);
});

test('score cumulé et vainqueur', () => {
  let g = newGame({ target: 30 });
  g = addHand(g, H(6, 10));
  g = addHand(g, H(16, 0));
  let r = computeGame(g);
  assert.deepEqual(r.totals, { us: 22, them: 10 });
  assert.equal(r.winner, null);
  g = addHand(g, H(9, 7));
  r = computeGame(g);
  assert.deepEqual(r.totals, { us: 31, them: 17 });
  assert.equal(r.winner, 'us');
  assert.equal(r.finishedAt, 2);
});

test('égalité au-delà de l’objectif : on continue', () => {
  const g = addHand(addHand(newGame({ target: 10 }), H(8, 8)), H(4, 4));
  assert.equal(computeGame(g).winner, null);
});

test('litige : la réserve va au gagnant de la donne suivante', () => {
  // atout pique, 81 / 81, eux preneurs -> litige, 8 points en réserve
  const cards = ['AH', '10H', 'AD', '10D', 'AC', '10C', 'KH', 'KD', 'KC', 'QH', 'QD', '7H'];
  const lit = scoreBelote({ trump: 'S', cards, lastTrick: 'them', taker: 'them' });
  assert.equal(lit.outcome, 'litige');
  assert.equal(lit.reserved, 8);
  let g = addHand(newGame(), handFromResult(lit));
  let r = computeGame(g);
  assert.deepEqual(r.totals, { us: 8, them: 0 });
  assert.equal(r.reserve, 8);
  g = addHand(g, H(4, 12));
  r = computeGame(g);
  assert.deepEqual(r.rows[1].bonus, { us: 0, them: 8 });
  assert.deepEqual(r.totals, { us: 12, them: 20 });
  assert.equal(r.reserve, 0);
});

test('capot direct et points manuels', () => {
  const c = scoreBelote({ capot: 'them', belote: 'them', announcements: { them: ['tierce'] } });
  assert.equal(c.mode, 'capot');
  assert.deepEqual(c.final, { us: 0, them: 290 });
  assert.deepEqual(c.score, { us: 0, them: 29 });

  const m = scoreBelote({ manualPoints: 62, belote: 'us' });
  assert.equal(m.mode, 'manual');
  assert.deepEqual(m.raw, { us: 82, them: 100 });
  assert.deepEqual(m.score, { us: 8, them: 10 });

  const bad = scoreBelote({ manualPoints: 170 });
  assert.equal(bad.warnings[0].code, 'manual');

  const d = scoreBelote({ manualPoints: 70, taker: 'us' }); // 70 < 92 -> dedans
  assert.equal(d.outcome, 'dedans');
  assert.deepEqual(d.score, { us: 0, them: 16 });

  const mm = scoreManille({ manualPoints: 38, multiplier: 2 });
  assert.deepEqual(mm.score, { us: 16, them: 0 });
});

test('modifier / supprimer une donne', () => {
  let g = addHand(addHand(newGame(), H(6, 10)), H(16, 0));
  g = editHandScore(g, 0, { us: '7', them: '9' });
  assert.deepEqual(computeGame(g).totals, { us: 23, them: 9 });
  g = removeHand(g, 1);
  assert.deepEqual(computeGame(g).totals, { us: 7, them: 9 });
});

test('manille : 12 donnes, le donneur alterne, fin après la 12e', () => {
  let g = newGame({ type: 'manille', firstDealer: 'them' });
  assert.equal(g.deals, 12);
  assert.equal(g.roules, 2);
  assert.equal(g.target, undefined);
  assert.equal(dealerOf(g, 0), 'them');
  assert.equal(dealerOf(g, 1), 'us');
  for (let i = 0; i < 11; i++) g = addHand(g, H(i % 2 ? 5 : 0, i % 2 ? 0 : 3));
  assert.equal(computeGame(g).winner, null);
  g = addHand(g, H(0, 0));
  const r = computeGame(g);
  assert.equal(r.finishedAt, 11);
  assert.equal(r.winner, 'us'); // 6×0 + 5×5 = 25 contre 6×3 = 18
});

test('manille : roulés obligatoires, imposés quand il ne reste plus assez de donnes', () => {
  let g = newGame({ type: 'manille' }); // nous distribuons aux donnes 1, 3, 5, 7, 9, 11
  let s = rouleStatus(g);
  assert.equal(s.nextDealer, 'us');
  assert.equal(s.forced, false);
  assert.deepEqual(s.teams.us, { done: 0, missing: 2, dealsLeft: 6 });
  // 8 donnes sans aucun roulé : il nous reste 2 donnes pour 2 roulés -> imposé
  for (let i = 0; i < 8; i++) g = addHand(g, H(1, 1));
  s = rouleStatus(g);
  assert.equal(s.nextDealer, 'us');
  assert.deepEqual(s.teams.us, { done: 0, missing: 2, dealsLeft: 2 });
  assert.equal(s.forced, true);
  // un roulé fait par nous, puis une donne d'eux : il reste 1 donne pour 1 roulé -> toujours imposé
  g = addHand(g, H(2, 0, { roule: true }));
  g = addHand(g, H(1, 1));
  s = rouleStatus(g);
  assert.deepEqual(s.teams.us, { done: 1, missing: 1, dealsLeft: 1 });
  assert.equal(s.forced, true);
  // eux n'ont fait aucun roulé : leur dernière donne ne suffit plus (manque 2, reste 1)
  assert.deepEqual(s.teams.them, { done: 0, missing: 2, dealsLeft: 1 });
});

test('manille : un roulé compte double', () => {
  const r = scoreManille({ manualPoints: 38, multiplier: 2 });
  assert.deepEqual(r.score, { us: 16, them: 0 });
});

test('manille : buké double encore (roulé buké = ×4)', () => {
  assert.deepEqual(scoreManille({ manualPoints: 38, multiplier: 2 }).score, { us: 16, them: 0 }); // buké seul
  assert.deepEqual(scoreManille({ manualPoints: 38, multiplier: 4 }).score, { us: 32, them: 0 }); // roulé + buké
  assert.deepEqual(scoreManille({ manualPoints: 20, multiplier: 4 }).score, { us: 0, them: 40 });
});
