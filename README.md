<p align="center">
  <img src="assets/job-bunny-logo.svg" alt="Job Bunny" width="170" height="170">
</p>

<h1 align="center">Job Bunny</h1>

<p align="center">
  <em>A personal job-search companion that hops through LinkedIn every day,<br>
  filters &amp; ranks roles against your profile, and syncs the keepers to Notion.</em>
</p>

<p align="center">
  <img alt="Node" src="https://img.shields.io/badge/Node-%E2%89%A520-3c873a">
  <img alt="Runtime" src="https://img.shields.io/badge/pipeline-deterministic-7B5EA7">
  <img alt="Source of truth" src="https://img.shields.io/badge/source%20of%20truth-Notion-black">
</p>

---

## What it does

Job Bunny automates the tedious half of a job hunt. It opens your LinkedIn saved searches, scrapes the postings, structures the messy job descriptions into clean records, drops the noise (wrong location, wrong timezone, avoid-listed companies), deduplicates against what you've already seen, scores each role against your résumé, and writes the survivors into a Notion database you can track from anywhere.

**Notion is the source of truth.** Your manual tracking fields (status, notes, next action) are never touched — the pipeline only writes the automated columns.

## How it works

```mermaid
flowchart LR
  LI[("LinkedIn<br/>saved searches")] --> EX[extract]
  EX --> CO[compress]
  CO --> ST["structure<br/><b>(LLM)</b>"]
  ST --> AS[assemble]
  AS --> FI[filter]
  FI --> DE[dedup]
  DE --> RA[rank]
  RA --> SY[sync]
  SY --> NO[("Notion DB")]
  NO -. reconcile .-> EX
  classDef llm fill:#EDE7FB,stroke:#7B5EA7,stroke-width:2px;
  class ST llm;
```

The guiding principle is **determinism**: filtering, dedup, and ranking are pure JavaScript, so the same input always yields the same output. The **only** runtime LLM step is `structure` — turning raw job-description text into schema-valid records. Ranking and filtering are never put behind a model.

A few other design choices worth calling out:

- **Config-driven scraping.** `extract.js` reads its selectors and behaviour from `page_inventory/<page>.md` at runtime. When LinkedIn changes its DOM, you fix one markdown file — no code regeneration.
- **Token-efficient LLM stage.** A pre-filter + compact markdown table (`compress.js`) and a markdown-table output format roughly halve the tokens the `structure` step spends versus raw JSON.
- **Notion as the mirror's master.** `data/cache.json` is just a performance mirror, rebuilt from the live Notion DB at the start of every run (`reconcile`), so cache drift can't accumulate.

## The pipeline stages

| Stage | What it does |
|-------|--------------|
| `doctor` | Preflight — Chrome/CDP reachable, every page-type has an inventory, keys present |
| `reconcile` | Rebuild `data/cache.json` from the live Notion DB |
| `extract` | Playwright-over-CDP scraper — collect job cards + raw JD text |
| `compress` → `structure` → `assemble` | Pre-filter & compact → LLM structuring → merge back pass-through fields |
| `filter` | Drop wrong-location / incompatible-timezone roles |
| `dedup` | De-duplicate against what's already in Notion (by `job_id`) |
| `rank` | Deterministic 100-point résumé-match score + an excitement label |
| `sync` | Push new roles to Notion (automated fields only) |

In day-to-day use these run as [Claude Code](https://claude.com/claude-code) slash commands (`/run` drives the whole sequence; each stage is also standalone for debugging). The pure-JS stages are exposed as npm scripts too (`npm run filter`, `npm run rank`, …).

## Getting started

> Requires **Node ≥ 20**, a Chrome install, and a Notion integration token.

```bash
git clone https://github.com/Harish-here/job-bunny.git
cd job-bunny
npm install

# secrets
cp .env.example .env          # fill in your Notion token

# your profile (the real file is gitignored — keep it private)
cp resume.example.json resume.json
npm run meta                  # derive resume_meta.json (the runtime input)

npm run init                  # idempotent: creates the Notion DB + scaffolds files
```

`data/cache.example.json` shows the shape of the run cache; the real `data/cache.json` is rebuilt from Notion on every run, so you never seed it by hand.

## Project layout

```
scripts/            deterministic pipeline stages (extract, filter, dedup, rank, sync …)
page_inventory/     per-page scraper config (selectors + behaviour, read at runtime)
.claude/commands/   Claude Code slash commands that drive the stages
resume.example.json profile template  →  copy to resume.json (gitignored)
filter_config.json  title/keyword gates — tune filtering without touching code
CLAUDE.md           the run-time contract / agent guide
```

## Privacy

This repo ships **sanitized templates** only. The real `resume.json` (contact details, work history) and `data/cache.json` (your live job pipeline) are gitignored and never leave your machine. Secrets live in `.env`, which is gitignored before any token is ever written.

---

<p align="center"><sub>A personal project — built and maintained with Claude Code. 🐰💜</sub></p>
