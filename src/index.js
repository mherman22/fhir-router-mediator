'use strict';

const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const { registerMediator, activateHeartbeat } = require('openhim-mediator-utils');

const { loadConfig } = require('./config');
const FhirClient = require('./fhir-client');
const createRouter = require('./routes');
const createMetrics = require('./metrics');
const logger = require('./logger');
const mediatorConfig = require('../config/mediator.json');

const config = loadConfig();

function buildApp() {
  const app = express();
  app.use(helmet());
  app.use(compression());

  const crClient = new FhirClient(config.performance, config.upstreamAuth);
  const shrClient = new FhirClient(config.performance, config.upstreamAuth);
  const metrics = createMetrics();

  app.use(createRouter({ config, crClient, shrClient, metrics }));
  return app;
}

// Register with OpenHIM (idempotent) and keep the heartbeat alive. Failure here is non-fatal:
// the mediator still serves traffic; it just won't show up / pull config from the OpenHIM console.
function registerWithOpenHIM() {
  const api = config.mediator.api;
  if (!api || !api.password) {
    logger.warn('OpenHIM API password not set — skipping mediator registration');
    return;
  }
  registerMediator(api, mediatorConfig, (err) => {
    if (err) {
      logger.error({ error: err.message }, 'OpenHIM mediator registration failed');
      return;
    }
    logger.info('registered with OpenHIM');
    activateHeartbeat(api);
  });
}

function start() {
  const app = buildApp();
  app.listen(config.app.port, () => {
    logger.info(
      {
        port: config.app.port,
        cr: config.destinations.clientRegistry.baseUrl,
        shr: config.destinations.sharedHealthRecord.baseUrl,
      },
      'fhir-router-mediator listening'
    );
    registerWithOpenHIM();
  });
}

if (require.main === module) {
  start();
}

module.exports = { buildApp };
