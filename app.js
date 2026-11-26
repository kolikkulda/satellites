// Satellites Overhead – satelity (hlavně Starlink) nad zvoleným místem v reálném čase.
// Dráhy: CelesTrak (OMM/JSON, SGP4 přes satellite.js). Brány: komunitní data (Hugging Face).
// Soukromí: poloha se nikam neposílá, výchozí region se odhaduje z časové zóny prohlížeče.
import * as S from './vendor/satellite.esm.js';
import { t, LANGS, detectLang, setLang, getLang, applyStatic } from './i18n.js';
import { TZ_REGIONS } from './tz-regions.js';
import { initGlobe } from './globe.js';

const R_EARTH = 6371.0;
const DEG = Math.PI / 180;
const GW_MIN_EL = 25;            // minimální elevace satelitu viděného z pozemní brány
const DATA_MAX_AGE = 2 * 3600e3; // CelesTrak data mění jednou za 2 h a častější stahování blokuje
const GW_MAX_AGE = 24 * 3600e3;
const AU_KM = 149597870.7;
const EYE_SUN_MAX = -6;          // Slunce aspoň 6° pod obzorem (občanský soumrak)
const EYE_SAT_MIN = 10;          // satelit aspoň 10° nad obzorem
const CACHE_NAME = 'satview-v1';
const $ = (id) => document.getElementById(id);
const store = {
  get() { try { return JSON.parse(localStorage.getItem('satview') || '{}'); } catch { return {}; } },
  set(v) { try { localStorage.setItem('satview', JSON.stringify(v)); } catch { /* soukromé okno */ } },
};

const gp = (group) => [{ name: 'CelesTrak GP', url: `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=json` }];
const GROUPS = [
  { key: 'starlink', color: '#5aa9ff', on: true, snapshot: 'data/starlink-snapshot.json', sources: [
      { name: 'CelesTrak SupGP (SpaceX)', url: 'https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?FILE=starlink&FORMAT=json' },
      ...gp('starlink')] },
  { key: 'oneweb', color: '#ffb547', sources: gp('oneweb') },
  { key: 'kuiper', color: '#7ee081', sources: gp('kuiper') },
  { key: 'stations', color: '#ff5d5d', sources: gp('stations') },
  { key: 'gps', color: '#ffe066', sources: gp('gps-ops') },
  { key: 'galileo', color: '#f5d76e', sources: gp('galileo') },
  { key: 'active', color: '#9aa3b5', sources: gp('active') },
];
const groupLabel = (k) => t('group.' + k);
const HF_SETS = ['juliensimon/starlink-ground-stations', '28hery/starlink-ground-stations'];

// ---------- výchozí region podle časové zóny (bez síťového dotazu) ----------
function regionFromTimezone() {
  let tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* nic */ }
  const r = TZ_REGIONS[tz];
  if (!r) return { lat: 30, lon: 10, kind: 'world', cc: null };
  return { lat: r[0], lon: r[1], kind: 'region', cc: r[2] };
}
const round2 = (x) => Math.round(x * 100) / 100; // ~1 km – dost pro satelity, méně prozradí

// ---------- stav ----------
const saved = store.get();
const region = regionFromTimezone();
const state = {
  obs: saved.obs && saved.obs.kind !== 'region' ? saved.obs : region,
  minEl: saved.minEl ?? 25,
  groups: saved.groups || GROUPS.filter(g => g.on).map(g => g.key),
  toggles: saved.toggles || {},
  customGws: saved.customGws || [],
  base: saved.base,
  dish: saved.dish || { on: false, az: null, el: null, fov: 100 },
  tab: saved.tab || 'sky',
  speed: 1, baseReal: Date.now(), baseSim: Date.now(),
  selected: null, picking: null, filter: '',
  eyeOnly: !!saved.eyeOnly, view: 'map',
};
setLang(detectLang(saved.lang));
const persist = () => store.set({
  obs: state.obs.kind === 'region' ? null : state.obs, minEl: state.minEl, groups: state.groups, toggles: state.toggles,
  customGws: state.customGws, base: state.base, dish: state.dish, tab: state.tab, lang: getLang(), eyeOnly: state.eyeOnly });
const simNow = () => new Date(state.baseSim + (Date.now() - state.baseReal) * state.speed);

let sats = [];
const groupData = {};
let gateways = [], pops = [];
let passes = [], passesFor = null;
let medianAlt = 550;
let candidates = [];
let sunEl = 0, eyeCount = 0;
let globe = null, globeLoading = false;

