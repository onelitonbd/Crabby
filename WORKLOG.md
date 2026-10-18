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

## করলাম (M4 slice 2 — override write-এর HTTP অর্ধ, D-134)

- **shared রাইটার সরানো হলো:** `nextOverride` + `describeOverride` + `writeOverrideRecord` এখন
  `packages/providers/override-write.ts`-এ — document write **injected** (`ConfigPersister`), কারণ providers প্যাকেজ
  ফাইল-লেআউটের মালিক নয়। CLI (model-edit.ts) নিজ layout বেঁধে পুরনো signature রাখল; Gateway route নিজটা বাঁধল।
  D-064/D-127-এর "both paths reach the same stored value" এখন তিন পাথে import-বলে বলবৎ।
- **`GET /api/v1/models`:** effective/reported/override/provenance পাশাপাশি; D-100 disabled entry নাম-ধরে সারিতে;
  `?provider=` ফিল্টার; `describe()` হতে পারে async — row অপেক্ষা করে।
- **`PUT /api/v1/models/{provider}/{model}/overrides`:** If-Match বাধ্যতামূলক; body = উত্তর-আকৃতি (`"true"|"false"|
  "auto"` স্ট্রিং, `auto` = দাবি প্রত্যাহার); `provider_unknown`/`model_unknown` নিজ কোডে (D-126 অঘোষিত মডেলের রেকর্ড
  ignore করে — dead key লেখা যাবে না); অপার্স-রেকর্ড → `override_unparsable` (clear অফার করে; বিশুদ্ধ clear পার্স ছাড়াই
  এগোয়); composition-এর গেট লেখার **পরে** — না-মাপান্দ → `composed:false` + কারণ, ফাইল তবু বদলায় (D-127)। `changed`
  ফাইল-সম্পর্কে, `changes` effective-সম্পর্কে — restatement প্রথমটা নড়ায় দ্বিতীয়টা নয়; note পার্থক্যটা বলে।
- **api-contracts/models.ts:** `PutModelOverridesBody` + `ModelOverridesWriteBody`।
- **§3.8-এর বাক্য চার adapter-এই পিন:** anthropic 14, gemini 13, ollama 11 (openai-র টেস্ট আগেই ছিল)।
- **ডক:** PROVIDERS_AND_TOOLS §3.8-এর শেষ রুলে D-134 বাক্য; INTERFACES §4.4-এর দুই row সমৃদ্ধ; ROADMAP-এ
  ষাট-ষষ্ঠ+সতেরোতম slice প্যারাগ্রাফ; D-134 রেকর্ড।
- **গেট:** models.test 8/8, model-edit 17/17, provider 18/18, tsc শূন্য, biome শূন্য। ফুল sweep কমিটের আগে।

## করলাম (M4 slice 3 — persistent memory: store + routes + CLI verbs)

- **schema v13:** `memory` (provenance: origin stated/confirmed/inferred, source_kind/id, source_missing, source_count,
  external, status active|superseded|needs-review|pending), `memory_reference`, `memory_search` + `memory_search_fts`
  (FTS5 unicode61, memory_id UNINDEXED — প্রথম চেষ্টায় কলাম ঘোষণা ভুলে ফেল-খেয়েছিল)।
- **packages/storage/memory.ts:** সব D-073/D-065 নিয়ম store-এ — শুধু newer-stated→older-stated supersede করে (অন্য
  কিছুই নয়); conversation-deletion কিছুই ডিলিট করে না — single-source → needs-review, multi-source → re-attribute +
  source_missing flag; pending queue = auto-memory-র ফিজিক্যাল অবস্থা; rebuildIndex(); trustWord() (শব্দ, কখনো % নয়)।
  টেস্ট ১১/১১।
- **D-135:** `mem_` = সপ্তম id-prefix (D-112-প্রেসিডেন্ট); ids.ts + contracts.test-এর "exactly the prefixes" লাইন
  উদ্দেশ্য করে বদলানো; INTERFACES traceability-তে যোগ। সিদ্ধান্ত counter 135।
- **gateway:** `createMemoryStore(db)` এক-ইনস্ট্যান্স; রাউট — GET/POST /memory, GET/PATCH/DELETE /memory/:id,
  GET /memory/search?q=, POST /memory/:id/review; রিফিউজাল কোড memory_unknown / memory_not_pending; লগে content কখনো
  নেই (§12) — id/count/bytes। টেস্ট ৭/৭। (শিক্ষা: Fastify-এ body ছাড়া content-type:json = empty-JSON রিফিউজাল —
  টেস্ট-হেল্পার header শর্তায়িত করে।)
- **CLI `crabby memory`:** list (--status), search (বাক্যেই "text search only in v1"), forget (আগে preview-print —
  C9-05), forget-topic (গুনে ছাপে, --yes কনফার্মেশন স্কিপ করে গোনাটা নয় — C9-06)। registry-তে চার verb ready +
  forget-topic নতুন row; crabby.ts dispatch।
- **ডক:** INTERFACES §4.4 memory rows সমৃদ্ধ; DATA_AND_MEMORY §2.3/§2.4 "Built (M4)" নোট; ROADMAP-এ আটষষ্ঠতম slice।
- **নাম-ধরা বাকি (এই M4-আইটেমের):** loop-এর automatic extraction + config toggle (memory.* namespace), executor-এ
  memory.save/search/delete tools, T9/W8/G3-19 স্ক্রিন; propagation call-site history.deleteConversation (C9-02 verb
  নেই)। স্যান্ডবক্স restore HEAD নামিয়েছিল (9c230b9) → fetch+reset-এ 391354a ফেরত; node_modules পুনঃইনস্টল।

