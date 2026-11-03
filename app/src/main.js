import { RANKS, SUITS, SUIT_SYMBOL, SUIT_NAME, RANK_NAME, RANK_SHORT, parseCard } from './cards.js';
import {
  scoreBelote, scoreManille, beloteCardValue, MANILLE_VALUES, ANNOUNCEMENTS, BELOTE_HAND_TOTAL, MANILLE_TOTAL,
} from './scoring.js';
import { CardDetector } from './detector.js';
import {
  GAME_TYPES, newGame, handFromResult, computeGame, addHand, removeHand, editHandScore, isDealGame, dealerOf, rouleStatus,
} from './game.js';

const $ = (id) => document.getElementById(id);
const RED = new Set(['H', 'D']);
const STORE_KEY = 'cardcounter.v1';

// ---------------------------------------------------------------------------
// État : partie (sauvegardée) + donne en cours de saisie
// ---------------------------------------------------------------------------

function loadStore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s?.game?.hands) return s;
  } catch { /* stockage indisponible ou corrompu */ }
  return { game: newGame({ type: 'belote' }), archive: [] };
}
const store = loadStore();
function saveStore() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch { /* navigation privée : la partie ne sera pas conservée */ }
}

function freshHand() {
  return {
    mode: 'photo',
    trump: null,
    cards: new Map(), // id -> { score, sure, alts }
    photoTeam: 'us',
    manualTeam: 'us',
    manualValue: '',
    capotTeam: 'us',
    der: 'us',
    belote: null,
    taker: null,
    announcements: { us: [], them: [] },
    image: null,
    detections: [],
  };
}
let hand = freshHand();

const game = () => store.game;
const teamName = (k) => game().teams[k];
const other = (k) => (k === 'us' ? 'them' : 'us');

// ---------------------------------------------------------------------------
// Détecteur (chargé en arrière-plan)
// ---------------------------------------------------------------------------

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
// Calcul de la donne en cours
// ---------------------------------------------------------------------------

/** Inverse nous/eux dans un objet de résultat (pour photographier ou compter l'autre équipe). */
function swapTeams(v, key = '') {
  if (v === 'us' || v === 'them') return ['capot', 'taker', 'lastTrick', 'belote'].includes(key) ? other(v) : v;
  if (Array.isArray(v)) return v.map((x) => swapTeams(x));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      const nk = k === 'us' ? 'them' : k === 'them' ? 'us' : k;
      out[nk] = swapTeams(x, k);
    }
    return out;
  }
  return v;
}

/** Résultat de la donne en cours, ou { error } si la saisie est incomplète. */
function computeHand() {
  const h = hand;
  const isBelote = game().type === 'belote';
  // équipe de référence pour les cartes / points saisis
  const ref = h.mode === 'photo' ? h.photoTeam : h.mode === 'manual' ? h.manualTeam : 'us';
  const flip = ref === 'them';
  const sw = (x) => (flip ? swapTeams(x) : x);

  if (h.mode === 'photo' && isBelote && !h.trump) return { error: 'Choisissez l’atout pour calculer les points.' };
  if (!isBelote && h.trump === null) return { error: 'Choisissez l’atout, ou le roulé (sans atout, compte double).' };
  if (h.mode === 'manual' && h.manualValue === '') return { error: 'Saisissez les points comptés.' };

  let r;
  if (isBelote) {
    const common = sw({
      announcements: h.announcements, belote: h.belote, taker: h.taker, lastTrick: h.der,
    });
    if (h.mode === 'capot') {
      r = scoreBelote({ capot: h.capotTeam, announcements: h.announcements, belote: h.belote, taker: h.taker });
      return r;
    }
    r = scoreBelote({
      ...common,
      trump: h.trump,
      cards: h.mode === 'photo' ? [...h.cards.keys()] : null,
      manualPoints: h.mode === 'manual' ? Number(h.manualValue) : null,
      announcements: common.announcements,
      belote: common.belote,
      taker: common.taker,
      lastTrick: common.lastTrick,
    });
  } else {
    r = scoreManille({
      trump: h.trump || null,
      multiplier: h.trump === '' ? 2 : 1, // roulé (sans atout) : compte double
      cards: h.mode === 'photo' ? [...h.cards.keys()] : null,
      manualPoints: h.mode === 'manual' ? Number(h.manualValue) : null,
    });
  }
  if (flip) {
    const { warnings, cards, ...rest } = r;
    r = { ...swapTeams(rest), warnings, cards, trump: r.trump, mode: r.mode, game: r.game };
  }
  return r;
}

