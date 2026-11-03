import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_CARDS } from '../src/cards.js';
import { scoreBelote, scoreManille, toGamePoints, beloteCardValue } from '../src/scoring.js';

const sum = (cards, trump) => cards.reduce((a, c) => a + beloteCardValue(c, trump), 0);

test('le jeu complet vaut 152 à la belote, quel que soit l’atout', () => {
  for (const t of ['S', 'H', 'D', 'C']) assert.equal(sum(ALL_CARDS, t), 152);
});

test('arrondi : 62 -> 6, 100 -> 10, 65 -> 7 (ou 6 en half-down)', () => {
  assert.equal(toGamePoints(62), 6);
  assert.equal(toGamePoints(100), 10);
  assert.equal(toGamePoints(65), 7);
  assert.equal(toGamePoints(65, 'half-down'), 6);
  assert.equal(toGamePoints(166), 17);
});

test('donne simple : valeurs atout / hors atout et 10 de der', () => {
  // Atout coeur : V♥ 20 + 9♥ 14 + A♠ 11 + 10♣ 10 = 55, 8 cartes = 2 plis
  const cards = ['JH', '9H', 'AS', '10C', '7S', '8D', 'QD', 'KC'];
  const r = scoreBelote({ trump: 'H', cards, lastTrick: 'us' });
  assert.equal(r.cardPoints.us, 20 + 14 + 11 + 10 + 0 + 0 + 3 + 4);
  assert.equal(r.raw.us, 62 + 10);
  assert.equal(r.raw.them, 152 - 62);
  assert.equal(r.raw.us + r.raw.them, 162);
  assert.deepEqual(r.warnings, []);
});

test('annonces et belote-rebelote', () => {
  const cards = ['JH', '9H', 'AS', '10C', '7S', '8D', 'QD', 'KC'];
  const r = scoreBelote({
    trump: 'H', cards, lastTrick: 'them',
    announcements: { us: ['tierce', 'cinquante'] }, belote: 'them',
  });
  assert.equal(r.raw.us, 62 + 70);
  assert.equal(r.raw.them, 90 + 10 + 20);
  assert.equal(r.score.us, 13);
  assert.equal(r.score.them, 12);
});

test('preneur dedans : la défense prend 162 + toutes les annonces, la belote reste', () => {
  const cards = ['JH', '9H', 'AS', '10C', '7S', '8D', 'QD', 'KC']; // 62
  const r = scoreBelote({
    trump: 'H', cards, lastTrick: 'them', taker: 'us',
    announcements: { us: ['tierce'] }, belote: 'us',
  });
  // nous : 62 + 20 + 20 = 102 < eux : 100
  assert.equal(r.raw.us, 102);
  assert.equal(r.outcome, 'made');

  const r2 = scoreBelote({ trump: 'H', cards, lastTrick: 'them', taker: 'us', announcements: { us: ['tierce'] } });
  // nous : 82 < eux : 100 -> dedans
  assert.equal(r2.outcome, 'dedans');
  assert.deepEqual(r2.final, { us: 0, them: 162 + 20 });
});

test('litige : égalité, la défense marque, le preneur est mis en réserve', () => {
  // atout pique : 3 as (33) + 3 dix (30) + 3 rois (12) + 2 dames (6) + 7H = 81
  const cards = ['AH', '10H', 'AD', '10D', 'AC', '10C', 'KH', 'KD', 'KC', 'QH', 'QD', '7H'];
  const r = scoreBelote({ trump: 'S', cards, lastTrick: 'them', taker: 'them' });
  assert.deepEqual(r.raw, { us: 81, them: 81 });
  assert.equal(r.outcome, 'litige');
  assert.deepEqual(r.final, { us: 81, them: 0 });
});

test('capot', () => {
  const r = scoreBelote({ trump: 'C', cards: ALL_CARDS, lastTrick: 'us' });
  assert.equal(r.capot, 'us');
  assert.deepEqual(r.raw, { us: 250, them: 0 });
  const r2 = scoreBelote({ trump: 'C', cards: [], lastTrick: 'them', belote: 'us' });
  assert.equal(r2.capot, 'them');
  assert.deepEqual(r2.raw, { us: 20, them: 250 });
});

test('alertes : doublon et nombre de cartes', () => {
  const r = scoreBelote({ trump: 'S', cards: ['AS', 'AS', 'KD'], lastTrick: 'us' });
  const codes = r.warnings.map((w) => w.code).sort();
  assert.deepEqual(codes, ['count', 'duplicate']);
  assert.equal(r.cardCount, 2);
});

test('manille : 60 points au total, on marque au-delà de 30', () => {
  const all = scoreManille({ cards: ALL_CARDS });
  assert.equal(all.raw.us, 60);
  // 10♥ 5 + 10♠ 5 + A♥ 4 + A♠ 4 + K♥ 3 + K♠ 3 + Q♥ 2 + Q♠ 2 + 10♦ 5 + A♦ 4 + 10♣ 5 + 7♣ 0 = 42
  const cards = ['10H', '10S', 'AH', 'AS', 'KH', 'KS', 'QH', 'QS', '10D', 'AD', '10C', '7C'];
  const r = scoreManille({ cards, trump: 'H' });
  assert.equal(r.raw.us, 42);
  assert.deepEqual(r.score, { us: 12, them: 0 });
  assert.deepEqual(scoreManille({ cards, multiplier: 2 }).score, { us: 24, them: 0 });
});
