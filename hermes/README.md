# Hermes — autonomous lead-hunting agent

Hermes is the messenger. Every weekday morning at **10:00 AM Bolivia time** he
scrapes local businesses, audits them, ranks them, drafts two personalized
outreach pitches for each, builds a spreadsheet, and emails Marvin **50 audited,
ranked, pitch-ready B2B leads** — then writes down what he learned so tomorrow's
run starts sharper than today's.

He is built to the "Lead Hunter" master prompt, and he has a **memory** and a
**self-learning loop** on top of it: every run is recorded, every reply is
attributed back to the pitch that earned it, and the conclusions are written
back as durable lessons and tuned scoring weights that shape the next run.

> **He never contacts a lead.** Every pitch is a **draft** in the spreadsheet.
> Marvin decides what to send.

---

## What makes him "like Hermes" — memory & learning

This is the part beyond a plain scraper. Four memory systems compound over time:

| System | Table | What it does |
|---|---|---|
| **Episodic memory** | `agent_runs` | One record per run — phases, metrics, cost, and a written reflection. The raw material the learning loop reasons over. |
| **Semantic memory** | `agent_memory` | Durable, scoped lessons ("dentists here always have a dated site — lead with the mobile gap"). Retrieved into the audit & pitch prompts. Confidence rises with corroboration, **decays** when unreinforced, and can be **contradicted** and retired. |
| **A/B pitch learning** | `pitch_performance` | Every pitch carries an *angle*. Replies are attributed back to the angle that earned them, and the pitch prompt is told which angles pull — so the A/B test compounds instead of restarting daily. |
| **Self-tuning scores** | `score_weights` | Phase 6 scores leads from weighted signals. Hermes grades his own past scores against who actually replied and nudges the weights toward what predicts replies — versioned, damped, and one query to roll back. |
| **Self-healing selectors** | `selector_memory` | Working Google Maps selectors are remembered and tried first; when the DOM shifts, a rediscovered selector is written back so the next run is already healed. |

The loop closes in `src/memory/reflect.ts`: after each run Claude reviews what
happened and writes lessons (`reflectOnBatch`); weekly it tunes the weights,
decays stale memory, and writes global lessons (`deepReflection`).

Inspect any of it from the CLI:

```bash
pnpm memory dump                       # every active lesson, by confidence
pnpm memory recall "New York City" restaurants   # what he'd inject for that target
pnpm memory weights                    # active score vector + version history
pnpm memory angles restaurants         # pitch-angle reply-rate standings
pnpm memory rollback 1                 # revert to a prior weight version
```

---

## The daily pipeline (exact order, master prompt §7)

```
0  health check + canary   → abort & alert if scrapers are down
1  determine today's target (weekly city+niche rotation)
2  scrape Google Maps (Playwright, with adjacent-category widening)
3  dedup against everything ever sent (place_id, then name+address hash)
4  enrich from website + socials (email, WhatsApp, IG/FB, site signals)
5  audit each lead (Claude Haiku)  → strengths / weaknesses / service-fit
6  score & rank (self-tuned weights)
7  take top 50
8  draft two A/B pitches per lead (Claude Sonnet) — DRAFTS ONLY
9  flag top N for the preview-site build (placeholder seam — §9)
10 build the .xlsx (exceljs)
11 email the digest (Resend, or Gmail SMTP)
12 persist + mark sent + advance the weekly counter
L  reflect → write lessons to memory
```

Two more entry points: **`reply-check`** (hourly — matches inbox replies to
leads, classifies sentiment, feeds the A/B learner, stops chasing anyone who
bit) and **`reflect`** (weekly deep pass).

---

## Setup

**Stack** (locked, per the master prompt): TypeScript · Playwright · Supabase
(Postgres) · Drizzle ORM · Anthropic Claude · exceljs · Resend · GitHub Actions
cron.

```bash
cd hermes
pnpm install
pnpm exec playwright install --with-deps chromium
cp .env.example .env          # then fill it in (see below)
pnpm db:push                  # create the tables in Supabase
```

