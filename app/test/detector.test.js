import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_CARDS } from '../src/cards.js';
import { decodeOutput, groupByCard, letterboxParams } from '../src/detector.js';

const NC = ALL_CARDS.length;
const cls = (id) => ALL_CARDS.indexOf(id);

/** Construit une sortie YOLO "classique" [1, 4+nc, A] à partir de détections. */
function rawOutput(dets) {
  const A = dets.length;
  const data = new Float32Array((4 + NC) * A);
  dets.forEach((d, a) => {
    const [cx, cy, w, h] = d.box;
    data[a] = cx; data[A + a] = cy; data[2 * A + a] = w; data[3 * A + a] = h;
    data[(4 + cls(d.card)) * A + a] = d.score;
  });
  return { dims: [1, 4 + NC, A], data };
}

const lb = letterboxParams(640, 640, 640);

test('même carte vue 2 fois (deux coins) -> une seule carte', () => {
  const { dims, data } = rawOutput([
    { card: 'KD', score: 0.9, box: [100, 100, 20, 40] },
    { card: 'KD', score: 0.8, box: [500, 500, 20, 40] },
  ]);
  const cards = groupByCard(decodeOutput(dims, data, lb));
  assert.equal(cards.length, 1);
  assert.equal(cards[0].boxes.length, 2);
  assert.equal(cards[0].sure, true);
});

test('deux cartes au même endroit -> la plus probable, l’autre en alternative, à vérifier', () => {
  const { dims, data } = rawOutput([
    { card: 'KD', score: 0.61, box: [100, 100, 20, 40] },
    { card: 'KH', score: 0.41, box: [101, 100, 20, 40] },
    { card: 'JH', score: 0.96, box: [60, 120, 20, 40] },
  ]);
  const cards = groupByCard(decodeOutput(dims, data, lb));
  assert.deepEqual(cards.map((c) => c.card).sort(), ['JH', 'KD']);
  const kd = cards.find((c) => c.card === 'KD');
  assert.equal(kd.sure, false);
  assert.deepEqual(kd.alts.map((a) => a.card), ['KH']);
});

test('une alternative déjà présente ailleurs dans la photo est ignorée', () => {
  const { dims, data } = rawOutput([
    { card: 'KD', score: 0.9, box: [100, 100, 20, 40] },
    { card: 'KH', score: 0.4, box: [101, 100, 20, 40] },
    { card: 'KH', score: 0.95, box: [400, 300, 20, 40] },
  ]);
  const cards = groupByCard(decodeOutput(dims, data, lb));
  assert.equal(cards.find((c) => c.card === 'KD').sure, true);
});

test('letterbox : les boîtes reviennent en pixels de la photo', () => {
  const l = letterboxParams(2000, 1000, 640); // ratio 0.32, bandes verticales de 160 px
  const { dims, data } = rawOutput([{ card: '7S', score: 0.9, box: [320, 320, 32, 32] }]);
  const [d] = decodeOutput(dims, data, l);
  assert.deepEqual(d.box.map(Math.round), [950, 450, 1050, 550]);
});