## করলাম (M4 slice 4 — memory tools executor + auto-memory মোড, D-136)

- **core config:** `memory.autoMemory` namespace — `"off"` (ডিফল্ট) | `"propose"` (pending কিউ) | `"store"`; D-073-এর
  promotion threshold-এর কোনো কি নেই ইচ্ছাকৃতভাবে (কিছুই না-পড়া কি মিথ্যা ক্ষেত)।
- **packages/tools/memory.ts:** memory.save/search/delete — kill switch কম্পোজিশনে বাঁধা (প্রতি-কল মত নয়); `off` রিফিউজাল
  কি-নাম বলে; মডেল একটাই দাবি করতে পারে — `fromUntrustedContent` (escalation-এর T2 + store-এর external মার্কার);
  origin/status/sourceCount স্কিমাতেই নেই; sourceKind সবসময় "agent"; bulk T3 গুনে উত্তর দেয়; search/save-এর সীমা
  store-এর ঘড়ি ধার (sqliteBusyTimeoutMs)। টেস্ট ৬/৬।
- **gateway composition root:** memoryTools composed-তালিকায় (runner-থাকা গেটওয়েতে runtime.implemented 17→20)।
- **D-136 রেকর্ড** (৩ সিদ্ধান্ত: kill switch কম্পোজিশনের, মডেলের এক-দাবি, escalation-আর্গ = ডিক্লেয়ার্ড-আর্গ); INTERFACES
  GET /tools রো 17→20; ROADMAP-এ ঊনসত্তরতম slice; counter 136।

## করলাম (M4 slice 5 — extensions core: manifest + SKILL.md + checker + C-1, D-035)

- **নতুন প্যাকেজ `@crabby/extensions`** — EXTENSIONS.md-র content-only পথ প্রথমবার কোডে:
  - `manifest.ts` — §4.2 নেটিভ `crabby.extension.json`: অজানা-ফিল্ড hard reject (নাম ধরে), বাধ্যতামূলক ৮ ফিল্ড,
    reverse-DNS id, semver, hostApi {min,max} এক জোড়া (§4.4), SPDX-ish license, kind enum, 64 KiB/depth-8 পার্সার-সীমা,
    `HOST_API = 1.0`, EXECUTABLE_KINDS (tool/provider/hook/interface) vs CONTENT_KINDS।
  - `skill.ts` — §4.3/D-071 ফ্রন্টম্যাটার (yaml@2): name 1–64 + ফোল্ডার-নাম হার্ড-এরর, description 1–1024 untrusted,
    license অনুপস্থিত=warn, compatibility displayed-not-enforced, metadata version/author/tags/`crabby.*` + অজানা
    verbatim-preserved, `allowed-tools` recorded-never-granted (string-না-এন্ট্রি হলে পুরো তালিকা preserved), body
    >500 লাইন warn / >32 KiB validation-পাস-কিন্তু activationBlock (ট্রাঙ্কেশন নেই)।
  - `scan.ts` — §6 ধাপ-৬ স্ট্যাটিক স্ক্যান: ৫ নাম-ঘোষিত প্যাটার্ন (instruction-override, role-hijack, secret-exfiltration,
    shell-payload, destructive-command), description+body-তে, প্যাটার্ন-ক্রমে deterministic।
  - `check.ts` — §6 নির্ধারক চেকার: ফরম্যাট ডিটেকশন (native বা SKILL.md direct/one-level-down pack), §4.4 পলিসি
    (min-major>host → incompatible দুই-ভার্সন-নামে; additive-minor → লোড+named gap), platforms অনুপস্থিত="unstated"
    নন-"all", executable-kind → D-038 রিফিউজাল, capabilities-অনুরোধ warn-recorded, verdict
    compatible|partial|incompatible|unsafe (unsafe-এর override নেই)।
  - `convert.ts` — §11 C-1: pack (one-level-down) বা single; রিপোর্ট mapped/displayed/reinterpreted(খালি, ইচ্ছাকৃত)/
    unknown + allowedTools {raw, granted:false}; alias টেবিল Bash→shell.run, Read→fs.read, WebFetch→net.fetch…;
    `originals/`-ফোল্ডারে SKILL.md verbatim; `reports/`-এ timestamped JSON; সোর্স ডিরেক্টরি অস্পৃশ্য; unsafe কিছুই ইমপোর্ট করে না।
  - `workspace.ts` — §4.1 `<workspace>/skills` স্ক্যান (one skill per folder, ভাঙা ফোল্ডার স্ক্যান থামায় না)।
  - `repo.ts` — §12 verb-গুলোর ফাংশন-রূপ: extList (ফোল্ডার=সত্য reconcile + workspace-মার্জ + repo↔workspace
    collision রিপোর্ট, imported জেতে), extValidate, extInit, extCheckCompat, extInstall, extUninstall।
- **টেস্ট ৪১/৪১** (manifest 9, frontmatter 8, checker 9, conversion 8, repo 3, workspace 4) — node:test, tmpdir fixture।
- **শিক্ষা:** §4.3-র folder-name হার্ড-এরর সর্বত্র — টেস্ট-fixture-ও নাম-সঠিক ফোল্ডারে; §4.1-এর collision এক-কালেকশনে
  structurally অসম্ভব (folder=name হলে), তাই সেটি repo↔workspace মার্জে ধরা হয়; `docs/extensions/PACKAGES.md` +
  `docs/extensions/REPO.md` (অ্যাডভাইজরি ব্যাখ্যা: first-party-র লোডিং কোথায়, ইমপোর্ট-পাইপলাইনের লেআউট কী)।
