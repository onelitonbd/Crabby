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

- **29d0413** — WORKLOG.md রিপো-মিরর শুরু; এ পর্যন্ত TUI build সম্পূর্ণ, রিপোর্ট ও বাকি-হিসাব চ্যাটে। push ✔।
- **cbf5ccc** — **Web UI সম্পূর্ণ (D-068/D-067):** Gateway-ই `apps/web`-কে সার্ভ করে (`packages/gateway/web.ts` +
  app.ts-এ webRoot hook, REDEEM-এর আগে; containment + content-type map + no-store)। Client: কোনো framework/build নেই —
  custom elements; safe.js (template-ভিত্তিক escape, নেস্টেড template SafeString-এ বিনা double-escape-এ যায়), router.js
  (hash → screen; `#/models` জাতীয় পুরনো টপ-লেভেল hash settings-subtab-এ normalize, অজানা → chat + W-O8 নোট), format.js
  (W16-01 cron + words), store.js। ৮টা screen: connect (শুধু redeem, D-053), chat (messages/slash/streaming/stop —
  W4-08 running ফ্রেম থেকে, stop-এ আলাদা ক্লাস যাতে send-এর সাথে কখনো bind না হয়), tasks (৯ ফিল্টার, detail =
  events+checkpoint), approvals (A3 exact-target, A10 conflict banner, A12 why), sessions (rename = quoted If-Match,
  delete = টাইটেল-টাইপ কনফার্ম W15-07), jobs (W16-01 দুইভাবে লেখা schedule, pause/resume/run-now), settings ৭ সাবট্যাব
  (schema-driven config + W12-02 diff-before-apply + T3 মার্কার; access-এ loopback ব্যাখ্যা; logs-এ diagnostics + sk_/crt_
  স্ক্যান W14-05)। Route-নেই জায়গায় নাম-সহ gap-block (logs/memory/extensions/vault/tunnel/lifecycle/telegram/jobDelete/
  probe/onboarding)। CLI: `web open` (absent → বলে `gateway start` করো; stale → শেষ ঠিকানা)। SECURITY.md §13-এ
  স্কোপ-নোট: asset হলে টোকেন লাগে না, প্রতিটা API route লাগে — প্রমাণ web.test.ts (4/4)। DECISIONS.md কাউন্টার 18।
  টেস্ট: web.test.ts 30/30, ফুল sweep **1202/1202**, tsc শূন্য, biome 270 ফাইল ✔, parity ✔, docs:check ✔; jsdom
  smoke (throwaway) ১২/১২ সবুজ। push ✔।

## করলাম (সর্বশেষ নির্দেশ অনুযায়ী)

TUI-র সব কাজ আগেই শেষ (ধাপ ১-এর ৫ ব্যাচ, ধাপ ২-৩ gap-note-সহ)। এরপরের নির্দেশ ছিল "সব web implementation শেষ করো এবং
আমাকে জানাও" — **Web UI (D-068) সম্পূর্ণ**, cbf5ccc-এ push; রিপোর্ট ও বাকি-হিসাব চ্যাটে। এখানেই এই স্তর শেষ — থামলাম।

## পরের কাজ (বাকি-হিসাব)

1. **Telegram bot** — tunnel লাগবে; টোকেন পেলে নোটিশ পুনরায় চালু। Web-এর access screen-এও telegram gap-note আছে।
2. Route-নির্ভর বাকি অংশ (ধাপ ২): `GET /logs`, `GET /audit`, `POST /models/…/probe`, job-delete, providers (W9),
   extensions/memory — Gateway route ছাড়া TUI/Web-এ ভাবনা নেই; দুই ক্লায়েন্টেই নাম-সহ gap-note আছে।
3. খোলা সিদ্ধান্ত: D-066 vault-secrets (milestone-বাঁধা), O-তালিকা HANDOVER §7-এ।
