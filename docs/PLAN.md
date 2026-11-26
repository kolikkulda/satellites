# Satellites Overhead – plán a předávací poznámky

Tento soubor je určený pro každého (člověka i agenta), kdo převezme práci. Drž ho aktuální: po každém kroku odškrtni hotové a dopiš rozhodnutí.

- **Web:** https://kolikkulda.github.io/satellites/
- **Repozitář:** https://github.com/kolikkulda/satellites (větev `main`, GitHub Pages ze složky `/`; každý push se na webu projeví do ~1 minuty)
- **Vlastník:** Martin (GitHub `kolikkulda`). Komunikace v češtině.
- **Commity:** jméno `kolikkulda`, e‑mail `24436436+kolikkulda@users.noreply.github.com` (nastaveno lokálně v repu, ať se nezveřejní osobní e‑mail).

## Cíl

Veřejná webová aplikace pro kohokoli na světě: satelity (hlavně Starlink) nad zvoleným místem v reálném čase, pozemní brány, a odhad, které satelity právě používá uživatelova anténa Starlink. Bez backendu, bez účtů, bez sledování.

## Pevná pravidla

1. **Soukromí:** poloha uživatele se nikdy neposílá žádné službě, nedává se do URL, neukládá se jinde než v `localStorage` jeho prohlížeče, a to zaokrouhleně na 0,01° (~1 km). Výchozí region se odhaduje z časové zóny (`tz-regions.js`), ne z IP adresy. Jediná výjimka je hledání místa: do OpenStreetMap Nominatim jde jen text, který uživatel napíše.
2. **Žádný cizí kód s copyleft licencí.** KeepTrack (AGPL) a podobné projekty slouží jen jako inspirace nápadů. Náš kód je MIT.
3. **Poctivost:** cokoli odhadovaného (obsluhující satelit, polohy bran) je v UI výslovně označené jako odhad.
4. **Všechny texty UI jdou přes `i18n.js`** (7 jazyků: cs, en, de, pl, sk, es, fr). Chybějící klíč spadne na angličtinu. Nový text = přidat klíč minimálně do `cs` a `en`, ideálně do všech.
5. **Žádný build krok.** Čisté statické soubory; knihovny buď ve `vendor/`, nebo z CDN s pevnou verzí.

## Architektura

| Soubor | Co dělá |
|---|---|
| `index.html` | Struktura: postranní panel se záložkami (Nad tebou / Můj Starlink / Brány / Nastavení), mapa, plovoucí obloha, časový panel. Texty přes `data-i18n`, `data-i18n-ph`, `data-i18n-title`. |
| `style.css` | Tmavé téma, tokeny v `:root`, mobilní rozvržení pod 860 px (mapa nahoře, panel pod ní). |
| `app.js` | Veškerá logika (ES modul): načítání dat, výpočet poloh, kreslení mapy (vlastní canvas nad Leafletem kvůli 11 000+ bodům), obloha, panel, anténa. |
| `i18n.js` | Slovníky a funkce `t()`, `detectLang()`, `applyStatic()`. |
| `tz-regions.js` | Časová zóna → [šířka, délka, kód země] z IANA `zone.tab`. |
| `vendor/satellite.esm.js` | satellite.js 7.2.0, ručně sbalený esbuildem jen z potřebných souborů (bez WASM). Postup níže. |
| `vendor/leaflet/` | Leaflet 1.9.4. |
| `data/starlink-snapshot.json` | Záložní snímek drah Starlinku (OMM JSON, ~4,7 MB) pro případ, že CelesTrak neodpovídá. |
| `data/ground-stations.json` | Záložní snímek bran a PoP (sloučené dva datasety z Hugging Face). |
| `docs/PLAN.md` | Tento soubor. |

### Datové zdroje a jejich limity

