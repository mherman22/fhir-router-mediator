# FHIR Router Mediator

[![CI](https://github.com/mherman22/fhir-router-mediator/actions/workflows/ci.yml/badge.svg)](https://github.com/mherman22/fhir-router-mediator/actions/workflows/ci.yml)
[![Publish image](https://github.com/mherman22/fhir-router-mediator/actions/workflows/publish.yml/badge.svg)](https://github.com/mherman22/fhir-router-mediator/actions/workflows/publish.yml)

An [OpenHIM](https://openhim.org/) mediator that takes a FHIR R4 **transaction Bundle** and
routes it by resource type to the SEDISH infrastructure:

- **`Patient` → OpenCR** (the Client Registry / MPI) — identity
- **clinical resources → SHR** (the Shared Health Record) — Encounters, Observations, Conditions, …

It is the write-side counterpart to [`fhir-aggregator-mediator`](https://github.com/mherman22/fhir-aggregator-mediator)
(which is read-side: it *aggregates* many FHIR servers into one). This one *splits* one stream out
to the right destinations, so the data pipeline doesn't need to know the CR/SHR topology — it just
POSTs bundles to a single endpoint.

## How it works

```
  data pipeline                OpenHIM                       fhir-router                OpenHIM channels
  (consolidated)   POST    /consolidated/fhir   ───────────>  split by type   ──PUT──>  /CR/fhir  -> OpenCR
  per-patient      ──────>  (transaction Bundle)              + dedupe         ──POST─>  /SHR/fhir -> SHR
  Bundle
```

1. The pipeline POSTs a per-patient transaction Bundle (`Patient` + its changed clinical) to the
   OpenHIM channel `/consolidated/fhir`, which forwards to this mediator.
2. The mediator **de-duplicates** entries by `resourceType/id` (so a stray duplicate can never
   poison a whole transaction — HAPI-0535), then:
   - **`Patient` → `PUT {CR_URL}/Patient/{id}`.** OpenCR doesn't support FHIR conditional-update,
     so we PUT by the stable uuid; OpenCR still matches/dedupes via `decisionRules.json` on the
     in-resource identifiers (source key, fingerprint). Idempotent, converges with the real-time feed.
   - **clinical → `POST {SHR_URL}`** as one transaction Bundle of **only clinical resources** — no
     demographics in the SHR (per the CHARESS spec). They keep their `subject` reference to
     `Patient/{id}`; the SHR's golden-record normalization resolves it against the CR.
3. Returns a `transaction-response` Bundle. If any downstream call fails it responds **502**, so
   OpenHIM marks the transaction failed and the pipeline retries the (idempotent) bundle.

## Configuration

`config/config.json`, overridable by env var:

| Env | Default | Purpose |
|-----|---------|---------|
| `PORT` | `3000` | listen port |
| `CR_URL` | `http://openhim-core:5001/CR/fhir` | OpenCR channel |
| `SHR_URL` | `http://openhim-core:5001/SHR/fhir` | SHR channel |
| `UPSTREAM_USERNAME` / `UPSTREAM_PASSWORD` | `consolidated` / `consolidated` | the one OpenHIM client (role `emr`) for both channels |
| `OPENHIM_API_URL` | `https://openhim-core:8080` | OpenHIM API for mediator registration |
| `OPENHIM_API_USERNAME` / `OPENHIM_API_PASSWORD` | `root@openhim.org` / — | OpenHIM API creds (registration skipped if password unset) |
| `RETRIES` | `3` | downstream retry attempts (network + 5xx) |

## Run

```bash
npm install
npm test            # unit tests (routing / dedupe / split)
npm start           # serve on :3000

# or
docker build -t fhir-router-mediator .
docker run -p 3000:3000 -e UPSTREAM_PASSWORD=consolidated fhir-router-mediator
```

### Try it

```bash
curl -sX POST http://localhost:3000/fhir \
  -H 'Content-Type: application/fhir+json' \
  -d '{"resourceType":"Bundle","type":"transaction","entry":[
        {"resource":{"resourceType":"Patient","id":"pA"}},
        {"resource":{"resourceType":"Observation","id":"o1","subject":{"reference":"Patient/pA"}}}
      ]}'
```

## Endpoints

- `POST /fhir` — route a transaction Bundle
- `GET /fhir/metadata` — minimal CapabilityStatement
- `GET /health` — liveness + configured destinations
- `GET /metrics` — Prometheus metrics

## Operational notes

- **Channel registration.** In the SEDISH stack the `/consolidated/fhir` channel is created by the
  OpenHIM **config importer**, not by this mediator — that OpenHIM uses Keycloak, so basic-auth
  mediator self-registration is skipped (registration only runs if `OPENHIM_API_PASSWORD` is set
  *and* your OpenHIM accepts it). The `config/mediator.json` here is the self-register definition
  for OpenHIM deployments that do support it.
- **Bundle size vs. timeout.** The mediator PUTs each `Patient` to OpenCR **sequentially**, so a
  very large bundle can take longer than OpenHIM's request timeout — OpenHIM then returns `500` to
  the caller even though the writes land, and the caller never sees success. Keep upstream bundles
  modest (the pipeline pages identities at `BATCH_SIZE=100`). If you need bigger bundles, raise the
  channel timeout or parallelize the CR PUTs (kept sequential here to avoid OpenCR matching races).
- **Failure semantics.** Any downstream non-2xx makes the whole bundle return `502` (logged at
  `warn` with status + detail); the upstream is expected to retry the idempotent bundle.
