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
