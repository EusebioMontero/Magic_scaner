// app.js — fase 1: una carta, cámara en vídeo, OCR del título (eng+spa) y
// resolución del nombre con Scryfall.
import {
  cleanOcr,
  nameCandidates,
  searchWords,
  rankCards,
  displayNames,
  cardImage,
} from './matching.js';

// ---- Parámetros ajustables -------------------------------------------------
const CARD_RATIO = 63 / 88; // proporción de una carta de Magic
// Franja del título, como fracción del marco de la carta.
// Se deja fuera la zona derecha (símbolos de maná).
const TITLE = { x: 0.05, y: 0.03, w: 0.75, h: 0.075 };
const MIN_CONF = 45; // confianza mínima del OCR (0-100) para consultar Scryfall
const CONFIRM_HITS = 2; // lecturas consecutivas iguales para dar la carta por buena
const FUZZY_MIN = 0.75; // parecido mínimo para aceptar el resultado inglés
const SEARCH_MIN = 0.7; // parecido mínimo para aceptar el resultado en español
const OCR_WIDTH = 900; // ancho objetivo (px) del recorte que se pasa al OCR

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

const state = {
  worker: null,
  stream: null,
  running: false,
  locked: false,
  guideRect: null,
  streak: { key: null, n: 0 },
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
  const k = Math.min(3, Math.max(0.5, OCR_WIDTH / w));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k);
  c.height = Math.round(h * k);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(video, x, y, w, h, 0, 0, c.width, c.height);
  return c;
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

// ---- OCR -------------------------------------------------------------------
async function initOcr() {
  setStatus('Cargando OCR (la primera vez descarga unos MB; luego queda en caché)…');
  state.worker = await Tesseract.createWorker(['eng', 'spa'], 1, {
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
}

async function ocr(canvas) {
  const t0 = performance.now();
  const { data } = await state.worker.recognize(canvas);
  return { text: data.text || '', conf: data.confidence || 0, ms: Math.round(performance.now() - t0) };
}

// ---- Scryfall --------------------------------------------------------------
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

async function resolveUncached(cleaned, trace) {
  const candidates = nameCandidates(cleaned);

  // 1) Inglés: búsqueda aproximada de Scryfall por nombre.
  for (const c of candidates) {
    const card = await scry('/cards/named?fuzzy=' + encodeURIComponent(c), trace);
    if (card && card.object === 'card') {
      const best = rankCards([card], candidates);
      if (best.score >= FUZZY_MIN) return { card, score: best.score, via: 'fuzzy (inglés)' };
    }
  }

  // 2) Español: se buscan impresiones en español que contengan las palabras más largas
  //    y se elige localmente la de nombre impreso más parecido.
  for (const w of searchWords(cleaned)) {
    const q = `lang:es name:"${w}"`;
    const list = await scry(
      '/cards/search?q=' + encodeURIComponent(q) + '&unique=cards&include_multilingual=true',
      trace
    );
    if (list && Array.isArray(list.data) && list.data.length) {
      const best = rankCards(list.data, candidates);
      if (best && best.score >= SEARCH_MIN) return { card: best.card, score: best.score, via: 'búsqueda (español)' };
    }
  }
  return null;
}

const cache = new Map();
async function resolve(cleaned, trace) {
  if (cache.has(cleaned)) return cache.get(cleaned);
  const res = await resolveUncached(cleaned, trace);
  cache.set(cleaned, res);
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return res;
}

// ---- Ciclo de lectura ------------------------------------------------------
async function readOnce(raw, invert) {
  const input = makeInput(raw, invert);
  preview.width = input.width;
  preview.height = input.height;
  preview.getContext('2d').drawImage(input, 0, 0);

  const r = await ocr(input);
  const cleaned = cleanOcr(r.text);
  const letters = (cleaned.match(/\p{L}/gu) || []).length;
  const trace = [];
  let found = null;
  if (r.conf >= MIN_CONF && letters >= 4) found = await resolve(cleaned, trace);
  return { r, cleaned, found, invert, trace };
}

async function tick() {
  const raw = grabTitle();
  if (!raw) return;

  let out = await readOnce(raw, false);
  if (!out.found) {
    // Algunos marcos llevan texto claro sobre fondo oscuro.
    const alt = await readOnce(raw, true);
    if (alt.found || alt.r.conf > out.r.conf) out = alt;
  }

  debugEl.textContent =
    `OCR: «${out.r.text.trim()}»\n` +
    `limpio: «${out.cleaned}»\n` +
    `confianza: ${Math.round(out.r.conf)} · ${out.r.ms} ms · invertido: ${out.invert}\n` +
    (out.found
      ? `resultado: ${out.found.card.name} [${out.found.card.lang}] · parecido ${out.found.score.toFixed(2)} · ${out.found.via}\n`
      : 'resultado: —\n') +
    (out.trace.length ? 'API:\n  ' + out.trace.join('\n  ') : 'API: (sin llamadas / en caché)');

  if (!out.found) {
    state.streak = { key: null, n: 0 };
    setStatus(out.cleaned ? `Leyendo… «${out.cleaned}»` : 'Encaja el título en la franja amarilla.');
    return;
  }

  const card = out.found.card;
  const key = card.oracle_id || card.name;
  state.streak = state.streak.key === key ? { key, n: state.streak.n + 1 } : { key, n: 1 };
  if (state.streak.n >= CONFIRM_HITS) {
    lock(out.found);
  } else {
    const { es, en } = displayNames(card);
    setStatus(`¿${es || en}? Confirmando…`);
  }
}

async function loop() {
  while (state.running) {
    if (state.locked || document.hidden) {
      await sleep(300);
      continue;
    }
    try {
      await tick();
    } catch (e) {
      setStatus(/Failed to fetch|NetworkError/i.test(String(e)) ? 'Sin conexión con Scryfall.' : 'Error: ' + e.message);
      await sleep(1500);
    }
    await sleep(150);
  }
}

// ---- Resultado -------------------------------------------------------------
function lock(found) {
  state.locked = true;
  guide.classList.add('ok');
  if (navigator.vibrate) navigator.vibrate(60);
  const { card } = found;
  const { en, es } = displayNames(card);
  $('nameMain').textContent = es || en;
  $('nameSub').textContent = es ? `EN: ${en}` : card.lang === 'en' ? 'Detectada en inglés' : '';
  $('meta').textContent = `Lectura en ${card.lang === 'es' ? 'español' : 'inglés'} · parecido ${Math.round(
    found.score * 100
  )} %`;
  const link = $('link');
  link.href = card.scryfall_uri || '#';
  const img = $('cardImg');
  img.src = cardImage(card) || '';
  $('result').hidden = false;
  againBtn.hidden = false;
  setStatus('Carta reconocida.');
}

function unlock() {
  state.locked = false;
  state.streak = { key: null, n: 0 };
  guide.classList.remove('ok');
  $('result').hidden = true;
  againBtn.hidden = true;
  setStatus('Encaja el título de la carta en la franja amarilla.');
}

againBtn.addEventListener('click', unlock);

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  try {
    await startCamera();
    layoutGuide();
    await initOcr();
    state.running = true;
    startBtn.hidden = true;
    setStatus('Encaja el título de la carta en la franja amarilla.');
    loop();
  } catch (e) {
    setStatus(friendlyError(e));
    startBtn.disabled = false;
  }
});