// ---------------------------------------------------------------------------
// Contrôles génériques
// ---------------------------------------------------------------------------

function bindSeg(id, onChange) {
  const el = $(id);
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    setSeg(id, b.dataset.v);
    onChange(b.dataset.v);
  });
}
function setSeg(id, value) {
  $(id).querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.v === String(value ?? '')));
}

function renderTeamLabels() {
  document.querySelectorAll('.teamseg button[data-v="us"], .tname[data-team="us"]').forEach((b) => { b.textContent = teamName('us'); });
  document.querySelectorAll('.teamseg button[data-v="them"], .tname[data-team="them"]').forEach((b) => { b.textContent = teamName('them'); });
}

// ---------------------------------------------------------------------------
// Vue PARTIE
// ---------------------------------------------------------------------------

const OUTCOME = { dedans: 'Dedans', litige: 'Litige' };
const MODE_ICON = { cards: '📷', manual: '✍️', capot: '🏆' };

function renderGame() {
  const g = game();
  const res = computeGame(g);
  const deal = isDealGame(g);
  const rs = deal ? rouleStatus(g) : null;
  $('subtitle').textContent = deal
    ? `${GAME_TYPES[g.type].label} · donne ${Math.min(g.hands.length + 1, g.deals)}/${g.deals}`
    : `${GAME_TYPES[g.type].label} · partie en ${g.target}`;

  $('board').innerHTML = ['us', 'them'].map((k) => {
    const lead = res.totals[k] > res.totals[other(k)];
    let pct;
    let hint;
    if (deal) {
      const t = rs.teams[k];
      pct = g.roules ? Math.min(100, (t.done / g.roules) * 100) : 100;
      hint = g.roules ? `roulés ${t.done}/${g.roules}${t.missing > t.dealsLeft ? ' ⚠️' : ''}` : '';
    } else {
      pct = Math.min(100, (res.totals[k] / g.target) * 100);
      hint = `reste ${Math.max(0, g.target - res.totals[k])}`;
    }
    return `<div class="score-team ${lead ? 'lead' : ''} ${res.winner === k ? 'won' : ''}">
      <div class="tn">${escapeHtml(teamName(k))}</div>
      <div class="total">${res.totals[k]}</div>
      <div class="bar"><span style="width:${pct}%"></span></div>
      <div class="hint">${hint}</div>
    </div>`;
  }).join('');

  $('winner').hidden = !res.winner;
  if (res.winner === 'tie') $('winner').innerHTML = '🤝 <b>Égalité</b> à la fin de la partie !';
  else if (res.winner) $('winner').innerHTML = `🏆 <b>${escapeHtml(teamName(res.winner))}</b> gagne la partie !`;
  $('nextDeal').hidden = !deal || !!res.winner;
  if (deal && !res.winner) {
    $('nextDeal').innerHTML = `Donne ${rs.next + 1}/${g.deals} : <b>${escapeHtml(teamName(rs.nextDealer))}</b> distribue et choisit l'atout`
      + (rs.forced ? ' — <span class="forced">roulé imposé</span>' : '');
  }
  $('reserveNote').hidden = !res.reserve;
  $('reserveNote').textContent = `Litige : ${res.reserve} points en réserve pour le gagnant de la prochaine donne.`;

  $('handCount').textContent = g.hands.length;
  $('noHands').hidden = g.hands.length > 0;
  const list = $('handsList');
  list.innerHTML = g.hands.length
    ? `<div class="hand-head"><span></span><span></span><span>${escapeHtml(teamName('us'))}</span><span>${escapeHtml(teamName('them'))}</span><span>total</span></div>`
    : '';
  [...res.rows].reverse().forEach((row) => {
    const h = row.hand;
    const div = document.createElement('button');
    div.type = 'button';
    div.className = 'hand-row';
    const badges = [];
    if (h.capot) badges.push(`<span class="badge">Capot ${escapeHtml(teamName(h.capot))}</span>`);
    if (OUTCOME[h.outcome]) badges.push(`<span class="badge">${OUTCOME[h.outcome]}</span>`);
    if (h.roule) badges.push('<span class="badge roule">Roulé ×2</span>');
    if (h.edited) badges.push('<span class="badge soft">modifiée</span>');
    const bonus = (k) => (row.bonus[k] ? ` <small class="plus">+${row.bonus[k]}</small>` : '');
    const trump = h.trump ? `<span class="${RED.has(h.trump) ? 'red' : ''}">${SUIT_SYMBOL[h.trump]}</span>` : '';
    div.innerHTML = `
      <span class="n">${row.index + 1}</span>
      <span class="meta">${MODE_ICON[h.mode] ?? ''} ${trump} ${badges.join(' ')}</span>
      <span class="pts">${h.score.us}${bonus('us')}</span>
      <span class="pts">${h.score.them}${bonus('them')}</span>
      <span class="cum">${row.total.us} – ${row.total.them}</span>`;
    div.onclick = () => openHandDialog(row.index);
    list.appendChild(div);
  });
  $('newHandBtn').disabled = !!res.winner;
  $('newHandBtn').textContent = res.winner ? 'Partie terminée' : '+ Nouvelle donne';
}