- **ডক:** ROADMAP-এ সপ্ততম slice। yaml@2.9.1 রুট-dependency (--ignore-scripts)।

## করলাম (M4 slice 6 — `crabby ext` CLI verbs, C-E1…C-E12)

- **apps/cli/commands/ext.ts** — সাত verb ready: init/validate/check-compat/install/list/info/uninstall (update
  planned — C-E10-র show-diff-before-replace সোর্স-রিরান ফ্লো চায়; mcp add/list/restart planned রো registry-তে, D-040)।
- verb-রা পাতলা: সব নিয়ম @crabby/extensions-এ; CLI শুধু ইন্টারঅ্যাকশন-দাম দেয় — validate exit 2+ফেলিং-কি (C-E2);
  install = verdict→capability diff→size লাইন→approval, unsafe থামে override-হীন (C-E6/C-E7); রিপোর্ট-পাথ উত্তরেই
  (C-E4, never-overwrite suffix -2/-3); `check-compat --diff OLDER` = দুই রিপোর্টের unified diff (নিজস্ব LCS, C-E5);
  uninstall ২ লাইনে ডিসক্লোজার + ওয়ার্কস্পেস-স্কিল রিফিউজ + --purge-data-র সৎ উত্তর (C-E11); executable-kind রিফিউজাল
  O-008/D-038-বাক্যে (C-E12); নন-TTY --yes-ছাড়া install = exit 3।
- **repo-র বাসস্থান:** `<stateDir>/extensions` (dataLayout থেকে) — গেটওয়ে route (slice-7) একই ফোল্ডার পড়বে; workspace
  স্ক্যান `<cwd>/skills` থাকলেই। apps/cli package.json-এ @crabby/extensions ডিপেন্ডেন্সি।
- **পাওয়া-শিক্ষা:** parseTail-এর value-key ড্যাশ-হীন (`tail.values["out"]`) — এই সূত্রে ধরা পড়ল **slice-3-র latent
  bug**: `crabby memory list --status S` কখনো ফিল্টার পড়ত না (key ছিল "--status") → ঠিক করা।
- **টেস্ট:** tests/unit/ext-cli.test.ts ৬/৬ (spawnSync-এ exit code+আউটপুট: init overwrite/bad-name, validate exit-2+key,
  install স্টেপ-লাইন+unsafe-থামা+nothing-written, info --json, নন-TTY exit-3, uninstall ডিসক্লোজার+workspace-রিফিউজ,
  tool-kind রিফিউজাল)। হাতে-যাচাই: init→validate→install→list→info→diff→uninstall, collision লাইন, purge-data।

## করলাম (M4 slice 7 — §10 MCP client + C-2 import, D-040/D-137)

- **D-137 রেকর্ড** (দুই স্থাপন-সিদ্ধান্ত): (১) সার্ভার-এন্ট্রি `<stateDir>/mcp/servers.json`-এ, কনফিগ-ডকুমেন্টে নয় —
  কনফিগ ফাইল If-Match-এর restart-সারফেস, সার্ভার-এন্ট্রি mcp verb-দের নিজস্ব state; env **নাম** ঢোকে, value কখনো নয়।
  (২) ডিসকভারি policy-র `registerTool` গেট দিয়ে — `mcp:<server>:<tool>` নেমস্পেস, C-1-র alias টেবিলেই এক §6.1
  capability, T2 floor (সার্ভার-ঘোষিত tier পড়া হয় না); capability-অনামযোগ্য টুল **রেজিস্টার হয় না** — refusal-বাক্য
  রিপোর্টে হুবহু। ক্যাপ Crabby-র: output MAX_TOOL_OUTPUT_BYTES-এ cut+marker, সার্ভারপ্রতি in-flight ২, timeout =
  tool-class deadline + extensionAdapterOverheadMs (fs 15s / net 25s / shell 125s), মৃত সার্ভার = typed
  `mcp_server_error` (phase নামে: start/handshake/list/call/connection)। counter 136→137 (§4A traceability-ও)।
- **packages/extensions:** `mcp-config.ts` (নেটিভ servers.json স্ট্রিক্ট পার্স — unknown-field reject, env-name shape,
  stdio/http দুই entry), `mcp-import.ts` (C-2: mcpServers/servers-mapping/servers-array আকৃতি; env/header value
  নাম-ধরে drop+warning; unknown verbatim; রিপোর্ট never-overwritten; বিদ্যমান ফাইলের সাথে merge, সোর্স অস্পৃশ্য),
  `mcp.ts` (StdioTransport: spawn+newline JSON-RPC+initialize handshake+stderr-tail; HttpTransport: POST JSON-RPC,
  application/json + text/event-stream দুই উত্তরই, Mcp-Session-Id echo; discovery→registerTool)।
- **CLI:** `crabby mcp add <file>` (C-2 import; উত্তরে value-drop গুনে + রিপোর্ট-পাথ + "approves nothing" fix-line),
  `crabby mcp list [--json]`; `mcp restart` planned (কিছুই স্বয়ংক্রিয়ভাবে connect করে না — runner-বিহীন wiring থিয়েটার)।
