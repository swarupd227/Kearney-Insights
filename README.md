# Astra Insights for Kearney

Agentic, voice-enabled firm intelligence: the demo build of the product described in
`Kearney_Astra_Insights_Product_Spec_v1.0.docx` for the Kearney Global IT Managed Services RFP orals (13 October 2026).

One conversation bar, sixteen agents (Conductor, Guardian and fourteen specialists), sixteen screens, 55 governed
metrics, fourteen models, eight demo personas, five storylines. Runs on Node.js and PostgreSQL in one container,
deployable to Azure Container Apps with the Azure CLI from Cloud Shell.

## Quick start (local)

Requirements: Node 20+, Docker (for Postgres) or any PostgreSQL 14+.

```bash
npm install
docker run -d --name astra-pg -e POSTGRES_PASSWORD=astra -e POSTGRES_USER=astra -e POSTGRES_DB=astra -p 5433:5432 postgres:16-alpine
cp .env.example .env            # DATABASE_URL already points at localhost:5433
npm start                       # migrates the schema, loads the seed on first boot (about 30 s), serves http://localhost:8080
```

Or with Docker Compose (Postgres and app together):

```bash
docker compose up --build        # http://localhost:8080
```

Useful commands:

| Command | What it does |
|---|---|
| `npm run seed` | Load the seed if the database is empty (`node server/seed/load.js --force` reloads) |
| `npm run seed:dry` | Print the seed summary without touching the database |
| `npm test` | Parser and formatting tests (no database needed) |

Voice: push-to-talk (orb or Ctrl+Space) and the wake word use the browser's speech engine (Edge or Chrome).
With `AZURE_SPEECH_KEY` and `AZURE_SPEECH_REGION` set, the server issues Azure AI Speech tokens instead.
Typing the same prompt into the command bar (Ctrl+K) produces the identical answer, which is the orals fallback.

## Deploy to Azure from Cloud Shell

