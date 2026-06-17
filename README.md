# FHIR Router Mediator

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
   - **clinical → `POST {SHR_URL}`** as one transaction Bundle (the patient is included as the
     reference target so the SHR's golden-record normalization can re-point clinical references).
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
