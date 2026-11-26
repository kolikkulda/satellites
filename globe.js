// 3D glóbus nad CesiumJS. Načítá se líně (až po otevření pohledu), podklad Esri – žádný Cesium ion ani token.
// Aplikace volá update(frame) při každém ticku; frame obsahuje už spočítané polohy (ECF v km).
const CESIUM_VER = '1.146.0';
const BASE = `https://cdn.jsdelivr.net/npm/cesium@${CESIUM_VER}/Build/Cesium/`;

function loadScript(src) {
  return new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = src; s.onload = ok; s.onerror = () => fail(new Error('script ' + src));
    document.head.appendChild(s);
  });
}

export async function initGlobe(el, { onPick }) {
  if (!window.Cesium) {
    window.CESIUM_BASE_URL = BASE;
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = BASE + 'Widgets/widgets.css';
    document.head.appendChild(css);
    await loadScript(BASE + 'Cesium.js');
  }
  const C = window.Cesium;
  const imagery = new C.UrlTemplateImageryProvider({
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    maximumLevel: 18, credit: new C.Credit('Esri, Maxar, Earthstar Geographics'),
  });
  const viewer = new C.Viewer(el, {
    baseLayer: new C.ImageryLayer(imagery),
    baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false,
    navigationHelpButton: false, animation: false, timeline: false, fullscreenButton: false,
    infoBox: false, selectionIndicator: false,
  });
  viewer.scene.globe.enableLighting = true;           // den a noc podle simulovaného času
  viewer.scene.globe.showGroundAtmosphere = true;
  viewer.clock.shouldAnimate = false;
  el.cesiumViewer = viewer; // pro ladění z konzole
  const credit = document.createElement('div');
  credit.id = 'globeCredit';
  credit.innerHTML = 'Imagery &copy; Esri · <a href="https://cesium.com/platform/cesiumjs/" target="_blank" rel="noopener">CesiumJS</a>';
  el.appendChild(credit);

  const pts = viewer.scene.primitives.add(new C.PointPrimitiveCollection());
  const gwPts = viewer.scene.primitives.add(new C.PointPrimitiveCollection());
  const lines = viewer.scene.primitives.add(new C.PolylineCollection());
  const obsPt = viewer.scene.primitives.add(new C.PointPrimitiveCollection()).add({
    pixelSize: 10, color: C.Color.WHITE, outlineColor: C.Color.fromCssColorString('#5aa9ff'), outlineWidth: 3,
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
  });
  const colorCache = new Map();
  const col = (css, a = 1) => {
    const k = css + a;
    if (!colorCache.has(k)) colorCache.set(k, C.Color.fromCssColorString(css).withAlpha(a));
    return colorCache.get(k);
  };
  const scratch = new C.Cartesian3();
  const ecf = (p, out = new C.Cartesian3()) => C.Cartesian3.fromElements(p.x * 1000, p.y * 1000, p.z * 1000, out);
  let ptSats = [];

  new C.ScreenSpaceEventHandler(viewer.scene.canvas).setInputAction((e) => {
    const p = viewer.scene.pick(e.position);
    if (p && p.id && p.id.satrec) return onPick(p.id);
    // body jsou malé a pohybují se – vezmi nejbližší viditelný satelit do 12 px (větší body mají přednost)
    const camPos = viewer.camera.positionWC;
    const occluder = new C.EllipsoidalOccluder(C.Ellipsoid.WGS84, camPos);
    let best = null, bd = 12;
    for (let i = 0; i < pts.length; i++) {
      const q = pts.get(i);
      if (!q.show || !occluder.isPointVisible(q.position)) continue;
      const w = C.SceneTransforms.worldToWindowCoordinates(viewer.scene, q.position);
      if (!w) continue;
      const d = Math.hypot(w.x - e.position.x, w.y - e.position.y) - (q.pixelSize >= 6 ? 4 : 0);
      if (d < bd) { bd = d; best = q.id; }
    }
    onPick(best);
  }, C.ScreenSpaceEventType.LEFT_CLICK);

  return {
    flyTo(lat, lon) {
      viewer.camera.flyTo({ destination: C.Cartesian3.fromDegrees(lon, lat, 9.0e6), duration: 1.2 });
    },
    setGateways(list) {
      gwPts.removeAll();
      for (const g of list) {
        gwPts.add({ position: C.Cartesian3.fromDegrees(g.lon, g.lat, 0), pixelSize: g.status === 'planned' ? 4 : 6,
          color: col(g.status === 'custom' ? '#4ade80' : '#ff8c42', g.status === 'planned' ? 0.5 : 1) });
      }
    },
    update(f) {
      viewer.clock.currentTime = C.JulianDate.fromDate(f.date);
      if (ptSats !== f.sats) {          // nová sada satelitů → přestavět body
        pts.removeAll();
        for (const s of f.sats) pts.add({ id: s, pixelSize: 2, color: col(s.color, 0.6), show: false });
        ptSats = f.sats;
      }
      const cand = new Set(f.candidates.map(c => c.s));
      for (let i = 0; i < f.sats.length; i++) {
        const s = f.sats[i], p = pts.get(i);
        if (!s.ok || !s.ecf || (!f.showDim && s.el < 0)) { p.show = false; continue; }
        p.show = true;
        p.position = ecf(s.ecf, scratch);
        if (s === f.serving) { p.pixelSize = 12; p.color = col('#3ddc84'); p.outlineColor = col('#ffffff'); p.outlineWidth = 2; }
        else if (s === f.selected) { p.pixelSize = 11; p.color = col('#ffffff'); p.outlineColor = col(s.color); p.outlineWidth = 3; }
        else if (cand.has(s)) { p.pixelSize = s === f.candidates[0].s ? 10 : 7; p.color = col('#ffd166'); p.outlineWidth = 0; }
        else if (s.el >= f.minEl) { p.pixelSize = 6; p.color = col(s.color); p.outlineWidth = 0; }
        else if (s.el >= 0) { p.pixelSize = 4; p.color = col(s.color, 0.9); p.outlineWidth = 0; }
        else { p.pixelSize = 2; p.color = col(s.color, 0.55); p.outlineWidth = 0; }
      }
      const obs = C.Cartesian3.fromDegrees(f.obs.lon, f.obs.lat, 300);
      obsPt.position = obs;
      lines.removeAll();
      for (const s of f.rays) {
        lines.add({ positions: [obs, ecf(s.ecf)], width: s === f.selected ? 2.5 : 1,
          material: C.Material.fromType('Color', { color: s === f.selected ? col('#ffffff', 0.95) : col('#8cc6ff', 0.35) }) });
      }
      if (f.serving) {
        lines.add({ positions: [obs, ecf(f.serving.ecf)], width: 4,
          material: C.Material.fromType('Color', { color: col('#3ddc84', 1) }) });
      }
      for (const [s, g, strong] of f.links) {
        lines.add({ positions: [ecf(s.ecf), C.Cartesian3.fromDegrees(g.lon, g.lat, 0)], width: strong ? 2 : 1,
          material: C.Material.fromType('Color', { color: col('#ff8c42', strong ? 0.95 : 0.35) }) });
      }
      if (f.orbit && f.orbit.length > 1) {
        lines.add({ positions: f.orbit.map(p => ecf(p)), width: 1.5,
          material: C.Material.fromType('PolylineDash', { color: col('#ffffff', 0.7), dashLength: 12 }) });
      }
      viewer.scene.requestRender();
    },
    resize() { viewer.resize(); },
  };
}
