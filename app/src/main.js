import { ALL_CARDS, RANKS, SUITS, SUIT_SYMBOL, SUIT_NAME, RANK_SHORT, parseCard } from './cards.js';
import { scoreBelote, scoreManille, beloteCardValue, MANILLE_VALUES, ANNOUNCEMENTS } from './scoring.js';
import { CardDetector } from './detector.js';

const $ = (id) => document.getElementById(id);
const RED = new Set(['H', 'D']);

const state = {
  game: 'belote',
  trump: null,
  cards: new Map(), // id -> { score, sure }
  der: 'us',
  belote: null,
  taker: null,
  announcements: { us: [], them: [] },
  mult: 1,
  image: null,
  detections: [],
};

let detector = null;
async function getDetector() {
  if (!detector) {
    const ort = await import('../vendor/ort/ort.wasm.min.mjs');
    ort.env.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href;
    ort.env.wasm.numThreads = 1;
    detector = new CardDetector(ort, { modelUrl: 'model/cards.onnx', metaUrl: 'model/meta.json' });
  }
  return detector;
}

// ---------------------------------------------------------------------------
// Contrôles
// ---------------------------------------------------------------------------

function bindSeg(id, onChange) {
  const el = $(id);
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    el.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    onChange(b.dataset.v);
  });
}

function renderTrump() {
  const el = $('trump');
  const opts = [...SUITS];
  if (state.game === 'manille') opts.push('');
  el.classList.toggle('five', opts.length === 5);
  el.innerHTML = '';
  for (const s of opts) {
    const b = document.createElement('button');
    b.textContent = s ? SUIT_SYMBOL[s] : 'Sans atout';
    b.title = s ? SUIT_NAME[s] : 'Sans atout';
    b.className = (RED.has(s) ? 'red ' : '') + (s ? '' : 'na ') + (state.trump === s ? 'on' : '');
    b.onclick = () => {
      state.trump = s;
      renderTrump();
      render();
    };
    el.appendChild(b);
  }
}

function fillAnnouncementSelects() {
  for (const sel of document.querySelectorAll('.annAdd')) {
    sel.innerHTML = '<option value="">+ annonce…</option>' +
      Object.entries(ANNOUNCEMENTS).map(([k, a]) => `<option value="${k}">${a.label} (${a.points})</option>`).join('');
    sel.onchange = () => {
      if (sel.value) state.announcements[sel.dataset.team].push(sel.value);
      sel.value = '';
      render();
    };
  }
}

function renderAnnouncements() {
  for (const team of ['us', 'them']) {
    const el = $(team === 'us' ? 'annUs' : 'annThem');
    el.innerHTML = '';
    state.announcements[team].forEach((k, i) => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = `${ANNOUNCEMENTS[k].label} ✕`;
      b.onclick = () => {
        state.announcements[team].splice(i, 1);
        render();
      };
      el.appendChild(b);
    });
  }
}

// ---------------------------------------------------------------------------
// Photo + détection
// ---------------------------------------------------------------------------

function setStatus(msg, error = false) {
  const el = $('status');
  el.hidden = !msg;
  el.textContent = msg || '';
  el.classList.toggle('error', error);
}

async function onPhoto(file) {
  if (!file) return;
  const img = await createImageBitmap(file, { imageOrientation: 'from-image' });
  state.image = img;
  state.detections = [];
  drawPreview();
  setStatus('Analyse de la photo…');
  try {
    const det = await getDetector();
    const res = await det.detect(img);
    state.detections = res.detections;
    state.cards = new Map(res.cards.map((c) => [c.card, { score: c.score, sure: c.sure }]));
    const unsure = res.cards.filter((c) => !c.sure).length;
    setStatus(`${res.cards.length} cartes reconnues en ${Math.round(res.ms)} ms` +
      (unsure ? ` — ${unsure} à vérifier (en orange)` : ''));
  } catch (err) {
    console.error(err);
    setStatus(`Échec de l'analyse : ${err.message}`, true);
  }
  drawPreview();
  render();
}

function drawPreview() {
  const img = state.image;
  $('photoWrap').hidden = !img;
  if (!img) return;
  const c = $('preview');
  const scale = Math.min(1, 1400 / Math.max(img.width, img.height));
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, c.width, c.height);
  ctx.lineWidth = Math.max(2, c.width / 400);
  ctx.font = `bold ${Math.max(12, c.width / 45)}px system-ui`;
  for (const d of state.detections) {
    if (!state.cards.has(d.card)) continue;
    const [x0, y0, x1, y1] = d.box.map((v) => v * scale);
    const sure = state.cards.get(d.card).sure;
    ctx.strokeStyle = sure ? '#22c55e' : '#f59e0b';
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    const { rank, suit } = parseCard(d.card);
    const label = RANK_SHORT[rank] + SUIT_SYMBOL[suit];
    const tw = ctx.measureText(label).width + 6;
    ctx.fillStyle = sure ? '#22c55e' : '#f59e0b';
    ctx.fillRect(x0, y0 - parseInt(ctx.font.match(/\d+/)[0], 10) - 4, tw, parseInt(ctx.font.match(/\d+/)[0], 10) + 4);
    ctx.fillStyle = '#000';
    ctx.fillText(label, x0 + 3, y0 - 3);
  }
}

// ---------------------------------------------------------------------------
// Récap
// ---------------------------------------------------------------------------

function cardPoints(id) {
  if (state.game === 'belote') return state.trump ? beloteCardValue(id, state.trump) : null;
  return MANILLE_VALUES[parseCard(id).rank];
}

