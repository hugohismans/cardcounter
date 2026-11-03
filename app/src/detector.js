// Détection des cartes dans une photo avec le modèle ONNX (hors ligne).
//
// Le modèle détecte les INDEX des cartes (valeur + couleur dans les coins).
// Une même carte peut donc être vue 2 fois (coin haut-gauche et bas-droit) :
// on regroupe par carte en gardant la détection la plus sûre.
//
// Les fonctions de pré/post-traitement sont pures (testables sous Node) ;
// `CardDetector` ajoute la partie navigateur (canvas + onnxruntime-web).

import { ALL_CARDS } from './cards.js';

export const DEFAULTS = {
  minScore: 0.25, // en dessous : ignoré
  sureScore: 0.6, // en dessous : carte affichée comme "à vérifier"
  iou: 0.5, // même carte, boîtes qui se recouvrent -> doublon
  crossIou: 0.6, // cartes différentes au même endroit -> un seul index, on garde la plus probable
  altScore: 0.3, // une alternative au-dessus de ce score rend la carte "à vérifier"
};

/** Paramètres du letterbox (redimensionnement en gardant les proportions + bandes grises). */
export function letterboxParams(width, height, size) {
  const ratio = Math.min(size / width, size / height);
  const w = Math.round(width * ratio);
  const h = Math.round(height * ratio);
  return { ratio, w, h, padX: Math.floor((size - w) / 2), padY: Math.floor((size - h) / 2), size };
}

/** RGBA (Uint8ClampedArray, size x size) -> Float32Array CHW normalisé [0,1]. */
export function rgbaToTensorData(rgba, size) {
  const n = size * size;
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    out[i] = rgba[4 * i] / 255;
    out[n + i] = rgba[4 * i + 1] / 255;
    out[2 * n + i] = rgba[4 * i + 2] / 255;
  }
  return out;
}

function iou(a, b) {
  const x0 = Math.max(a[0], b[0]);
  const y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[2], b[2]);
  const y1 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return ua > 0 ? inter / ua : 0;
}

function nms(dets, thr, crossThr) {
  dets.sort((a, b) => b.score - a.score);
  const keep = [];
  for (const d of dets) {
    let suppressed = false;
    for (const k of keep) {
      const o = iou(k.box, d.box);
      if (k.cls === d.cls && o >= thr) {
        suppressed = true;
        break;
      }
      if (k.cls !== d.cls && o >= crossThr) {
        // un index ne peut être qu'une seule carte : on garde la plus probable, l'autre devient une alternative
        if (!k.alts.some((a) => a.card === d.card)) k.alts.push({ card: d.card, score: d.score });
        suppressed = true;
        break;
      }
    }
    if (!suppressed) keep.push(d);
  }
  return keep;
}

/**
 * Décode la sortie du modèle.
 * - modèle "end2end" (YOLO26) : [1, N, 6] = x1, y1, x2, y2, score, classe
 * - modèle classique : [1, 4 + nc, A] = cx, cy, w, h, scores... (NMS ici)
 * Les boîtes sont renvoyées en pixels de l'image d'origine.
 */
