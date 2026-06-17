'use strict';

const client = require('prom-client');

function createMetrics() {
  const register = new client.Registry();
  client.collectDefaultMetrics({ register });

  const routed = new client.Counter({
    name: 'fhir_router_resources_routed_total',
    help: 'Resources routed downstream, by destination and outcome',
    labelNames: ['destination', 'outcome'],
    registers: [register],
  });

  const bundles = new client.Counter({
    name: 'fhir_router_bundles_total',
    help: 'Bundles received, by outcome',
    labelNames: ['outcome'],
    registers: [register],
  });

  return { register, routed, bundles };
}

module.exports = createMetrics;