- **টেস্ট ১৪:** mcp.test.ts ১২/১২ (আসল child process + আসল HTTP সার্ভার — framing প্রমাণিত; oversized-cut marker,
  timeout "Crabby's cap", dead-server typed error, T2-floor registration, unnameable-refusal, alias-map, C-2 চার কেস),
  mcp-cli.test.ts ২/২ (state dir-এ secret-value-অনুপস্থিতি-ই মূল assertion)।
- **শিক্ষা:** erasableSyntaxOnly-তে constructor parameter-property নিষিদ্ধ; template literal-এ `\n` আসল newline হয় —
  fixture-এ `\\n`; biomet-এর --unsafe fix গ্রহণযোগ্য যেখানে key লিটারেল নিশ্চিত।
## Slice 8 — D-133-এর রুট-গ্যাপ: /logs, /audit, /whoami, DELETE /jobs, probe, `each`, tool_invocation ট্রেইল (schema v14+v15, D-138) — 2026-10-17

- **slice-1 (4d4db38):** `aud_` ৮ম prefix (D-138) + migrate v14 "audit" (audit_log, **কোনো FK নেই** — রিভোকড ক্লায়েন্ট/ডিলিটেড টাস্ক তার ইতিহাস নিয়ে যায় না; index audit_kind/audit_task) + `packages/storage/audit.ts` (recordAudit = write-এ redact; listAudit = aud_-cursor paging, limit 1..500) + gateway `GET /logs` (রিং-বাফার, exported RANK দিয়ে level-filter, limit 1..500/def 200, cursor=offset), `GET /audit`, `GET /whoami` (identity + executor-এর সত্যিকারের surface; অনুপস্থিত হলে note) + guard-hook-এ rejected auth_attempt।
- **slice-2 (এই কমিট):** অডিট-রাইট সম্পূর্ণ — redeem ok/rejected, mint (capabilities সহ), revoke (O-071), `config_change` (শুধু key-path), approval decision (who/interface/tier/tool)। **DELETE /jobs/{id}** (T17-05/W16-11): ডিফল্টে রান-হিস্টরি থাকে, `?history=delete`-এ যায়; in-flight হলে 409; no-scheduler Gateway-ও store দিয়ে ডিলিট করে (delete টাইমার আর্ম করে না); `job_delete` অডিট-রো লেখে। **schema v15 "job-run-history"** — v5-এর `ON DELETE CASCADE` ঠিক সেই ইতিহাসই মুছত, যেটা W16-11 রাখে; job_run rebuild (job-FK বাদ, task-FK SET NULL থাকে), fixture+`/health` literal 15।
- **`each` (D-133):** `JobBacklogBody` = `latest|each|skip`; scheduler `backlog("each")` প্রথম (earliest) missed occurrence এখনই ফায়ার করে, বাকি row unacknowledged-ই কিউ; `reconcile` backlog-triggered run settle হলে `drainBacklogChain` — এক-এ-একটা, D-103 নিজেই drain-এর precondition; `skip` বাকিটা retire করে; `acknowledgeRun(runId)` + `deleteJob(id, withHistory)` JobStore-এ (memory+SQL দুটোতেই); TUI-র hand-walk অবসর, `e` = এক কল; CLI `--each`; C12-06-র তিন-উত্তর।
- **probe (W10-07/C7-09):** `POST /models/{p}/{m}/probe` — যে capability ব্যায়াম করা যায় (systemRole/streaming/toolCalling) সেগুলোতে ছোট live call, ব্যর্থ রোতে §3.5 class; বাকি claim `unprobed` (রো-তে কারণ), unclaimed `unclaimed`; 20s/row নিজস্ব abort; provider/model অজানা = ঐ রাউটের 404 কোড।
- **tool_invocation:** লুপ = একমাত্র সাক্ষী, `auditToolInvocation` seam দিয়ে fact বেরিয়ে যায় (composition root লেখে) — **args ছাড়া** (§7: model-এর কথা checkpoint-এর মতো ট্রেইলেরও নয়; per-task journal-ই arg-বহনকারী রেকর্ড); ok/error/rejected তিনটাই — rejected = policy-র moment-of-execution re-evaluation (denied ও revoked-দুই সাইটে)।
- **ডক:** INTERFACES §4.1-এ /logs /audit /whoami উত্তর-shape সহ, jobs-রোতে DELETE+each; §8 parity --write; DECISIONS **D-138** (aud_ prefix, counter 138) + §4A ম্যাপ; ROADMAP সত্তরতম-তৃতীয় slice; check-docs-এ whoami pattern; TUI/CLI/WEB/TELEGRAM-এ সৎ "source/why-not" নোট; DATA_AND_MEMORY sqlite-রো v14+v15।
- **শিক্ষা:** E2B re-init-এ HEAD ব্রাঞ্চ-পয়েন্টে ফেরে — restore = `git fetch` + `git reset origin/<branch>` (mixed) + `npm install --ignore-scripts`; better-sqlite3-এর bundled prebuild যথেষ্ট, rebuild-এর দরকার নেই।
## Slice 9 — §4.6-র extension routes + installed-records দুই মুখ, CLI install --json ফিক্স — M4 শেষ — 2026-10-17