// ---------- formátování ----------
const nf = (d = 0) => new Intl.NumberFormat(getLang(), { maximumFractionDigits: d, minimumFractionDigits: d });
const fmtKm = (km) => nf(0).format(km) + ' km';
const fmtTime = (d) => d.toLocaleTimeString(getLang(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const compass = (az) => t('compass').split(',')[Math.round(az / 45) % 8];
const dayTag = (ms) => new Date(ms).toDateString() === simNow().toDateString() ? '' :
  new Date(ms).toLocaleDateString(getLang(), { day: 'numeric', month: 'numeric' }) + ' ';
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function countryName(cc) {
  try { return new Intl.DisplayNames([getLang()], { type: 'region' }).of(cc); } catch { return cc; }
}

// ---------- mapa ----------
const map = L.map('map', { worldCopyJump: true, minZoom: 2, zoomControl: true })
  .setView([state.obs.lat, state.obs.lon], state.obs.kind === 'world' ? 2 : 5);
const esri = (name, maxZoom = 16) => L.tileLayer(`https://server.arcgisonline.com/ArcGIS/rest/services/${name}/MapServer/tile/{z}/{y}/{x}`, {
  maxZoom, attribution: '&copy; Esri · <a href="https://celestrak.org">CelesTrak</a>' });
const BASES = {
  dark: L.layerGroup([esri('Canvas/World_Dark_Gray_Base'), esri('Canvas/World_Dark_Gray_Reference')]),
  sat: L.layerGroup([esri('World_Imagery', 18), esri('Reference/World_Boundaries_and_Places')]),
  osm: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · <a href="https://celestrak.org">CelesTrak</a>' }),
};
(BASES[state.base] || BASES.dark).addTo(map);
let layerCtl = null;
function buildLayerControl() {
  if (layerCtl) layerCtl.remove();
  const o = {}; for (const k of Object.keys(BASES)) o[t('base.' + k)] = BASES[k];
  layerCtl = L.control.layers(o, null, { position: 'topleft' }).addTo(map);
}
map.on('baselayerchange', e => { state.base = Object.keys(BASES).find(k => BASES[k] === e.layer); persist(); });

const obsMarker = L.marker([state.obs.lat, state.obs.lon], { draggable: true, zIndexOffset: 1000 }).addTo(map);
obsMarker.on('dragend', () => { const p = obsMarker.getLatLng(); setObserver(p.lat, p.lng, 'custom', false); });
const covCircle = L.circle([0, 0], { radius: 1, color: '#5aa9ff', weight: 1.5, dashArray: '6 6', fill: true, fillOpacity: 0.04, interactive: false });
const selCircle = L.circle([0, 0], { radius: 1, color: '#ffffff', weight: 1, opacity: 0.5, dashArray: '3 5', fill: false, interactive: false });
const gwLayer = L.layerGroup();
const popLayer = L.layerGroup();

const canvas = $('satCanvas');
const ctx = canvas.getContext('2d');
let screenPts = new Float32Array(0);
function resizeCanvas() {
  const r = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = r.width * dpr; canvas.height = r.height * dpr;
  canvas.style.width = r.width + 'px'; canvas.style.height = r.height + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// ---------- geometrie ----------
const normLon = (l) => ((((l + 180) % 360) + 360) % 360) - 180;
function centralAngle(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * DEG, p2 = lat2 * DEG, dl = (lon2 - lon1) * DEG;
  const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}
const elevFromCentral = (lambda, h) => Math.atan2(Math.cos(lambda) - R_EARTH / (R_EARTH + h), Math.sin(lambda)) / DEG;
const centralForElev = (h, el) => Math.acos(R_EARTH * Math.cos(el * DEG) / (R_EARTH + h)) - el * DEG;
const coverageRadius = (h, el) => R_EARTH * centralForElev(h, el);
function destination(lat, lon, bearing, ang) {
  const p1 = lat * DEG, l1 = lon * DEG, b = bearing * DEG;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(ang) + Math.cos(p1) * Math.sin(ang) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(ang) * Math.cos(p1), Math.cos(ang) - Math.sin(p1) * Math.sin(p2));
  return [p2 / DEG, l2 / DEG];
}
// směr na obloze (azimut, elevace) jako jednotkový vektor v soustavě východ–sever–nahoru
const enu = (az, el) => [Math.cos(el * DEG) * Math.sin(az * DEG), Math.cos(el * DEG) * Math.cos(az * DEG), Math.sin(el * DEG)];
const angBetween = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) / DEG;
function coneBoundary(az, el, half, steps = 72) {
  const b = enu(az, el);
  let u = [b[1], -b[0], 0]; // kolmice k ose v horizontální rovině
  const n = Math.hypot(...u); u = n < 1e-6 ? [1, 0, 0] : u.map(x => x / n);
  const v = [b[1] * u[2] - b[2] * u[1], b[2] * u[0] - b[0] * u[2], b[0] * u[1] - b[1] * u[0]];
  const c = Math.cos(half * DEG), s = Math.sin(half * DEG), out = [];
  for (let i = 0; i <= steps; i++) {
    const f = (i / steps) * 2 * Math.PI;
    const d = [0, 1, 2].map(k => c * b[k] + s * (Math.cos(f) * u[k] + Math.sin(f) * v[k]));
    out.push({ az: (Math.atan2(d[0], d[1]) / DEG + 360) % 360, el: Math.asin(Math.max(-1, Math.min(1, d[2]))) / DEG });
  }
  return out;
}

function starlinkShell(inc) {
  if (inc > 90) return { color: '#ff7ab6', name: t('shell.polar') };
  if (inc > 60) return { color: '#b48cff', name: '70°' };
  if (inc < 48) return { color: '#3dd6c6', name: '43°' };
  return { color: '#5aa9ff', name: '53°' };
}

// ---------- data ----------
async function cacheGet(key) {
  if (!('caches' in window)) return null;
  const c = await caches.open(CACHE_NAME);
  const r = await c.match('https://satview.local/' + key);
  if (!r) return null;
  return { data: await r.json(), fetchedAt: +r.headers.get('x-fetched-at'), source: decodeURIComponent(r.headers.get('x-source') || '') };
}
async function cachePut(key, data, source) {
  if (!('caches' in window)) return;
  const c = await caches.open(CACHE_NAME);
  await c.put('https://satview.local/' + key, new Response(JSON.stringify(data), { headers: {
    'content-type': 'application/json', 'x-fetched-at': String(Date.now()), 'x-source': encodeURIComponent(source) } }));
}

async function loadGroup(g, force = false) {
  const cached = await cacheGet('tle-' + g.key).catch(() => null);
  if (cached && !force && Date.now() - cached.fetchedAt < DATA_MAX_AGE) return cached;
  for (const src of g.sources) {
    try {
      const r = await fetch(src.url);
      if (!r.ok) continue;
      const txt = await r.text();
      if (!txt.trimStart().startsWith('[')) continue; // CelesTrak vrací text, když nová data ještě nejsou
      const data = JSON.parse(txt);
      if (!data.length) continue;
      await cachePut('tle-' + g.key, data, src.name).catch(() => {});
      return { data, fetchedAt: Date.now(), source: src.name };
    } catch { /* další zdroj */ }
  }
  if (cached) return { ...cached, stale: true };
  if (g.snapshot) {
    const data = await (await fetch(g.snapshot)).json();
    return { data, fetchedAt: null, source: 'snapshot', stale: true };
  }
  throw new Error(groupLabel(g.key));
}

function rebuildSats() {
  const byId = new Map();
  const prevSel = state.selected?.id;
  for (const g of GROUPS) {
    if (!state.groups.includes(g.key) || !groupData[g.key]) continue;
    for (const o of groupData[g.key].data) {
      const id = o.NORAD_CAT_ID;
      if (byId.has(id)) continue;
      let satrec;
      try { satrec = S.json2satrec(o); } catch { continue; }
      if (!satrec || satrec.error) continue;
      const name = o.OBJECT_NAME || ('#' + id);
      const isStarlink = /^STARLINK/i.test(name);
      byId.set(id, {
        id, name, cospar: o.OBJECT_ID, group: g.key, satrec, inc: o.INCLINATION, isStarlink,
        epoch: new Date((satrec.jdsatepoch + (satrec.jdsatepochF || 0) - 2440587.5) * 86400000),
        color: isStarlink ? starlinkShell(o.INCLINATION).color : g.color,
        lat: 0, lon: 0, alt: 0, vel: 0, el: -90, az: 0, range: 0, ok: false,
      });
    }
  }
  sats = [...byId.values()];
  sats.forEach((s, i) => { s.i = i; });
  state.selected = prevSel ? byId.get(prevSel) || null : null;
  updateChipCounts();
}

async function loadGroups(force = false) {
  const need = GROUPS.filter(g => state.groups.includes(g.key) && (force || !groupData[g.key]));
  await Promise.all(need.map(async g => {
    try { groupData[g.key] = await loadGroup(g, force); }
    catch (e) { console.warn(e); groupData[g.key] = null; }
  }));
  rebuildSats();
  tick(true);
  const alts = sats.filter(s => s.isStarlink && s.ok).map(s => s.alt).sort((a, b) => a - b);
  if (alts.length) medianAlt = alts[alts.length >> 1];
  updateCoverage();
}

async function loadGateways() {
  const snap = await (await fetch('data/ground-stations.json')).json();
  applyGateways(snap.gateways, snap.pops);
  let cached = await cacheGet('gateways').catch(() => null);
  if (!cached || Date.now() - cached.fetchedAt > GW_MAX_AGE) {
    try {
      const fresh = { gateways: [], pops: [] };
      for (const ds of HF_SETS) for (const cfg of ['gateways', 'pops']) {
        let off = 0, total = 1;
        while (off < total) {
          const r = await fetch(`https://datasets-server.huggingface.co/rows?dataset=${ds}&config=${cfg}&split=train&offset=${off}&length=100`);
          if (!r.ok) throw new Error(r.status);
          const j = await r.json();
          total = j.num_rows_total; off += 100;
          fresh[cfg].push(...j.rows.map(x => x.row));
        }
      }
      await cachePut('gateways', fresh, 'Hugging Face');
      cached = { data: fresh };
    } catch (e) { console.warn('Gateways: live refresh failed, using snapshot', e); }
  }
  if (cached) applyGateways([...snap.gateways, ...cached.data.gateways], [...snap.pops, ...cached.data.pops]);
}

function applyGateways(gwList, popList) {
  const m = new Map();
  for (const g of gwList) {
    if (!isFinite(g.lat) || !isFinite(g.lon) || !g.name) continue;
    m.set(g.name.toLowerCase().trim(), { name: g.name, lat: g.lat, lon: g.lon, status: g.status || 'operational' });
  }
  gateways = [...m.values()];
  const pm = new Map();
  for (const p of popList) {
    const name = p.name || p.city;
    if (!name || !isFinite(p.lat)) continue;
    pm.set(name, { name, lat: p.lat, lon: p.lon, country: p.country });
  }
  pops = [...pm.values()];
  renderGatewayMarkers();
}
const allGateways = () => [...gateways, ...state.customGws.map(g => ({ ...g, status: 'custom' }))];

function renderGatewayMarkers() {
  gwLayer.clearLayers(); popLayer.clearLayers();
  for (const g of allGateways()) {
    if (g.status === 'planned' && !state.toggles.gwPlanned) continue;
    const color = g.status === 'custom' ? '#4ade80' : '#ff8c42';
    L.circleMarker([g.lat, g.lon], {
      radius: 5, color, weight: 2, fillColor: color, fillOpacity: g.status === 'planned' ? 0 : 0.85,
      dashArray: g.status === 'planned' ? '2 3' : null, bubblingMouseEvents: false,
    }).bindPopup(() => gatewayPopup(g)).addTo(gwLayer);
  }
  for (const p of pops) {
    L.circleMarker([p.lat, p.lon], { radius: 4, color: '#c084fc', weight: 2, fillOpacity: 0.3, bubblingMouseEvents: false })
      .bindPopup(`<b>${esc(t('pop.name', { name: p.name }))}</b>${p.country ? ' (' + esc(p.country) + ')' : ''}<br>${esc(t('pop.popup'))}`)
      .addTo(popLayer);
  }
  renderNearGateways();
  globe?.setGateways(allGateways().filter(g => g.status !== 'planned' || state.toggles.gwPlanned));
}

function gatewayPopup(g) {
  const d = centralAngle(state.obs.lat, state.obs.lon, g.lat, g.lon) * R_EARTH;
  const n = sats.filter(s => s.ok && s.isStarlink && satSeesPoint(s, g.lat, g.lon, GW_MIN_EL)).length;
  return `<b>${esc(g.name)}</b><br>${esc(t('gw.popupKind', { status: t('gw.' + g.status) }))}<br>` +
    `${g.lat.toFixed(3)}, ${g.lon.toFixed(3)}<br>${esc(t('gw.popupDist', { d: fmtKm(d) }))}<br>` +
    esc(t('gw.popupSats', { el: GW_MIN_EL, n }));
}
function satSeesPoint(s, lat, lon, minEl) {
  const lam = centralAngle(s.lat, s.lon, lat, lon);
  if (lam > 0.35) return false;
  return elevFromCentral(lam, s.alt) >= minEl;
}

// ---------- anténa ----------
function dishParams() {
  const d = state.dish;
  return { az: d.az ?? (state.obs.lat >= 0 ? 0 : 180), el: d.el ?? 65, fov: d.fov || 100 };
}
function computeCandidates() {
  if (!state.dish.on) { candidates = []; return; }
  const p = dishParams(), axis = enu(p.az, p.el);
  candidates = [];
  for (const s of sats) {
    if (!s.ok || !s.isStarlink || s.el < state.minEl) continue;
    const off = angBetween(axis, enu(s.az, s.el));
    if (off <= p.fov / 2) candidates.push({ s, off });
  }
  candidates.sort((a, b) => a.off - b.off);
}
function handoverInfo(date) {
  const sec = (date.getTime() / 1000) % 60;
  let rem = (((12 - sec) % 15) + 15) % 15; // přepnutí v sekundách :12, :27, :42, :57
  if (rem < 0.05) rem = 15;
  return rem;
}

// ---------- Slunce a viditelnost okem ----------
function sunAt(date) {
  const r = S.sunPos(S.jday(date)).rsun; // AU v ECI
  const eciKm = { x: r.x * AU_KM, y: r.y * AU_KM, z: r.z * AU_KM };
  const la = S.ecfToLookAngles({ latitude: state.obs.lat * DEG, longitude: state.obs.lon * DEG, height: 0 }, S.eciToEcf(eciKm, S.gstime(date)));
  return { rsun: r, el: la.elevation / DEG };
}
// 'eye' = viditelný okem, 'day' = na slunci, ale u pozorovatele je den, 'low' = na slunci, ale nízko, 'shadow' = ve stínu Země
function lightState(sun, eci, el) {
  if (S.shadowFraction(sun.rsun, eci) >= 0.5) return 'shadow';
  if (sun.el > EYE_SUN_MAX) return 'day';
  return el >= EYE_SAT_MIN ? 'eye' : 'low';
}

// ---------- výpočet poloh ----------
function propagateAll(date) {
  const gmst = S.gstime(date);
  const o = state.obs;
  const obsGd = { latitude: o.lat * DEG, longitude: o.lon * DEG, height: 0.3 };
  for (const s of sats) {
    const pv = S.propagate(s.satrec, date);
    if (!pv || !pv.position || isNaN(pv.position.x)) { s.ok = false; continue; }
    const gd = S.eciToGeodetic(pv.position, gmst);
    s.lat = gd.latitude / DEG; s.lon = normLon(gd.longitude / DEG); s.alt = gd.height;
    if (s.alt < 80) { s.ok = false; continue; }
    s.ok = true; s.eci = pv.position; s.light = null;
    if (globe) s.ecf = S.eciToEcf(pv.position, gmst);
    const v = pv.velocity; s.vel = Math.hypot(v.x, v.y, v.z);
    const lam = centralAngle(o.lat, o.lon, s.lat, s.lon);
    if (lam > Math.acos(R_EARTH / (R_EARTH + s.alt)) + 0.01) { s.el = -90; continue; }
    const la = S.ecfToLookAngles(obsGd, S.eciToEcf(pv.position, gmst));
    s.el = la.elevation / DEG; s.az = la.azimuth / DEG; s.range = la.rangeSat;
  }
  const sun = sunAt(date);
  sunEl = sun.el; eyeCount = 0;
  for (const s of sats) {
    if (!s.ok || s.el < 0) continue;
    s.light = lightState(sun, s.eci, s.el);
    if (s.light === 'eye') eyeCount++;
  }
}
function lookAt(s, date) {
  const pv = S.propagate(s.satrec, date);
  if (!pv || !pv.position) return null;
  const la = S.ecfToLookAngles({ latitude: state.obs.lat * DEG, longitude: state.obs.lon * DEG, height: 0.3 }, S.eciToEcf(pv.position, S.gstime(date)));
  return { el: la.elevation / DEG, az: la.azimuth / DEG, eci: pv.position };
}
function computePasses(s, from) {
  const out = [], step = 20e3, end = from.getTime() + 24 * 3600e3;
  let cur = null;
  for (let tm = from.getTime() - 15 * 60e3; tm < end && out.length < 6; tm += step) {
    const l = lookAt(s, new Date(tm));
    if (!l) break;
    if (l.el >= 0) {
      if (!cur) cur = { start: null, end: null, maxEl: -90, track: [], eye: false };
      cur.track.push({ az: l.az, el: l.el, t: tm });
      if (!cur.eye && l.el >= EYE_SAT_MIN && l.eci) {
        const d = new Date(tm);
        if (lightState(sunAt(d), l.eci, l.el) === 'eye') cur.eye = true;
      }
      if (l.el >= state.minEl) { if (!cur.start) cur.start = tm; cur.end = tm; }
      if (l.el > cur.maxEl) cur.maxEl = l.el;
    } else if (cur) {
      if (cur.start && cur.end >= from.getTime()) out.push(cur);
      cur = null;
    }
  }
  if (cur && cur.start) out.push(cur);
  return out;
}
function groundTrack(s, date) {
  const period = (2 * Math.PI / s.satrec.no) * 60e3;
  const pts = [];
  let prev = null, offset = 0;
  for (let dt = -0.35 * period; dt <= period; dt += 30e3) {
    const d = new Date(date.getTime() + dt);
    const pv = S.propagate(s.satrec, d);
    if (!pv || !pv.position) continue;
    const gd = S.eciToGeodetic(pv.position, S.gstime(d));
    let lon = normLon(gd.longitude / DEG);
    if (prev !== null) { const diff = lon + offset - prev; if (diff > 180) offset -= 360; else if (diff < -180) offset += 360; }
    lon += offset; prev = lon;
    pts.push([gd.latitude / DEG, lon]);
  }
  return pts;
}

// ---------- kreslení mapy ----------
let trackCache = { id: null, at: 0, pts: [] };
function draw() {
  const size = map.getSize();
  ctx.clearRect(0, 0, size.x, size.y);
  if (!sats.length) return;
  const W = 256 * Math.pow(2, map.getZoom());
  const minEl = state.minEl, T = state.toggles;
  const pt = (lat, lon) => map.latLngToContainerPoint([lat, lon]);
  const copies = (x, fn) => {
    const k0 = Math.ceil((-30 - x) / W), k1 = Math.floor((size.x + 30 - x) / W);
    for (let k = k0; k <= k1; k++) fn(x + k * W);
  };
  if (screenPts.length !== sats.length * 2) screenPts = new Float32Array(sats.length * 2);
  const obsP = pt(state.obs.lat, state.obs.lon);
  const visible = [];

  // zorné pole antény promítnuté na zem (kde musí být satelit, aby ho anténa viděla)
  if (state.dish.on) {
    const p = dishParams();
    const ring = coneBoundary(p.az, p.el, p.fov / 2, 90).map(d => {
      const e = Math.max(d.el, minEl);
      const [la, lo] = destination(state.obs.lat, state.obs.lon, d.az, centralForElev(medianAlt, e));
      let dl = lo - state.obs.lon; dl -= Math.round(dl / 360) * 360;
      return pt(la, state.obs.lon + dl);
    });
    copies(0, off => {
      ctx.beginPath();
      ring.forEach((q, j) => j ? ctx.lineTo(q.x + off, q.y) : ctx.moveTo(q.x + off, q.y));
      ctx.closePath();
      ctx.fillStyle = 'rgba(255,209,102,0.08)'; ctx.fill();
      ctx.strokeStyle = 'rgba(255,209,102,0.7)'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]); ctx.stroke(); ctx.setLineDash([]);
    });
  }

  ctx.globalAlpha = 0.55;
  for (let i = 0; i < sats.length; i++) {
    const s = sats[i];
    if (!s.ok) { screenPts[i * 2] = NaN; continue; }
    const p = pt(s.lat, s.lon);
    screenPts[i * 2] = p.x; screenPts[i * 2 + 1] = p.y;
    if (s.el >= 0) { visible.push(s); continue; }
    if (!T.dim) continue;
    ctx.fillStyle = s.color;
    copies(p.x, x => ctx.fillRect(x - 1, p.y - 1, 2, 2));
  }
  ctx.globalAlpha = 1;

  const sel = state.selected;
  if (sel && sel.ok) {
    if (trackCache.id !== sel.id || Date.now() - trackCache.at > 20000 || state.speed > 1) {
      trackCache = { id: sel.id, at: Date.now(), pts: groundTrack(sel, simNow()) };
    }
    const tp = trackCache.pts.map(([la, lo]) => pt(la, lo));
    for (const k of [-1, 0, 1]) {
      ctx.beginPath();
      tp.forEach((q, j) => j ? ctx.lineTo(q.x + k * W, q.y) : ctx.moveTo(q.x + k * W, q.y));
      ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 5]); ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  const above = visible.filter(s => s.el >= minEl);
  const linkSats = T.links ? above.filter(s => s.isStarlink) : [];
  if (sel && sel.isStarlink && sel.ok && !linkSats.includes(sel)) linkSats.push(sel);
  if (state.dish.on && candidates[0] && !linkSats.includes(candidates[0].s)) linkSats.push(candidates[0].s);
  const gws = allGateways().filter(g => g.status !== 'planned' || T.gwPlanned);
  const activeGw = new Set();
  for (const s of linkSats) {
    const sx = screenPts[s.i * 2], sy = screenPts[s.i * 2 + 1];
    const strong = s === sel || (candidates[0] && s === candidates[0].s);
    for (const g of gws) {
      if (!satSeesPoint(s, g.lat, g.lon, GW_MIN_EL)) continue;
      activeGw.add(g);
      const gp = pt(g.lat, g.lon);
      let dx = gp.x - sx; dx -= Math.round(dx / W) * W;
      ctx.strokeStyle = strong ? 'rgba(255,170,90,0.95)' : 'rgba(255,140,66,0.22)';
      ctx.lineWidth = strong ? 2 : 1;
      copies(sx, x => { ctx.beginPath(); ctx.moveTo(x, sy); ctx.lineTo(x + dx, gp.y); ctx.stroke(); });
    }
  }
  for (const g of activeGw) {
    const gp = pt(g.lat, g.lon);
    ctx.strokeStyle = '#ffb27a'; ctx.lineWidth = 2;
    copies(gp.x, x => { ctx.beginPath(); ctx.arc(x, gp.y, 10, 0, Math.PI * 2); ctx.stroke(); });
  }

  if (T.rays) {
    for (const s of above) {
      let dx = screenPts[s.i * 2] - obsP.x; dx -= Math.round(dx / W) * W;
      ctx.strokeStyle = s === sel ? 'rgba(255,255,255,0.95)' : 'rgba(140,198,255,0.28)';
      ctx.lineWidth = s === sel ? 2 : 1;
      copies(obsP.x, x => { ctx.beginPath(); ctx.moveTo(x, obsP.y); ctx.lineTo(x + dx, screenPts[s.i * 2 + 1]); ctx.stroke(); });
    }
  }

  for (const s of visible) {
    const x0 = screenPts[s.i * 2], y = screenPts[s.i * 2 + 1], good = s.el >= minEl;
    copies(x0, x => {
      ctx.fillStyle = s.color;
      if (good) {
        ctx.shadowColor = s.color; ctx.shadowBlur = 10;
        ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();
      } else {
        ctx.globalAlpha = 0.85; ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
      }
    });
  }

  // kandidáti pro anténu
  candidates.forEach(({ s }, idx) => {
    copies(screenPts[s.i * 2], x => {
      const y = screenPts[s.i * 2 + 1];
      ctx.strokeStyle = '#ffd166'; ctx.lineWidth = idx === 0 ? 3 : 1.5;
      ctx.beginPath(); ctx.arc(x, y, idx === 0 ? 11 : 7, 0, Math.PI * 2); ctx.stroke();
    });
  });

  const label = (s, x, y) => {
    ctx.font = '600 12px Inter, -apple-system, system-ui, sans-serif'; ctx.fillStyle = '#fff';
    ctx.shadowColor = '#000'; ctx.shadowBlur = 4; ctx.fillText(s.name, x + 14, y + 4); ctx.shadowBlur = 0;
  };
  if (state.dish.on && candidates[0] && candidates[0].s !== sel) {
    const s = candidates[0].s; copies(screenPts[s.i * 2], x => label(s, x, screenPts[s.i * 2 + 1]));
  }
  if (sel && sel.ok) {
    copies(screenPts[sel.i * 2], x => {
      const y = screenPts[sel.i * 2 + 1];
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = sel.color; ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
      label(sel, x, y);
    });
  }
}