function openHandDialog(index) {
  const h = game().hands[index];
  const g = game();
  $('handDialogTitle').textContent = `Donne ${index + 1}` + (isDealGame(g) ? ` · donneur : ${teamName(dealerOf(g, index))}` : '');
  const raw = h.raw ? ` — ${h.raw.us} / ${h.raw.them} points` : '';
  $('handDialogInfo').textContent = `Corrigez le score si besoin${raw}.`;
  $('editUs').value = h.score.us;
  $('editThem').value = h.score.them;
  const dlg = $('handDialog');
  dlg.onclose = () => {
    if (dlg.returnValue === 'save') {
      store.game = editHandScore(game(), index, { us: $('editUs').value, them: $('editThem').value });
    } else if (dlg.returnValue === 'delete') {
      if (!confirm(`Supprimer la donne ${index + 1} ?`)) return;
      store.game = removeHand(game(), index);
    } else return;
    saveStore();
    renderGame();
  };
  dlg.returnValue = '';
  dlg.showModal();
}

function openNewGameDialog() {
  const g = game();
  let type = g.type;
  setSeg('ngType', type);
  $('ngUs').value = g.teams.us === 'Nous' ? '' : g.teams.us;
  $('ngThem').value = g.teams.them === 'Eux' ? '' : g.teams.them;
  let first = 'us';
  setSeg('ngFirst', first);
  const syncNames = () => {
    $('ngFirst').querySelector('[data-v="us"]').textContent = $('ngUs').value.trim() || 'Nous';
    $('ngFirst').querySelector('[data-v="them"]').textContent = $('ngThem').value.trim() || 'Eux';
  };
  syncNames();
  $('ngUs').oninput = syncNames;
  $('ngThem').oninput = syncNames;
  $('ngFirst').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    first = b.dataset.v;
    setSeg('ngFirst', first);
  };
  const setType = (t) => {
    type = t;
    $('ngTargetField').hidden = t !== 'belote';
    $('ngManilleFields').hidden = t !== 'manille';
    if (t === 'belote') $('ngTarget').value = GAME_TYPES.belote.target;
    else {
      $('ngDeals').value = GAME_TYPES.manille.deals;
      $('ngRoules').value = GAME_TYPES.manille.roules;
    }
    $('ngHint').textContent = t === 'belote'
      ? 'Belote : scores comptés sur 10 (162 points = 16). 100 = partie en 1000 points.'
      : 'Manille : chaque équipe marque ses points au-delà de 30. Celui qui distribue choisit l’atout ; un roulé (sans atout) compte double.';
  };
  setType(type);
  $('ngType').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    setSeg('ngType', b.dataset.v);
    setType(b.dataset.v);
  };
  const dlg = $('newGameDialog');
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok') return;
    if (game().hands.length) {
      store.archive = [{ ...game(), endedAt: new Date().toISOString() }, ...(store.archive ?? [])].slice(0, 20);
    }
    store.game = newGame({
      type,
      teams: { us: $('ngUs').value, them: $('ngThem').value },
      target: $('ngTarget').value,
      deals: $('ngDeals').value,
      roules: $('ngRoules').value,
      firstDealer: first,
    });
    saveStore();
    hand = freshHand();
    showView('game');
  };
  dlg.returnValue = '';
  dlg.showModal();
}

