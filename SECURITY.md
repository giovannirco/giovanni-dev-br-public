# Security

## Reporting a vulnerability

Report privately through GitHub: **Security → Report a vulnerability** on this repository
(https://github.com/giovannirco/giovanni-dev-br-public/security/advisories/new).
Please do not open a public issue for a suspected vulnerability.

Include the route or file, what you sent, and what came back. Expect a first reply within a week.

## Scope

- The code in this repository and the site it serves at https://orrery.giovanni.dev.br.
- Out of scope: volumetric denial of service, social engineering, and anything that needs
  access to a visitor's device.

## What the site is built to hold

- The code is public; the addresses behind it are not. `test/disclosure.test.mjs` drives every
  public route with internal-looking configuration and failing upstreams, and fails if a
  hostname, port, tenant, credential, machine name or upstream error reaches a response.
- Upstream data is picked and coerced field by field. A raw upstream body is never forwarded.
- State-changing routes refuse cross-origin and non-JSON posts before reading a body.
- Every public route that reaches an upstream is rate limited per caller and in total.
- `/metrics` answers only to in-cluster scrapes.

A report that breaks one of these is especially welcome.