- **Gateway `registerExtensionRoutes`:** `GET /extensions` (extList + প্রতি রোতে verdict — W11-04-এর "reason সহ greyed",
  এক রিকোয়েস্টে), `POST /extensions/validate` ({path} absolute বাধ্যতামূলক), `POST /extensions/install` (আগে extValidate —
  C-E6-এর no-override ওয়্যারেও; unsafe/incompatible = 400 `extension_*`; re-install = D-039-র update path, report
  never-overwrites; 201 + location), `GET /extensions/{id}/reports` (newest-first, D-065-র two-version depth; `..`/`/`-যুক্ত
  id = 404), `DELETE /extensions/{id}` (extUninstall; 404-দ্বিতীয়বার)। সবই `<stateDir>/extensions`-এর ওপর — CLI-র `ext`
  verb-দের একই store, দুই মুখ, এক সত্য (§13 reconcile)। Authority = token (F-52 substitution, job-routes-র মতো)।
- **audit:** route install/uninstall `extension_install` রো লেখে; **CLI-র `ext install` এখন নিজেই** openDatabase+migrate+
  recordAudit করে — ট্রেইল ঘটনার, interface-এর নয় (§14)।
- **`ext install --json` ফাঁকা-stdout বাগ ফিক্স:** --json-এ প্রম্পট নেই — `--yes` ছাড়া উত্তর `renderer.fail({code:
  "approval_required"})` + exit 3; স্ক্রিপ্ট ডকুমেন্ট পায়, প্রোজ বা নীরবতা নয়।
- **contracts:** `packages/api-contracts/extensions.ts` — ExtPackBody, InstalledExtensionRow, ExtListBody (verdict-সহ),
  ExtensionReportRow/Body; exactOptionalPropertyTypes-এ store-এর `T | undefined` → conditional spread দিয়ে ম্যাপ।
- **টেস্ট:** tests/integration/extensions.test.ts ৪/৪ (install+trail+verdict-in-list, validate-বিধিনিষেধ+update-path,
  reports newest-first+path-walk 404, uninstall+trail+401 guard); ext-cli.test.ts ৭/৭ (নতুন: --json --yes-বিহীন =
  ডকুমেন্ট+exit 3+কিছু লেখা হয়নি)।
- **ডক:** ROADMAP **74th slice** এন্ট্রি + §6-তে M4-র **Status: complete** লাইন; HANDOVER §2-তে M4-সম্পূর্ণ অনুচ্ছেদ
  (D-138/O-075, slices 39–74), §3-র শেষ-তিন-স্লাইস = 72/73/74, T5-06 ও T17-05 এন্ট্রি "answered"; parity ৪৭ routes।
- **lint-নোট:** লক করা biome 2.5.15 পুরনো integration টেস্টের `any`-গুলো ধরেছে (audit/memory/models) — repo-র চিরচেনা
  per-line `biome-ignore` + কারণ দিয়ে ১৯ জায়গায় স্থগিত; নীতি-পরিবর্তন নয়।
## Slice 10 — M5 শুরু: ভল্ট (D-031/D-139, F-56 বন্ধ) — 2026-10-17

- **`packages/vault`:** এক facade, দুই back end — keychain (macOS `security` / Linux `secret-tool`, PATH থেকে detect,
  value Crabby-র মেমোরিতে আসে না) আর D-066-র scrypt envelope (N=2^15/r=8/p=1 + node `maxmem` 96MiB — নইলে বাউন্ডারিতে
  ফেল; per-install salt কখনো rotate নয়; per-write GCM IV; KDF params ফাইলেই pinned)। ভুল passphrase = GCM tag দিয়ে
  clean refusal। CLI test-এ ছোট N (`kdf` override — শুধু টেস্ট)।
- **compose resolver:** `composeProviders(entries, limits, resolve?)` — resolver দিলে keyed entry compose হয়; না দিলে
  view-refusal ("crabby vault status দেখুন"); locked/missing-এ vault-নিজের কারণসহ refuse। Gateway `deps.vault` +
  `recomposeProviders` (array in-place splice — identity অটুট)।
- **routes:** `GET /vault`, `POST /vault/unlock`, `POST /vault/lock` (+ `vault` audit kind, schema **v16** — CHECK-এ
  kind বাড়ায় rebuild-and-copy)। unlock = session খোলা + re-compose + উত্তরে প্রতি-entry সিদ্ধান্ত + runner sentence;
  ভুল passphrase = `vault` rejected ট্রেইল রো (credential ছাড়া); unset-এ `409 vault_unset` (create শুধু `crabby vault
  set`-এ, মানুষ যেই passphrase টাইপ করবে)। `/health`-এ managed/kind/state/note; `/status`-এ vault রো + extensions রো
  এখন সত্যি উত্তর দেয়। `system.vault.locked/unlocked` bus-event ( journaled নয় — replayable সত্য `/vault`);
  Event schema-তে sessionId/taskId optional (system family), AppendEventInput narrowed।
- **CLI `vault`:** status/set/get/list/delete/unlock/lock — stdin-only (TTY-তে muted prompt, pipe-এ লাইন), argv-তে
  secret কখনোই নয়; set-ই rotation; get = মালিকের টার্মিনাল; disclosure create-এর উত্তরে।
- **doctor:** vault check এখন openVault-এর status থেকে — unset/locked/unlocked + fix lines।
- **docs:** INTERFACES §4.4-তে ৩টা vault রো + §4.1-এ `vault` kind + §7.1 CLI রো; DATA_AND_MEMORY §4-এ schema v16;
  DECISIONS **D-139** (counter 139) + 4A ম্যাপ; CONSISTENCY_REVIEW **F-56 answered**; ROADMAP 75th slice;
  parity **৫০ routes**।
- **টেস্ট:** vault.test.ts ৭/৭, vault HTTP ৩/৩, vault CLI ৩/৩, compose ১৭/১৭।
## Slice 11 — M5 slice-2: Quick Tunnel (§13, D-066-র lifecycle) — 2026-10-17

