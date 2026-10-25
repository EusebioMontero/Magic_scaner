// app.js — fase 1 (v0.2): una carta, cámara en vídeo, OCR del título y resolución del nombre.
// Con names.json (diccionario local) todo se resuelve en el móvil; sin él, usa la API de Scryfall.
import {
  cleanOcr,
  nameCandidates,
  searchWords,
  rankCards,
  displayNames,
  cardImage,
  buildIndex,
  lookup,
} from './matching.js';

const VERSION = 'v0.2';

// ---- Parámetros ajustables -------------------------------------------------
const CARD_RATIO = 63 / 88; // proporción de una carta de Magic
// Franja del título, como fracción del marco de la carta.
// Se deja fuera la zona derecha (símbolos de maná).
const TITLE = { x: 0.05, y: 0.03, w: 0.75, h: 0.075 };
const OCR_WIDTH = 560; // ancho objetivo (px) del recorte que se pasa al OCR
const OCR_LANGS_DICT = ['eng']; // con diccionario basta: los acentos se ignoran al comparar
const OCR_LANGS_API = ['eng', 'spa']; // sin diccionario, el modelo español ayuda con los acentos
const MIN_CONF_DICT = 30; // confianza mínima del OCR (0-100) para buscar en el diccionario
const MIN_CONF_API = 45; // ídem para consultar Scryfall
const DICT_MIN = 0.8; // parecido mínimo para aceptar una coincidencia del diccionario
const FAST_SCORE = 0.95; // coincidencia casi exacta → se da por buena con una sola lectura
const FAST_CONF = 60;
const FAST_LETTERS = 5;
const CONFIRM_HITS = 2; // en el resto de casos, lecturas consecutivas iguales
const FUZZY_MIN = 0.75; // modo API: parecido mínimo del resultado inglés
const SEARCH_MIN = 0.7; // modo API: parecido mínimo del resultado en español
const DARK_MEAN = 105; // brillo medio (0-255) por debajo del cual se prueba texto claro sobre oscuro
const STATIC_EPS = 4; // diferencia media entre fotogramas para considerar la escena "sin cambios"
const STATIC_FAILS = 2; // fallos seguidos sobre una escena quieta antes de dejar de leerla
const STATIC_RETRY_MS = 2000; // aun así, se reintenta cada tanto
const LOG_SIZE = 60; // ciclos que guarda el informe de depuración

// ---- Elementos y estado ----------------------------------------------------
const $ = (id) => document.getElementById(id);
const video = $('video');
const stage = $('stage');
const guide = $('guide');
const band = $('band');
const statusEl = $('status');
const debugEl = $('debug');
const preview = $('preview');
const startBtn = $('startBtn');
const againBtn = $('againBtn');
const copyBtn = $('copyBtn');
const COPY_LABEL = copyBtn.textContent;

const state = {
  worker: null,
  stream: null,
  running: false,
  locked: false,
  lockId: 0,
  guideRect: null,
  streak: { key: null, n: 0 },
  index: null, // diccionario local (si se pudo cargar)
  dictInfo: null,
  ocrLangs: [],
  lastSig: null,
  failsOnSig: 0,
  bias: false, // qué polaridad funcionó la última vez respecto a la heurística
  lastOcrAt: 0,
  log: [],
  timing: {},
  lastResult: null,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const setStatus = (t) => {
  statusEl.textContent = t;
};

// ---- Marco guía ------------------------------------------------------------
function layoutGuide() {
  const cw = stage.clientWidth;
  const ch = stage.clientHeight;
  const w = Math.min(cw * 0.86, ch * 0.92 * CARD_RATIO);
  const h = w / CARD_RATIO;
  const x = (cw - w) / 2;
  const y = (ch - h) / 2;
  state.guideRect = { x, y, w, h };
  Object.assign(guide.style, {
    left: x + 'px',
    top: y + 'px',
    width: w + 'px',
    height: h + 'px',
  });
  Object.assign(band.style, {
    left: TITLE.x * 100 + '%',
    top: TITLE.y * 100 + '%',
    width: TITLE.w * 100 + '%',
    height: TITLE.h * 100 + '%',
  });
}
window.addEventListener('resize', layoutGuide);
video.addEventListener('loadedmetadata', layoutGuide);

// ---- Cámara ----------------------------------------------------------------
async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('NO_MEDIA');
  }
  state.stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
  });
  video.srcObject = state.stream;
  await video.play();
  const track = state.stream.getVideoTracks()[0];
  try {
    await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
  } catch (_) {
    /* no todos los móviles lo soportan */
  }
  try {
    await navigator.wakeLock.request('screen');
  } catch (_) {
    /* opcional */
  }
}