// ---------------------------------------------------------------------------
// Vue DONNE
// ---------------------------------------------------------------------------

function renderTrump() {
  const el = $('trump');
  const g = game();
  const opts = [...SUITS];
  if (g.type === 'manille') opts.push('');
  // manille : roulé imposé quand l'équipe qui distribue n'a plus assez de donnes pour ses roulés
  const rs = isDealGame(g) ? rouleStatus(g) : null;
  if (rs?.forced) hand.trump = '';
  $('trumpTitle').textContent = rs?.nextDealer ? `Atout — choisi par ${teamName(rs.nextDealer)}` : 'Atout';
  $('rouleWarn').hidden = !rs?.forced;
  if (rs?.forced) {
    const t = rs.teams[rs.nextDealer];
    $('rouleWarn').textContent = `Roulé imposé : ${teamName(rs.nextDealer)} doit encore faire ${t.missing} roulé${t.missing > 1 ? 's' : ''} `
      + `et n'a plus que ${t.dealsLeft} donne${t.dealsLeft > 1 ? 's' : ''} à distribuer.`;
  }
  el.classList.toggle('five', opts.length === 5);
  el.innerHTML = '';
  for (const s of opts) {
    const b = document.createElement('button');
    b.textContent = s ? SUIT_SYMBOL[s] : 'Roulé ×2';
    b.title = s ? SUIT_NAME[s] : 'Roulé : sans atout, compte double';
    b.className = (RED.has(s) ? 'red ' : '') + (s ? '' : 'na ') + (hand.trump === s ? 'on' : '');
    b.disabled = !!rs?.forced && s !== '';
    b.onclick = () => {
      hand.trump = s;
      renderTrump();
      renderHand();
    };
    el.appendChild(b);
  }
}

function fillAnnouncementSelects() {
  for (const sel of document.querySelectorAll('.annAdd')) {
    sel.innerHTML = '<option value="">+ annonce…</option>' +
      Object.entries(ANNOUNCEMENTS).map(([k, a]) => `<option value="${k}">${a.label} (${a.points})</option>`).join('');
    sel.onchange = () => {
      if (sel.value) hand.announcements[sel.dataset.team].push(sel.value);
      sel.value = '';
      renderHand();
    };
  }
}

function renderAnnouncements() {
  for (const team of ['us', 'them']) {
    const el = $(team === 'us' ? 'annUs' : 'annThem');
    el.innerHTML = '';
    hand.announcements[team].forEach((k, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = `${ANNOUNCEMENTS[k].label} ✕`;
      b.onclick = () => {
        hand.announcements[team].splice(i, 1);
        renderHand();
      };
      el.appendChild(b);
    });
  }
}

function setStatus(msg, error = false) {
  const el = $('status');
  el.hidden = !msg;
  el.textContent = msg || '';
  el.classList.toggle('error', error);
}

async function onPhoto(file) {
  if (!file) return;
  const img = await createImageBitmap(file, { imageOrientation: 'from-image' });
  hand.image = img;
  hand.detections = [];
  drawPreview();
  setStatus('Analyse de la photo…');
  try {
    const det = await getDetector();
    const res = await det.detect(img);
    hand.detections = res.detections;
    hand.cards = new Map(res.cards.map((c) => [c.card, { score: c.score, sure: c.sure, alts: c.alts }]));
    const unsure = res.cards.filter((c) => !c.sure).length;
    setStatus(`${res.cards.length} cartes reconnues en ${Math.round(res.ms)} ms` +
      (unsure ? ` — ${unsure} à vérifier (en orange)` : ''));
  } catch (err) {
    console.error(err);
    setStatus(`Échec de l'analyse : ${err.message}`, true);
  }
  $('photo').value = '';
  drawPreview();
  renderHand();
}

