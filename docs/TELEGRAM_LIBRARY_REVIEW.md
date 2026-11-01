# Telegram library review

Preliminary desk review, 31 October 2026. **Telegram stays disabled.** This records
what could be established by reading the package and its public metadata. It is
not a security audit, and it does not approve anything.

## Where things stand

- `teleproto` is **not in `package.json`**. It was removed from the lockfile until a
  library is approved, so nothing is installed.
- The adapter cannot start without `GEV_TELEGRAM_ALLOWED=1`, whatever the panel or
  the settings file say, and with it unset it does not even read a login.
- No credentials have been requested or stored.
- The adapter uses a small interface in `adapters/telegramClient.js`, so changing
  library touches that one file.

## Why `teleproto` was chosen, and why that no longer stands

GramJS (`telegram` on npm) was archived by its maintainers in July 2026 with a notice
pointing to `teleproto`. That made it the obvious successor, and it audited clean.
Looking further:

| Fact                 | `teleproto` 1.232.0 | `cifrante` 0.6.0                   | `gramjs` (archived) |
| -------------------- | ------------------- | ---------------------------------- | ------------------- |
| Maintainers          | 1                   | 1, the same person                 | Several             |
| First published      | May 2025            | **6 October 2026**                 | 2019                |
| GitHub stars / forks | 317 / 17            | **2 / 0**                          | 1,763 / 234         |
| Versions             | 59                  | 13 in 25 days                      |                     |
| npm build provenance | None                | None                               |                     |
| Install scripts      | None                | None                               |                     |
| Known advisories     | None (`npm audit`)  | None (a new package has no record) |                     |
| Weekly downloads     | 71,694              |                                    | 333,041             |

`cifrante` is what matters. `crypto/IGE.js`, `crypto/CTR.js` and
`crypto/Factorizator.js` all call it, along with `Password.js`, so the MTProto message
encryption and the two-step password handling for a real account would run through a
library 25 days old, with two stars and one author, shipped as 230 KB of bundled code.
A single compromised release of either package could read a Telegram session.

`teleproto` also pins an old `cifrante` (0.6.0 against 0.8.1 current), so fixes in the
crypto library do not reach it without a new `teleproto` release.

Nothing here shows either package is malicious: no `eval`, no `child_process`, no
unexpected network hosts were found by search. The concern is that very little
independent scrutiny stands behind code that would hold an account credential.

## Recommendation

Do not approve `teleproto`. Compare these first:

| Candidate      | For                                                                  | Against                                                  |
| -------------- | -------------------------------------------------------------------- | -------------------------------------------------------- |
| `tdl` + TDLib  | TDLib is Telegram's own C++ client, the most reviewed code available | Native build; 37,000 downloads a week; heavier to run    |
| `@mtcute/node` | Maintained, 163,000 downloads a week, MIT                            | Native `better-sqlite3` dependency; needs its own review |

## Before any account is connected

1. Choose a library and record who reviewed it.
2. Use a dedicated monitoring account, never a personal one: a session grants the
   whole account.
3. Confirm the reviewed version is pinned exactly, with integrity hashes in the
   lockfile.
4. Test against a channel you control before following any others.
5. Only then set `GEV_TELEGRAM_ALLOWED=1`.