function friendlyError(e) {
  if (e && e.message === 'NO_MEDIA')
    return 'El navegador no da acceso a la cámara: la página debe servirse por HTTPS.';
  if (e && e.name === 'NotAllowedError') return 'Permiso de cámara denegado. Actívalo en los ajustes del sitio.';
  if (e && e.name === 'NotFoundError') return 'No se ha encontrado ninguna cámara.';
  return 'Error: ' + (e && e.message ? e.message : e);
}

// ---- Recorte y preprocesado ------------------------------------------------
// Recorta del fotograma la franja del título, a resolución nativa.
function grabTitle() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !state.guideRect) return null;
  const cw = stage.clientWidth;
  const ch = stage.clientHeight;
  // El <video> usa object-fit: cover; se invierte esa transformación.
  const s = Math.max(cw / vw, ch / vh);
  const ox = (cw - vw * s) / 2;
  const oy = (ch - vh * s) / 2;
  const g = state.guideRect;
  const x = (g.x + g.w * TITLE.x - ox) / s;
  const y = (g.y + g.h * TITLE.y - oy) / s;
  const w = (g.w * TITLE.w) / s;
  const h = (g.h * TITLE.h) / s;
  const k = Math.min(3, Math.max(0.3, OCR_WIDTH / w));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k);
  c.height = Math.round(h * k);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(video, x, y, w, h, 0, 0, c.width, c.height);
  return c;
}

// Firma diminuta (48×8 en grises) para detectar si la escena ha cambiado y medir el brillo.
const sigCanvas = document.createElement('canvas');
sigCanvas.width = 48;
sigCanvas.height = 8;
const sigCtx = sigCanvas.getContext('2d', { willReadFrequently: true });
function signature(raw) {
  sigCtx.drawImage(raw, 0, 0, 48, 8);
  const d = sigCtx.getImageData(0, 0, 48, 8).data;
  const g = new Uint8Array(48 * 8);
  let sum = 0;
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const v = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    g[j] = v;
    sum += v;
  }
  return { g, mean: sum / g.length };
}
function sigDiff(a, b) {
  let s = 0;
  for (let i = 0; i < a.g.length; i++) s += Math.abs(a.g[i] - b.g[i]);
  return s / a.g.length;
}

// Escala de grises + estirado de contraste (percentiles 2 %-98 %), con inversión opcional.
function stretchContrast(d, total, invert) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const g = ((d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000) | 0;
    d[i] = g;
    hist[g]++;
  }
  let lo = 0;
  let hi = 255;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= total * 0.02) {
      lo = v;
      break;
    }
  }
  acc = 0;
  for (let v = 255; v >= 0; v--) {
    acc += hist[v];
    if (acc >= total * 0.02) {
      hi = v;
      break;
    }
  }
  const range = Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    let g = ((d[i] - lo) * 255) / range;
    g = g < 0 ? 0 : g > 255 ? 255 : g;
    if (invert) g = 255 - g;
    d[i] = d[i + 1] = d[i + 2] = g;
    d[i + 3] = 255;
  }
}