function drawPreview() {
  const img = hand.image;
  $('photoWrap').hidden = !img;
  if (!img) return;
  const c = $('preview');
  const scale = Math.min(1, 1400 / Math.max(img.width, img.height));
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const fs = Math.max(12, Math.round(c.width / 45));
  ctx.lineWidth = Math.max(2, c.width / 400);
  ctx.font = `bold ${fs}px system-ui`;
  for (const d of hand.detections) {
    if (!hand.cards.has(d.card)) continue;
    const [x0, y0, x1, y1] = d.box.map((v) => v * scale);
    const color = hand.cards.get(d.card).sure ? '#22c55e' : '#f59e0b';
    ctx.strokeStyle = color;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    const label = shortLabel(d.card);
    ctx.fillStyle = color;
    ctx.fillRect(x0, y0 - fs - 4, ctx.measureText(label).width + 6, fs + 4);
    ctx.fillStyle = '#000';
    ctx.fillText(label, x0 + 3, y0 - 3);
  }
}

function shortLabel(id) {
  const { rank, suit } = parseCard(id);
  return RANK_SHORT[rank] + SUIT_SYMBOL[suit];
}

function cardPoints(id) {
  if (game().type === 'belote') return hand.trump ? beloteCardValue(id, hand.trump) : null;
  return MANILLE_VALUES[parseCard(id).rank];
}

function cardButton(id, { onClick, disabled = false, info } = {}) {
  const { suit } = parseCard(id);
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'c' + (RED.has(suit) ? ' red' : '') + (info?.sure === false ? ' unsure' : '') +
    (hand.trump === suit ? ' trump' : '');
  b.innerHTML = shortLabel(id);
  const pts = cardPoints(id);
  if (info && pts !== null) b.innerHTML += `<small>${pts} pt${pts > 1 ? 's' : ''}</small>`;
  const alt = info?.sure === false && info.alts?.find((a) => !hand.cards.has(a.card));
  if (alt) b.innerHTML += `<span class="alt">ou ${shortLabel(alt.card)} ?</span>`;
  b.disabled = disabled;
  if (onClick) b.onclick = onClick;
  return b;
}

function renderCards() {
  $('cardsPanel').hidden = hand.mode !== 'photo' || !(hand.image || hand.cards.size);
  $('cardCount').textContent = `${hand.cards.size}`;
  const list = $('cardList');
  list.innerHTML = '';
  const order = hand.trump ? [hand.trump, ...SUITS.filter((s) => s !== hand.trump)] : SUITS;
  for (const s of order) {
    const ids = RANKS.map((r) => r + s).filter((id) => hand.cards.has(id));
    if (!ids.length) continue;
    const row = document.createElement('div');
    row.className = 'suit-row';
    row.innerHTML = `<span class="sym" style="color:${RED.has(s) ? 'var(--red)' : 'inherit'}">${SUIT_SYMBOL[s]}</span>`;
    let sum = 0;
    for (const id of ids) {
      sum += cardPoints(id) ?? 0;
      row.appendChild(cardButton(id, { info: hand.cards.get(id), onClick: () => openCardMenu(id) }));
    }
    const t = document.createElement('span');
    t.className = 'sum';
    t.textContent = `${sum} pts`;
    row.appendChild(t);
    list.appendChild(row);
  }
}

function openCardMenu(id) {
  const info = hand.cards.get(id);
  const { rank, suit } = parseCard(id);
  $('cardMenuTitle').textContent = `${RANK_NAME[rank]} de ${SUIT_NAME[suit].toLowerCase()}`;
  $('cardMenuInfo').textContent = info.score < 1 ? `Confiance du détecteur : ${Math.round(info.score * 100)} %` : 'Ajoutée à la main';
  const box = $('cardMenuActions');
  box.innerHTML = '';
  const action = (label, fn, primary = false) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (primary) b.className = 'primary';
    b.onclick = () => {
      fn();
      $('cardMenu').close();
      drawPreview();
      renderHand();
    };
    box.appendChild(b);
  };
  if (!info.sure) action(`C'est bien ${shortLabel(id)}`, () => { info.sure = true; }, true);
  for (const a of (info.alts ?? []).filter((x) => !hand.cards.has(x.card))) {
    action(`Remplacer par ${shortLabel(a.card)}`, () => {
      hand.cards.delete(id);
      hand.cards.set(a.card, { score: a.score, sure: true, alts: [] });
      for (const d of hand.detections) if (d.card === id) d.card = a.card;
    });
  }
  action('Retirer cette carte', () => hand.cards.delete(id));
  action('Annuler', () => {});
  $('cardMenu').showModal();
}

