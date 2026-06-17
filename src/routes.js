'use strict';

const express = require('express');
const { route, operationOutcome } = require('./router');
const logger = require('./logger');

// Builds the express router. deps: { config, crClient, shrClient, metrics }.
function createRouter(deps) {
  const router = express.Router();
  const { config, metrics } = deps;

  router.use(express.json({ type: ['application/fhir+json', 'application/json'], limit: '50mb' }));

  // Main entry: the pipeline POSTs a FHIR transaction Bundle here (OpenHIM channel /consolidated/fhir).
  router.post('/fhir', async (req, res) => {
    try {
      const result = await route(req.body, { ...deps, logger });
      metrics &&
        metrics.bundles.inc({ outcome: result.httpStatus === 200 ? 'ok' : 'fail' });
      if (result.summary) {
        logger.info(result.summary, 'bundle routed');
      }
      res
        .status(result.httpStatus)
        .set('Content-Type', 'application/fhir+json; charset=utf-8')
        .json(result.body);
    } catch (err) {
      logger.error({ error: err.message }, 'routing failed');
      metrics && metrics.bundles.inc({ outcome: 'error' });
      res
        .status(500)
        .set('Content-Type', 'application/fhir+json; charset=utf-8')
        .json(operationOutcome('error', 'exception', err.message));
    }
  });

  // Minimal CapabilityStatement so OpenHIM / clients can probe the endpoint.
  router.get('/fhir/metadata', (req, res) => {
    res.set('Content-Type', 'application/fhir+json; charset=utf-8').json({
      resourceType: 'CapabilityStatement',
      status: 'active',
      kind: 'instance',
      fhirVersion: '4.0.1',
      format: ['application/fhir+json'],
      rest: [{ mode: 'server', interaction: [{ code: 'transaction' }] }],
    });
  });

  router.get('/health', (req, res) => {
    res.json({
      status: 'UP',
      destinations: {
        clientRegistry: config.destinations.clientRegistry.baseUrl,
        sharedHealthRecord: config.destinations.sharedHealthRecord.baseUrl,
      },
    });
  });

  if (metrics) {
    router.get('/metrics', async (req, res) => {
      res.set('Content-Type', metrics.register.contentType);
      res.end(await metrics.register.metrics());
    });
  }

  return router;
}

module.exports = createRouter;
