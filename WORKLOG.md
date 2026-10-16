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

## করলাম (সর্বশেষ: Telegram bot-এর সব implementation)

"tahole ekhon telegram bot er sob kaj ja ja implementation dorkar sob ses koro. erpor amake janao" — **Telegram bot
(TELEGRAM.md-এর ১১ region, 129 element) সম্পূর্ণ**, এক কমিটে push।

- **`packages/telegram` (২৩ ফাইল, D-132):** limit (4096/1024/64B, edit-floor 1100/3100ms, UPLOAD 50MB, MENU 10,
  POLL 25s, SHED 12/min, TARGET_OWN 2000) · format (G2: escape, subset→plain, fence-সচেতন split, stamp, truncation) ·
  commands (৩৬ row = ৩২+৪ refusal, menu ৭, parse +@bot, closest) · state (**telegram.json = D-078-এর ৬ষ্ঠ ফাইল**,
  0600, corrupt→empty) · transport (grammY, 429 retry_after, is_bot→ignored G1-08) · outbound (per-chat pace, 429→
  (retry_after+1)s→১ পুনঃপ্রয়াস→recordFailedSend G-T06, edit coalescer, approval bypass G-A13) · approvals
  (`apr:<id>:<nonce>`, triple-verify G-A4, ≤2000 G-A10) · watch (SSE + Last-Event-ID + gap, reconnect 1.5s, terminal
  নিজ মেসেজ G4-03, silence ≥30s G4-07, final>3800 G4-05) · surface (সব ৩২ কমান্ড + সৎ gap: /logs /export /delete
  /tunnel /memory /ext /probe; config set→confirm→apply দুই-ধাপ, telegram.* refused G7-03) · bot (gate নীরব G1-01,
  shed G-S10, pair redeem, ৩৬ কমান্ড রাউটিং, approval decide 409→conflict) · run (getUpdates offset+1, প্রতি update
  শেষে setOffset G-S03, poll-ব্যর্থতায় backoff 2s→×2→60s) · index barrel।
- **CLI:** `crabby telegram start` — টোকেন নেই→usage+fix-লাইন; `vault://`→vault-বাক্য+platformUnsupported (এই বিল্ডে
  resolve নেই, F-56/M5); wiring `startTelegramLoop` exported (M5-এ বসবে)। core/config.ts-এ TelegramConfig
  (allowUsers/allowChats regex)। gateway client-এ PUT method।
- **ডকুমেন্ট:** DECISIONS.md **D-132** (adapter-প্যাকেজ + telegram.json ৬ষ্ঠ + token রানটাইমে, counter 132) +
  docs/DATA_AND_MEMORY.md §4.1-এ telegram.json রো।
- **যাচাই:** টেলিগ্রাম-প্যাকেজ টেস্ট **১০৪/১০৪** (১০ ফাইল), ফুল sweep **1308/1308**, tsc শূন্য, biome ✔, parity ✔
  (32 routes), docs:check ✔ (24 docs)।
- **যা হয়নি (সৎ):** লাইভ Telegram টোকেন নেই — প্রকৃত getUpdates পোল/setMyCommands চালানো যায়নি; টোকেন পেলে
  `crabby config set telegram.token <token>` → `crabby telegram start`।

## পরের কাজ (বাকি-হিসাব)

1. M5 vault slice → `vault://telegram/bot-token` resolve হলে startTelegramLoop বসবে; লাইভ টোকেনে পোল-যাচাই।
2. Route-নির্ভর বাকি (ধাপ ২): GET /logs, /audit, probe, job-delete, providers (W9), extensions/memory — তিন
   ইন্টারফেসেই gap-note।
3. খোলা সিদ্ধান্ত: D-066 vault-secrets (milestone-বাঁধা)।

## করলাম (টোকেন এসেছে — লাইভ যাচাইয়ের প্রস্তুতি)