- **CelesTrak** – dráhy. Pro Starlink primárně SupGP (efemeridy od SpaceX, přesnější): `sup-gp.php?FILE=starlink&FORMAT=json`, záložně `gp.php?GROUP=starlink&FORMAT=json`, nakonec snímek v `data/`.
  - **Limit:** stejná data z jedné IP smí jít stáhnout jednou za 2 hodiny, jinak CelesTrak vrací 403 nebo text „GP data has not updated…“. Proto se data ukládají přes Cache API (`satview-v1`) na 2 hodiny. Při vývoji šetři požadavky, jinak se zablokuješ.
  - **Musí se používat JSON (OMM), ne TLE:** nové Starlinky mají katalogová čísla nad 100 000, která se do formátu TLE nevejdou.
- **Hugging Face datasets-server** – brány a PoP, `juliensimon/starlink-ground-stations` (hlavně USA) a `28hery/starlink-ground-stations` (celý svět). Živá aktualizace max. 1× denně, jinak snímek. CORS je povolený.
- **Mapy:** Esri (tmavá a satelitní, bez klíče, s atribucí) a OpenStreetMap. CARTO už chce API klíč – nepoužívat.
- **Nominatim** – hledání míst, s pauzou 500 ms mezi dotazy (pravidla použití: max. 1 dotaz za sekundu).

### Jak sestavit `vendor/satellite.esm.js`

```bash
npm i satellite.js@7.2.0 esbuild
cat > entry.js <<'EOF'
export { json2satrec } from './node_modules/satellite.js/dist/io.js';
export { propagate, gstime } from './node_modules/satellite.js/dist/propagation.js';
export { eciToGeodetic, eciToEcf, ecfToLookAngles, geodeticToEcf, degreesLat, degreesLong } from './node_modules/satellite.js/dist/transforms.js';
export { sunPos } from './node_modules/satellite.js/dist/sun.js';
export { shadowFraction } from './node_modules/satellite.js/dist/shadow.js';
export { jday } from './node_modules/satellite.js/dist/ext.js';
EOF
npx esbuild entry.js --bundle --format=esm --minify --outfile=vendor/satellite.esm.js
```

Importy přímo z `dist/…` jsou nutné: hlavní `index.js` táhne WASM a `node:worker_threads`, což v prohlížeči nejde.

### Geometrie (pro orientaci v `app.js`)

- Polohy: `propagate` → `eciToGeodetic` (mapa) a `ecfToLookAngles` (azimut/elevace od pozorovatele). Pro rychlost se look angles počítají jen pro satelity nad obzorem (rychlý test přes středový úhel).
- Viditelnost brány: kulová Země, `elevFromCentral(λ, h)`; brána vidí satelit nad 25° (`GW_MIN_EL`).
- Anténa: kužel kolem osy (azimut, elevace) s polovičním úhlem `fov/2`. Kandidáti = Starlinky nad minimální elevací uvnitř kužele, seřazené podle úhlu od osy. Na mapu se kužel promítá přes `centralForElev(medianAlt, el)` a `destination()`.
- Přepínání satelitů: Starlink plánuje v 15s intervalech, hranice v sekundách :12, :27, :42 a :57 (komunitní měření). Odpočet v `handoverInfo()`.

### Kde v aplikaci Starlink najít hodnoty antény

Ověřeno ze snímku české aplikace (iPhone, listopad 2026), sekce **Ladicí data → Zarovnání**:

| Pole na webu | Česká aplikace | Anglická aplikace (dle komunity, neověřeno) |
|---|---|---|
| Azimut antény | **Odhad zorného úhlu** (např. 23,8°) | Estimated boresight azimuth |
| Elevace antény | **Výška zorného úhlu** (např. 67,3°) | Estimated boresight elevation |
| (nepoužívat) | Cílový azimut / Cílová výška | Desired boresight azimuth / elevation |
| (jen informace) | Sklon | Tilt |

Cesta v aplikaci: Starlink → (profil/nastavení) → **Ladicí data** (Debug data). Telefon musí být připojený k Wi‑Fi antény. Pro ostatní jazyky aplikace ukazujeme anglické názvy a umístění v sekci Zarovnání/Alignment.