- **`packages/gateway/tunnel.ts`:** `QuickTunnel` host — `cloudflared tunnel --url <loopback>` নিজের process group-এ
  (stop = group signal, D-066-র ৫s drain → SIGKILL; orphan মানেই exposure বেঁচে থাকা); URL `*.trycloudflare.com`
  pattern দিয়ে stdout/stderr থেকে discover (৬০s wall — না এলে failed start, শিশুর শেষ কথাসহ); `CRABBY_TUNNEL_COMMAND`
  override; টেস্ট inject করা command/script দিয়ে।
- **routes:** `POST /tunnel` (body-তে `confirm: true` বাধ্যতামূলক — T3 confirm flag; উত্তরে fresh URL + reachable
  identities; ready/starting-এ `409 tunnel_active`; ব্যর্থতায় `tunnel_start_failed`), `DELETE /tunnel` (পুরো বন্ধ;
  দ্বিতীয়বার 404)। `/health`-র listener.mode live tunnel-এ `tunnel`; `/status`-র tunnel রো host-এর snapshot থেকে;
  `tunnel` audit রো (start/stop); `system.tunnel.started/stopped` bus-event; `onClose`-তে host.stop()।
- **CLI `tunnel on/off/status`:** on = T3 প্রম্পট (reachable list ছাপে, §13-র বাক্য), `--yes` স্ক্রিপ্ট-পথ; off =
  revoke; status = Gateway-র live state (URL মনে রাখে না — D-066 discover-don't-assume)। Registry-র ৩টা planned রো
  এখন ready।
- **contracts:** `packages/api-contracts/tunnel.ts` (TunnelBody{confirm}, TunnelAnswer{url,reachable})।
- **টেস্ট:** tunnel.test.ts ৬/৬ (fake binary — URL pattern, stderr discover, group-kill pgrep-প্রমাণিত, silent-exit
  last-words, double-start refuse, absent binary); tunnel HTTP ২/২ (confirm-gate, reachable list, mode flip, 409,
  stop→404, audit)।
- **docs:** INTERFACES §4.4-র দুই tunnel রো নতুন চুক্তি + §7.1 ready; ROADMAP 76th slice + §7-তে M5 underway নোট;
  parity **৫১ routes**।
## Slice 12 — M5 slice-3: auth last-seen + `doctor --security` posture — 2026-10-17

- **`crabby auth list`:** প্রতি রোতে `last seen <ts>` / `never used` (route আগে থেকেই lastUsedAt দিত, CLI দেখাত না) —
  revocation সিদ্ধান্তের তথ্য।
- **`crabby doctor --security`:** security-relevant check-উপসেট (data.dir/config/workspace/vault/shell/tunnel — একই
  collector, দ্বিতীয় collector নয়) + plain-language posture বাক্য (workspace confinement, ask-first, vault-অবস্থা,
  Termux no-sandbox §15 বাক্য); human লাইন + `--json` `posture[]` দুই চ্যানেলেই। registry-র doctor রো flag-সহ।
- **টেস্ট:** cli 55/55 (নতুন: --security subset + posture assertions)।
## Slice 13 — M5 slice-4: O-008-এর গেট চূড়ান্ত (D-140), §17 injection fixtures, §4.5 রিড-থ্রু (D-141) — 2026-10-17

- **D-140:** O-008-এর hard gate চূড়ান্ত — অবিশ্বস্ত executable কোড যেকোনো পথে বন্ধ, যতক্ষণ না কোনো candidate
  primary-platform-এ §17-র fixture-corpus পাস করে; strategy (filtered in-process vs child-process RPC) post-v1-এ
  খোলা, candidate implementation-এর অপেক্ষায়।
- **`tests/security/injection.test.ts` (৪টি fixture, ৪/৪):** self-grant `allowed-tools` → পড়া হয়, কখনো দেওয়া হয় না;
  permission-সদৃশ unknown key → named line; wrapper-closer content → nonce ধরে রাখে; call-এর নিজের nonce বহন করা
  content → attack হিসেবে refuse।
- **D-141:** §4.5-র vault-job defer বুলেট = composition-এর visible reasons (keys eager-compose; runner-less হলে
  `driven:false`+note, 501 `scheduler_absent`) — নতুন কোনো run state নেই।
- **ডক:** SECURITY §17/§18(03·06·08)/§19(O-009·O-018·O-019 বন্ধ হিসেবে স্বীকৃত)/§20 (টেস্ট-কলামসহ T-map);
  EXTENSIONS §15; PROVIDERS §4.5; DECISIONS (D-140, D-141, O-008, D-078-এর ষষ্ঠ নাম `telegram.json`); HANDOVER
  (M5-complete, D-141 পর্যন্ত counts); ROADMAP ৭৮তম slice + §7 complete।

## বাকি-হিসাব — M5 শেষে (2026-10-17) — Telegram লগবুকের WORKLOG-mirror

*টোকেন নেই, তাই নিয়ম ৭ অনুযায়ী এখানেই মিরর। টোকেন এলে এই ব্লকটাই টেলিগ্রামে যাবে।*

**M5 সম্পূর্ণ ✅** — ৪টি slice, ৪টি push:
1. `fd9f9d4` — vault (D-139): scrypt/GCM ফাইল-স্টোর, set/unlock/lock, hot re-compose, `vault://` (F-56)।
2. `615156a` — Quick Tunnel (§13): confirm-gated route, `tunnel_active` 409, URL প্রতি স্টার্টে, `crabby tunnel on/off/status`।
3. `1313459` — `auth list` last-seen + `doctor --security` posture (plain-language, human+JSON দুই চ্যানেলে)।
4. `9f4e6a8` — D-140 (O-008-এর গেট চূড়ান্ত) + §17-র injection corpus (৪ fixture) + D-141 (§4.5 রিড-থ্রু) + ডক ক্যাচ-আপ (§18/§19/§20, D-078-এর ষষ্ঠ নাম, HANDOVER)।

**গেট:** sweep 1486/1486 · tsc ✓ · biome 0 · parity 51 routes/45 tools/32 capabilities · docs:check ✓ (141 accepted · 11 proposed · 75 open)।

**মালিকের হাতে যা বাকি:**
- `TG_BOT_TOKEN=… npm run telegram:check` — মালিক-ডিভাইসে; এরপর M3-র চার-ইন্টারফেস ডেমো (Telegram→Web→TUI→CLI)।
- `termux-keystore` probe — O-018-এর মালিক-ডিভাইস মাপা (vault চলবে কি keychain-এ, নাকি ফাইলে)।

**Post-v1 (কিছুই ব্লক করে না):** O-008-এর strategy half (candidate implementation হলে D-140-র corpus পয়েন্ট করা), O-065 (Termux sandbox মাপা), O-052 (remembered approvals), O-064 (signing), O-001-র এক ক্লজ (clean-env better-sqlite3 reproduction)।
## Slice 14 — M6 slice-1: `crabby backup` (D-142) — 2026-10-17

- **নতুন verb:** `crabby backup [destination]` — online `db.backup()` + config.json + extensions/ + mcp/ →
  timestamped dir + manifest.json (অন্তর্ভুক্ত/বাদ-তালিকা কারণসহ); copy-র `integrity_check` backup-সময়েই, ফেল হলে
  dir মুছে যায়।
- **বাদ (§8-র ডিফল্ট):** vault/, client.json, telegram.json (সিক্রেট/বেয়ারার), gateway.json, last-exit.json,
  scratch/, backups/ — সব manifest-এ নাম-কারণসহ।
- **Restore manual (D-065):** DATA_AND_MEMORY §8-এ ৪ ধাপ (sidecar-সতর্কতাসহ); verb-এর fix line সেখাই পয়েন্ট করে।
- **migration-fail টেস্ট** storage.test.ts-এ — rollback + ledger-সততা + আগের সংস্করণ অক্ষত (D-065-র ক্লজ, এখন টেস্ট)।
## Slice 15 — M6 slice-2: CHANGELOG.md + 0.x-পলিসির ঘর (D-143) — 2026-10-17

- **`CHANGELOG.md`:** user-facing, newest-first, `Unreleased` ফেজ-ধরে জমে; M-D→M6 পর্যন্ত সব ফেজের সারি, সিকিউরিটি
  নোট ও platform-limitation পরিবর্তনসহ (DEVELOPMENT §9-র নিয়ম)।
- **D-143:** version field `0.0.0`-ই থাকে; **`v0.1.0` কাটা হয় M6-র exit bar-এ**; প্রতি-slice বিবরণ ROADMAP-এই —
  ডাবল হাতে-লেখা তালিকা নয় (F-08-এর শিক্ষা)।
- README-র "দুটি ফাইল ইচ্ছাকৃত নেই" লাইন → এখন শুধু LICENSE বাকি; CONSISTENCY_REVIEW-র "M9"-এ dated সংশোধন-নোট;
  docs:check-এর ৩টি standing advisory মিলে গেছে (25 documents, 143 accepted)।
## Slice 16 — M6 slice-3: লাইসেন্স অডিট + notices + LICENSE (D-144) — 2026-10-17

- **`npm run license:audit`:** production-closure ওয়াক (workspace dependencies, transitive, যা আসলে install আছে),
  allowlist-বাইরে হলে **ব্যর্থ** (MIT/ISC/BSD/Apache-2.0/0BSD/Unlicense/CC0/BlueOak); SPDX OR-branch সবই পাস লাগে।
- **THIRD-PARTY-NOTICES.md:** জেনারেটেড, সাজানো, প্রতিটা প্যাকেজের নিজের লাইসেন্স-টেক্সট verbatim — আজ ৬০টা
  প্যাকেজ, সব allowlist-এ।
- **`LICENSE` (MIT)** এখন আছে — README-র অপেক্ষার তালিকা খালি।
## Slice 17 — M6 slice-4: INSTALL.md + engines-পিন — 2026-10-17

- **`engines.node = ">=22.22"`** — M0 P1-র মাপা সংখ্যা (D-070-র single pin অবশেষে ভরা); doctor-র node চেক এখন ok।
- **`docs/INSTALL.md`:** D-050-র পথ (checkout + npm install; Termux-এ --build-from-source + pkg তালিকা;
  doctor = recovery), clone→প্রথম conversation পর্যন্ত ধাপ, update/rollback (migration forward-only — rollback
  মানে backup), rehearsed বক্স (linux/x64, আজ; Termux কলাম = মালিক-ডিভাইস, O-001-র শেষ ক্লজ)।
- **রিহার্সাল:** সতেজ clone → install → init/doctor exit 0 → backup integrity ok → gateway start (v16, pairing
  কোড, auth gate, clean drain)।
## Slice 18 — M6 slice-5: রিলিজ-পেজ (README + LIMITATIONS + TROUBLESHOOTING) — 2026-10-17

- **README:** M2-যুগের বর্ণনা সরিয়ে — ৪-কমান্ড install, "using it" টেবিল (চার ইন্টারফেস), কে-কী-ধর্য (মালিক-ডিভাইস:
  telegram wire check + ডেমো + Termux rehearsal + performance pass + probe phone কলাম; রিপো: পেজগুলো + v0.1.0 কাটা)।
- **`docs/LIMITATIONS.md`:** §18-09-এর user-facing পেজ — no-sandbox, no local inference, no executable extension,
  once-only approvals, forward-only migration, tunnel fresh-URL, weaker file-store — প্রতিটা লাইনে সিদ্ধান্ত-লিংক।
- **`docs/TROUBLESHOOTING.md`:** লক্ষণ → বিল্ড আসলে যে বাক্য ছাপে → টাইপ করার কমান্ড; doctor = triage entry।

## বাকি-হিসাব — M6 (sandbox অংশ) শেষে (2026-10-17) — Telegram লগবুকের WORKLOG-mirror

*টোকেন নেই → নিয়ম ৭ অনুযায়ী এখানেই মিরর।*

**M6-র রিপো-সাইড সম্পূর্ণ ✅** — ৫টি slice, ৫টি push (M5-সমেত মোট ৯টি এই ফেজে):
1. `e600186` — `crabby backup` (D-142): online backup, integrity-verified, secrets-excluded + manifest; restore §8-এ manual।
2. `02dfa42` — CHANGELOG.md (D-143): Unreleased জমে, `v0.1.0` = M6 exit bar-এ।
3. `dc24789` — license:audit + THIRD-PARTY-NOTICES.md + LICENSE (D-144): ৬০ প্যাকেজ, সব allowlist-এ।
4. `1b0f20f` — docs/INSTALL.md + `engines.node >=22.22` (P1-মাপা): সতেজ clone-এ রিহার্সড।
5. `6bf20fe` — রিলিজ-পেজ: README সত্য-বলা অবস্থায়, LIMITATIONS (§18-09), TROUBLESHOOTING।

**গেট:** sweep 1492/1492 · tsc ✓ · biome 0 · parity 51 routes · docs:check ✓ (29 docs, 144 accepted · 11 proposed · 75 open)।

**মালিকের হাতে যা বাকি (release bar):**
1. `TG_BOT_TOKEN=… npm run telegram:check` → M3-র চার-ইন্টারফেস ডেমো।
2. Termux-এ clean install rehearsal (docs/INSTALL.md-র ধাপ; O-001-র শেষ ক্লজ)।
3. Performance pass (startup/memory/idle CPU/battery/WAL)।
4. Probes-এর phone কলাম (P-003/P-004/P-010/P-011) + `termux-keystore` probe।
5. এগুলো মিললে **`v0.1.0` কাটা** — "নতুন ব্যবহারকারী শুধু ডক পড়ে ফোনে একটা multi-step task শেষ করবে, LIMITATIONS-এ না-লেখা কিছুতে আটকাবে না।"

**Post-v1:** O-008 strategy half, O-065, O-052, O-064, O-001-র ক্লজটি ছাড়া সব বন্ধ।
## Slice 19 — মালিক-ডিভাইসের প্রথম হিট: bare `crabby` নাম — INSTALL/TROUBLESHOOTING ধরা হলো — 2026-10-17

- Termux-এ `crabby doctor` → command-not-found (D-050-র ফল, বাগ নয়)। INSTALL.md-তে "the name `crabby`" সেকশন
  (alias = no-global-install-এর ergonomic রূপ) + **bare `npx crabby` সতর্কতা** (রেজিস্ট্রির অচেনা প্যাকেজ —
  সাপ্লাই-চেইন-প্রত্যাখ্যান); TROUBLESHOOTING-এ প্রথম এন্ট্রি।
## Slice 20 — M6 slice-6: bare `crabby` নাম PATH-এ (D-145) + undeclared-dep গ্রাফ ঠিক — 2026-10-17

- **`scripts/link-global.sh`:** এক symlink (`$PREFIX/bin`/`~/.local/bin` → checkout); কিছু নামায় না, আপডেট =
  `git pull`, আনইনস্টল = `rm`; `--remove` সহ। (স্ক্রিপ্টের প্রথম সংস্করণের echo-তে backtick command-substitution
  বাগ ছিল — smoke test-এ ধরা পড়ে ঠিক।)
- **আসল বাগ:** fresh clone-এ `doctor` যেকোনো cwd থেকে `@crabby/vault` পেত না — ৮টা প্যাকেজ ২১টা cross-import
  ডিক্লেয়ারই করেনি (hoisting ঢেকে রাখছিল)। সব declared → links সত্যি → মডিউল-গ্রাফ এখন সৎ।
- **প্রমাণ:** fresh clone + link-global → যেকোনো ডিরেক্টরি থেকে `crabby doctor` exit 0, `backup` ok।
## Slice 21 — দ্বিতীয় ডিভাইস-হিট: ব্রাঞ্চ-বদলের পরে পুরোনো node_modules — 2026-10-17

- মালিকের ফোনে `npm install` হয়েছিল পুরোনো main-এ; নতুন ব্রাঞ্চে গিয়ে `@crabby/extensions` ERR_MODULE_NOT_FOUND —
  লিংক-গাছ package.json-এর সাথে চলে না, install চলে। TROUBLESHOOTING-এ লক্ষণ → `npm install` পুনরায়।