function openPicker() {
  const grid = $('pickerGrid');
  grid.innerHTML = '';
  for (const s of SUITS) {
    for (const r of RANKS) {
      const id = r + s;
      grid.appendChild(cardButton(id, {
        disabled: hand.cards.has(id),
        onClick: () => {
          hand.cards.set(id, { score: 1, sure: true, alts: [] });
          $('picker').close();
          renderHand();
        },
      }));
    }
  }
  $('picker').showModal();
}

function renderManual() {
  const total = game().type === 'belote' ? BELOTE_HAND_TOTAL : MANILLE_TOTAL;
  const t = hand.manualTeam;
  $('manualInput').max = total;
  $('manualHint').textContent = game().type === 'belote' ? `/ ${total} (10 de der compris)` : `/ ${total}`;
  const v = Number(hand.manualValue);
  $('manualOther').textContent = hand.manualValue !== '' && v >= 0 && v <= total
    ? `${teamName(other(t))} : ${total - v} points`
    : '';
}

function renderResult(r) {
  const el = $('result');
  if (r.error) {
    el.innerHTML = `<p class="hint">${r.error}</p>`;
    return;
  }
  const names = { us: escapeHtml(teamName('us')), them: escapeHtml(teamName('them')) };
  if (r.game === 'belote') {
    const team = (k) => {
      const bits = [];
      if (r.capot) bits.push(r.capot === k ? 'capot 250' : 'capot 0');
      else if (r.mode === 'manual') bits.push(`points ${r.base[k]}`);
      else {
        bits.push(`cartes ${r.cardPoints[k]}`);
        if (r.lastTrick === k) bits.push('der 10');
      }
      if (r.announcements[k]) bits.push(`annonces ${r.announcements[k]}`);
      if (r.belote[k]) bits.push('belote 20');
      return `<div class="team"><div>${names[k]}</div><div class="big">${r.score[k]}</div>
        <div class="raw">${r.final[k]} pts</div><div class="detail">${bits.join(' + ')}</div></div>`;
    };
    const badges = [r.capot ? '<span class="badge">Capot</span>' : '',
      OUTCOME[r.outcome] ? `<span class="badge">${OUTCOME[r.outcome]}${r.outcome === 'dedans' ? ' !' : ''}</span>` : ''].join(' ');
    const litige = r.outcome === 'litige'
      ? `<div class="warn">Litige : ${r.reserved} points de ${names[r.taker]} mis en réserve pour le gagnant de la donne suivante.</div>` : '';
    el.innerHTML = `
      <div class="row-between"><h2>Résultat de la donne</h2><div>${badges}</div></div>
      <div class="teams">${team('us')}${team('them')}</div>${litige}
      ${r.warnings.map((w) => `<div class="warn">${w.message}</div>`).join('')}`;
  } else {
    const team = (k) => `<div class="team"><div>${names[k]}</div><div class="big">${r.score[k]}</div>
      <div class="raw">${r.raw[k]} pts sur 60</div></div>`;
    el.innerHTML = `<h2>Résultat de la donne</h2><div class="teams">${team('us')}${team('them')}</div>
      ${r.warnings.map((w) => `<div class="warn">${w.message}</div>`).join('')}`;
  }
}

function renderHand() {
  const isBelote = game().type === 'belote';
  if (!isBelote && hand.mode === 'capot') hand.mode = 'photo';
  setSeg('mode', hand.mode);
  $('modeCapot').hidden = !isBelote;
  $('trumpPanel').hidden = isBelote ? hand.mode !== 'photo' : hand.mode === 'capot';
  $('photoPanel').hidden = hand.mode !== 'photo';
  $('manualPanel').hidden = hand.mode !== 'manual';
  $('capotPanel').hidden = hand.mode !== 'capot';
  $('beloteOptions').hidden = !isBelote;
  $('derRow').hidden = hand.mode !== 'photo';
  setSeg('photoTeam', hand.photoTeam);
  setSeg('manualTeam', hand.manualTeam);
  setSeg('capotTeam', hand.capotTeam);
  setSeg('der', hand.der);
  setSeg('belote', hand.belote ?? '');
  setSeg('taker', hand.taker ?? '');
  renderAnnouncements();
  renderCards();
  renderManual();
  const r = computeHand();
  renderResult(r);
  const blocking = r.error || r.warnings?.some((w) => w.code === 'manual');
  $('saveHand').disabled = !!blocking;
  $('saveHand').textContent = blocking ? 'Valider la donne' : `Valider : ${r.score.us} – ${r.score.them}`;
}