// ---------- obloha ----------
const sky = $('skyCanvas'), sctx = sky.getContext('2d');
let skyPts = [];
function drawSky() {
  const Wc = sky.clientWidth;
  if (!Wc) return;
  const dpr = window.devicePixelRatio || 1;
  if (sky.width !== Math.round(Wc * dpr)) { sky.width = Math.round(Wc * dpr); sky.height = Math.round(Wc * dpr); }
  sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const c = Wc / 2, r = c - 15;
  sctx.clearRect(0, 0, Wc, Wc);
  const toXY = (az, el) => { const rr = r * (90 - el) / 90; return [c + rr * Math.sin(az * DEG), c - rr * Math.cos(az * DEG)]; };
  const minR = r * (90 - state.minEl) / 90;
  sctx.fillStyle = '#0a1324'; sctx.beginPath(); sctx.arc(c, c, r, 0, Math.PI * 2); sctx.fill();
  sctx.fillStyle = 'rgba(90,169,255,0.08)'; sctx.beginPath(); sctx.arc(c, c, minR, 0, Math.PI * 2); sctx.fill();
  sctx.strokeStyle = '#2a3956'; sctx.lineWidth = 1;
  for (const el of [0, 30, 60]) { sctx.beginPath(); sctx.arc(c, c, r * (90 - el) / 90, 0, Math.PI * 2); sctx.stroke(); }
  sctx.beginPath(); sctx.moveTo(c - r, c); sctx.lineTo(c + r, c); sctx.moveTo(c, c - r); sctx.lineTo(c, c + r); sctx.stroke();
  sctx.setLineDash([4, 4]); sctx.strokeStyle = '#5aa9ff';
  sctx.beginPath(); sctx.arc(c, c, minR, 0, Math.PI * 2); sctx.stroke(); sctx.setLineDash([]);

  if (state.dish.on) {
    const p = dishParams();
    const ring = coneBoundary(p.az, p.el, p.fov / 2, 90).map(d => toXY(d.az, Math.max(d.el, 0)));
    sctx.save(); sctx.beginPath(); sctx.arc(c, c, r, 0, Math.PI * 2); sctx.clip();
    sctx.beginPath(); ring.forEach(([x, y], j) => j ? sctx.lineTo(x, y) : sctx.moveTo(x, y)); sctx.closePath();
    sctx.fillStyle = 'rgba(255,209,102,0.12)'; sctx.fill();
    sctx.strokeStyle = 'rgba(255,209,102,0.8)'; sctx.setLineDash([5, 3]); sctx.stroke(); sctx.setLineDash([]);
    const [bx, by] = toXY(p.az, p.el);
    sctx.fillStyle = '#ffd166'; sctx.beginPath(); sctx.moveTo(bx - 5, by); sctx.lineTo(bx + 5, by); sctx.moveTo(bx, by - 5); sctx.lineTo(bx, by + 5);
    sctx.strokeStyle = '#ffd166'; sctx.lineWidth = 2; sctx.stroke(); sctx.lineWidth = 1;
    sctx.restore();
  }

  const cmp = t('compass').split(',');
  sctx.fillStyle = '#8b97ad'; sctx.font = '600 11px Inter, system-ui'; sctx.textAlign = 'center'; sctx.textBaseline = 'middle';
  sctx.fillText(cmp[0], c, 7); sctx.fillText(cmp[4], c, Wc - 7); sctx.fillText(cmp[2], Wc - 7, c); sctx.fillText(cmp[6], 7, c);
  sctx.font = '9px Inter, system-ui'; sctx.fillText('30°', c + 10, c - r * 60 / 90 + 7); sctx.fillText('60°', c + 10, c - r * 30 / 90 + 7);

  const sel = state.selected;
  if (sel && passes.length) {
    const now = simNow().getTime();
    const p = passes.find(q => q.track[q.track.length - 1].t >= now);
    if (p) {
      sctx.strokeStyle = 'rgba(255,255,255,0.6)'; sctx.setLineDash([3, 3]); sctx.beginPath();
      p.track.forEach((q, j) => { const [x, y] = toXY(q.az, q.el); j ? sctx.lineTo(x, y) : sctx.moveTo(x, y); });
      sctx.stroke(); sctx.setLineDash([]);
    }
  }
  skyPts = [];
  for (const s of sats) {
    if (!s.ok || s.el < 0) continue;
    const [x, y] = toXY(s.az, s.el);
    skyPts.push([x, y, s]);
    const good = s.el >= state.minEl;
    sctx.fillStyle = s.color; sctx.globalAlpha = good ? 1 : 0.45;
    sctx.beginPath(); sctx.arc(x, y, good ? 3.2 : 2, 0, Math.PI * 2); sctx.fill();
    if (s.light === 'eye') { sctx.globalAlpha = 1; sctx.strokeStyle = '#9be7ff'; sctx.lineWidth = 1; sctx.beginPath(); sctx.arc(x, y, 5, 0, Math.PI * 2); sctx.stroke(); }
  }
  sctx.globalAlpha = 1;
  candidates.forEach(({ s }, idx) => {
    const [x, y] = toXY(s.az, s.el);
    sctx.strokeStyle = '#ffd166'; sctx.lineWidth = idx === 0 ? 2.5 : 1.2;
    sctx.beginPath(); sctx.arc(x, y, idx === 0 ? 7 : 5, 0, Math.PI * 2); sctx.stroke();
  });
  if (sel && sel.ok && sel.el >= 0) {
    const [x, y] = toXY(sel.az, sel.el);
    sctx.strokeStyle = '#fff'; sctx.lineWidth = 2; sctx.beginPath(); sctx.arc(x, y, 8, 0, Math.PI * 2); sctx.stroke();
  }
}
sky.addEventListener('click', (e) => {
  const b = sky.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top;
  let best = null, bd = 12;
  for (const [px, py, s] of skyPts) { const d = Math.hypot(px - x, py - y); if (d < bd) { bd = d; best = s; } }
  if (best) selectSat(best, true);
});

