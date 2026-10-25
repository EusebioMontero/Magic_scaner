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

console.log('matching.js: todas las pruebas OK');