মালিক নতুন bot টোকেন দিলেন (2026-10-16)। টোকেন কোথাও কমিট/লগ হয়নি — workspace-এ `.tg-token` (0600, রিপোর বাইরে)।

- **স্যান্ডবক্সের সীমা, প্রমাণসহ:** `api.telegram.org`-এ DNS বসে, TLS হ্যান্ডশেক কাটা পড়ে (SSL_ERROR_SYSCALL) — egress
  allowlist-এ Telegram নেই। তাই লাইভ পোল এই পরিবেশ থেকে সম্ভব নয় (আগের "Telegram blocked" নোটেরই পুনর্নিশ্চিতি);
  Telegram-নোটিশও এখান থেকে পাঠানো যায় না — WORKLOG mirror-ই চলছে।
- **`scripts/telegram-live-check.ts` + `npm run telegram:check`:** মালিকের ডিভাইসে এক কমান্ডে D-132-এর তিন অযাচাইত
  বিষয় যাচায় — getMe (টোকেন), setMyCommands (মেনু), getUpdates 5s (পোল, আমাদের addressUpdate দিয়ে শেপ-প্রিন্ট,
  content নয়)। টোকেন env থেকে (G1-03: argv/লগ নয়), কোথাও সংরক্ষিত নয়। 401/409/নেটওয়ার্ক — তিনটারই নাম-ধরা ব্যাখ্যা।
- **এখানে যা যাচাই হলো:** no-token → usage + exit 1; নেটওয়ার্ক-ব্যর্থতা → সৎ লাইন + exit 1 (উপরের স্যান্ডবক্স-সীমার
  বার্তাসহ)। tsc শূন্য, biome ✔। **বাকি:** ফোন/হোস্টে `TG_BOT_TOKEN=… npm run telegram:check` চালিয়ে আউটপুট দেখা।

## করলাম (M3 বন্ধ — ফাইনাল চেক)

"final check diye M3 ses kore M4 chalu koro" — **M3 কোড-সম্পূর্ণ ঘোষণা করলাম**, যাচাইসহ:

- **ফাইনাল সুইপ (2026-10-16):** ফুল টেস্ট **1308/1308**, tsc শূন্য, biome শূন্য, parity ✔ (32 routes — §8-এর প্রতিটা
  blank cell-এ accepted limitation), docs:check ✔ (24 docs)। M3 exit-এর অটোমেটেবল অর্ধেক পাস।
- **যা বাকি (টোকেন-নির্ভর):** চার-ইন্টারফেস ডেমো (Telegram start → Web watch → TUI approve → CLI cancel) — হোস্টে
  `TG_BOT_TOKEN=… npm run telegram:check` পাস হলেই সম্ভব। HANDOVER §2-তে M3-এর এই অবস্থা লেখা হলো।
- **M4 শুরুর ভিত্তি:** ROADMAP §6 ক্রম — provider adapters + conformance (D-042 presets) → overrides-এর loop অর্ধেক
  (D-126-এর নাম-ধরা বাকি) → memory (D-065 FTS5) → skills (D-035) → MCP client (D-040) → importer C-1/C-2। M4-এর
  স্থাপত্য-সিদ্ধান্ত বেশিরভাগই আগেই বন্ধ (O-008/015/016/021/026/028/029/030/031/038)। মালিকের কাছে যে ক'টা সত্যিই
  খোলা (conformance-এর লাইভ প্রোভাইডার, route-নির্ভর স্কোপ, 'each' backlog action) — সেগুলো জিজ্ঞেস করা হলো।

## করলাম (M4 শুরু — মালিকের তিন উত্তর D-133)

মালিকের উত্তর: (১) conformance mock/recorded-transport-এই, লাইভ কি লাগবে না; (২) সব route-gap কাজ M4-এ ঢুকবে
(logs/audit store + whoami + DELETE /jobs + model probe); (৩) 'each' কনট্র্যাক্ট-অ্যাকশন হবে। **D-133** রেকর্ড
(counter 133) + HANDOVER §7-এর দুই খোলা আইটেম answered করা হলো।

