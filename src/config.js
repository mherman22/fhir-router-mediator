'use strict';

// Loads config/config.json, applies environment-variable overrides, and validates it.
// Env overrides keep secrets out of the committed JSON and let the OpenHIM/Instant stack
// inject per-deployment values.
const baseConfig = require('../config/config.json');

function applyEnvOverrides(config) {
  const env = process.env;

  if (env.PORT) config.app.port = parseInt(env.PORT, 10);

  // OpenHIM mediator API (registration + heartbeat)
  if (env.OPENHIM_API_URL) config.mediator.api.apiURL = env.OPENHIM_API_URL;
  if (env.OPENHIM_API_USERNAME) config.mediator.api.username = env.OPENHIM_API_USERNAME;
  if (env.OPENHIM_API_PASSWORD) config.mediator.api.password = env.OPENHIM_API_PASSWORD;

  // Downstream channels (OpenCR / SHR), reached through OpenHIM
  if (env.CR_URL) config.destinations.clientRegistry.baseUrl = env.CR_URL;
  if (env.SHR_URL) config.destinations.sharedHealthRecord.baseUrl = env.SHR_URL;

  // The single OpenHIM client used for both downstream channels (role `emr`)
  if (env.UPSTREAM_USERNAME) config.upstreamAuth.username = env.UPSTREAM_USERNAME;
  if (env.UPSTREAM_PASSWORD) config.upstreamAuth.password = env.UPSTREAM_PASSWORD;

  if (env.REQUEST_TIMEOUT_MS) config.performance.timeoutMs = parseInt(env.REQUEST_TIMEOUT_MS, 10);
  if (env.RETRIES) config.performance.retries = parseInt(env.RETRIES, 10);

  return config;
}

function validateConfig(config) {
  const errors = [];

  if (
    !config.app ||
    typeof config.app.port !== 'number' ||
    config.app.port < 1 ||
    config.app.port > 65535
  ) {
    errors.push('app.port must be a number between 1 and 65535');
  }

  ['clientRegistry', 'sharedHealthRecord'].forEach((key) => {
    const dest = config.destinations && config.destinations[key];
    if (!dest || !dest.baseUrl) {
      errors.push(`destinations.${key}.baseUrl is required`);
      return;
    }
    try {
      new URL(dest.baseUrl);
    } catch {
      errors.push(`destinations.${key}.baseUrl "${dest.baseUrl}" is not a valid URL`);
    }
  });

  if (!Array.isArray(config.routing && config.routing.identityResourceTypes)) {
    errors.push('routing.identityResourceTypes must be an array');
  }

  if (errors.length) {
    throw new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);
  }
  return config;
}

function loadConfig() {
  const config = applyEnvOverrides(baseConfig);
  validateConfig(config);
  return config;
}

module.exports = { loadConfig, applyEnvOverrides, validateConfig };
