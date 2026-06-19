'use strict';

const { route, dedupeResources, split, buildTransactionBundle } = require('../src/router');

const config = {
  destinations: {
    clientRegistry: { baseUrl: 'http://openhim/CR/fhir' },
    sharedHealthRecord: { baseUrl: 'http://openhim/SHR/fhir' },
  },
  routing: { identityResourceTypes: ['Patient'] },
};

// fake downstream clients that record calls and return a configurable status
function fakeClient(status = 200) {
  const calls = [];
  return {
    calls,
    put: async (url, body) => (calls.push({ method: 'PUT', url, body }), { status, body: {} }),
    post: async (url, body) => (calls.push({ method: 'POST', url, body }), { status, body: {} }),
  };
}

const pat = (id) => ({ resource: { resourceType: 'Patient', id } });
const obs = (id, p) => ({ resource: { resourceType: 'Observation', id, subject: { reference: `Patient/${p}` } } });
const enc = (id, p) => ({ resource: { resourceType: 'Encounter', id, subject: { reference: `Patient/${p}` } } });
const bundle = (...entries) => ({ resourceType: 'Bundle', type: 'transaction', entry: entries });

describe('dedupeResources', () => {
  test('removes duplicate resourceType/id, keeps first, preserves order', () => {
    const out = dedupeResources([obs('o1', 'pA'), obs('o1', 'pA'), enc('e1', 'pA')]);
    expect(out.map((r) => `${r.resourceType}/${r.id}`)).toEqual(['Observation/o1', 'Encounter/e1']);
  });
  test('drops entries missing id or resourceType', () => {
    expect(dedupeResources([{ resource: { resourceType: 'Observation' } }, { resource: null }])).toEqual([]);
  });
});

describe('split', () => {
  test('separates identity (Patient) from clinical', () => {
    const { patients, clinical } = split(
      [pat('pA').resource, obs('o1', 'pA').resource, enc('e1', 'pA').resource],
      ['Patient']
    );
    expect(patients.map((r) => r.id)).toEqual(['pA']);
    expect(clinical.map((r) => r.resourceType)).toEqual(['Observation', 'Encounter']);
  });
});

describe('buildTransactionBundle', () => {
  test('PUTs each resource by resourceType/id', () => {
    const b = buildTransactionBundle([pat('pA').resource, obs('o1', 'pA').resource]);
    expect(b.type).toBe('transaction');
    expect(b.entry.map((e) => e.request.url)).toEqual(['Patient/pA', 'Observation/o1']);
  });
});

describe('route', () => {
  test('identity -> CR by PUT /Patient/{id} (not conditional ?identifier=)', async () => {
    const cr = fakeClient();
    const shr = fakeClient();
    const r = await route(bundle(pat('pA'), obs('o1', 'pA')), {
      config, crClient: cr, shrClient: shr,
    });
    expect(r.httpStatus).toBe(200);
    expect(cr.calls).toEqual([
      { method: 'PUT', url: 'http://openhim/CR/fhir/Patient/pA', body: { resourceType: 'Patient', id: 'pA' } },
    ]);
    expect(cr.calls[0].url).not.toContain('?identifier=');
  });

  test('SHR bundle includes the patient(s) + clinical (mediator stubs/strips the Patient)', async () => {
    const cr = fakeClient();
    const shr = fakeClient();
    await route(bundle(pat('pA'), obs('o1', 'pA'), enc('e1', 'pA')), {
      config, crClient: cr, shrClient: shr,
    });
    expect(shr.calls).toHaveLength(1);
    expect(shr.calls[0].url).toBe('http://openhim/SHR/fhir');
    const ids = shr.calls[0].body.entry.map((e) => e.request.url);
    // patient forwarded to the SHR too — the SHR mediator decides what to keep (link-only stub)
    expect(ids).toEqual(['Patient/pA', 'Observation/o1', 'Encounter/e1']);
    // and the Patient still went to CR
    expect(cr.calls.map((c) => c.url)).toEqual(['http://openhim/CR/fhir/Patient/pA']);
  });

  test('duplicate clinical entries are deduped before the SHR bundle (no HAPI-0535)', async () => {
    const cr = fakeClient();
    const shr = fakeClient();
    await route(bundle(pat('pA'), obs('o1', 'pA'), obs('o1', 'pA'), obs('o1', 'pA')), {
      config, crClient: cr, shrClient: shr,
    });
    const urls = shr.calls[0].body.entry.map((e) => e.request.url);
    expect(urls).toEqual(['Patient/pA', 'Observation/o1']); // deduped; patient + the single obs
  });

  test('patient-only (identity) bundle -> CR only, no SHR stub', async () => {
    const cr = fakeClient();
    const shr = fakeClient();
    await route(bundle(pat('pA')), { config, crClient: cr, shrClient: shr });
    expect(cr.calls).toHaveLength(1);
    expect(shr.calls).toHaveLength(0); // no clinical -> nothing sent to the SHR
  });

  test('downstream failure -> 502 (so OpenHIM marks it failed and the pipeline retries)', async () => {
    const cr = fakeClient(500);
    const shr = fakeClient();
    const r = await route(bundle(pat('pA'), obs('o1', 'pA')), { config, crClient: cr, shrClient: shr });
    expect(r.httpStatus).toBe(502);
    expect(r.summary.failures).toBe(1);
    // failure is captured in the summary (for the warn log), with destination + status
    expect(r.summary.errors[0]).toMatchObject({ dest: 'cr', id: 'pA', status: 500 });
    expect(typeof r.summary.crMs).toBe('number');
  });

  test('non-bundle body -> 400', async () => {
    const r = await route({ resourceType: 'Patient', id: 'x' }, { config, crClient: fakeClient(), shrClient: fakeClient() });
    expect(r.httpStatus).toBe(400);
  });
});
