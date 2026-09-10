# giovanni.dev.br

A compact Three.js orrery about Giovanni Coutinho, Platform Engineer in Belo Horizonte. Fly between projects, enter orbit to read their dossiers, and open COMM for a conversation grounded in that destination. The resume is a separate application at https://resume.giovanni.dev.br and remains accessible without JavaScript or WebGL.

## Play

Choose **Take the controls** to start. W accelerates, S brakes, A/D steer, and Space boosts. Select a body for assisted travel, E enters orbit, and Esc leaves it. M opens the orrery chart; C cycles flight cameras and V returns overhead. Phones have touch steering and boost controls.

Orbit notes and COMM are translucent instruments; opening them keeps the scene moving. COMM supports streamed Markdown, a searchable model selector, Stop and Clear. Nearby metric sources appear on the scanner without entering orbit. Missing readings stay unavailable rather than becoming zero. Reduced-motion and low-graphics settings are available, and chart mode works when WebGL fails.

## Develop

Use Node 22 or newer:

```sh
npm ci
npm run build
npm test
npm run test:browser
node server.mjs
```

The server listens on port 8080. Configuration comes from process environment variables; `.env` is not loaded automatically. To use a local file, copy `.env.example` to `.env`, fill only the integrations needed, and run `node --env-file=.env server.mjs`. Keep that file untracked.

## Optional integrations

| Variables | Purpose |
| --- | --- |
| `MEMPOOL_API_BASE` | Mempool backend serving the fixed Bitcoin API routes |
| `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL` | OpenAI-compatible chat endpoint, credential and default model |
| `CHAT_MODELS` | Comma-separated public model allowlist |
| `WAHA_BASE_URL`, `WAHA_API_KEY`, `WAHA_SESSION`, `WAHA_BEACON_CHAT_ID` | Server-side notification transport and destination |
| `MIMIR_URL`, `MIMIR_TENANT` | Read-only site, cluster and uptime-monitor metrics |
| `PUBLIC_NODE_ALIASES` | `real=shown` pairs for the node panel; unmapped machines read as `node-01` |
| `JOB_SCOUT_URL` | Counts-only project activity feed |
| `LIGHTNING_ADDRESS`, `BTCPAY_URL` | Optional public payment destination |
| `TRUSTED_PROXY_CIDRS`, `TRUSTED_EDGE_CIDRS` | Explicit forwarding-header trust boundaries |
| `LOG_LEVEL`, `APP_VERSION` | Structured logging level and release identifier |

Deployment addresses belong in private deployment configuration. Credentials belong in a secret manager or runtime Secret references, never committed values. Integrations without configuration are unavailable; the portfolio remains playable. Payment destinations, selected model IDs and configured public metric readings are intentionally visible to visitors. Cluster readings never carry a real machine name: the node panel shows `PUBLIC_NODE_ALIASES` labels, or positional ones when unset. The uptime panel is aggregate-only for the same reason: its upstream series label every reading with the monitor's name, URL and hostname, so each query collapses the whole set to a single number and none may group by, select or return a per-monitor series. A test asserts that of every query rather than trusting the author of the next one.

`test/disclosure.test.mjs` is the boundary this repository is built around: the code is public, the addresses behind it are not. It drives every public route with internal-looking configuration and failing upstreams, and fails if a hostname, port, tenant, credential, machine name or upstream error message reaches a response. Add an integration and add it there. Server-side structured logs do record upstream addresses and are meant for a private log pipeline, not a public one.

Bitcoin is exposed only through allowlisted `/api/bitcoin/*` routes. Never point them at bitcoind RPC or expose Fulcrum. Chat has catalog grounding and no live-data tools; upstream model discovery is filtered through the public allowlist. No conversation database is required.

Launch notifications occur when a visitor chooses Take the controls. Relay messages require a separate explicit submission. WAHA receives connection/browser context and submitted text; failure does not block flight. Request logs include visitor addresses, and chat logs include prompt/reply excerpts — this is deliberate conversation observability, not a leak, and it means the logs are personal data. Retention, who may read the conversation view, and any stronger disclosure are deployment decisions: record the effective values where the deployment lives, not here, and set them before enabling collection. Never commit logs or captured notification payloads.

Logging-only bounds are applied to the log copy alone. Clipping a visitor or orbit identifier for storage must never change routing, quotas, grounding or the message actually sent. A refusal is not an upstream failure: an invalid orbit, an unconfigured service and a lost capacity race log as `rejected`, `unavailable` and `busy`, and none of them increments the chat error rate, so that metric measures the upstream rather than our own gatekeeping.

## Deploy and verify

`Dockerfile` builds the static frontend and Node server, runs as UID 10001, and exposes port 8080. Build for the target architecture, smoke-test `/api/healthz` with a read-only root filesystem and writable `/tmp`, then publish to your registry. Keep image digest pins and runtime configuration in your private deployment repository. This repository contains CI, not credentials or an environment-specific deployment workflow.

Run the Node and desktop/phone browser suites before shipping. Review the deployed asset version and both viewport sizes after deployment. Live browser reviews must intercept notification endpoints to avoid sending review traffic to the operator.

## Content and publication

Public dossiers live in `data/projects.json`. Preserve verified career facts; do not invent metrics, authorship or private employer project names. The resume application is maintained separately.

Operational notes, deployment configuration and the audit trail are maintained privately and are not part of this repository.