export function decodeOutput(dims, data, lb, {
  minScore = DEFAULTS.minScore, iou: iouThr = DEFAULTS.iou, crossIou = DEFAULTS.crossIou,
} = {}) {
  const nc = ALL_CARDS.length;
  const unmap = (x, y) => [(x - lb.padX) / lb.ratio, (y - lb.padY) / lb.ratio];
  let dets = [];
  if (dims.length === 3 && dims[2] === 6) {
    const n = dims[1];
    for (let i = 0; i < n; i++) {
      const o = i * 6;
      const score = data[o + 4];
      if (score < minScore) continue;
      const [x0, y0] = unmap(data[o], data[o + 1]);
      const [x1, y1] = unmap(data[o + 2], data[o + 3]);
      const cls = Math.round(data[o + 5]);
      dets.push({ cls, card: ALL_CARDS[cls], score, box: [x0, y0, x1, y1], alts: [] });
    }
  } else if (dims.length === 3 && dims[1] === 4 + nc) {
    const A = dims[2];
    for (let a = 0; a < A; a++) {
      let best = 0;
      let cls = -1;
      for (let c = 0; c < nc; c++) {
        const s = data[(4 + c) * A + a];
        if (s > best) {
          best = s;
          cls = c;
        }
      }
      if (best < minScore) continue;
      const cx = data[a];
      const cy = data[A + a];
      const w = data[2 * A + a];
      const h = data[3 * A + a];
      const [x0, y0] = unmap(cx - w / 2, cy - h / 2);
      const [x1, y1] = unmap(cx + w / 2, cy + h / 2);
      dets.push({ cls, card: ALL_CARDS[cls], score: best, box: [x0, y0, x1, y1], alts: [] });
    }
  } else {
    throw new Error(`Sortie de modèle inattendue : [${dims.join(', ')}]`);
  }
  dets = nms(dets, iouThr, crossIou);
  return dets;
}

/**
 * Regroupe les détections par carte (une carte n'existe qu'une fois dans le jeu).
 * Renvoie [{ card, score, sure, boxes }], trié par score décroissant.
 */
export function groupByCard(dets, { sureScore = DEFAULTS.sureScore, altScore = DEFAULTS.altScore } = {}) {
  const byCard = new Map();
  for (const d of dets) {
    const g = byCard.get(d.card) ?? { card: d.card, score: 0, boxes: [], alts: [] };
    g.score = Math.max(g.score, d.score);
    g.boxes.push({ box: d.box, score: d.score });
    for (const a of d.alts) if (!g.alts.some((x) => x.card === a.card)) g.alts.push(a);
    byCard.set(d.card, g);
  }
  const found = new Set(byCard.keys());
  return [...byCard.values()]
    .map((g) => {
      // une alternative déjà vue ailleurs dans la photo n'est pas crédible (chaque carte est unique)
      const alts = g.alts.filter((a) => a.score >= altScore && !found.has(a.card)).sort((a, b) => b.score - a.score);
      return { ...g, alts, sure: g.score >= sureScore && alts.length === 0 };
    })
    .sort((a, b) => b.score - a.score);
}

/** Partie navigateur : charge le modèle et analyse une image (HTMLImageElement / ImageBitmap / canvas). */
export class CardDetector {
  constructor(ort, { modelUrl = 'model/cards.onnx', metaUrl = 'model/meta.json' } = {}) {
    this.ort = ort;
    this.modelUrl = modelUrl;
    this.metaUrl = metaUrl;
    this.session = null;
  }

  async load() {
    if (this.session) return;
    this.meta = await (await fetch(this.metaUrl)).json();
    if (JSON.stringify(this.meta.classes) !== JSON.stringify(ALL_CARDS)) {
      throw new Error('Le modèle ne correspond pas à la liste de cartes de l’appli');
    }
    this.session = await this.ort.InferenceSession.create(this.modelUrl, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
  }

  async detect(image, opts = {}) {
    await this.load();
    const size = this.meta.imgsz;
    const width = image.naturalWidth ?? image.width;
    const height = image.naturalHeight ?? image.height;
    const lb = letterboxParams(width, height, size);
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = 'rgb(114,114,114)';
    ctx.fillRect(0, 0, size, size);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, lb.padX, lb.padY, lb.w, lb.h);
    const { data } = ctx.getImageData(0, 0, size, size);
    const input = new this.ort.Tensor('float32', rgbaToTensorData(data, size), [1, 3, size, size]);
    const t0 = performance.now();
    const out = await this.session.run({ [this.session.inputNames[0]]: input });
    const ms = performance.now() - t0;
    const tensor = out[this.session.outputNames[0]];
    const dets = decodeOutput(tensor.dims, tensor.data, lb, opts);
    return { detections: dets, cards: groupByCard(dets, opts), ms, width, height };
  }
}