**M4 slice 1 শুরু:** তিন অনুপস্থিত provider পরিবার — `ollama` (native model listing + pull state), `anthropic`
(message format + tool blocks), `gemini` (streaming + safety metadata) — প্রত্যেকে conformance suite পাস করবে
(§7: no live APIs; scripted transports)। বর্তমান ভিত্তি পড়া হয়েছে: conformance.ts (৫ area-র case-জেনারেটর),
contract.ts, fake.ts (reference), openai.ts (D-100), compose.ts-এর ABSENT_FAMILIES (৩টা কমবে; `mock` refused থাকবে)।

## করলাম (M4 slice 1 — তিন পরিবারের adapter + conformance)

**wire.ts:** guardFor/Guard/WireDeadlines/WIRE_DEADLINE_DEFAULTS/createInFlightTable/translateFailure/retryAfterFrom/
isRecord/asString/asNumber + requireDescriptor/refuseUndeclaredTools — openai.ts এখন এর ওপর দাঁড়িয়ে (43/43 অক্ষত)।

- **anthropic.ts + টেস্ট 13/13:** Messages API — system টপ-লেভেল, max_tokens ডেসক্রিপ্টর থেকে, tool_use/tool_result
  ব্লক, typed SSE, STOP_REASONS (অজানা→invalid-response), x-api-key কী। ২-ফেল-রহস্যের মূল-কারণ: স্টাবের handle()
  mode-ভিত্তিক ডিসপ্যাচ (conformance plain-text-ও stream করে) + টাইমার-লাইনে `type` অনুপস্থিত → স্টাব wire-ভিত্তিক
  (`body.stream===true`) → পাস। **শিক্ষা: স্টাব request যা চেয়েছে সে-ভিত্তিক হোক, টেস্ট-মুড-ভিত্তিক নয়।**
- **gemini.ts + টেস্ট 12/12:** generateContent/streamGenerateContent?alt=sse — parts grammar, functionResponse-এ tool-এর
  নাম (proposing-turn থেকে রেজলভ), SAFETY/RECITATION→content-filter, কী x-goog-api-key-তে (?key= কখনো নয়, G1-03)।
- **ollama.ts + টেস্ট 10/10:** native /api/chat NDJSON, done_reason টেবিল, options.num_predict, tool ফলে tool_name।
  **ডিজাইন-সংশোধন:** প্রথম খসড়া listModels-এ installed∪declared দেখাত; §7-এর নিজের কেস D-100-এর বাক্য কার্যকর করে —
  ডেসক্রিপ্টর-হীন নাম = অজানা সীমা = ফেল → `listModels()` ঘোষিত-প্রাইসড সেট; /api/tags স্ক্রিন + pull state
  (/api/pull, /api/ps) D-133-এর remainder-এ নাম-ধরে রেকর্ড (contract change, এক adapter-এ পঞ্চম মেথড নয়)।
- **compose.ts:** তিন কাইন্ড এখন রাউট হয় (anthropic/gemini/ollama-র নিজ নিজ কনস্ট্রাক্টর, overrides+deadlines সবার
  সাথে); ABSENT_FAMILIES-এ শুধু `mock` (§17: task মডেল-ছাড়া completed হতে পারে না)। compose.test এখন পজিটিভ — তিন
  পরিবারই কম্পোজ হয়।
- **ডক:** PROVIDERS_AND_TOOLS.md — "remain absent" বাক্য সরে "Implemented in M4 (D-133)" প্যারাগ্রাফ এসেছে (তিন
  পরিবারের wire-সার + /api/tags non-goal + pull-state remainder)।
- **গেট:** providers 145/145 (openai 43 + anthropic 13 + gemini 12 + ollama 10 + compose/fake/conformance বাকিটা),
  tsc শূন্য, biome শূন্য, parity ✔, docs:check ✔ (133 accepted)। ফুল sweep কমিটের আগে।
