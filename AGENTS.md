# giovanni-dev-br

Three.js orrery for Giovanni Coutinho. Not a Bruno Simon / Miguel Medeiros clone.

MUST:

- Keep travel compact. Hops in seconds.
- Map is an orrery / cockpit chart, not a ground map.
- Resume lives on resume.giovanni.dev.br. Do not require WebGL to read the CV.
- Proxy Bitcoin through `/api/bitcoin/*` to in-cluster mempool. Never expose bitcoind RPC or Fulcrum to the public internet.
- Claims only from `data/projects.json` and the privately maintained resume master. Never from memory.

MUST NOT:

- Copy kart, island, citadel, or Bruno Blender files.
- Invent metrics, headcount, or authorship.
- Put secrets in git.
- Name real private repositories, cluster hostnames, internal service addresses or machine names anywhere in this public tree, including docs (test fixtures use made-up internal-looking values).

The boundary (see README): the code is public, the addresses behind it are not.

- `test/disclosure.test.mjs` drives every public route with internal-looking configuration and failing upstreams. Every new integration gets an entry there in the same pull request.
- Upstream data is picked and coerced field by field in the server; never forward a raw upstream body. Missing readings render as unavailable, never as zero.
- Aggregate-only panels (uptime) must not group by, select or return per-monitor series.
- New live panels read Mimir over the existing egress where possible. One integration per pull request: exporter → PromQL in `src/insight.mjs` → body in `data/projects.json` → disclosure test entry.
- Logs contain visitor addresses and chat excerpts: they are personal data. Never commit logs or captured notification payloads. Intercept notification endpoints in live browser reviews.

Verify before shipping: `npm run build && npm test && npm run test:browser`.

Release: the default branch is `master`. Pushing it runs `release.yml`, which builds `ghcr.io/giovannirco/giovanni-dev-br-public:<sha>` and prints the digest; the pin lives in private deployment configuration. Commit or push only when asked.