// Devuelve un lienzo "texto oscuro sobre fondo claro" con margen blanco.
function makeInput(raw, invert) {
  const c = document.createElement('canvas');
  c.width = raw.width;
  c.height = raw.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(raw, 0, 0);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  stretchContrast(img.data, c.width * c.height, invert);
  ctx.putImageData(img, 0, 0);

  const PAD = 16;
  const p = document.createElement('canvas');
  p.width = c.width + PAD * 2;
  p.height = c.height + PAD * 2;
  const pctx = p.getContext('2d');
  pctx.fillStyle = '#fff';
  pctx.fillRect(0, 0, p.width, p.height);
  pctx.drawImage(c, PAD, PAD);
  return p;
}

// ---- Diccionario local -----------------------------------------------------
async function loadDictionary() {
  const t0 = performance.now();
  try {
    const res = await fetch('names.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const dict = await res.json();
    state.index = buildIndex(dict);
    state.dictInfo = { date: dict.date, cards: dict.names.length, keys: state.index.size };
  } catch (e) {
    state.index = null;
    state.dictInfo = { error: String((e && e.message) || e) };
  }
  state.timing.dictMs = Math.round(performance.now() - t0);
}

// ---- OCR -------------------------------------------------------------------
async function initOcr() {
  const t0 = performance.now();
  state.ocrLangs = state.index ? OCR_LANGS_DICT : OCR_LANGS_API;
  setStatus('Cargando OCR (la primera vez descarga unos MB; luego queda en caché)…');
  state.worker = await Tesseract.createWorker(state.ocrLangs, 1, {
    logger: (m) => {
      if (m.status && typeof m.progress === 'number' && m.progress < 1) {
        setStatus(`Cargando OCR: ${m.status} ${Math.round(m.progress * 100)} %`);
      }
    },
  });
  await state.worker.setParameters({
    tessedit_pageseg_mode: '7', // una sola línea de texto
    preserve_interword_spaces: '1',
  });
  state.timing.ocrInitMs = Math.round(performance.now() - t0);
}

async function ocr(canvas) {
  const t0 = performance.now();
  const { data } = await state.worker.recognize(canvas);
  return { text: data.text || '', conf: data.confidence || 0, ms: Math.round(performance.now() - t0) };
}

// ---- Resolución del nombre -------------------------------------------------
// Resultado unificado: { key, nameEn, nameEs, lang, score, via, card }

function resolveLocal(cleaned) {
  const hit = lookup(state.index, nameCandidates(cleaned), DICT_MIN);
  if (!hit) return null;
  return {
    key: hit.nameEn,
    nameEn: hit.nameEn,
    nameEs: hit.nameEs,
    lang: hit.lang,
    score: hit.score,
    via: 'diccionario',
    card: null,
  };
}

// Respaldo sin diccionario: API de Scryfall.
let lastCall = 0;
async function scry(path, trace) {
  const wait = 110 - (Date.now() - lastCall); // cortesía: ~9 peticiones/s como máximo
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  trace.push(path);
  const res = await fetch('https://api.scryfall.com' + path, { headers: { Accept: 'application/json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Scryfall ' + res.status);
  return res.json();
}

function cardToFound(card, score, via) {
  const { en, es } = displayNames(card);
  return { key: card.oracle_id || card.name, nameEn: en, nameEs: es, lang: card.lang, score, via, card };
}

async function resolveApiUncached(cleaned, trace) {
  const candidates = nameCandidates(cleaned);

  // 1) Inglés: búsqueda aproximada de Scryfall por nombre.
  for (const c of candidates) {
    const card = await scry('/cards/named?fuzzy=' + encodeURIComponent(c), trace);
    if (card && card.object === 'card') {
      const best = rankCards([card], candidates);
      if (best.score >= FUZZY_MIN) return cardToFound(card, best.score, 'API fuzzy (inglés)');
    }
  }

  // 2) Español: impresiones en español con las palabras más largas; se elige la de nombre más parecido.
  for (const w of searchWords(cleaned)) {
    const q = `lang:es name:"${w}"`;
    const list = await scry(
      '/cards/search?q=' + encodeURIComponent(q) + '&unique=cards&include_multilingual=true',
      trace
    );
    if (list && Array.isArray(list.data) && list.data.length) {
      const best = rankCards(list.data, candidates);
      if (best && best.score >= SEARCH_MIN) return cardToFound(best.card, best.score, 'API búsqueda (español)');
    }
  }
  return null;
}

const apiCache = new Map();
async function resolveApi(cleaned, trace) {
  if (apiCache.has(cleaned)) return apiCache.get(cleaned);
  const res = await resolveApiUncached(cleaned, trace);
  apiCache.set(cleaned, res);
  if (apiCache.size > 200) apiCache.delete(apiCache.keys().next().value);
  return res;
}

async function resolve(cleaned, trace) {
  return state.index ? resolveLocal(cleaned) : resolveApi(cleaned, trace);
}

// ---- Registro de ciclos (para el informe de depuración) -------------------
function pushLog(entry) {
  state.log.push(entry);
  if (state.log.length > LOG_SIZE) state.log.shift();
}

// ---- Ciclo de lectura ------------------------------------------------------
async function readOnce(raw, invert) {
  const t1 = performance.now();
  const input = makeInput(raw, invert);
  preview.width = input.width;
  preview.height = input.height;
  preview.getContext('2d').drawImage(input, 0, 0);
  const prepMs = Math.round(performance.now() - t1);

  const r = await ocr(input);
  const cleaned = cleanOcr(r.text);
  const letters = (cleaned.match(/\p{L}/gu) || []).length;
  const trace = [];
  let found = null;
  const minConf = state.index ? MIN_CONF_DICT : MIN_CONF_API;
  if (r.conf >= minConf && letters >= 4) found = await resolve(cleaned, trace);
  return { r, cleaned, letters, found, invert, trace, prepMs };
}

// Devuelve 'idle' si no ha hecho OCR (para esperar más antes del siguiente ciclo).
async function tick() {
  const t0 = performance.now();
  const raw = grabTitle();
  if (!raw) return 'idle';

  // ¿Ha cambiado la escena? Si no y ya hemos probado ambas polaridades sin éxito, no se repite el OCR.
  const sig = signature(raw);
  const unchanged = !!state.lastSig && sigDiff(sig, state.lastSig) < STATIC_EPS;
  state.lastSig = sig;
  if (!unchanged) state.failsOnSig = 0;
  if (unchanged && state.failsOnSig >= STATIC_FAILS && t0 - state.lastOcrAt < STATIC_RETRY_MS) {
    pushLog({ ts: Date.now(), skipped: true });
    return 'idle';
  }

  // Un solo OCR por ciclo. Polaridad: heurística por brillo, ajustada por lo que funcionó
  // la última vez, y alternada cuando falla sobre una escena quieta.
  const heuristicInvert = sig.mean < DARK_MEAN;
  const invert = (heuristicInvert !== state.bias) !== (state.failsOnSig % 2 === 1);
  const out = await readOnce(raw, invert);
  state.lastOcrAt = performance.now();
  const tickMs = Math.round(state.lastOcrAt - t0);

  if (out.found) {
    state.failsOnSig = 0;
    state.bias = invert !== heuristicInvert; // la polaridad que ha funcionado, respecto a la heurística
  } else {
    state.failsOnSig += 1;
  }

  const found = out.found;
  const label = found ? (found.lang === 'es' ? found.nameEs : found.nameEn) || found.nameEn : null;
  pushLog({
    ts: Date.now(),
    raw: out.r.text.replace(/\s+/g, ' ').trim().slice(0, 60),
    cleaned: out.cleaned,
    conf: Math.round(out.r.conf),
    ocrMs: out.r.ms,
    prepMs: out.prepMs,
    tickMs,
    invert,
    api: out.trace.length,
    found: found ? { name: label, lang: found.lang, score: found.score, via: found.via } : null,
  });

  debugEl.textContent =
    `OCR: «${out.r.text.trim()}»\n` +
    `limpio: «${out.cleaned}»\n` +
    `confianza: ${Math.round(out.r.conf)} · OCR ${out.r.ms} ms · prep ${out.prepMs} ms · ciclo ${tickMs} ms · invertido: ${invert}\n` +
    (found
      ? `resultado: ${label} [${found.lang}] · parecido ${found.score.toFixed(2)} · ${found.via}\n`
      : 'resultado: —\n') +
    (out.trace.length ? 'API:\n  ' + out.trace.join('\n  ') : 'API: sin llamadas');

  if (!found) {
    state.streak = { key: null, n: 0 };
    setStatus(out.cleaned ? `Leyendo… «${out.cleaned}»` : 'Encaja el título en la franja amarilla.');
    return 'ran';
  }

  state.streak = state.streak.key === found.key ? { key: found.key, n: state.streak.n + 1 } : { key: found.key, n: 1 };
  const fast =
    found.via === 'diccionario' &&
    found.score >= FAST_SCORE &&
    out.letters >= FAST_LETTERS &&
    out.r.conf >= FAST_CONF;
  if (fast || state.streak.n >= CONFIRM_HITS) {
    lock(found, fast ? 'una lectura' : `${state.streak.n} lecturas`);
  } else {
    setStatus(`¿${label}? Confirmando…`);
  }
  return 'ran';
}

async function loop() {
  while (state.running) {
    if (state.locked || document.hidden) {
      await sleep(300);
      continue;
    }
    let result = 'ran';
    try {
      result = await tick();
    } catch (e) {
      setStatus(/Failed to fetch|NetworkError/i.test(String(e)) ? 'Sin conexión con Scryfall.' : 'Error: ' + e.message);
      await sleep(1500);
    }
    await sleep(result === 'idle' ? 250 : 60);
  }
}

// ---- Resultado -------------------------------------------------------------
function showCard(card) {
  const img = $('cardImg');
  const link = $('link');
  const src = card ? cardImage(card) : null;
  if (src) img.src = src;
  else img.removeAttribute('src');
  if (card && card.scryfall_uri) {
    link.href = card.scryfall_uri;
    link.hidden = false;
  } else {
    link.hidden = true;
  }
}

// Con el diccionario no hay carta de Scryfall todavía: se pide una vez, ya confirmado, para la imagen.
async function fillCardDetails(found, lockId) {
  try {
    const card = await scry('/cards/named?exact=' + encodeURIComponent(found.nameEn), []);
    if (card && card.object === 'card' && state.lockId === lockId) {
      found.card = card;
      showCard(card);
    }
  } catch (_) {
    /* la imagen es opcional */
  }
}

function lock(found, how) {
  state.locked = true;
  state.lockId += 1;
  state.lastResult = {
    name: found.lang === 'es' ? found.nameEs : found.nameEn,
    nameEn: found.nameEn,
    lang: found.lang,
    score: found.score,
    via: found.via,
    how,
    at: new Date().toISOString(),
  };
  guide.classList.add('ok');
  if (navigator.vibrate) navigator.vibrate(60);
  const es = found.lang === 'es';
  $('nameMain').textContent = (es ? found.nameEs : found.nameEn) || found.nameEn;
  $('nameSub').textContent = es ? `EN: ${found.nameEn}` : found.nameEs ? `ES: ${found.nameEs}` : 'Detectada en inglés';
  $('meta').textContent = `Leída en ${es ? 'español' : 'inglés'} · parecido ${Math.round(found.score * 100)} % · ${found.via} · ${how}`;
  showCard(found.card);
  $('result').hidden = false;
  againBtn.hidden = false;
  setStatus('Carta reconocida.');
  if (!found.card) fillCardDetails(found, state.lockId);
}

function unlock() {
  state.locked = false;
  state.lockId += 1; // invalida cualquier imagen que aún esté en camino
  state.streak = { key: null, n: 0 };
  guide.classList.remove('ok');
  $('result').hidden = true;
  againBtn.hidden = true;
  setStatus('Encaja el título de la carta en la franja amarilla.');
}

againBtn.addEventListener('click', unlock);

// ---- Informe de depuración -------------------------------------------------
function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function buildReport() {
  const ran = state.log.filter((e) => !e.skipped);
  const avg = (f) => (ran.length ? Math.round(ran.reduce((s, e) => s + f(e), 0) / ran.length) : '—');
  const dict = state.dictInfo
    ? state.dictInfo.error
      ? `no disponible (${state.dictInfo.error}) → modo API de Scryfall`
      : `${state.dictInfo.cards} cartas, ${state.dictInfo.keys} claves, generado ${state.dictInfo.date || '?'}, carga ${state.timing.dictMs} ms`
    : 'aún sin cargar';
  const lines = [
    `Escáner MTG ${VERSION} — informe de depuración`,
    `Fecha: ${new Date().toISOString()}`,
    `Navegador: ${navigator.userAgent}`,
    `Vídeo: ${video.videoWidth}x${video.videoHeight} · pantalla ${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio}x`,
    `Diccionario: ${dict}`,
    `OCR: idiomas ${state.ocrLangs.join('+') || '—'} · inicio ${state.timing.ocrInitMs ?? '—'} ms · recorte ${OCR_WIDTH} px · modo línea`,
    `Parámetros: DICT_MIN=${DICT_MIN} FAST_SCORE=${FAST_SCORE} FAST_CONF=${FAST_CONF} CONFIRM_HITS=${CONFIRM_HITS} MIN_CONF=${MIN_CONF_DICT}/${MIN_CONF_API} DARK_MEAN=${DARK_MEAN}`,
    `Último resultado: ${
      state.lastResult
        ? `${state.lastResult.name} [${state.lastResult.lang}] ${state.lastResult.score.toFixed(2)} · ${state.lastResult.via} · ${state.lastResult.how}`
        : '—'
    }`,
    '',
    `Resumen (últimos ${state.log.length} ciclos): con OCR ${ran.length} · saltados ${state.log.length - ran.length} · con resultado ${ran.filter((e) => e.found).length} · OCR medio ${avg((e) => e.ocrMs)} ms · ciclo medio ${avg((e) => e.tickMs)} ms · llamadas API ${ran.reduce((s, e) => s + e.api, 0)}`,
    '',
    'Ciclos (el más reciente primero):',
  ];
  for (const e of [...state.log].reverse()) {
    if (e.skipped) {
      lines.push(`${fmtTime(e.ts)} · saltado (escena sin cambios)`);
      continue;
    }
    const res = e.found ? `${e.found.name} [${e.found.lang}] ${e.found.score.toFixed(2)} ${e.found.via}` : '—';
    lines.push(
      `${fmtTime(e.ts)} · OCR ${e.ocrMs} ms · prep ${e.prepMs} ms · ciclo ${e.tickMs} ms · conf ${e.conf} · inv ${
        e.invert ? 'sí' : 'no'
      } · crudo «${e.raw}» · limpio «${e.cleaned}» → ${res}${e.api ? ` · API ${e.api}` : ''}`
    );
  }
  return lines.join('\n');
}

function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch (_) {
    /* sin permiso */
  }
  ta.remove();
  return ok;
}

copyBtn.addEventListener('click', async () => {
  const text = buildReport();
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch (_) {
    ok = legacyCopy(text);
  }
  copyBtn.textContent = ok ? 'Copiado ✔' : 'No se pudo copiar';
  setTimeout(() => {
    copyBtn.textContent = COPY_LABEL;
  }, 2000);
});

// ---- Arranque --------------------------------------------------------------
startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  try {
    await startCamera();
    layoutGuide();
    setStatus('Cargando diccionario…');
    await loadDictionary();
    await initOcr();
    state.running = true;
    startBtn.hidden = true;
    setStatus(
      (state.index ? '' : 'Sin names.json: usando la API de Scryfall (más lento). ') +
        'Encaja el título de la carta en la franja amarilla.'
    );
    loop();
  } catch (e) {
    setStatus(friendlyError(e));
    startBtn.disabled = false;
  }
});