// ---------- panel ----------
function renderLocation() {
  const o = state.obs;
  const kind = { region: 'loc.region', precise: 'loc.precise', custom: 'loc.custom', world: 'loc.world' }[o.kind] || 'loc.custom';
  $('locKind').textContent = t(kind);
  $('locName').textContent = o.kind === 'region' ? countryName(o.cc) : o.kind === 'world' ? '—' :
    (o.name ? o.name + ' · ' : '') + `${nf(2).format(o.lat)}°, ${nf(2).format(o.lon)}°`;
  $('lat').value = o.kind === 'world' ? '' : o.lat; $('lon').value = o.kind === 'world' ? '' : o.lon;
  const region = o.kind === 'region' || o.kind === 'world';
  obsMarker.setIcon(L.divIcon({ className: '', html: `<div class="obs-icon${region ? ' region' : ''}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] }));
  obsMarker.unbindTooltip().bindTooltip(t(region ? 'obs.regionTooltip' : 'obs.tooltip'), { direction: 'top', offset: [0, -10] });
  $('btnForget').hidden = region;
  $('dishNeedLoc').hidden = !(state.dish.on && region);
}

function renderTable() {
  const f = state.filter.trim().toLowerCase();
  const vis = sats.filter(s => s.ok && s.el >= 0).sort((a, b) => b.el - a.el);
  const good = vis.filter(s => s.el >= state.minEl);
  $('stGood').textContent = good.length;
  $('stGoodL').textContent = t('stat.good', { minEl: state.minEl });
  $('stStarlink').textContent = good.filter(s => s.isStarlink).length;
  $('stHorizon').textContent = vis.length;
  const eyeB = (s) => s.light === 'eye' ? `<span class="eye">${esc(t('vis.badge'))}</span>` : '';
  $('sunInfo').textContent = t('vis.sun', { el: nf(0).format(sunEl) });
  $('eyeTip').hidden = !state.eyeOnly;
  let rows;
  if (state.eyeOnly && !f) {
    rows = vis.filter(s => s.light === 'eye');
    $('visHint').textContent = rows.length ? t('sky.dimHint') : t('vis.none');
  } else if (f) {
    rows = sats.filter(s => s.name.toLowerCase().includes(f) || String(s.id) === f)
      .sort((a, b) => (b.ok ? b.el : -999) - (a.ok ? a.el : -999)).slice(0, 200);
    $('visHint').textContent = t('sky.searchAll', { n: nf(0).format(sats.length) });
  } else {
    rows = vis.slice(0, 250);
    $('visHint').textContent = t('sky.dimHint');
  }
  $('visTable').tBodies[0].innerHTML = rows.map(s => {
    const up = s.ok && s.el >= 0;
    return `<tr data-id="${s.id}" class="${s === state.selected ? 'sel' : ''} ${!up || s.el < state.minEl ? 'low' : ''}">` +
      `<td><span class="dot" style="background:${s.color}"></span>${esc(s.name)}${eyeB(s)}</td>` +
      (up ? `<td>${nf(1).format(s.el)}°</td><td>${Math.round(s.az)}° ${compass(s.az)}</td><td>${fmtKm(s.range)}</td>`
          : `<td colspan="3" class="muted">${esc(t('sky.below'))}</td>`) + '</tr>';
  }).join('');
}

function launchInfo(cospar) {
  const m = /^(\d{4})-(\d{3})/.exec(cospar || '');
  return m ? t('sel.launchVal', { year: m[1], n: +m[2] }) : '–';
}
function renderSelected() {
  const s = state.selected;
  $('selCard').hidden = !s;
  if (!s) return;
  $('selName').textContent = s.name;
  $('selDot').style.background = s.color;
  const ageH = (simNow() - s.epoch) / 3600e3;
  const rows = [
    [t('sel.ids'), `${s.id} · ${esc(s.cospar || '–')}`],
    [t('sel.group'), esc(groupLabel(s.group)) + (s.isStarlink ? ' · ' + esc(t('sel.shell', { s: starlinkShell(s.inc).name })) : '')],
    [t('sel.launch'), esc(launchInfo(s.cospar))],
    [t('sel.pos'), s.ok ? `${nf(2).format(s.lat)}°, ${nf(2).format(s.lon)}°` : esc(t('sel.offOrbit'))],
    [t('sel.alt'), s.ok ? fmtKm(s.alt) : '–'],
    [t('sel.speed'), s.ok ? `${nf(2).format(s.vel)} ${t('unit.kms')} (${nf(0).format(s.vel * 3600)} ${t('unit.kmh')})` : '–'],
    [t('sel.inc'), `${nf(2).format(s.inc)}°`],
    [t('sel.fromYou'), s.ok && s.el > -90 && s.el >= 0
      ? esc(t('sel.fromYouVal', { el: nf(1).format(s.el), az: Math.round(s.az), dir: compass(s.az), range: nf(0).format(s.range) }))
      : esc(t('sel.belowHorizon'))],
    [t('sel.age'), esc(t('sel.hours', { h: nf(1).format(ageH) }))],
  ];
  let dishRow = '';
  if (state.dish.on && s.isStarlink) {
    const yes = candidates.some(c => c.s === s);
    dishRow = `<dt>${esc(t('sel.dish'))}</dt><dd class="${yes ? 'yes' : ''}">${esc(t(yes ? 'sel.dishYes' : 'sel.dishNo'))}</dd>`;
  }
  let eyeRow = '';
  if (s.ok && s.el >= 0 && s.light) {
    const key = { eye: 'vis.yes', day: 'vis.sunlit', low: 'vis.low', shadow: 'vis.shadow' }[s.light];
    eyeRow = `<dt>${esc(t('vis.row'))}</dt><dd class="${s.light === 'eye' ? 'eyeyes' : ''}">${esc(t(key))}</dd>`;
  }
  $('selInfo').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('') + eyeRow + dishRow;

  $('selPassesT').textContent = t('sel.passes', { minEl: state.minEl });
  const now = simNow().getTime();
  const upcoming = passes.filter(p => p.end >= now).slice(0, 4);
  $('selPasses').innerHTML = upcoming.length ? upcoming.map(p => {
    const live = p.start <= now ? ` <b style="color:#7ee081">${esc(t('sel.now'))}</b>` : '';
    const dur = Math.max(1, Math.round((p.end - p.start) / 60e3));
    const eye = p.eye ? `<span class="eye">${esc(t('vis.passEye'))}</span>` : '';
    return `<li><span>${dayTag(p.start)}${fmtTime(new Date(p.start))}–${fmtTime(new Date(p.end))}${live}${eye}</span>` +
      `<span class="tag">${esc(t('sel.max', { el: Math.round(p.maxEl), min: dur }))}</span></li>`;
  }).join('') : `<li class="muted">${esc(t('sel.noPass'))}</li>`;

  const seen = s.ok ? allGateways().filter(g => satSeesPoint(s, g.lat, g.lon, GW_MIN_EL)) : [];
  $('selGws').innerHTML = seen.length ? seen.map(g => {
    const el = elevFromCentral(centralAngle(s.lat, s.lon, g.lat, g.lon), s.alt);
    return `<li data-lat="${g.lat}" data-lon="${g.lon}"><span>${esc(g.name)}</span><span class="tag">${esc(t('sel.gwEl', { el: Math.round(el) }))}</span></li>`;
  }).join('') : `<li class="muted">${esc(t(s.isStarlink ? 'sel.noGwStarlink' : 'sel.noGwOther'))}</li>`;
}

function renderDish(date) {
  $('legCand').hidden = !state.dish.on;
  const rem = handoverInfo(date);
  $('hoSec').textContent = state.speed === 1 ? `${Math.ceil(rem)} s` : '–';
  $('hoBar').style.width = state.speed === 1 ? `${(1 - rem / 15) * 100}%` : '0';
  $('candN').textContent = candidates.length;
  if (!state.dish.on) { $('candList').innerHTML = ''; return; }
  $('candList').innerHTML = candidates.length ? candidates.slice(0, 12).map((c, i) =>
    `<li data-id="${c.s.id}"><span class="${i === 0 ? 'likely' : ''}"><span class="dot" style="background:${c.s.color}"></span>${esc(c.s.name)}` +
    `${i === 0 ? ' · ' + esc(t('dish.likely')) : ''}</span><span class="tag">${nf(0).format(c.s.el)}° · ${esc(t('dish.offAxis', { deg: nf(0).format(c.off) }))}</span></li>`
  ).join('') : `<li class="muted">${esc(t('dish.none'))}</li>`;
}

function renderNearGateways() {
  const o = state.obs;
  const list = allGateways().map(g => ({ g, d: centralAngle(o.lat, o.lon, g.lat, g.lon) * R_EARTH }))
    .sort((a, b) => a.d - b.d).slice(0, 10);
  $('nearGws').innerHTML = list.map(({ g, d }) => {
    const tag = g.status === 'planned' || g.status === 'custom' ? ` <span class="tag">${esc(t('gw.' + g.status))}</span>` : '';
    const del = g.status === 'custom' ? ` <span class="del" data-del="${esc(g.name)}" title="${esc(t('gw.del'))}">✕</span>` : '';
    return `<li data-lat="${g.lat}" data-lon="${g.lon}"><span>${esc(g.name)}${tag}</span><span>${fmtKm(d)}${del}</span></li>`;
  }).join('');
}

function renderStatus() {
  const parts = [];
  for (const g of GROUPS) {
    if (!state.groups.includes(g.key)) continue;
    const d = groupData[g.key];
    if (!d) { parts.push(`<div class="warn">${esc(groupLabel(g.key))}: ${esc(t('status.failed'))}</div>`); continue; }
    const src = d.source === 'snapshot' ? t('status.snapshot') : d.source;
    const when = d.fetchedAt ? t('status.downloaded', { when: new Date(d.fetchedAt).toLocaleString(getLang(), { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }) }) : '';
    parts.push(`<div>${esc(groupLabel(g.key))}: <b>${nf(0).format(d.data.length)}</b> · ${esc(src)}${when ? ', ' + esc(when) : ''}` +
      `${d.stale ? ` · <span class="warn">${esc(t('status.stale'))}</span>` : ''}</div>`);
  }
  parts.push(`<div>${esc(t('status.gws', { n: gateways.length, p: pops.length }))}</div>`);
  $('status').innerHTML = parts.join('');
}

function renderChips() {
  $('groupChips').innerHTML = GROUPS.map(g => `<label class="chip ${state.groups.includes(g.key) ? 'on' : ''}" data-key="${g.key}">` +
    `<input type="checkbox" ${state.groups.includes(g.key) ? 'checked' : ''}><i style="background:${g.color}"></i>${esc(groupLabel(g.key))} <span class="n"></span></label>`).join('');
  updateChipCounts();
}
function updateChipCounts() {
  for (const g of GROUPS) {
    const el = document.querySelector(`.chip[data-key="${g.key}"] .n`);
    if (el) el.textContent = groupData[g.key] && state.groups.includes(g.key) ? nf(0).format(groupData[g.key].data.length) : '';
  }
}
function updateCoverage() {
  covCircle.setLatLng([state.obs.lat, state.obs.lon]).setRadius(coverageRadius(medianAlt, state.minEl) * 1000);
  covCircle.unbindTooltip().bindTooltip(t('cov.tooltip', { alt: Math.round(medianAlt), minEl: state.minEl }), { sticky: true });
}

// ---------- akce ----------
function setObserver(lat, lon, kind, pan = true, name = null) {
  state.obs = { lat: round2(+lat), lon: round2(normLon(+lon)), kind, name };
  obsMarker.setLatLng([state.obs.lat, state.obs.lon]);
  if (pan) { map.panTo([state.obs.lat, state.obs.lon]); if (state.view === 'globe') globe?.flyTo(state.obs.lat, state.obs.lon); }
  updateCoverage(); renderNearGateways(); renderLocation(); persist();
  passesFor = null; tick(true);
}
function selectSat(s, fromMap = false) {
  state.selected = s || null; passesFor = null; trackCache.id = null;
  if (s) map.addLayer(selCircle); else map.removeLayer(selCircle);
  if (s && fromMap) showTab('sky');
  tick(true);
  if (s) $('selCard').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
function showTab(name) {
  state.tab = name;
  document.querySelectorAll('.tabs button').forEach(b => { b.classList.toggle('on', b.dataset.tab === name); b.setAttribute('aria-selected', b.dataset.tab === name); });
  document.querySelectorAll('.tabpanel').forEach(p => { p.hidden = p.id !== 'tab-' + name; });
  persist();
}

function orbitEcf(s, date) {
  const period = (2 * Math.PI / s.satrec.no) * 60e3, out = [];
  for (let dt = -0.35 * period; dt <= period; dt += 45e3) {
    const d = new Date(date.getTime() + dt);
    const pv = S.propagate(s.satrec, d);
    if (pv && pv.position) out.push(S.eciToEcf(pv.position, S.gstime(d)));
  }
  return out;
}
let orbitCache = { id: null, at: 0, pts: [] };
function updateGlobe(date) {
  if (!globe || state.view !== 'globe') return;
  const T = state.toggles, sel = state.selected;
  const above = sats.filter(s => s.ok && s.el >= state.minEl);
  const linkSats = (T.links ? above.filter(s => s.isStarlink) : []);
  if (sel && sel.isStarlink && sel.ok && !linkSats.includes(sel)) linkSats.push(sel);
  if (state.dish.on && candidates[0] && !linkSats.includes(candidates[0].s)) linkSats.push(candidates[0].s);
  const gws = allGateways().filter(g => g.status !== 'planned' || T.gwPlanned);
  const links = [];
  for (const s of linkSats) for (const g of gws) {
    if (satSeesPoint(s, g.lat, g.lon, GW_MIN_EL)) links.push([s, g, s === sel || (candidates[0] && s === candidates[0].s)]);
  }
  if (sel && sel.ok && (orbitCache.id !== sel.id || Date.now() - orbitCache.at > 20000 || state.speed > 1)) {
    orbitCache = { id: sel.id, at: Date.now(), pts: orbitEcf(sel, date) };
  }
  globe.update({
    date, sats, selected: sel, candidates, obs: state.obs, minEl: state.minEl, showDim: T.dim,
    rays: T.rays ? above.filter(s => s.ecf) : (sel && sel.el >= state.minEl ? [sel] : []),
    links: links.filter(([s]) => s.ecf), orbit: sel && sel.ok ? orbitCache.pts : null,
  });
}

async function showView(view) {
  state.view = view;
  document.querySelectorAll('#viewSwitch button').forEach(b => b.classList.toggle('on', b.dataset.view === view));
  $('globe').hidden = view !== 'globe';
  if (view === 'globe' && !globe && !globeLoading) {
    globeLoading = true;
    $('loading').hidden = false; $('loading').textContent = t('globe.loading');
    try {
      globe = await initGlobe($('globe'), { onPick: (s) => selectSat(s, true) });
      globe.setGateways(allGateways());
      globe.flyTo(state.obs.lat, state.obs.lon);
    } catch (e) {
      console.warn(e);
      $('loading').textContent = t('globe.error', { msg: e.message || e });
      globeLoading = false;
      setTimeout(() => { $('loading').hidden = true; }, 4000);
      return showView('map');
    }
    globeLoading = false;
    $('loading').hidden = true;
  }
  if (view === 'map') { map.invalidateSize(); resizeCanvas(); }
  else globe?.resize();
  tick(true);
}

let lastUi = 0;
function tick(force = false) {
  const date = simNow();
  propagateAll(date);
  computeCandidates();
  const s = state.selected;
  if (s && (passesFor !== s.id || (passes.length && passes[passes.length - 1].end < date.getTime()))) {
    passes = computePasses(s, date); passesFor = s.id;
  }
  if (s && s.ok) selCircle.setLatLng([s.lat, s.lon]).setRadius(coverageRadius(s.alt, state.minEl) * 1000);
  if (state.view === 'map') draw(); else updateGlobe(date);
  drawSky();
  renderDish(date);
  if (force || Date.now() - lastUi > 900) {
    lastUi = Date.now();
    renderTable(); renderSelected(); renderStatus();
    $('clockLocal').textContent = date.toLocaleString(getLang(), { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    $('clockUtc').textContent = date.toISOString().slice(11, 19) + ' ' + t('time.utc');
  }
}
function loop() { tick(); setTimeout(loop, state.speed > 1 ? 200 : 500); }

function applyLanguage() {
  applyStatic();
  buildLayerControl();
  renderChips(); renderLocation(); renderNearGateways(); renderGatewayMarkers(); updateCoverage();
  $('minElVal').textContent = state.minEl + '°';
  if ($('loading').hidden === false) $('loading').textContent = t('loading');
  if (state.picking) $('pickWhat').textContent = t(state.picking === 'gw' ? 'pick.gw' : 'pick.obs');
  tick(true);
}

// ---------- ovládání ----------
function initUI() {
  $('lang').innerHTML = Object.entries(LANGS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  $('lang').value = getLang();
  $('lang').addEventListener('change', e => { setLang(e.target.value); persist(); applyLanguage(); });

  $('btnRefine').onclick = () => {
    const p = $('locPanel'); p.hidden = !p.hidden;
    $('btnRefine').textContent = t(p.hidden ? 'loc.refine' : 'loc.hide');
    $('btnRefine').dataset.i18n = p.hidden ? 'loc.refine' : 'loc.hide';
  };
  const onCoord = () => {
    const la = parseFloat($('lat').value), lo = parseFloat($('lon').value);
    if (isFinite(la) && isFinite(lo) && Math.abs(la) <= 90) setObserver(la, lo, 'custom');
  };
  $('lat').addEventListener('change', onCoord); $('lon').addEventListener('change', onCoord);
  $('btnGeo').onclick = () => {
    if (!navigator.geolocation) return alert(t('loc.geoNo'));
    $('btnGeo').textContent = t('loc.geoBusy');
    navigator.geolocation.getCurrentPosition(
      p => { $('btnGeo').textContent = t('loc.geo'); setObserver(p.coords.latitude, p.coords.longitude, 'precise'); map.setZoom(Math.max(map.getZoom(), 6)); },
      e => { $('btnGeo').textContent = t('loc.geo'); alert(t('loc.geoErr', { msg: e.message })); },
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 });
  };
  $('btnForget').onclick = () => {
    const r = regionFromTimezone();
    state.obs = r; setObserver(r.lat, r.lon, r.kind); state.obs.cc = r.cc; renderLocation(); persist();
  };
  const startPick = (what) => { state.picking = what; $('pickBanner').hidden = false; $('map').classList.add('picking');
    $('pickWhat').textContent = t(what === 'gw' ? 'pick.gw' : 'pick.obs'); };
  const endPick = () => { state.picking = null; $('pickBanner').hidden = true; $('map').classList.remove('picking'); };
  $('btnPick').onclick = () => startPick('obs');
  $('btnAddGw').onclick = () => startPick('gw');
  $('pickCancel').onclick = endPick;

  map.on('contextmenu', e => setObserver(e.latlng.lat, e.latlng.lng, 'custom', false));
  map.on('click', e => {
    if (state.picking === 'obs') { endPick(); return setObserver(e.latlng.lat, e.latlng.lng, 'custom', false); }
    if (state.picking === 'gw') {
      endPick();
      const name = prompt(t('gw.namePrompt'), t('gw.defaultName'));
      if (name) { state.customGws.push({ name: name.slice(0, 60), lat: round2(e.latlng.lat), lon: round2(normLon(e.latlng.lng)) }); persist(); renderGatewayMarkers(); }
      return;
    }
    const W = 256 * Math.pow(2, map.getZoom()), cp = e.containerPoint;
    let best = -1, bd = 10;
    for (let i = 0; i < sats.length; i++) {
      const x = screenPts[i * 2]; if (isNaN(x)) continue;
      const s = sats[i];
      if (!state.toggles.dim && s.el < 0) continue;
      let dx = cp.x - x; dx -= Math.round(dx / W) * W;
      const d = Math.hypot(dx, cp.y - screenPts[i * 2 + 1]) - (s.el >= 0 ? 4 : 0);
      if (d < bd) { bd = d; best = i; }
    }
    selectSat(best >= 0 ? sats[best] : null, true);
  });
  map.on('move zoom', () => draw());
  map.on('resize', () => { resizeCanvas(); draw(); });
  window.addEventListener('resize', () => { resizeCanvas(); draw(); drawSky(); });

  let qTimer;
  $('placeQuery').addEventListener('input', e => {
    clearTimeout(qTimer);
    const q = e.target.value.trim();
    if (q.length < 3) { $('placeResults').hidden = true; return; }
    qTimer = setTimeout(async () => {
      try {
        const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=6&accept-language=${getLang()}&q=${encodeURIComponent(q)}`);
        const res = await r.json();
        $('placeResults').innerHTML = res.map(p => `<li data-lat="${+p.lat}" data-lon="${+p.lon}">${esc(p.display_name)}</li>`).join('') || `<li class="muted">${esc(t('loc.noResults'))}</li>`;
        $('placeResults').hidden = false;
      } catch { /* bez připojení */ }
    }, 500);
  });
  $('placeResults').addEventListener('click', e => {
    const li = e.target.closest('li[data-lat]'); if (!li) return;
    const name = li.textContent.split(',')[0];
    setObserver(li.dataset.lat, li.dataset.lon, 'custom', true, name);
    map.setZoom(Math.max(map.getZoom(), 6));
    $('placeResults').hidden = true; $('placeQuery').value = name;
  });

  $('minEl').value = state.minEl;
  $('minEl').addEventListener('input', () => {
    state.minEl = +$('minEl').value; $('minElVal').textContent = state.minEl + '°';
    passesFor = null; updateCoverage(); persist(); tick(true);
  });

  $('groupChips').addEventListener('change', async e => {
    const chip = e.target.closest('.chip'); const key = chip.dataset.key;
    state.groups = e.target.checked ? [...state.groups, key] : state.groups.filter(k => k !== key);
    chip.classList.toggle('on', e.target.checked); persist();
    if (e.target.checked && !groupData[key]) {
      $('loading').hidden = false; $('loading').textContent = t('loadingGroup', { g: groupLabel(key) });
      await loadGroups(); $('loading').hidden = true;
    } else { rebuildSats(); tick(true); }
  });

  const toggleDefs = { tRays: 'rays', tLinks: 'links', tGw: 'gw', tGwPlanned: 'gwPlanned', tPop: 'pop', tCov: 'cov', tDim: 'dim' };
  for (const [id, key] of Object.entries(toggleDefs)) {
    if (key in state.toggles) $(id).checked = state.toggles[key]; else state.toggles[key] = $(id).checked;
    $(id).addEventListener('change', () => { state.toggles[key] = $(id).checked; applyToggles(); persist(); });
  }

  // anténa
  const d = state.dish;
  $('dishOn').checked = d.on;
  $('dishAz').value = d.az ?? ''; $('dishEl').value = d.el ?? ''; $('dishFov').value = d.fov ?? 100;
  const dp = dishParams(); $('dishAz').placeholder = dp.az; $('dishEl').placeholder = dp.el;
  const onDish = () => {
    const num = (id, lo, hi) => { const v = parseFloat($(id).value.replace(',', '.')); return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null; };
    state.dish = { on: $('dishOn').checked, az: num('dishAz', 0, 360), el: num('dishEl', 0, 90), fov: num('dishFov', 20, 160) || 100 };
    persist(); renderLocation(); tick(true);
  };
  ['dishOn', 'dishAz', 'dishEl', 'dishFov'].forEach(id => $(id).addEventListener('input', onDish));
  $('candList').addEventListener('click', e => { const li = e.target.closest('li[data-id]'); if (li) selectSat(sats.find(s => s.id === +li.dataset.id), true); });

  $('speedBtns').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const cur = simNow().getTime();
    if (b.id === 'btnNow') { state.baseSim = Date.now(); state.speed = 1; }
    else { state.baseSim = cur; state.speed = +b.dataset.speed; }
    state.baseReal = Date.now();
    document.querySelectorAll('#speedBtns button[data-speed]').forEach(x => x.classList.toggle('on', +x.dataset.speed === state.speed));
    passesFor = null; tick(true);
  });

  $('filter').addEventListener('input', e => { state.filter = e.target.value; renderTable(); });
  $('eyeOnly').checked = state.eyeOnly;
  $('eyeOnly').addEventListener('change', e => { state.eyeOnly = e.target.checked; persist(); renderTable(); });
  $('visTable').addEventListener('click', e => {
    const tr = e.target.closest('tr[data-id]'); if (!tr) return;
    const s = sats.find(x => x.id === +tr.dataset.id);
    selectSat(s);
    if (s && s.ok && (s.el < 0 || state.filter)) map.panTo([s.lat, s.lon]);
  });
  $('selClose').onclick = () => selectSat(null);
  const flyGw = e => {
    const del = e.target.closest('[data-del]');
    if (del) { state.customGws = state.customGws.filter(g => g.name !== del.dataset.del); persist(); renderGatewayMarkers(); return; }
    const li = e.target.closest('li[data-lat]'); if (li) map.flyTo([+li.dataset.lat, +li.dataset.lon], Math.max(map.getZoom(), 6));
  };
  $('nearGws').addEventListener('click', flyGw); $('selGws').addEventListener('click', flyGw);
  $('skyToggle').onclick = () => { const c = $('sky').classList.toggle('collapsed'); $('skyToggle').textContent = c ? '+' : '–'; };
  $('btnReload').onclick = async () => {
    $('loading').hidden = false; $('loading').textContent = t('loading');
    await loadGroups(true); $('loading').hidden = true;
  };
  $('viewSwitch').addEventListener('click', e => { const b = e.target.closest('button[data-view]'); if (b && b.dataset.view !== state.view) showView(b.dataset.view); });
  document.querySelector('.tabs').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (b) showTab(b.dataset.tab); });
}

function applyToggles() {
  const T = state.toggles;
  T.gw ? map.addLayer(gwLayer) : map.removeLayer(gwLayer);
  T.pop ? map.addLayer(popLayer) : map.removeLayer(popLayer);
  T.cov ? map.addLayer(covCircle) : map.removeLayer(covCircle);
  renderGatewayMarkers();
  draw();
}

// ---------- start ----------
resizeCanvas();
initUI();
applyStatic();
buildLayerControl();
renderChips();
renderLocation();
applyToggles();
showTab(state.tab);
updateCoverage();
$('minElVal').textContent = state.minEl + '°';
loadGateways().catch(e => console.warn(e));
loadGroups().then(() => { $('loading').hidden = true; loop(); })
  .catch(e => { $('loading').textContent = String(e.message || e); });