function saveHand() {
  const r = computeHand();
  if (r.error) return;
  const soft = r.warnings?.filter((w) => w.code !== 'manual') ?? [];
  if (soft.length && !confirm(`${soft.map((w) => w.message).join('\n')}\n\nValider quand même ?`)) return;
  store.game = addHand(game(), handFromResult(r, {
    cards: hand.mode === 'photo' ? [...hand.cards.keys()] : undefined,
    roule: game().type === 'manille' && hand.trump === '',
  }));
  saveStore();
  hand = freshHand();
  showView('game');
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

function showView(v) {
  $('viewGame').hidden = v !== 'game';
  $('viewHand').hidden = v !== 'hand';
  $('newGameBtn').hidden = v !== 'game';
  renderTeamLabels();
  if (v === 'game') renderGame();
  else {
    const g = game();
    $('subtitle').textContent = `Donne ${g.hands.length + 1}${isDealGame(g) ? `/${g.deals}` : ''} · ${GAME_TYPES[g.type].label}`;
    renderTrump();
    renderHand();
  }
  window.scrollTo(0, 0);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------

bindSeg('mode', (v) => { hand.mode = v; renderHand(); });
bindSeg('photoTeam', (v) => { hand.photoTeam = v; renderHand(); });
bindSeg('manualTeam', (v) => { hand.manualTeam = v; renderHand(); });
bindSeg('capotTeam', (v) => { hand.capotTeam = v; renderHand(); });
bindSeg('der', (v) => { hand.der = v; renderHand(); });
bindSeg('belote', (v) => { hand.belote = v || null; renderHand(); });
bindSeg('taker', (v) => { hand.taker = v || null; renderHand(); });
$('manualInput').addEventListener('input', (e) => { hand.manualValue = e.target.value.trim(); renderHand(); });
$('photo').addEventListener('change', (e) => onPhoto(e.target.files[0]));
$('addCard').addEventListener('click', openPicker);
$('newHandBtn').addEventListener('click', () => { hand = freshHand(); $('manualInput').value = ''; setStatus(''); showView('hand'); });
$('cancelHand').addEventListener('click', () => {
  if ((hand.cards.size || hand.manualValue) && !confirm('Abandonner la saisie de cette donne ?')) return;
  hand = freshHand();
  showView('game');
});
$('saveHand').addEventListener('click', saveHand);
$('newGameBtn').addEventListener('click', openNewGameDialog);
fillAnnouncementSelects();
showView('game');

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js');
}

// ---------------------------------------------------------------------------
// Installation comme une appli (écran d'accueil)
// ---------------------------------------------------------------------------

const INSTALL_KEY = 'cardcounter.installDismissed';
const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let installDismissed = false;
try { installDismissed = localStorage.getItem(INSTALL_KEY) === '1'; } catch { /* ignore */ }
let installPrompt = null;

function showInstall(html, withButton) {
  if (standalone || installDismissed) return;
  $('installText').innerHTML = html;
  $('installBtn').hidden = !withButton;
  $('installBox').hidden = false;
}
// Android / Chrome / Edge : le navigateur propose l'installation
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  showInstall('<b>Installer l’appli</b><br>Sur l’écran d’accueil, utilisable hors ligne.', true);
});
$('installBtn').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  $('installBox').hidden = true;
});
window.addEventListener('appinstalled', () => { $('installBox').hidden = true; });
// iPhone / iPad : pas de bouton possible, on explique la marche à suivre
if (isIOS) {
  showInstall('<b>Installer l’appli</b><br>Touchez <span class="ios-share">⬆︎</span> Partager, puis « Sur l’écran d’accueil ».', false);
}
$('installClose').addEventListener('click', () => {
  $('installBox').hidden = true;
  try { localStorage.setItem(INSTALL_KEY, '1'); } catch { /* ignore */ }
});
// précharge le modèle en arrière-plan
getDetector().then((d) => d.load()).catch((e) => console.warn('modèle non chargé', e));
