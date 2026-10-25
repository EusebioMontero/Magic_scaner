import assert from 'node:assert/strict';
import {
  norm,
  levenshtein,
  similarity,
  cleanOcr,
  nameCandidates,
  searchWords,
  rankCards,
  displayNames,
  cardImage,
  boundedLevenshtein,
  buildIndex,
  lookup,
} from './matching.js';

// norm / levenshtein / similarity
assert.equal(norm('Relámpago Encadenado!'), 'relampago encadenado');
assert.equal(norm('Æther Vial'), 'aether vial');
assert.equal(levenshtein('kitten', 'sitting'), 3);
assert.equal(similarity('Relámpago', 'relampago'), 1);
assert.ok(similarity('Lightnlng Bolt', 'Lightning Bolt') > 0.9);
assert.ok(similarity('Isla', 'Island') < 0.75); // no debe confundirse con el fuzzy inglés

// cleanOcr
assert.equal(cleanOcr('  Lightning Bolt\n@ R '), 'Lightning Bolt R');
assert.equal(cleanOcr('|| Relámpago — 2 ~'), 'Relámpago');
assert.equal(cleanOcr("Gaea's Cradle"), "Gaea's Cradle");
assert.equal(cleanOcr('1234 ///'), '');

// nameCandidates
assert.deepEqual(nameCandidates('Lightning Bolt R'), ['Lightning Bolt R', 'Lightning Bolt']);
assert.deepEqual(nameCandidates('Relámpago encadenado RR'), ['Relámpago encadenado RR', 'Relámpago encadenado']);
assert.deepEqual(nameCandidates('Llanura'), ['Llanura']);
assert.deepEqual(nameCandidates('Sol Ring'), ['Sol Ring']);

// searchWords
assert.deepEqual(searchWords('Relámpago encadenado RR'), ['encadenado', 'relampago']); // más largas primero
assert.deepEqual(searchWords('Sol Ring'), ['ring']);

// rankCards / displayNames
const bolt = { name: 'Lightning Bolt', printed_name: 'Rayo', lang: 'es', oracle_id: 'a' };
const chain = { name: 'Chain Lightning', printed_name: 'Relámpago encadenado', lang: 'es', oracle_id: 'b' };
const best = rankCards([bolt, chain], nameCandidates('Relampago encadenado RR'));
assert.equal(best.card.oracle_id, 'b');
assert.ok(best.score > 0.95);

const dfc = {
  name: 'Delver of Secrets // Insectile Aberration',
  lang: 'es',
  card_faces: [
    { name: 'Delver of Secrets', printed_name: 'Explorador de secretos', image_uris: { normal: 'http://img/front' } },
    { name: 'Insectile Aberration', printed_name: 'Aberración insectoide' },
  ],
};
assert.equal(rankCards([dfc], ['Explorador de secretos']).score, 1);
assert.deepEqual(displayNames(dfc), {
  en: 'Delver of Secrets // Insectile Aberration',
  es: 'Explorador de secretos // Aberración insectoide',
});
assert.equal(cardImage(dfc), 'http://img/front');
assert.deepEqual(displayNames({ name: 'Sol Ring', lang: 'en' }), { en: 'Sol Ring', es: null });

// boundedLevenshtein
assert.equal(boundedLevenshtein('kitten', 'sitting', 3), 3);
assert.equal(boundedLevenshtein('kitten', 'sitting', 2), 3); // k + 1 = "supera el tope"
assert.equal(boundedLevenshtein('abc', 'abc', 0), 0);
assert.equal(boundedLevenshtein('abc', 'abcdefgh', 2), 3);
assert.equal(boundedLevenshtein('x'.repeat(300), 'x'.repeat(299) + 'y', 2), 1); // más largo que el búfer inicial

// Diccionario local
const dict = {
  names: [
    'Lightning Bolt',
    'Chain Lightning',
    'Delver of Secrets // Insectile Aberration',
    'Sol Ring',
    'Island',
  ],
  es: [
    ['Rayo', 0],
    ['Relámpago encadenado', 1],
    ['Explorador de secretos // Aberración insectoide', 2],
    ['Anillo solar', 3],
    ['Isla', 4],
  ],
};
const idx = buildIndex(dict);
const look = (...c) => lookup(idx, c);

let h = look('Lightning Bolt');
assert.equal(h.nameEn, 'Lightning Bolt');
assert.equal(h.lang, 'en');
assert.equal(h.score, 1);
assert.equal(h.nameEs, 'Rayo'); // el nombre en español se conoce aunque se lea en inglés

h = look('Lightnlng Bolt'); // error de OCR
assert.equal(h.nameEn, 'Lightning Bolt');
assert.ok(h.score > 0.9 && h.score < 1);

h = look('Relampago encadenado RR', 'Relampago encadenado'); // sin acento y con basura de maná
assert.equal(h.lang, 'es');
assert.equal(h.nameEn, 'Chain Lightning');
assert.equal(h.nameEs, 'Relámpago encadenado');
assert.equal(h.score, 1);

h = look('Explorador de secretos'); // solo la cara frontal de una carta de dos caras
assert.equal(h.lang, 'es');
assert.equal(h.nameEn, 'Delver of Secrets // Insectile Aberration');
assert.equal(h.nameEs, 'Explorador de secretos // Aberración insectoide');

h = look('Delver of Secrets');
assert.equal(h.lang, 'en');
assert.equal(h.idx, 2);

h = look('Isla'); // no debe confundirse con "Island"
assert.equal(h.lang, 'es');
assert.equal(h.nameEn, 'Island');

assert.equal(look('Sol Ring').nameEs, 'Anillo solar');
assert.equal(look('xqzv wkj'), null);
assert.equal(look('Is'), null); // demasiado corto
assert.equal(look('Lightning'), null); // título incompleto: no llega al parecido mínimo

// Rendimiento con un diccionario del tamaño real (~65.000 claves sintéticas)
const rnd = (() => {
  let s = 12345;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
})();
const syl = ['ka', 'lo', 'mi', 'ra', 'ten', 'vo', 'shi', 'dor', 'an', 'el', 'gri', 'mus', 'ban', 'quel', 'zu'];
const word = () => Array.from({ length: 2 + Math.floor(rnd() * 2) }, () => syl[Math.floor(rnd() * syl.length)]).join('');
const fakeName = () => Array.from({ length: 2 + Math.floor(rnd() * 3) }, word).join(' ');
const big = { names: Array.from({ length: 32000 }, fakeName), es: [] };
big.es = Array.from({ length: 33000 }, (_, i) => [fakeName(), i % 32000]);
big.names[777] = 'Lightning Bolt';
const bigIdx = buildIndex(big);
const t0 = performance.now();
for (let i = 0; i < 20; i++) lookup(bigIdx, ['Lightnlng Bolt', 'Lightnlng']);
const perLookup = (performance.now() - t0) / 20;
console.log(`búsqueda en ${bigIdx.size} claves: ${perLookup.toFixed(1)} ms por lectura (2 candidatos)`);
assert.equal(lookup(bigIdx, ['Lightnlng Bolt']).idx, 777);

console.log('matching.js: todas las pruebas OK');