Everything is plain Azure CLI. Open [Cloud Shell](https://shell.azure.com) (bash), get the code there
(`git clone …` or upload the folder), then:

```bash
cd astra-insights-kearney
chmod +x infra/*.sh
./infra/deploy.sh
```

`deploy.sh` creates, in one resource group:

1. **Azure Container Registry** and builds the image in the cloud with `az acr build` (no local Docker).
2. **Azure Database for PostgreSQL Flexible Server** (Postgres 16, Burstable B2s, 32 GB, Azure-services access, SSL required).
3. **Azure Container Apps** environment and app (external HTTPS, 1–2 replicas, 1 vCPU / 2 GiB). The database
   connection string is a Container App secret. On first boot the app migrates the schema and loads the seed.

It prints the public URL at the end. Re-running `./infra/deploy.sh` rebuilds the image and updates the app in place;
generated names and the database password are kept in `infra/.deploy.env` (git-ignored).

Options (environment variables before the command):

| Variable | Default | Meaning |
|---|---|---|
| `LOCATION` | `westeurope` | Azure region |
| `PREFIX` | `astra` | Name prefix for every resource |
| `RG` | `rg-astra-insights` | Resource group |
| `DEMO_TODAY` | `2026-10-13` | Frozen demo clock |
| `WITH_AI` | `false` | `true` also creates Azure OpenAI (gpt-4o-mini deployment) and Azure AI Speech and wires the keys in as secrets |

Other scripts: `./infra/reseed.sh` reloads the seed in the running app (after replacing the ServiceNow extract, for
example); `./infra/destroy.sh` deletes the resource group.

## Connecting a language model (Settings screen)

Open **Settings** in the left rail (or click the `LLM:` chip in the top bar), choose a provider, enter the key and model, click
**Test connection**, then **Save**. The key is stored in the `app_settings` table and never sent back to the browser; the change is
written to the audit trail.

| Provider | What to enter | Default model |
|---|---|---|
| Anthropic Claude | API key from console.anthropic.com; model ID | `claude-opus-5-5` (official `@anthropic-ai/sdk`) |
| Azure OpenAI | Resource endpoint `https://<resource>.openai.azure.com`, key, deployment name, API version | `gpt-4o-mini` |
| OpenAI | API key; model | `gpt-4o-mini` |

Environment variables are the fallback when nothing is saved in Settings: `AZURE_OPENAI_ENDPOINT`/`AZURE_OPENAI_API_KEY`/
`AZURE_OPENAI_DEPLOYMENT`, `ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL`, `OPENAI_API_KEY`/`OPENAI_MODEL`. A key that fails
authentication shows a warning on the chip and pauses model calls for a minute.

What the model does once connected, visible in the agent timeline under every answer:

- **Conductor** plans every question with the model (the dictionary parse is passed as a hint and used as the fallback).
- **Briefing Agent** writes the spoken answer with the model under a citation check: any number the model did not receive is rejected and the template answer is used instead.
- **Conversational questions** ("what does leverage mean here?") are answered by the model, grounded in the last answer, with no new figures.
- Token usage and cost per answer are real (from the provider's usage fields) and appear on the answer card and in the observatory.

The fourteen analytical agents (variance, forecast, win probability, engagement health, talent risk, staffing match, scenarios
and the rest) are statistical models on the firm's data by design: the specification requires every number to come from the
Query Agent, with language models used through prompts only.

### Voice: Azure AI Speech or the browser engine

Settings → **Voice**: enter the Azure AI Speech region and key (or deploy with `WITH_AI=true`, which creates the resource
and sets `AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION`). The server issues short-lived tokens to the browser; the key never
leaves the server. With Azure configured, recognition uses a phrase list of the firm's vocabulary (metric names, units,
offices, practices, industries, public clients and the persona prompts), synthesis uses a neural voice (default
`en-GB-SoniaNeural`, selectable), both work in every browser, and audio stays in the tenant. Without it, the browser's own
engine is used (Edge and Chrome). "Hear the voice" in Settings plays a sample; push-to-talk, the wake word "Astra",
interruption and quiet mode behave the same with either engine. The SDK is vendored at `public/vendor/speech-sdk.min.js`
so the product works without internet access to a CDN.

### Theme and provenance badges

The ☀/☾ button in the top bar switches between dark and light; the choice is remembered per browser and the charts re-theme.
Provenance badges on cards are off by default and can be switched on in Settings; the calculation drawer always names the source
system and, in demo mode, the connector stub.

## What is real and what is seeded

The product follows the data rule in Section 3 of the specification:

- **Real and sourced**: regions, the 17 business units, 53 offices with user counts and the employee/contractor split
  (`server/seed/offices.json`, in the shape of Schedule M), practices, industries, Kearney companies, leadership titles,
  the six publicly reported clients and their public work, research publication titles.
- **Seeded behind integration points**: fees, hours, invoices, pipeline, plan values, people attributes. They are generated
  by connector stubs from a fixed random seed (`server/seed/manifest.json`, `server/seed/generate.js`) and honour the real
  constraints: 6,637 people across the Schedule M offices, about 300 partners, 2025 revenue scaled to the public ">US$2 billion".
  Every seeded value carries a **Seeded** badge; the calculation drawer names the stub.
- **Planted patterns** for the storylines (all listed in the manifest): the Europe plan gap, the DACH realisation decline
  concentrated in E-1182, E-1207, E-1159, E-1231 and E-1244 (two trending to overrun), LIC's purchase history and white space
  in Digital and Analytics, and the Principal flight-risk cluster in the Middle East unit.

**Before the orals, replace two inputs:**

1. `server/seed/offices.json`: swap the per-office user counts and contractor counts for the Schedule M export (the file
   already reconciles to the regional totals, the 5,651 / 986 split and the Seoul contractor pattern, but office-level
   numbers are an allocation).
2. `data/servicenow_tickets.csv`: replace the sample rows with the RFP pack ticket extracts and set
   `source=rfp-pack:ticket-extract`. The product then shows them without a Seeded badge (storyline E, step 3).

Then run `npm run seed -- --force` locally or `./infra/reseed.sh` in Azure.

## The five storylines

Pick the persona (screen 1), then speak or type the prompts. Every prompt in Section 10 of the specification works as written.

| Storyline | Persona | Prompts |
|---|---|---|
| A. Managing Partner | Managing Partner and Chairman | "Are we on track for the year?" · click Europe on the map, "Why?" (or "Why is Europe behind plan?") · "What if we raise rates by 3% in North America from January?" |
| B. Realisation | Regional MD, Europe | "Why did realisation drop in DACH last quarter?" · "Will it get worse?" · "What should I do about it?" · open the action centre and approve one |
| C. Account 360 | Global Account Leader | "Prepare me for my meeting with LIC tomorrow" · "Where is the white space?" · "Who in the firm has worked with them?" · "Send me a short audio brief for the car" |
| D. Talent | Chief People Officer, then Principal | "Where will we lose the most Principals in the next six months, and why?" · "Show me the highest-risk Principals" · switch to Principal: "Show me the flight risk of my colleagues" (Guardian block) · back to CPO: "How many hires does India need next year?" |
| E. Governance | KNet leader | "Show me what the agents did today" · "What can the Action Agent change?" · "Show me our service desk volumes by application" · "How was this calculated?" |

The morning brief speaks on the first visit to Home for each persona. Point and ask works on every chart (click, then
"Why this?"). "Pin this to my board", "Make this weekly" and "Turn this into a slide" work after any answer.

## Architecture

```
public/            single-page product (vanilla ES modules, ECharts vendored for offline rooms)
  js/app.js        shell: persona entry, navigation fallback, command bar, voice orb, answer routing
  js/ui.js         answer cards, tables, lineage drawer, point-and-ask
  js/charts.js     the Composer's visual grammar rendered with ECharts (line+band, ranked bar, waterfall, map, heatmap, forecast, …)
  js/screens/      the sixteen screens
server/
  index.js         Express app; migrates and seeds on boot
  metrics/         catalogue.js (55 governed metrics), engine.js (one SQL implementation per metric, lineage on every result)
  agents/          conductor, guardian, parser, and the fourteen specialists (variance, forecast, trend, pipeline, engagement,
                   talent, staffing, client360, scenario, briefing, action, cash, observatory, composer), llm.js (optional Azure OpenAI)
  seed/            offices.json (real geography), manifest.json (constraints and planted patterns), generate.js, load.js
  routes/          api.js (ask, home, actions, boards, lineage, speech) and screens.js (role workspaces)
  schema.sql       Postgres schema
data/              servicenow_tickets.csv (replace with the RFP pack extract)
infra/             deploy.sh, reseed.sh, destroy.sh (Azure CLI, Cloud Shell)
```

Every question follows the eight steps in Section 6: parse and plan (Conductor) → resolve the governed metric (Metric Agent)
→ query under the persona's row-level security (Query Agent) → analytical agents → compose visual and narrative → Guardian
(pass, redact or block, logged) → answer with "How was this calculated?", the agent timeline and three follow-ups.
The Action Agent only drafts; approvals in the action centre go to a stub that records them and sends nothing.

### Models

Models 1–12 are statistical and run on the seeded data in this repository (revenue forecast with backtest band, utilisation
forecast, win probability, engagement overrun and write-off risk, late payment, flight risk with per-person drivers, burnout
rules, skill demand, hiring need, metric anomaly detection, next-best practice). Models 13–14 are language-model prompts and
only run when Azure OpenAI is configured; otherwise narrative generation uses templates, which satisfy the citation check by
construction. Accuracy figures shown in the observatory describe the seed, not Kearney.

### Security notes for the demo

Personas replace Entra ID sign-in in demo mode; the Guardian enforces each persona's scope, blocks individual people data outside
the People roles, restricts partner compensation, and logs every block, redaction, individual-data view and action decision to
`audit_log`. In Azure the database accepts connections only from Azure services over TLS and the connection string is a secret.
For a live deployment add Entra ID authentication on the Container App (`az containerapp auth update`) and private networking.
