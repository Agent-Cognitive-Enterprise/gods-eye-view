# Traditional Chinese (`zh-Hant`)

Catalog: `src/i18n/locales/zh-Hant.json`. General rules: [TRANSLATORS.md](../TRANSLATORS.md).

Sources: caxer (#724), tbdavid2019 (#652), and the zh-CN catalog credited to abiyeenzo (#914) and EDIT-Aeterna (#979). The remaining entries were seeded with OpenCC s2twp and edited for consistency. The catalog retains terminology from these Taiwan-oriented sources; `zh-Hant` identifies the writing system and does not promise separate regional vocabulary.

## Style

- Use Traditional characters and consistent terminology from the glossary below. Prefer short, neutral instructions: 「點選地圖」、「儲存金鑰」.
- Use full-width Chinese punctuation and 「」 for quotations. Keep `·`, `…`, provider names, codes and placeholders unchanged.
- Separate Chinese from Latin letters and numbers with a space: 「AIS 船舶」、「24 小時」. Keep unit symbols unchanged: km, m, km/h, m/s, kn, ft, MW, °, %.
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