### Required secrets (`.env`, or GitHub Actions secrets)

| Var | What |
|---|---|
| `DATABASE_URL` | Supabase → Database → Connection string (URI). |
| `ANTHROPIC_API_KEY` | The value engine. Haiku for bulk, Sonnet for pitch copy. |
| `EMAIL_TO` | Where the daily digest lands. |
| `RESEND_API_KEY` | Email delivery (free tier). *Or* set `SMTP_USER`/`SMTP_PASS` for Gmail. |
| `IMAP_USER` / `IMAP_PASS` | Optional — enables the reply-check job. |

Everything else has a sensible default — see `.env.example`.

### Run it

```bash
pnpm daily          # the full morning pipeline
pnpm reply-check    # inbox → reply attribution
pnpm reflect        # weekly deep reflection + weight tuning
pnpm health         # Phase 0 on its own
```

Handy toggles while wiring things up: `NO_EMAIL=1` (build the sheet, don't
send), `DISABLE_LEARNING=1` (freeze memory/weights), `LOG_LEVEL=debug`.

### Editing the hunt

The niche rotation queue lives in **`config/targets.ts`** — reorder, add, or
remove `{ city, niche }` entries and Hermes walks them one per week. Each entry
can list `widenWith` phrases used when a search comes up short of 50.

---

## Scheduling

Free path: three GitHub Actions crons in `.github/workflows/`:

- `hermes-daily.yml` — 14:00 UTC (10:00 BOT) Mon–Fri
- `hermes-reply-check.yml` — hourly during Bolivian waking hours
- `hermes-reflect.yml` — Sunday night, before the Monday hunt

GH Actions cron is best-effort and can fire a few minutes late — fine for a
morning digest.

---

## `// PAID-UPGRADE:` seams (all free today, documented for later)

Everything runs free **except the LLM**, which is cheap and is the whole point.
Upgrade the rest reactively, only when the free path actually hurts:

| Piece | Free path (built) | When to pay | Where |
|---|---|---|---|
| Google Maps at scale | Playwright scrape | rate-limited / DOM breaks often → Apify actor or Places API | `src/pipeline/02-scrape.ts` |
| Deep LinkedIn / socials | shallow (handles from the site) | need real depth → Apify LinkedIn actor | `src/pipeline/04-enrich.ts` |
| Scheduler reliability | GH Actions cron | timing matters / always-on reply job → Railway (already connected) | `.github/workflows/` |
| Email | Resend free (100/day) | volume grows | `src/pipeline/11-email.ts` |
| Reply parsing | free Gmail IMAP | IMAP gets flaky → Resend inbound | `src/jobs/reply-check.ts` |

The **preview-site generator is a deliberate placeholder** (§9): Hermes flags the
top N leads and calls `generatePreviewSite()`, which only logs. Marvin's separate
preview system plugs into that seam later — it is not coupled to this agent.

---

## Compliance note (blunt, as the brief asked)

Scraping Google Maps is against its ToS, and it uses anti-bot measures. For
low-volume public **business** contact data (50/day) this is normal lead-gen
territory and the practical risk is IP blocks, not lawsuits — so Hermes is built
defensively: rotating user-agents, throttling, randomized delays, a concurrency
cap, and aggressive caching, with clean seams to move to the paid APIs (which
make the ToS problem largely go away) if this ever scales.

---

## Layout

```
hermes/
├── config/targets.ts        ← the niche queue (Marvin edits this)
├── src/
│   ├── core/                ← env, config, logger, persona, Anthropic client
│   ├── db/                  ← Drizzle schema + client
│   ├── memory/              ← the learning brain: memory, run log, playbook,
│   │                          weights, reflection
│   ├── pipeline/            ← phases 00–11 + dedup, persist, selectors, types
│   └── jobs/                ← daily · reply-check · reflect · health · memory CLI
├── drizzle/                 ← generated SQL migration
└── .github/workflows/       ← the three crons
```
