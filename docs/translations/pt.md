# Brazilian Portuguese (`pt`)

Catalog: `src/i18n/locales/pt.json`. General rules: [TRANSLATORS.md](../TRANSLATORS.md).

Translation source: abiyeenzo (#909).

## Style

- Brazilian Portuguese (pt-BR): câmera, tela, compartilhar, arquivo, baixar, ônibus, metrô. Every `pt` tag, `pt-PT` included, gets this catalog, so avoid slang and regionalisms.
- Address the user with «você» imperatives: «Clique no mapa», «Ative o CCTV», «Tente novamente». Tooltips that name an action use the infinitive: «Expandir painel», «Redefinir a câmera».
- Sentence case, not Title Case: "Live Flights" → «Voos ao vivo». UPPERCASE English stays UPPERCASE: «AO VIVO», «SEM DADOS».
- Quotes inside Portuguese text are straight double quotes: «Excluir o plano "{shot}"?».
- Short labels, chips and HUD readouts stay short. A standard abbreviation with a period beats a wrapped line: ANT., PRÓX., DESLIG., EXCL., INCL., ALT., VEL., câm.
- The HUD codes HDG, BRG, CRS, FOV, DEST, SPD, RANGE, ALT, GS and TRK stay in English, as in cockpit avionics. Words used in a sentence are translated: heading → «rumo», range → «alcance».
- Keyboard keys stay in English: Space, Esc, Enter, Tab, Shift, Backspace, H, 1–9 («Segure Space para falar»).
- Common English tech words used in Brazil stay: feed, stream, snapshot, briefing, dock, layout, bloom, status, app, link, token.
- Units: km, m, km/h, m/s, kt (knots), ft (feet), h, min, s; in UPPERCASE text KM, KM/S, KT, FT, MIN, H. "m" is always metres, so minutes are «min» («há 5 min»). MW stays MW. `°` and `%` stay. Decimal comma in written numbers («M4,4»).
- "ago" goes before the time: «há {count} min». When a placeholder already holds a localized "ago" text (`{age}`, `{ago}`), do not add «há» again.
- Money: «US$ {amount} mil / mi / bi» for thousands, millions and billions.
- Compass points use Leste/Oeste: N, NNE, NE, ENE, L, ESE, SE, SSE, S, SSO, SO, OSO, O, ONO, NO, NNO; hemisphere letters N, S, L, O.

## Plurals

A `tn()` entry needs three forms. `Intl.PluralRules('pt')` follows Brazilian usage:

| Form    | Counts                                 | Example            |
| ------- | -------------------------------------- | ------------------ |
| `one`   | 0, 1 and anything below 2: 0, 1, 1.5   | 0 câmera, 1 câmera |
| `many`  | 1 000 000, 2 000 000… (exact millions) | 1000000 de câmeras |
| `other` | everything else: 2–999 999, 2.5…       | 3 câmeras          |

The `many` form is the `other` text with «de» after the number: «{count} de câmeras carregadas», «{count} DE CHAVES PENDENTES». A `one` form is also read for 0, so keep it natural with zero («0 arquivo selecionado» is standard Brazilian usage).

## Glossary

| English                                       | Português                                                    |
| --------------------------------------------- | ------------------------------------------------------------ |
| layer / data layer                            | camada / camada de dados                                     |
| feed / source / data source                   | feed / fonte / fonte de dados                                |
| LIVE (status) / live data                     | AO VIVO / dados ao vivo                                      |
| SIMULATED                                     | SIMULADO                                                     |
| stale / degraded / unavailable                | desatualizado / degradado / indisponível                     |
| retry / retrying                              | nova tentativa / tentando de novo                            |
| key (API key) / POWER UP / POWERED UP         | chave / ATIVAR / ATIVADO                                     |
| Provider Settings                             | Configurações de provedores                                  |
| ON / OFF (state chips)                        | ATIVO / INATIVO                                              |
| enable / disable                              | ativar / desativar                                           |
| globe / map / map source / map stack          | globo / mapa / fonte do mapa / pilha de mapas                |
| basemap / tile                                | mapa base / bloco                                            |
| aircraft, plane / flight / military flights   | aeronave, avião / voo / voos militares                       |
| vessel, ship                                  | embarcação                                                   |
| satellite / shell (Starlink) / DENSE          | satélite / camada orbital / DENSO                            |
| launch (rocket) / launch site / space mission | lançamento / local de lançamento / missão espacial           |
| ascent / replay / payload / stage             | subida / reprise / carga útil / estágio                      |
| contact / tracking / track                    | contato / rastreamento / rastro                              |
| installation / site                           | instalação / local                                           |
| mapped / observed                             | mapeado / observado                                          |
| camera / CCTV camera                          | câmera / câmera de CCTV                                      |
| earthquake / active fire                      | terremoto / incêndio ativo                                   |
| advisory (NHC/CPHC cyclone)                   | boletim                                                      |
| radio station / broadcaster                   | estação de rádio / emissora                                  |
| road / flow (traffic)                         | via / fluxo                                                  |
| Street Level (layer)                          | Nível da rua                                                 |
| scene / shot / scene recipe                   | cena / plano / receita de cena                               |
| briefing / panel / dock                       | briefing / painel / dock                                     |
| cockpit                                       | cabine                                                       |
| preset / visual preset                        | predefinição / predefinição visual                           |
| Scope (circular viewport mask) / keyhole      | mira / visor                                                 |
| feather / fade                                | suavização / esmaecimento                                    |
| detection overlay                             | sobreposição de detecção                                     |
| pin (Draw tool) / box (Recent Imagery)        | marcador / área                                              |
| Cyber (HUD layout, effect)                    | Ciber                                                        |
| heading / course / altitude / ground speed    | rumo / curso / altitude / velocidade solo (VELOC. SOLO)      |
| HDG / BRG / CRS / FOV / DEST / SPD / RANGE    | HDG / BRG / CRS / FOV / DEST / SPD / RANGE (unchanged)       |
| PREV / NEXT                                   | ANT. / PRÓX.                                                 |
| Previous / Next (button text)                 | Anterior / Próximo (Próxima)                                 |
| L / R (relative bearing)                      | E / D                                                        |
| SIG / NEWS / LOCAL (briefing tabs)            | SIG / NOTÍCIAS / LOCAL                                       |
| PITCH / HGT (CCTV calibration chips)          | INCL. / ALT.                                                 |
| NOT AN ALL-CLEAR                              | NÃO GARANTE SEGURANÇA                                        |
| turn-by-turn: turn left / keep left / lane    | vire à esquerda / mantenha-se à esquerda / faixa da esquerda |
