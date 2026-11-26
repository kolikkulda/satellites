// Maska obzoru: pro každý azimut (0–359°) nejvyšší elevační úhel, pod kterým terén nebo budovy zakrývají oblohu.
// Terén: AWS Open Data Terrain Tiles (Terrarium PNG). Budovy dodává volající (polygony s výškou).
const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const R = 6371000;
const R_EFF = R * 4 / 3; // zakřivení Země včetně běžné atmosférické refrakce
const DEG = Math.PI / 180;

const lon2x = (lon, z) => (lon + 180) / 360 * 2 ** z * 256;
const lat2y = (lat, z) => {
  const s = Math.sin(lat * DEG);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z * 256;
};

async function loadTile(z, x, y) {
  const r = await fetch(DEM_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y));
  if (!r.ok) throw new Error('DEM ' + r.status);
  const bmp = await createImageBitmap(await r.blob());
  const c = document.createElement('canvas'); c.width = 256; c.height = 256;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  const px = g.getImageData(0, 0, 256, 256).data;
  const h = new Float32Array(256 * 256);
  for (let i = 0; i < h.length; i++) h[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
  return h;
}

// Načte výškový model kolem bodu. Vrací funkci elevAt(lat, lon) v metrech (NaN mimo načtenou oblast).
export async function loadDem(lat, lon, radiusM, z = 12) {
  const dLat = radiusM / 111320, dLon = radiusM / (111320 * Math.cos(lat * DEG));
  const x0 = Math.floor(lon2x(lon - dLon, z) / 256), x1 = Math.floor(lon2x(lon + dLon, z) / 256);
  const y0 = Math.floor(lat2y(lat + dLat, z) / 256), y1 = Math.floor(lat2y(lat - dLat, z) / 256);
  const tiles = new Map(), jobs = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    jobs.push(loadTile(z, x, y).then(h => tiles.set(x + '/' + y, h)));
  }
  await Promise.all(jobs);
  const px = (gx, gy) => {
    const tx = Math.floor(gx / 256), ty = Math.floor(gy / 256);
    const h = tiles.get(tx + '/' + ty);
    if (!h) return NaN;
    return h[(gy - ty * 256) * 256 + (gx - tx * 256)];
  };
  return {
    tiles: tiles.size,
    elevAt(la, lo) {
      const fx = lon2x(lo, z) - 0.5, fy = lat2y(la, z) - 0.5;
      const ix = Math.floor(fx), iy = Math.floor(fy), ax = fx - ix, ay = fy - iy;
      return (px(ix, iy) * (1 - ax) + px(ix + 1, iy) * ax) * (1 - ay) + (px(ix, iy + 1) * (1 - ax) + px(ix + 1, iy + 1) * ax) * ay;
    },
  };
}

function dest(lat, lon, az, d) {
  const a = d / R, p1 = lat * DEG, b = az * DEG;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(a) + Math.cos(p1) * Math.sin(a) * Math.cos(b));
  const l2 = lon * DEG + Math.atan2(Math.sin(b) * Math.sin(a) * Math.cos(p1), Math.cos(a) - Math.sin(p1) * Math.sin(p2));
  return [p2 / DEG, l2 / DEG];
}
// lokální rovinná aproximace (stačí do pár km)
function local(lat0, lon0, lat, lon) {
  const x = (lon - lon0) * DEG * R * Math.cos(lat0 * DEG), y = (lat - lat0) * DEG * R;
  return { d: Math.hypot(x, y), az: (Math.atan2(x, y) / DEG + 360) % 360 };
}
function inside(ring, lon, lat) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/**
 * @param dem      výsledek loadDem
 * @param buildings [{ ring: [[lon, lat], ...], height }]
 * @returns { mask: number[360] (stupně), ground, h0, buildings: počet použitých }
 */
export function computeMask(dem, lat, lon, antennaH, buildings, radiusM) {
  const ground = dem.elevAt(lat, lon);
  const h0 = ground + antennaH;
  const mask = new Array(360).fill(-90);
  const angle = (h, d) => Math.atan2(h - h0 - d * d / (2 * R_EFF), d) / DEG;

  // terén: paprsky po 1°, krok roste se vzdáleností
  for (let az = 0; az < 360; az++) {
    let best = -90;
    for (let d = 30; d <= radiusM; d += Math.max(25, d * 0.015)) {
      const [la, lo] = dest(lat, lon, az + 0.5, d);
      const h = dem.elevAt(la, lo);
      if (!isNaN(h)) best = Math.max(best, angle(h, d));
    }
    mask[az] = best;
  }

  // budovy: zhuštěné hrany polygonů, ignorovat budovu, ve které stojí pozorovatel
  let used = 0;
  for (const b of buildings) {
    const ring = b.ring;
    if (!ring || ring.length < 3 || !(b.height > 0)) continue;
    if (inside(ring, lon, lat)) continue;
    let near = false;
    const pts = [];
    for (let i = 0; i < ring.length - 1; i++) {
      const p = local(lat, lon, ring[i][1], ring[i][0]), q = local(lat, lon, ring[i + 1][1], ring[i + 1][0]);
      if (Math.min(p.d, q.d) < 4) { near = true; break; }
      const edge = Math.hypot(ring[i + 1][0] - ring[i][0], ring[i + 1][1] - ring[i][1]) * DEG * R;
      const n = Math.min(200, Math.ceil(edge / Math.max(0.5, Math.min(p.d, q.d) * 0.008)) + 1);
      for (let k = 0; k <= n; k++) {
        const f = k / n;
        pts.push([ring[i][1] + (ring[i + 1][1] - ring[i][1]) * f, ring[i][0] + (ring[i + 1][0] - ring[i][0]) * f]);
      }
    }
    if (near || !pts.length) continue;
    const g = dem.elevAt(pts[0][0], pts[0][1]);
    const base = isNaN(g) ? ground : g;
    for (const [la, lo] of pts) {
      const { d, az } = local(lat, lon, la, lo);
      if (d > radiusM) continue;
      const a = angle(base + b.height, d), i = Math.floor(az) % 360;
      if (a > mask[i]) mask[i] = a;
    }
    used++;
  }
  return { mask: mask.map(v => Math.round(v * 10) / 10), ground: Math.round(ground), h0: Math.round(h0), buildings: used };
}

// podíl zakryté oblohy uvnitř kužele antény nad minimální elevací (vážený prostorovým úhlem)
export function blockedFraction(mask, inCone, minEl) {
  let tot = 0, blk = 0;
  for (let az = 0; az < 360; az += 1) for (let el = minEl + 0.5; el < 90; el += 1) {
    if (!inCone(az + 0.5, el)) continue;
    const w = Math.cos(el * DEG);
    tot += w;
    if (el <= mask[az]) blk += w;
  }
  return tot ? blk / tot : 0;
}