## Stav

### Fáze 1 – hotovo (26. 11. 2026)
- [x] Mapa, obloha, seznam satelitů nad pozorovatelem, detail satelitu, přelety na 24 h.
- [x] Brány a PoP, vlastní brány (jen lokálně), spoje satelit → brána.
- [x] 7 jazyků, region z časové zóny, zaokrouhlená poloha, „Zapomenout polohu“.
- [x] Záložky, statistiky, hledání satelitu, informační karta.
- [x] Můj Starlink: zorné pole, kandidáti, odpočet 15 s.
- [x] GitHub Pages.

### Fáze 2 – rozpracováno
- [ ] Návod přímo u polí antény (přesné názvy z aplikace Starlink, viz tabulka výše).
- [ ] Viditelnost pouhým okem: satelit osvětlený Sluncem (`shadowFraction` < 0,5), pozorovatel ve tmě (Slunce pod −6°), satelit nad 10°. Ikona v seznamu, filtr „jen viditelné okem“, informace v detailu a u přeletů.
- [ ] 3D glóbus: CesiumJS 1.146.0 z jsDelivr, načítat až po otevření pohledu „3D“. Podklad Esri (bez Cesium ion, bez tokenu). Satelity jako `PointPrimitiveCollection` ve skutečné výšce, pozorovatel, brány, dráha vybraného satelitu, spoje k branám, osvětlení Sluncem.
- [ ] Test desktop + mobil, nasazení, ověření na veřejné adrese.

### Fáze 3 – 3D okolí pozorovatele (nápad od Martina, proveditelné)
Cíl: po zadání polohy zobrazit okolí ve 3D a ukázat, jestli terén nebo budovy nestíní ve směru antény.
- Knihovna: MapLibre GL JS (bez klíče) nebo Cesium.
- Terén: AWS Open Data „Terrain Tiles“ (Terrarium PNG, `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`) – ověřit CORS a licenci.
- Budovy: OpenFreeMap (vektorové dlaždice s výškami budov, bez klíče) – ověřit podmínky.
- Snímky: Esri World Imagery.
- Výpočet **masky obzoru**: z výškového modelu spočítat pro každý azimut nejvyšší úhel terénu do ~20 km a vykreslit ho do oblohy (sky plotu); satelity za kopcem označit jako zakryté. Budovy a stromy v DEM nejsou – budovy lze doplnit z OSM, stromy ne.
- Pozor na soukromí: dlaždice terénu se stahují podle polohy, takže poskytovatel dlaždic uvidí přibližnou oblast. Uživatele na to upozornit a načítat až po jeho kliknutí („Zobrazit 3D okolí“).

### Nápady na později
- Domácí pomocník: malý program v domácí síti, který čte data přímo z antény (gRPC na 192.168.100.1:9200) – mapu překážek a směr antény – a určí obsluhující satelit přesněji. Web ho nemůže číst sám (blokuje to prohlížeč a je to tak správně).
- Import mapy překážek ze Starlinku pro přesnější odhad.
- Odkaz na sdílení konkrétního satelitu (`#sat-12345` v URL; nikdy ne poloha).

## Ověřování před nasazením

1. Spustit lokálně (`python3 -m http.server 8777`) a otevřít v prohlížeči.
2. Zkontrolovat konzoli (žádné chyby), mapu, oblohu, výběr satelitu, záložku Můj Starlink se zapnutou anténou, přepnutí jazyka.
3. Mobil 375 px: stránka nesmí scrollovat do strany (`document.documentElement.scrollWidth === innerWidth`).
4. Po pushi počkat na build Pages (`gh api repos/kolikkulda/satellites/pages --jq .status` = `built`) a ověřit veřejnou adresu.
5. Prohlížeč rád drží staré `app.js` v mezipaměti – při testu stránku načti s obejitím cache.
