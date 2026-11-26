# Satellites Overhead

Live map of Starlink and other satellites above any place on Earth: what is in your sky right now, which ground gateways each satellite can reach, and which satellites your Starlink dish is most likely using.

**Open the app:** https://kolikkulda.github.io/satellites/

Languages: English, Čeština, Deutsch, Polski, Slovenčina, Español, Français (picked from your browser, switchable in the app).

## Features

- All ~11 000 Starlink satellites in real time, coloured by orbital shell; optional OneWeb, Amazon Kuiper, ISS, GPS, Galileo and all active satellites.
- Sky view (azimuth and elevation) and a list of satellites above you, with distance, altitude, speed, launch and next passes.
- Starlink ground gateways and internet points of presence, with the gateways each satellite can see.
- **My Starlink**: enter your dish direction (from *Debug data* in the Starlink app) to see its field of view, the likely serving satellites and a countdown to the next 15-second handover. This is an estimate; Starlink does not publish which satellite serves you.
- **Serving satellite estimate**: a green line to the satellite most likely serving your dish in the current 15-second slot, and which gateways it can relay to.
- **3D surroundings and obstructions**: terrain (AWS Terrain Tiles) and buildings (OpenFreeMap) around you in 3D, a horizon mask on the sky view, blocked satellites marked, and an estimate of blocked sky in the dish field of view. Loaded only after you agree.
- Naked-eye visibility: which satellites are sunlit while your sky is dark and bright enough for your sky (city, suburbs or dark countryside), with an estimated magnitude from distance, lighting angle and satellite type, a filter and marks on upcoming passes.
- 3D globe view (CesiumJS, loaded on demand) with satellites at their real altitude and day/night shading.
- Accelerated time (10×, 60×, 300×) to watch the constellation move.

## Privacy

No cookies, no analytics, no backend. The starting region is estimated from your browser's time zone without contacting any service. Your location, settings and custom gateways stay in your browser's local storage and are never sent to the site. Place search sends only the typed text to OpenStreetMap Nominatim.

## Data sources

- Orbits: [CelesTrak](https://celestrak.org) (SpaceX-supplied ephemerides for Starlink, GP data for other groups), propagated in the browser with [satellite.js](https://github.com/shashwatak/satellite-js) (SGP4).
- Gateways: community dataset on [Hugging Face](https://huggingface.co/datasets/28hery/starlink-ground-stations) built from FCC filings and Starlink Insider. Locations are approximate and incomplete.
- Map tiles: Esri and OpenStreetMap.

A snapshot of Starlink orbits and gateways is bundled in `data/` as a fallback when the live sources are unreachable.

## Run locally

Any static file server works, for example:

```bash
python3 -m http.server 8777
```

Then open http://localhost:8777. On macOS you can also double-click `spustit.command`.

## Disclaimer

Unofficial project, not affiliated with SpaceX or Starlink.

## License

MIT for the app code. Bundled libraries keep their own licenses: Leaflet (BSD-2-Clause), satellite.js (MIT).
