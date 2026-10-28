# Japanese (`ja`)

Catalog: `src/i18n/locales/ja.json`. General rules: [TRANSLATORS.md](../TRANSLATORS.md).

Translation source: abiyeenzo (#913).

## Style

- Sentences use です／ます: 「キーを保存しました」, 「もう一度お試しください」. Labels, buttons and HUD chips are short nouns or verb stems without a final 。: 「再試行」, 「保存」, 「ライブ」, 「オフ」.
- Japanese has no case: an UPPERCASE English label becomes the same short Japanese label. Codes, units and names stay in their own case (HDG, ADS-B, km).
- Full-width punctuation in Japanese text: 、。：？！（）「」. Quote names and titles with 「」: 「{shot}」を削除しますか？ Keep `·` as the HUD separator, `…` for an ellipsis and `—`, `→`, `↗` as in English. A dash inside a sentence becomes 。 or ：.
- Button names cited in running text go in ［］: ［次へ］を使ってください.
- No space between Japanese and Latin letters, digits or a `{placeholder}`: 「AIS船舶」, 「Spaceを長押しで話す」, 「{count}件」, 「{name}を表示」.
- Two exceptions keep the space: a Japanese label before its value in a readout (「雲量 {pct}%」, 「ステーション {id}」, 「高度 {altitude}」), and the state words in toggles (「CCTV オン」, 「ラジオ オフ」).
- Loanwords are katakana with the long-vowel mark, as in Microsoft and Apple style: ユーザー, ブラウザー, ビューアー, プロバイダー, レイヤー, フィルター, モニター, パラメーター. Pick one katakana form per term and keep it (see the glossary).
- Product, provider and dataset names stay in Latin script: Google Maps, Cesium ion, OpenSky, CelesTrak, NASA FIRMS, Sentinel-2, KartaView. Google's own product names use Google's Japanese, joined like any Latin word: Googleストリートビュー. Nepal place names in the Bhote Koshi scenes stay in Latin script, as in zh-CN; country and well-known city names are translated (ネパール, 東京, オースティン).

## Numbers, units and dates

- Units: km, m, km/h, m/s, kt, ft, mph, hPa, MW, dB, °, % stay as written, with the English spacing (「250 km」, 「{frp} MW」, 「95 kt」).
- Time units are words written straight after the number: 秒, 分, 時間, 日 (「5分前」, 「{count}時間」, 「1時間5分」). `formatQuantity` and `formatRelativeTime` drop the space for Japanese unit words, so code-built values match the catalog.
- Counters follow the thing counted: 機 (aircraft), 隻 (ships), 基 (satellites), 台 (cameras, vehicles), 局 (stations), 件 (records, results, events), か所 (sites), 個 (generic). Prefer a counter to a bare number.
- Dates come from `Intl` and read year first: 2026年8月26日. Coordinates in prose are 北緯 / 東経; HUD hemisphere letters stay N, S, E, W.

## Plurals

`Intl.PluralRules('ja')` has one category, `other`: a `tn()` entry has only that form. Put the counter next to the number: 「航空機{n}機」, 「船舶{n}隻」, 「メッセージ {count}件」.

## Glossary

| English                                   | 日本語                                  |
| ----------------------------------------- | --------------------------------------- |
| layer / data layer                        | レイヤー / データレイヤー               |
| feed                                      | フィード                                |
| source / data source / attribution        | ソース / データソース / 出典            |
| LIVE (status) / live data                 | ライブ / ライブデータ                   |
| SIMULATED                                 | シミュレーション                        |
| stale / degraded / unavailable            | 更新遅延 / 性能低下 / 利用不可          |
| retry                                     | 再試行                                  |
| key (API key) / POWER UP                  | キー（APIキー）/ パワーアップ           |
| Provider Settings                         | プロバイダー設定                        |
| globe / map / map source / basemap        | 地球儀 / 地図 / マップソース / ベースマップ |
| mapped (OSM-mapped sites)                 | マップ済み                              |
| aircraft / flight / military flights      | 航空機 / フライト / 軍用機              |
| vessel, ship                              | 船舶                                    |
| satellite                                 | 衛星                                    |
| launch (rocket) / space mission           | 打ち上げ / 宇宙ミッション               |
| stage (rocket) / downrange                | 段 / ダウンレンジ                       |
| contact (tracked object)                  | コンタクト                              |
| installation, site                        | 施設                                    |
| camera / CCTV camera                      | カメラ / CCTVカメラ                     |
| earthquake / active fire / fire perimeter | 地震 / 火災検知 / 延焼範囲              |
| contained (fire)                          | 鎮圧                                    |
| scene / shot                              | シーン / ショット                       |
| briefing / panel / dock                   | ブリーフィング / パネル / ドック        |
| preset / visual preset                    | プリセット / ビジュアルプリセット       |
| Tactical / Operator / Minimal / Cyber     | タクティカル / オペレーター / ミニマル / サイバー |
| Scope (circular viewport mask) / keyhole  | スコープ / キーホール                   |
| Clean UI                                  | クリーンUI                              |
| cockpit                                   | コックピット                            |
| heading / altitude / ground speed         | 機首方位 / 高度 / 対地速度              |
| HDG / BRG / CRS / FOV                     | そのまま（HUDコード）                   |
| squawk                                    | スコーク                                |
| map heading / North up                    | 方位 / 北を上に                         |
| Street Level / Street View (Google)       | ストリートレベル / ストリートビュー     |
| Recent Imagery                            | 最近の衛星画像                          |
| Global Context / Context (panel)          | グローバルコンテキスト / コンテキスト   |
| radio (station) / tune / seek             | ラジオ（局）/ 選局・同調 / シーク       |
| transit / bikeshare                       | 公共交通 / シェアサイクル               |
| Previous / Next                           | 前へ / 次へ                             |
| compass points (N, NNE, NE, ENE, …)       | 北, 北北東, 北東, 東北東, …             |
| weather field / FIELD (selector)          | 要素                                    |
| weather model / forecast lead hours       | モデル / 予報時間                       |
| valid (forecast time) / issued            | 対象時刻 / 発表                         |
| radar reflectivity / lightning density    | レーダー反射強度 / 雷密度               |
| cyclone / advisory (NHC/CPHC)             | サイクロン / 情報（第N報）              |
| forecast uncertainty cone                 | 予報円                                  |
| tropical storm / tropical depression      | 熱帯暴風雨 / 熱帯低気圧                 |
| scene cloud / mosaic / daily overview     | シーン雲量 / モザイク / 日次概観        |
| box (Recent Imagery area)                 | 範囲                                    |
| pin (Recent Imagery)                      | 固定                                    |
| outline / mark (map annotation)           | 輪郭 / マーク                           |
| share (a view or link)                    | 共有                                    |
| AI agent                                  | AIエージェント                          |
| frame (bring into view)                   | 視野に収める                            |
| story beat / evidence beat                | ストーリー区切り / 証拠の区切り         |
| camera pose / camera move                 | カメラの姿勢 / 移動                     |
| roundabout / ramp / exit                  | ロータリー / ランプ / 出口              |
| reduced motion                            | 動きを減らす                            |
| NOT AN ALL-CLEAR                          | 安全の保証ではありません                |
