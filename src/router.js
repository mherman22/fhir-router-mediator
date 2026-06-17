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

// short human string from a downstream response, for logs (FHIR OperationOutcome text or raw)
function snippet(res) {
  if (!res) return '';
  if (res.error) return String(res.error).slice(0, 200);
  const b = res.body;
  if (b == null) return '';
  if (typeof b === 'string') return b.slice(0, 200);
  const issue = b.issue && b.issue[0];
  if (issue) return `${issue.code || ''}: ${issue.diagnostics || issue.details?.text || ''}`.slice(0, 200);
  try {
    return JSON.stringify(b).slice(0, 200);
  } catch {
    return '';
  }
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
  const deduped = bundle.entry.length - resources.length;
  const { patients, clinical } = split(resources, config.routing.identityResourceTypes);
  const crBase = config.destinations.clientRegistry.baseUrl.replace(/\/$/, '');
  const shrBase = config.destinations.sharedHealthRecord.baseUrl.replace(/\/$/, '');

  const responseEntries = [];
  const errors = []; // sample of downstream failures, for the summary log
  let failures = 0;
  let crOk = 0;
  let crMs = 0;
  let shrMs = 0;

  // identity -> OpenCR (one PUT per patient). OpenCR has no conditional-update, so PUT by id.
  for (const p of patients) {
    const t = Date.now();
    const res = await crClient.put(`${crBase}/Patient/${p.id}`, p);
    crMs += Date.now() - t;
    const ok = isOk(res.status);
    crOk += ok ? 1 : 0;
    if (!ok) {
      failures += 1;
      if (errors.length < 5) errors.push({ dest: 'cr', id: p.id, status: res.status, detail: snippet(res) });
      logger && logger.warn({ patient: p.id, status: res.status, detail: snippet(res) }, 'CR PUT failed');
    }
    metrics && metrics.routed.inc({ destination: 'cr', outcome: ok ? 'ok' : 'fail' });
    responseEntries.push({ response: { status: String(res.status || 0), location: `Patient/${p.id}` } });
  }

  // clinical -> SHR (single transaction bundle; include patients as reference targets)
  let shrStatus = null;
  if (clinical.length) {
    const shrBundle = buildTransactionBundle([...patients, ...clinical]);
    const t = Date.now();
    const res = await shrClient.post(shrBase, shrBundle);
    shrMs = Date.now() - t;
    shrStatus = res.status;
    const ok = isOk(res.status);
    if (!ok) {
      failures += 1;
      errors.push({ dest: 'shr', count: clinical.length, status: res.status, detail: snippet(res) });
      logger && logger.warn({ clinical: clinical.length, status: res.status, detail: snippet(res) }, 'SHR POST failed');
    }
    metrics &&
      metrics.routed.inc({ destination: 'shr', outcome: ok ? 'ok' : 'fail' }, clinical.length);
    responseEntries.push({
      response: { status: String(res.status || 0), outcome: res.body || res.error },
    });
  }

  return {
    // 200 only when every downstream call succeeded; else 502 so OpenHIM marks the
    // transaction failed and the pipeline retries the (idempotent) bundle next cycle.
    httpStatus: failures === 0 ? 200 : 502,
    body: { resourceType: 'Bundle', type: 'transaction-response', entry: responseEntries },
    summary: {
      patients: patients.length,
      patientsOk: crOk,
      clinical: clinical.length,
      shrStatus,
      deduped,
      failures,
      crMs,
      shrMs,
      errors,
    },
  };
}

module.exports = { route, dedupeResources, buildTransactionBundle, split, operationOutcome };
