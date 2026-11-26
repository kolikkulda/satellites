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

### Fáze 2 – hotovo (26. 11. 2026)
- [x] Návod přímo u polí antény podle skutečných názvů v aplikaci Starlink (CZ ověřeno ze snímku; ostatní jazyky ukazují anglické názvy). Varování, ať se nepoužívá „Cílový azimut/výška“. Pole přijímají desetinnou čárku i tečku.
- [x] Viditelnost pouhým okem (`sunAt`, `lightState` v `app.js`): stav `eye` / `day` / `low` / `shadow` pro satelity nad obzorem, odznak „okem“ v seznamu, filtr „Jen viditelné pouhým okem“, výška Slunce u pozorovatele, řádek v detailu, značka u přeletů. Poznámka o slabé jasnosti Starlinků (5.–7. mag) – skutečnou jasnost zatím nepočítáme.
- [x] 3D glóbus (`globe.js`): CesiumJS 1.146.0 z jsDelivr, načítá se až po přepnutí na „3D glóbus“. Podklad Esri přes `UrlTemplateImageryProvider` (bez ion tokenu). Satelity ve skutečné výšce (ECF z `propagateAll`, počítá se jen když glóbus existuje), den/noc podle simulovaného času, pozorovatel, paprsky, spoje k branám, dráha vybraného satelitu. Klik vybere nejbližší satelit do 12 px. Pro ladění je viewer na `document.getElementById('globe').cesiumViewer`.
- [x] Mobil: mapa nahoře (`order: -1`), zkrácené hodiny.

### Možná vylepšení fáze 2
- Odhad jasnosti (magnitudy) podle vzdálenosti a fázového úhlu, ať „okem“ nehlásí satelity, které jsou ve skutečnosti moc slabé.
- V glóbu zobrazit zorné pole antény jako kužel.

### Fáze 3 – 3D okolí a maska obzoru (hotovo 26. 11. 2026)
Cíl: po zadání polohy ukázat okolí ve 3D a spočítat, kde terén a budovy zakrývají oblohu.

**Ověřené zdroje (26. 11. 2026):**
- Terén: AWS Open Data Terrain Tiles, `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`, kódování Terrarium (`výška = R*256 + G + B/256 − 32768`), CORS `*`. Atribuce: „Terrain Tiles – AWS Open Data / Mapzen“.
- Budovy: OpenFreeMap `https://tiles.openfreemap.org/planet` (TileJSON, vektorové dlaždice OpenMapTiles do z14), vrstva `building` s poli `render_height`, `render_min_height`, `hide_3d`. CORS `*`. Atribuce: OpenFreeMap, OpenMapTiles, OpenStreetMap.
- Knihovna: MapLibre GL JS 5.24.1 (BSD-3) z unpkg, načítat až po souhlasu.

**Návrh:**
- `horizon.js`: načte dlaždice terénu z12 v okruhu ~8 km, `elevAt(lat, lon)` s bilineární interpolací. `computeMask()` pro každý azimut 0–359° projde paprsek 30 m – 8 km a vezme max. elevační úhel terénu (korekce zakřivení Země s refrakcí, R_eff = 4/3 R). Budovy (z MapLibre `querySourceFeatures`, ~1 km kolem) se přidají přes zhuštěné hrany polygonů; budova, ve které stojí pozorovatel, se ignoruje (anténa bývá na její střeše).
- `local3d.js`: MapLibre s podkladem Esri, terénem a vytaženými budovami, pohled natočený ve směru antény. Žlutá plocha = oblast, nad kterou anténa hledí (průmět kužele do výšky 150 m nad anténou), žluté čáry = směry ke kandidátům.
- Souhlas: před prvním načtením panel v aplikaci (ne `confirm()`), který vysvětlí, že poskytovatelé dlaždic uvidí přibližnou oblast. Souhlas se pamatuje v `localStorage`.
- Výsledek: maska v `localStorage` vázaná na polohu (zaokrouhlenou na 0,01°) a výšku antény. Maska na obloze jako šedá plocha, zakryté satelity duté a označené „zakrytý“, kandidáti antény vynechávají zakryté satelity. Odhad % zakryté oblohy v zorném poli antény pro srovnání s aplikací Starlink (Ladicí data → Překážky).
- Omezení, která říct uživateli: stromy a drobné překážky v datech nejsou, výšky budov z OSM bývají odhadnuté, s polohou podle regionu to nedává smysl.

**Implementováno (26. 11. 2026):**
- [x] `horizon.js` (`loadDem`, `computeMask`, `blockedFraction`) – terén z12 do 8 km (`MASK_RADIUS`), budovy z MapLibre. Na zkušebním bodě v Praze (50,09; 14,42; anténa 3 m) to trvá asi 3 s, 8 341 budov, výsledek 38,5 % zakryté oblohy v zorném poli.
- [x] `local3d.js` – MapLibre 5.24.1, budovy průhledné (0,62), **3D paprsky** jako řada malých kvádrů (fill-extrusion) od antény do 150 m nad ní. Čáry a plochy na zemi MapLibre při terénu kreslí pod budovy, proto paprsky jako kvádry. Pro ladění je mapa na `document.getElementById('local3d').mlMap`.
- [x] Souhlas `#consent` (pamatuje se jako `consent3d`), maska v `localStorage['satview-mask']`, „Brát překážky v úvahu“, „Přepočítat“, „Smazat překážky“, výška antény (`obst.antH`, výchozí 3 m).
- [x] Na obloze šedá maska, zakryté satelity jako prázdná kolečka, odznak „zakrytý“ v seznamu, řádek „Výhled“ v detailu; kandidáti vynechávají zakryté satelity.

### Obsluhující satelit (odhad) – hotovo 26. 11. 2026
Martin se ptal, „od kterého Starlinku chytám internet“. Vysvětlení v UI: anténa komunikuje vždy s **jedním** satelitem, plánovač ho přiděluje na 15 s, pak může dát jiný nebo nechat stejný.
- `serving` v `app.js`: na začátku každého úseku (sekundy :12, :27, :42, :57) se vybere kandidát nejblíž ose antény a drží se do konce úseku. Uprostřed úseku se mění jen tehdy, když satelit zmizí ze zorného pole nebo se schová za překážku.
- Zobrazení: **zelená** (`SERVE_COLOR` #3ddc84) čára od pozorovatele na mapě, na obloze, v glóbu i ve 3D (zelený paprsek), popisek „tvůj internet (odhad)“, karta „Teď tě nejspíš obsluhuje“ v záložce Můj Starlink s časem přidělení a bránami, na které satelit může posílat data (případně laser).
- Kandidáti mají žlutou barvu, obsluhující zelenou.
- Možné zlepšení: věrnější výběr (komunita pozoruje, že plánovač preferuje satelity severně od antény a s velkou elevací, a vyhýbá se geostacionárnímu pásu), ověření proti mapě překážek z antény.

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
