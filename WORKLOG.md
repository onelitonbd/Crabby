# WORKLOG.md — Crabby লগবুক (Telegram মিরর)

> **নোট (2026-10-16):** আগের ফাইলটি স্যান্ডবক্স-স্ন্যাপশট রিস্টোরে হারিয়েছে; এই ফাইলটি সেশন-রেকর্ড থেকে
> পুনর্গঠিত। এখন থেকে রিপোতেও মিরর হয় (`WORKLOG.md`, repo root) যাতে আর হারাতে না হয়।
> Telegram ডাউন (repo secret `TG_BOT_TOKEN` রিভোকড); নতুন টোকেন দিলে আবার সেখানেও যাবে।

## লগ

- **3f5fcb9 / 84f0270 / 674bfcd** — ধাপ ১-এর প্রথম ব্যাচগুলো: T7 (task detail), T16+T8 (session switcher + context
  view), এবং তার পরের ধাপ। push ✔, গেট ✔।
- **84b3c6a** — composer-ব্যাচ: T5-03/04/05/07/08/10 (slash menu, attach, one-turn model pin, cancel, queue,
  token estimate)। গেট: ফুল sweep 1050/1050, tsc শূন্য, biome ✔। push ✔।
- **86495ac** — T12+T14+T13 wiring: `tools.ts`/`access.ts`/`settings.ts` (unit-tested আগেই) main.ts-এ জোড়া হলো —
  models pane-এ `t`-তে tools view (dangerous-first, Enter-এ schema fold); logs pane-এর `v` এখন ৫ স্টপ (log → audit →
  decisions → clients → config); access-এ `r` দুবার চাপলে revoke + `n`-এ pair-code mint; config-এ buffer → diff →
  write (CLI-র একই `applyEdit`, CAS, 0600)। `client.ts`-এ `pairCode()`। ফুল sweep 1154/1154। push ✔।
- **d30f497** — style: panes.test format + context.test useTemplate (biome repo-wide শূন্য ত্রুটি)। push ✔।
- **d329ab2** — polish ব্যাচ (৬টা element row): T5-02 (আসল terminal cursor, block glyph টিটিতে নেই), T5-09 (↑/↓-তে
  ইনপুট-হিস্ট্রি হাঁটা, নতুনতমের পরে খালি বাফারে বেরিয়ে যায়), T8-08 (send-এর আগে overflow সতর্কতা + দুই সমাধান),
  T1-08 (চলমান টাস্কে q/Ctrl-Q একবার জিজ্ঞেস করে — "the task survives"; Ctrl-Z suspend + SIGCONT redraw), T2-09/T-C8
  (task id ও watch-command ট্রান্সক্রিপ্টে bare লাইনে), T6-01 (tasks pane-এ filter row: `f` ঢোকা/ফিল্ড টগল, Esc
  ক্লিয়ার)। HANDOVER.md §2/§3 হালনাগাদ; T5-06 gap-note ("which identity am I" route নেই)। ফুল sweep **1168/1168**,
  tsc শূন্য, biome 242 ফাইল ✔। push ✔।

## করলাম (সর্বশেষ নির্দেশ অনুযায়ী)

TUI-র বাকি সব কাজ শেষ: ধাপ ১-এর ৫ ব্যাচই (T7; T16+T8; composer; T12+T13+T14; T1/T3 polish) সম্পূর্ণ। ধাপ ২-র
route-নির্ভর row (GET /logs, GET /audit, model probe, job delete) TUI-তে যা সম্ভব তাই আগেই হয়েছে — ভিউগুলো তাদের
route-gap নিজেই নাম করে দেখায় (logs.ts, models.ts, jobs.ts); ধাপ ৩-র milestone-বাঁধা row (tunnel/vault, T9/T-E)
accessLines-এর gap-তালিকায় নাম-সহ রেকর্ডেড। **TUI build এখানেই শেষ — থামলাম।**

## পরের কাজ (বাকি-হিসাব)

1. **Web UI** (D-068: custom elements, no SPA) — ব্যবহারকারীর স্কোপে আছে, TUI শেষ হয়েছে বলে এরপর শুরু করার কথা।
2. **Telegram bot** — tunnel লাগবে; টোকেন পেলে নোটিশ পুনরায় চালু।
3. Route-নির্ভর বাকি অংশ (ধাপ ২): `GET /logs`, `GET /audit`, `POST /models/…/probe`, job-delete-র history-path —
   Gateway-র route + store ছাড়া TUI/Web-এ আর ভাবনাই নেই; gap-note সব জায়গায় আছে।
4. খোলা সিদ্ধান্ত: D-066 vault-secrets (T12-08), O-তালিকা HANDOVER §7-এ।
