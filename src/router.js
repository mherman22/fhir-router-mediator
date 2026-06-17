'use strict';

// The routing core. Given a FHIR transaction Bundle, route by resource type:
//   Patient   -> OpenCR (identity): PUT /Patient/{id}. OpenCR matches/dedupes via decisionRules
//                on the in-resource identifiers (source key, fingerprint), so a stable uuid PUT is
//                idempotent and converges with the parallel real-time feed. (OpenCR does NOT
//                support FHIR conditional-update, so we PUT by id, not by ?identifier=.)
//   clinical  -> SHR: one transaction Bundle (patient included as the reference target), so the
//                SHR's golden-record normalization can re-point clinical references.
// All bundle entries are de-duplicated by resourceType/id first, so a stray duplicate can never
// poison a whole transaction (HAPI-0535).

function operationOutcome(severity, code, diagnostics) {
  return { resourceType: 'OperationOutcome', issue: [{ severity, code, diagnostics }] };
}

// resources from a Bundle's entries, de-duplicated by resourceType/id (first wins, order kept)
function dedupeResources(entries) {
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    const r = e && e.resource;
    if (!r || !r.resourceType || !r.id) continue;
    const key = `${r.resourceType}/${r.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function buildTransactionBundle(resources) {
  return {
    resourceType: 'Bundle',
    type: 'transaction',
    entry: resources.map((r) => ({
      resource: r,
      request: { method: 'PUT', url: `${r.resourceType}/${r.id}` },
    })),
  };
}

function isOk(status) {
  return status >= 200 && status < 300;
}

// Split the deduped resources into the identity set (-> CR) and the clinical set (-> SHR).
function split(resources, identityResourceTypes) {
  const identitySet = new Set(identityResourceTypes);
  const patients = resources.filter((r) => identitySet.has(r.resourceType));
  const clinical = resources.filter((r) => !identitySet.has(r.resourceType));
  return { patients, clinical };
}

// Orchestrate one bundle. deps: { config, crClient, shrClient, metrics, logger }.
async function route(bundle, deps) {
  const { config, crClient, shrClient, metrics, logger } = deps;

  if (!bundle || bundle.resourceType !== 'Bundle' || !Array.isArray(bundle.entry)) {
    return {
      httpStatus: 400,
      body: operationOutcome('error', 'invalid', 'body must be a FHIR Bundle with an entry array'),
    };
  }

  const resources = dedupeResources(bundle.entry);
  const { patients, clinical } = split(resources, config.routing.identityResourceTypes);
  const crBase = config.destinations.clientRegistry.baseUrl.replace(/\/$/, '');
  const shrBase = config.destinations.sharedHealthRecord.baseUrl.replace(/\/$/, '');

  const responseEntries = [];
  let failures = 0;

  // identity -> OpenCR (one PUT per patient)
  for (const p of patients) {
    const res = await crClient.put(`${crBase}/Patient/${p.id}`, p);
    const ok = isOk(res.status);
    if (!ok) failures += 1;
    metrics && metrics.routed.inc({ destination: 'cr', outcome: ok ? 'ok' : 'fail' });
    responseEntries.push({ response: { status: String(res.status || 0), location: `Patient/${p.id}` } });
    logger && logger.debug({ patient: p.id, status: res.status }, 'routed Patient -> CR');
  }

  // clinical -> SHR (single transaction bundle; include patients as reference targets)
  if (clinical.length) {
    const shrBundle = buildTransactionBundle([...patients, ...clinical]);
    const res = await shrClient.post(shrBase, shrBundle);
    const ok = isOk(res.status);
    if (!ok) failures += 1;
    metrics &&
      metrics.routed.inc({ destination: 'shr', outcome: ok ? 'ok' : 'fail' }, clinical.length);
    responseEntries.push({
      response: { status: String(res.status || 0), outcome: res.body || res.error },
    });
    logger &&
      logger.debug({ clinical: clinical.length, status: res.status }, 'routed clinical -> SHR');
  }

  return {
    // 200 only when every downstream call succeeded; else 502 so OpenHIM marks the
    // transaction failed and the pipeline retries the (idempotent) bundle next cycle.
    httpStatus: failures === 0 ? 200 : 502,
    body: { resourceType: 'Bundle', type: 'transaction-response', entry: responseEntries },
    summary: { patients: patients.length, clinical: clinical.length, failures },
  };
}

module.exports = { route, dedupeResources, buildTransactionBundle, split, operationOutcome };
