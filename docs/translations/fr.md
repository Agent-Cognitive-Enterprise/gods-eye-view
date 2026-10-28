# French (`fr`)

Catalog: `src/i18n/locales/fr.json`. General rules: [TRANSLATORS.md](../TRANSLATORS.md).

Translation source: abiyeenzo (#907); the French part of meirm's #312 was used for comparison.

## Style

- Standard French that reads naturally in France, Belgium, Switzerland and Canada; avoid regionalisms.
- Address the user with "vous" imperatives: « Cliquez », « Activez », « Réessayez ». Tooltips that name an action use the infinitive: « Réduire le panneau », « Réinitialiser la caméra ». UPPERCASE HUD instructions also use the infinitive: « CLIQUER SUR UNE CAMÉRA POUR L'ACTIVER ».
- Sentence case, not Title Case: "Live Flights" → « Vols en direct ». UPPERCASE English stays UPPERCASE, accents included: « ÉTAT », « PRÉC. ».
- Typography: a narrow no-break space (U+202F) goes before `:` `;` `?` `!` and `%`, and inside « » quotes: `Supprimer le plan « {shot} » ?`. It keeps the sign on the same line as the word before it. Do not type a plain space there. Ellipsis is `…`, not `...`. Dashes keep their spaces: « flux indisponible — réessayez ».
- Short labels, chips and HUD readouts stay short. A standard abbreviation with a period beats a wrapped line: PRÉC., SUIV., RÉINIT., ENREG., INDISP., DIST.
- The HUD codes HDG, BRG, CRS, FOV, DEST, SPD and ALT stay in English everywhere, as in cockpit avionics. Words are translated: RANGE → « PORTÉE », heading in a sentence → « cap ».
- ON and OFF stay as they are on HUD toggles and chips (« CCTV ON », « PROJECTION OFF »); in a sentence use « activé » / « désactivé ».
- Keyboard keys stay in English: Space, Esc, Enter, Tab, Shift, Backspace, H, 1–9 (« Maintenez Space pour parler », « ESC pour fermer »).
- Units: km, m, km/h, m/s, nd (knots), ft (feet), h, min, s, with a space before the unit: « 250 km », « il y a 5 min »; in UPPERCASE text KM, KM/S, ND, FT, MIN. MW, dBZ, hPa and `°` stay. Decimal comma in fixed numbers: « 28,2710° N », « M4,4 ». Money: « 12 k$ », « 3 M$ », « 2 Md$ ».
- "ago" goes before the time: « il y a {count} min ». When a placeholder already holds a localized "ago" text (`{age}`, `{ago}`), do not add « il y a » again.
- Round-about exit ordinals: 1re, 2e, 3e… (« prenez la 1re sortie »).

## Plurals

A `tn()` entry needs three forms. `Intl.PluralRules('fr')` picks:

| Form    | Counts                                 | Example              |
| ------- | -------------------------------------- | -------------------- |
| `one`   | 0 and 1, fractions below 2 (1,5)       | 1 caméra, 0 caméra   |
| `many`  | 1 000 000, 2 000 000… (exact millions) | 1 000 000 de caméras |
| `other` | everything else: 2–999 999, 2,5…       | 3 caméras            |

The `many` form is the `other` text with « de » (« d' » before a vowel) after the number: « {count} de couches effacées », « {count} D'ENTRÉES INCONNUES ». When the words after the number cannot agree (an UPPERCASE readout, a list), put the number after a colon in every form: « CAPTÉS : {count} ».

## Glossary

| English                                        | Français                                                        |
| ---------------------------------------------- | --------------------------------------------------------------- |
| layer / data layer / DATA LAYERS (panel title) | couche / couche de données / COUCHES                            |
| feed / source / data source                    | flux / source / source de données                               |
| LIVE (status) / live data                      | DIRECT / données en direct                                      |
| SIMULATED                                      | SIMULÉ                                                          |
| stale / degraded / unavailable                 | obsolète / dégradé / indisponible                               |
| retry / retrying                               | nouvel essai / réessayez                                        |
| rate-limited                                   | limite de requêtes atteinte                                     |
| key (API key) / POWER UP / POWERED UP          | clé (clé API) / ALLUMER / ALLUMÉ                                |
| Provider Settings                              | paramètres des fournisseurs                                     |
| enable / disable                               | activer / désactiver                                            |
| globe / map / map source / basemap / map stack | globe / carte / source de carte / fond de carte / fond de carte |
| tile (map)                                     | tuile                                                           |
| aircraft / flight / military flights           | aéronef (avion in short copy) / vol / vols militaires           |
| vessel, ship                                   | navire                                                          |
| satellite / shell (Starlink) / DENSE           | satellite / couche de la constellation / DENSE                  |
| launch / launch site / space mission           | lancement / site de lancement / mission spatiale                |
| ascent / replay / payload / stage / downrange  | ascension / rejeu / charge utile / étage / distance parcourue   |
| contact / tracking / track (HUD)               | contact / suivi / piste                                         |
| installation / site                            | installation / site                                             |
| mapped / observed                              | cartographié / observé                                          |
| camera / CCTV camera / ALPR camera             | caméra / caméra CCTV / caméra LAPI                              |
| earthquake                                     | séisme                                                          |
| active fire (FIRMS detection) / wildfire       | feu actif / incendie                                            |
| contained (wildfire)                           | maîtrisé                                                        |
| advisory (NHC/CPHC cyclone)                    | bulletin                                                        |
| forecast / lead hours / valid / issued         | prévision / échéances / valide / émise                          |
| AQHI (Canada)                                  | CQAS (cote air santé)                                           |
| radio station / tune                           | station / régler                                                |
| bikeshare / transit                            | vélos partagés / transports en commun                           |
| route (directions) / turn (maneuver)           | itinéraire / manœuvre                                           |
| scene / shot / scene recipe                    | scène / plan / recette de scène                                 |
| bundle / data pack / anchor                    | archive / paquet de données / ancre                             |
| story beat                                     | étape du récit                                                  |
| briefing / panel / dock                        | briefing / panneau / dock                                       |
| cockpit                                        | cockpit                                                         |
| preset / visual preset                         | préréglage / préréglage visuel                                  |
| Scope (circular viewport mask) / keyhole       | lunette / ouverture                                             |
| detection overlay                              | surcouche de détection                                          |
| Clean UI                                       | vue épurée                                                      |
| Street Level (layer) / Street View (Google)    | Niveau rue / Street View                                        |
| Recent Imagery / box                           | imagerie récente / zone                                         |
| pin (Draw tool) / pin (Recent Imagery)         | épingle / épingler                                              |
| Cyber (HUD layout, effect)                     | Cyber                                                           |
| heading, course / altitude / ground speed      | cap / altitude / vitesse sol                                    |
| HDG / BRG / CRS / FOV / DEST / SPD / ALT       | unchanged                                                       |
| RANGE / PITCH / HGT (CCTV calibration chips)   | PORTÉE / INCL. / HAUT.                                          |
| PREV / PREVIOUS / NEXT (chips)                 | PRÉC. / PRÉC. / SUIV.                                           |
| Previous / Next (button text)                  | Précédent / Suivant                                             |
| L / R (relative bearing)                       | G / D                                                           |
| SIG / NEWS / LOCAL (briefing tabs)             | SIG / ACTUS / LOCAL                                             |
| compass points (N, NNE, …, W, NW)              | N, NNE, …, O, NO                                                |
| NOT AN ALL-CLEAR                               | PAS UN FEU VERT                                                 |
| AI agent                                       | agent IA                                                        |
| share (a view or link)                         | partager                                                        |
| click / click to …                             | cliquez / cliquer pour …                                        |
