'use strict';

const https = require('https');
const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const logger = require('./logger');

// Thin HTTP client for the downstream FHIR channels (OpenCR / SHR via OpenHIM).
// Retries idempotent failures (network + 5xx) with exponential backoff; one basic-auth
// credential (the `consolidated` OpenHIM client, role `emr`) is used for both channels.
class FhirClient {
  constructor(perf = {}, auth = {}) {
    this.client = axios.create({
      timeout: perf.timeoutMs || 120000,
      httpsAgent: new https.Agent({ rejectUnauthorized: perf.rejectUnauthorized !== false }),
      auth: auth.username ? { username: auth.username, password: auth.password } : undefined,
      headers: { 'Content-Type': 'application/fhir+json', Accept: 'application/fhir+json' },
      // resolve (don't throw) for any status < 500 so the caller can record 4xx outcomes
      validateStatus: (s) => s < 500,
    });

    axiosRetry(this.client, {
      retries: perf.retries != null ? perf.retries : 3,
      retryDelay: axiosRetry.exponentialDelay,
      retryCondition: (err) =>
        axiosRetry.isNetworkOrIdempotentRequestError(err) ||
        (err.response && err.response.status >= 500),
    });
  }

  async send(method, url, body) {
    try {
      const res = await this.client.request({ method, url, data: body });
      return { status: res.status, body: res.data };
    } catch (err) {
      // network / timeout after retries
      logger.warn({ method, url, error: err.message }, 'downstream request failed');
      return { status: 0, error: err.message };
    }
  }

  put(url, body) {
    return this.send('PUT', url, body);
  }

  post(url, body) {
    return this.send('POST', url, body);
  }
}

module.exports = FhirClient;
