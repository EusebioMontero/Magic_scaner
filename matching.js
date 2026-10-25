// matching.js — utilidades puras (sin DOM) para limpiar el texto del OCR
// y comparar nombres de cartas. Se prueban con test_matching.mjs.

export function stripAccents(s) {
  return s.normalize('NFD').replace(/\p{M}/gu, '');
}

// Minúsculas, sin acentos, solo [a-z0-9] separados por un espacio.
export function norm(s) {
  return stripAccents(String(s))
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

// 1 = idénticos (ignorando acentos y mayúsculas), 0 = nada en común.
export function similarity(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

// Deja solo letras, apóstrofos, guiones y comas; descarta "palabras" sin letras.
export function cleanOcr(text) {
  return String(text)
    .replace(/[\r\n]+/g, ' ')
    .replace(/[^\p{L}\p{M}'’\-, ]/gu, ' ')
    .split(/\s+/)
    .filter((t) => /\p{L}/u.test(t))
    .join(' ')
    .trim();
}

// Variantes del texto a probar. La segunda quita fragmentos finales de 1-2
// letras: suelen ser símbolos de maná que el OCR ha leído como letras ("RR").
export function nameCandidates(cleaned) {
  const out = [cleaned];
  const toks = cleaned.split(' ');
  while (toks.length > 1 && toks[toks.length - 1].replace(/[^\p{L}]/gu, '').length <= 2) {
    toks.pop();
  }
  const trimmed = toks.join(' ');
  if (trimmed !== cleaned && trimmed.length >= 3) out.push(trimmed);
  return out;
}

// Palabras largas (sin acentos) para buscar en Scryfall en español.
export function searchWords(cleaned, max = 2) {
  const words = [...new Set(norm(cleaned).split(' ').filter((w) => w.length >= 4))];
  words.sort((a, b) => b.length - a.length);
  return words.slice(0, max);
}

// Todos los nombres con los que se puede identificar una carta de Scryfall.
export function allNames(card) {
  const out = new Set();
  const add = (n) => {
    if (n) out.add(n);
  };
  add(card.name);
  add(card.printed_name);
  for (const f of card.card_faces || []) {
    add(f.name);
    add(f.printed_name);
  }
  return [...out];
}

// Devuelve { card, score, matched } con la carta más parecida al texto leído.
export function rankCards(cards, candidates) {
  let best = null;
  for (const card of cards) {
    for (const n of allNames(card)) {
      for (const c of candidates) {
        const score = similarity(c, n);
        if (!best || score > best.score) best = { card, score, matched: n };
      }
    }
  }
  return best;
}

export function displayNames(card) {
  const faces = card.card_faces || [];
  let es = null;
  if (card.lang === 'es') {
    es =
      card.printed_name ||
      faces.map((f) => f.printed_name).filter(Boolean).join(' // ') ||
      null;
  }
  return { en: card.name, es };
}

export function cardImage(card) {
  const u =
    card.image_uris ||
    (card.card_faces && card.card_faces[0] && card.card_faces[0].image_uris);
  return u ? u.normal || u.small || null : null;
}

// ---- Diccionario local (names.json) ----------------------------------------
// Formato: { v, date, names: [nombre inglés, ...], es: [[nombre español, índice en names], ...] }
// Lo genera build_names.py. La búsqueda se hace en el propio móvil, sin red.

let rowA = new Int32Array(256);
let rowB = new Int32Array(256);

// Levenshtein con tope: devuelve la distancia si es <= k; si no, k + 1.
// Corta en cuanto toda una fila supera k, así que descartar es muy barato.
export function boundedLevenshtein(a, b, k) {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > k) return k + 1;
  if (a === b) return 0;
  if (lb + 1 > rowA.length) {
    rowA = new Int32Array(lb + 1);
    rowB = new Int32Array(lb + 1);
  }
  let prev = rowA;
  let cur = rowB;
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let rowMin = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const sub = prev[j - 1] + (ca === b.charCodeAt(j - 1) ? 0 : 1);
      const del = prev[j] + 1;
      const ins = cur[j - 1] + 1;
      const v = sub < del ? (sub < ins ? sub : ins) : del < ins ? del : ins;
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > k) return k + 1;
    const t = prev;
    prev = cur;
    cur = t;
  }
  return prev[lb] > k ? k + 1 : prev[lb];
}

// Prepara el diccionario para buscar: claves normalizadas agrupadas por longitud.
// Las cartas de dos caras ("A // B") también se pueden encontrar solo por la cara frontal.
export function buildIndex(dict) {
  const byLen = new Map();
  let size = 0;
  const add = (text, idx, lang) => {
    const addKey = (t) => {
      const key = norm(t);
      if (!key) return;
      const e = { key, idx, lang, full: text };
      const bucket = byLen.get(key.length);
      if (bucket) bucket.push(e);
      else byLen.set(key.length, [e]);
      size++;
    };
    addKey(text);
    const p = text.indexOf(' // ');
    if (p > 0) addKey(text.slice(0, p));
  };
  dict.names.forEach((n, i) => add(n, i, 'en'));
  const esByIdx = new Map();
  for (const [t, i] of dict.es) {
    add(t, i, 'es');
    if (!esByIdx.has(i)) esByIdx.set(i, t);
  }
  return { names: dict.names, byLen, esByIdx, size };
}

// Busca en el diccionario el nombre más parecido a alguno de los candidatos.
// Devuelve { idx, lang, score, nameEn, nameEs } o null si nada llega a minScore.
export function lookup(index, candidates, minScore = 0.8) {
  let best = null;
  for (const cand of candidates) {
    const q = norm(cand);
    const lq = q.length;
    if (lq < 3) continue;
    const lo = Math.max(1, Math.ceil(minScore * lq));
    const hi = Math.floor(lq / minScore);
    for (let l = lo; l <= hi; l++) {
      const bucket = index.byLen.get(l);
      if (!bucket) continue;
      const maxLen = Math.max(lq, l);
      const k = Math.floor((1 - minScore) * maxLen + 1e-9);
      for (const e of bucket) {
        const d = boundedLevenshtein(q, e.key, k);
        if (d > k) continue;
        const score = 1 - d / maxLen;
        if (!best || score > best.score) best = { e, score };
      }
    }
    if (best && best.score === 1) break;
  }
  if (!best) return null;
  const { e, score } = best;
  return {
    idx: e.idx,
    lang: e.lang,
    score,
    nameEn: index.names[e.idx],
    nameEs: e.lang === 'es' ? e.full : index.esByIdx.get(e.idx) || null,
  };
}