function cardButton(id, { onClick, disabled = false, info } = {}) {
  const { rank, suit } = parseCard(id);
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'c' + (RED.has(suit) ? ' red' : '') + (info?.sure === false ? ' unsure' : '') +
    (state.trump === suit ? ' trump' : '');
  b.innerHTML = `${RANK_SHORT[rank]}${SUIT_SYMBOL[suit]}`;
  const pts = cardPoints(id);
  if (info && pts !== null) b.innerHTML += `<small>${pts} pt${pts > 1 ? 's' : ''}</small>`;
  b.disabled = disabled;
  if (onClick) b.onclick = onClick;
  return b;
}

function renderCards() {
  const show = state.image || state.cards.size;
  $('cardsPanel').hidden = !show;
  $('cardCount').textContent = `${state.cards.size}`;
  const list = $('cardList');
  list.innerHTML = '';
  // l'atout en premier
  const order = state.trump ? [state.trump, ...SUITS.filter((s) => s !== state.trump)] : SUITS;
  for (const s of order) {
    const ids = RANKS.map((r) => r + s).filter((id) => state.cards.has(id));
    if (!ids.length) continue;
    const row = document.createElement('div');
    row.className = 'suit-row';
    row.innerHTML = `<span class="sym" style="color:${RED.has(s) ? 'var(--red)' : 'inherit'}">${SUIT_SYMBOL[s]}</span>`;
    let sum = 0;
    for (const id of ids) {
      sum += cardPoints(id) ?? 0;
      row.appendChild(cardButton(id, {
        info: state.cards.get(id),
        onClick: () => {
          state.cards.delete(id);
          drawPreview();
          render();
        },
      }));
    }
    const t = document.createElement('span');
    t.className = 'sum';
    t.textContent = `${sum} pts`;
    row.appendChild(t);
    list.appendChild(row);
  }
}

function openPicker() {
  const grid = $('pickerGrid');
  grid.innerHTML = '';
  for (const s of SUITS) {
    for (const r of RANKS) {
      const id = r + s;
      grid.appendChild(cardButton(id, {
        disabled: state.cards.has(id),
        onClick: () => {
          state.cards.set(id, { score: 1, sure: true });
          $('picker').close();
          render();
        },
      }));
    }
  }
  $('picker').showModal();
}

const OUTCOME = { dedans: 'Dedans !', litige: 'Litige' };

function renderResult() {
  const el = $('result');
  const cards = [...state.cards.keys()];
  if (!state.trump && state.game === 'belote') {
    el.innerHTML = '<p class="hint">Choisissez l’atout pour calculer les points.</p>';
    return;
  }
  if (state.game === 'belote') {
    const r = scoreBelote({
      trump: state.trump, cards, lastTrick: state.der, announcements: state.announcements,
      belote: state.belote, taker: state.taker,
    });
    const team = (k, name) => {
      const bits = [`cartes ${r.capot ? (r.capot === k ? 250 : 0) : r.cardPoints[k]}`];
      if (!r.capot && r.lastTrick === k) bits.push('der 10');
      if (r.announcements[k]) bits.push(`annonces ${r.announcements[k]}`);
      if (r.belote[k]) bits.push('belote 20');
      return `<div class="team"><div>${name}</div><div class="big">${r.score[k]}</div>
        <div class="raw">${r.final[k]} pts</div><div class="detail">${bits.join(' + ')}</div></div>`;
    };
    el.innerHTML = `
      <div class="row-between"><h2>Résultat</h2>${r.capot ? '<span class="badge">Capot</span>' : ''}
        ${OUTCOME[r.outcome] ? `<span class="badge">${OUTCOME[r.outcome]}</span>` : ''}</div>
      <div class="teams">${team('us', 'Nous')}${team('them', 'Eux')}</div>
      ${r.warnings.map((w) => `<div class="warn">${w.message}</div>`).join('')}`;
  } else {
    const r = scoreManille({ cards, trump: state.trump || null, multiplier: state.mult });
    const team = (k, name) => `<div class="team"><div>${name}</div><div class="big">${r.score[k]}</div>
      <div class="raw">${r.raw[k]} pts sur 60</div></div>`;
    el.innerHTML = `<h2>Résultat</h2><div class="teams">${team('us', 'Nous')}${team('them', 'Eux')}</div>
      ${r.warnings.map((w) => `<div class="warn">${w.message}</div>`).join('')}`;
  }
}

function render() {
  $('beloteOptions').hidden = state.game !== 'belote';
  $('manilleOptions').hidden = state.game !== 'manille';
  renderAnnouncements();
  renderCards();
  renderResult();
}

// ---------------------------------------------------------------------------

bindSeg('game', (v) => {
  state.game = v;
  if (v === 'belote' && state.trump === '') state.trump = null;
  renderTrump();
  render();
});
bindSeg('der', (v) => { state.der = v; render(); });
bindSeg('belote', (v) => { state.belote = v || null; render(); });
bindSeg('taker', (v) => { state.taker = v || null; render(); });
bindSeg('mult', (v) => { state.mult = Number(v); render(); });
$('photo').addEventListener('change', (e) => onPhoto(e.target.files[0]));
$('addCard').addEventListener('click', openPicker);
fillAnnouncementSelects();
renderTrump();
render();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js');
}
// précharge le modèle en arrière-plan
getDetector().then((d) => d.load()).catch((e) => console.warn('modèle non chargé', e));
