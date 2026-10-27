# Traditional Chinese (`zh-Hant`)

Catalog: `src/i18n/locales/zh-Hant.json`. General rules: [TRANSLATORS.md](../TRANSLATORS.md).

Sources: caxer (#724), tbdavid2019 (#652), and the zh-CN catalog credited to abiyeenzo (#914) and EDIT-Aeterna (#979). The remaining entries were seeded with OpenCC s2twp and edited for consistency. The catalog retains terminology from these Taiwan-oriented sources; `zh-Hant` identifies the writing system and does not promise separate regional vocabulary.

## Style

- Use Traditional characters and consistent terminology from the glossary below. Prefer short, neutral instructions: 「點選地圖」、「儲存金鑰」.
- Use full-width Chinese punctuation and 「」 for quotations. Keep `·`, `…`, provider names, codes and placeholders unchanged.
- Separate Chinese from Latin letters and numbers with a space: 「AIS 船舶」、「24 小時」. Keep unit symbols unchanged: km, m, km/h, m/s, kn, ft, MW, °, %.
- Relative-time placeholders may already include 前. In `LIVE · updated {age}`, the caller supplies the complete relative age; do not append another 前.
- Chinese labels have no uppercase variant. Keep button labels short and avoid splitting short words across lines.
- The picker displays 中文（繁體） / Chinese (Traditional). Browser tags with Hant or TW/HK/MO select the shared `zh-Hant` catalog. Existing `zh-TW` links and saved choices remain supported. Explicit Hans selects Simplified Chinese, including Hans-TW.

## Plurals

`Intl.PluralRules('zh-Hant')` uses only `other`. Keep suitable measure words: 「{count} 架飛機」、「{count} 艘船」、「{count} 個金鑰」.

## Catalog terminology

| English | Traditional Chinese |
| --- | --- |
| data / information | 資料 / 資訊 |
| file / folder | 檔案 / 資料夾 |
| settings / save | 設定 / 儲存 |
| API key / token | API 金鑰 / 權杖 |
| live / load | 即時 / 載入 |
| camera / video | 攝影機 / 影片 |
| network / link | 網路 / 連結 |
| image / imagery | 圖像 / 影像 |
| click / double-click | 點選 / 按兩下 |
| response / timeout | 回應 / 逾時 |
| layer / data layer | 圖層 / 資料圖層 |
| cockpit / context | 駕駛艙 / 態勢 |
| air quality | 空氣品質 |
| transit / bikeshare | 大眾運輸 / 公共自行車 |

## Context-sensitive terms

- Weather `CLEAR` is 晴; `action|CLEAR` is 清除.
- `LOCAL INFO` describes 在地資訊; 本機 refers to the local device.
- Observation windows describe 範圍, not a UI 視窗. The scope control is 視域 and its feather slider is 視域邊緣羽化.
- Roundabouts are 圓環; telemetry is 回報; weather advisories are 發布.
- Intercardinal compass points: NNE 北北東, ENE 東北東, ESE 東南東, SSE 南南東, SSW 南南西, WSW 西南西, WNW 西北西, NNW 北北西.
- The Celestial control and its help text use 天球環. An uncalibrated camera's `RAW PRIOR` is 原始推估.
- `Wind unavailable` is shared by cyclone wind-speed cards and the wind-field layer; keep the wording broad enough for both (風況資料不可用).
