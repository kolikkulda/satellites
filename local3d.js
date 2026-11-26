// 3D okolí pozorovatele nad MapLibre GL: satelitní snímky, terén (AWS Terrain Tiles) a budovy (OpenFreeMap).
// Načítá se až po souhlasu uživatele. Poskytuje i polygony budov pro výpočet masky obzoru.
const VER = '5.24.1';
const BASE = `https://unpkg.com/maplibre-gl@${VER}/dist/`;
const DEM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

function loadScript(src) {
  return new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = src; s.onload = ok; s.onerror = () => fail(new Error('script ' + src));
    document.head.appendChild(s);
  });
}
const empty = () => ({ type: 'FeatureCollection', features: [] });

export async function initLocal3D(el, { lat, lon, bearing }) {
  if (!window.maplibregl) {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = BASE + 'maplibre-gl.css';
    document.head.appendChild(css);
    await loadScript(BASE + 'maplibre-gl.js');
  }
  const ml = window.maplibregl;
  const map = new ml.Map({
    container: el,
    center: [lon, lat], zoom: 15.8, pitch: 60, bearing: bearing || 0, maxPitch: 80,
    attributionControl: { compact: true },
    style: {
      version: 8,
      sources: {
        sat: { type: 'raster', tileSize: 256, maxzoom: 19,
          tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
          attribution: 'Imagery &copy; Esri' },
        dem: { type: 'raster-dem', tiles: [DEM], encoding: 'terrarium', tileSize: 256, maxzoom: 15,
          attribution: 'Terrain Tiles: AWS Open Data / Mapzen' },
        ofm: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
        fov: { type: 'geojson', data: empty() },
        rays: { type: 'geojson', data: empty() },
        beams: { type: 'geojson', data: empty() },
      },
      layers: [
        { id: 'sat', type: 'raster', source: 'sat' },
        { id: 'fov-fill', type: 'fill', source: 'fov', paint: { 'fill-color': '#ffd166', 'fill-opacity': 0.3 } },
        { id: 'fov-line', type: 'line', source: 'fov', paint: { 'line-color': '#ffd166', 'line-width': 2, 'line-dasharray': [2, 1.5] } },
        { id: 'rays', type: 'line', source: 'rays', paint: {
          'line-color': ['case', ['get', 'top'], '#ffd166', '#8cc6ff'], 'line-width': ['case', ['get', 'top'], 4, 2],
          'line-opacity': ['case', ['get', 'blocked'], 0.35, 0.95] } },
        { id: 'bld', type: 'fill-extrusion', source: 'ofm', 'source-layer': 'building', minzoom: 13,
          filter: ['!=', ['get', 'hide_3d'], true],
          paint: {
            'fill-extrusion-color': '#e4e8ef',
            'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 6],
            'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
            'fill-extrusion-opacity': 0.62,
          } },
        // 3D paprsky: řada malých kvádrů stoupajících od antény směrem k satelitu (nad budovami vidět)
        { id: 'beams', type: 'fill-extrusion', source: 'beams', paint: {
          'fill-extrusion-color': ['get', 'color'],
          'fill-extrusion-base': ['get', 'base'],
          'fill-extrusion-height': ['get', 'top'],
          'fill-extrusion-opacity': 0.9,
        } },
      ],
      terrain: { source: 'dem', exaggeration: 1 },
      sky: { 'sky-color': '#0b1a33', 'horizon-color': '#2a3f66', 'fog-color': '#1a2740', 'sky-horizon-blend': 0.6 },
    },
  });
  map.addControl(new ml.NavigationControl({ visualizePitch: true }), 'top-right');
  el.mlMap = map; // pro ladění z konzole
  const markerEl = document.createElement('div'); markerEl.className = 'obs-icon';
  const marker = new ml.Marker({ element: markerEl }).setLngLat([lon, lat]).addTo(map);
  await new Promise(ok => map.once('load', ok));

  return {
    map,
    setObserver(la, lo, br) {
      marker.setLngLat([lo, la]);
      map.jumpTo({ center: [lo, la], bearing: br ?? map.getBearing() });
    },
    // fov: [[lon, lat], ...] uzavřený polygon; rays: [{ coords: [[lon,lat],[lon,lat]], top, blocked }]
    setOverlays(fov, rays, beams = []) {
      map.getSource('beams').setData({ type: 'FeatureCollection', features: beams.map(b => ({
        type: 'Feature', geometry: { type: 'Polygon', coordinates: [b.poly] }, properties: { base: b.base, top: b.top, color: b.color } })) });
      map.getSource('fov').setData(fov && fov.length > 2
        ? { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [fov] }, properties: {} }] }
        : empty());
      map.getSource('rays').setData({ type: 'FeatureCollection', features: rays.map(r => ({
        type: 'Feature', geometry: { type: 'LineString', coordinates: r.coords }, properties: { top: !!r.top, blocked: !!r.blocked } })) });
    },
    // počká, až se dočtou dlaždice, a vrátí polygony budov kolem pozorovatele
    async buildings() {
      if (!map.areTilesLoaded()) await new Promise(ok => map.once('idle', ok));
      const out = [];
      for (const f of map.querySourceFeatures('ofm', { sourceLayer: 'building' })) {
        const h = f.properties.render_height ?? 6;
        if (f.properties.hide_3d === true) continue;
        const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [];
        for (const p of polys) if (p[0]) out.push({ ring: p[0], height: h });
      }
      return out;
    },
    resize() { map.resize(); },
  };
}
