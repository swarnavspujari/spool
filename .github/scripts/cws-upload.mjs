// @ts-check
/**
 * Uploads a zip to the Chrome Web Store and submits it for review (Chrome Web Store API v2).
 *
 * NOT YET EXERCISED against the real store. The endpoints and fields follow the v2 reference
 * (developer.chrome.com/docs/webstore/api); the pure parts below are unit-tested, the network
 * calls are not. The first real run is the test.
 *
 * Usage: node .github/scripts/cws-upload.mjs <zip>
 *
 * Environment:
 *   GOOGLE_APPLICATION_CREDENTIALS  Path of the service account JSON key (required).
 *   CWS_PUBLISHER_ID                Publisher ID from the store dashboard (required).
 *   CWS_EXTENSION_ID                32-letter item ID (required).
 *   CWS_PUBLISH_TYPE                STAGED_PUBLISH (default: approved, then held until you press
 *                                   Publish in the dashboard) or DEFAULT_PUBLISH.
 *
 * v2 cannot create items or change visibility: the item and its listing must exist already.
 * It uses Node built-ins only. The key and the access token are never printed.
 */

import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const API = 'https://chromewebstore.googleapis.com';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';
export const PUBLISH_TYPES = Object.freeze(['STAGED_PUBLISH', 'DEFAULT_PUBLISH']);

const POLL_INTERVAL_MS = 15_000;
const POLL_LIMIT = 20;

/**
 * @param {string} publisherId
 * @param {string} extensionId
 * @returns {{ upload: string, publish: string, fetchStatus: string }} The three v2 endpoints.
 */
export function endpoints(publisherId, extensionId) {
  if (!/^[A-Za-z0-9_-]+$/.test(publisherId)) throw new Error('CWS_PUBLISHER_ID is not valid');
  if (!/^[a-z]{32}$/.test(extensionId)) {
    throw new Error('CWS_EXTENSION_ID must be 32 lower-case letters');
  }
  const item = `publishers/${publisherId}/items/${extensionId}`;
  return {
    upload: `${API}/upload/v2/${item}:upload`,
    publish: `${API}/v2/${item}:publish`,
    fetchStatus: `${API}/v2/${item}:fetchStatus`,
  };
}

/**
 * @param {string | undefined} type
 * @returns {string} The publish type, STAGED_PUBLISH when empty.
 */
export function publishType(type) {
  const value = type === undefined || type === '' ? 'STAGED_PUBLISH' : type;
  if (!PUBLISH_TYPES.includes(value)) {
    throw new Error(`CWS_PUBLISH_TYPE must be one of ${PUBLISH_TYPES.join(', ')}, not "${value}"`);
  }
  return value;
}

/**
 * @param {string} type A value from publishType().
 * @returns {string} The JSON body of the publish request.
 */
export function publishBody(type) {
  return JSON.stringify({ publishType: type });
}

/**
 * @param {unknown} json Parsed key file.
 * @returns {{ client_email: string, private_key: string }}
 */
export function parseServiceAccount(json) {
  const key = /** @type {Record<string, unknown>} */ (json ?? {});
  if (key['type'] !== 'service_account') {
    throw new Error('the key file is not a service account key');
  }
  const { client_email: email, private_key: privateKey } = key;
  if (typeof email !== 'string' || typeof privateKey !== 'string' || !email || !privateKey) {
    throw new Error('the key file has no client_email or private_key');
  }
  return { client_email: email, private_key: privateKey };
}

/** @param {unknown} value @returns {string} */
const base64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * Signs the JWT that Google exchanges for an access token (service account flow, RS256).
 * @param {{ client_email: string, private_key: string }} account
 * @param {number} nowSeconds
 * @returns {string}
 */
export function buildAssertion(account, nowSeconds) {
  const unsigned = `${base64url({ alg: 'RS256', typ: 'JWT' })}.${base64url({
    iss: account.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + 3000,
  })}`;
  const signature = createSign('RSA-SHA256')
    .update(unsigned)
    .sign(account.private_key, 'base64url');
  return `${unsigned}.${signature}`;
}

/**
 * @param {string} assertion
 * @returns {URLSearchParams} The body of the token request.
 */
export function tokenRequestBody(assertion) {
  return new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });
}

/**
 * The docs name the in-progress state both "IN_PROGRESS" and "UPLOAD_IN_PROGRESS", so match on
 * the stable part.
 * @param {unknown} state An upload state string.
 * @returns {'done' | 'wait' | 'failed'}
 */
export function classifyUploadState(state) {
  const text = String(state ?? '');
  if (/IN_PROGRESS/.test(text)) return 'wait';
  if (/^(?:UPLOAD_)?SUCCEEDED$/.test(text)) return 'done';
  return 'failed';
}

/**
 * @param {unknown} body Response of :upload or :fetchStatus.
 * @returns {unknown} The upload state: `uploadState` of :upload, else `lastAsyncUploadState`.
 */
export function uploadStateOf(body) {
  const object = /** @type {Record<string, unknown>} */ (body ?? {});
  return object['uploadState'] ?? object['lastAsyncUploadState'];
}

/**
 * @param {unknown} body Response of :publish.
 * @returns {string} A one-line summary. Throws when the item is rejected or cancelled.
 */
export function describePublish(body) {
  const object = /** @type {Record<string, unknown>} */ (body ?? {});
  const state = String(object['state'] ?? 'UNKNOWN');
  if (state === 'REJECTED' || state === 'CANCELLED') {
    throw new Error(`the store reports the submission as ${state}`);
  }
  return `item ${String(object['itemId'] ?? '?')} is ${state}`;
}

/** @param {number} ms @returns {Promise<void>} */
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * @param {string} url
 * @param {RequestInit} init
 * @returns {Promise<any>} Parsed JSON. Throws with the status and body on a non-2xx answer.
 */
async function request(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
  const text = await response.text();
  /** @type {any} */
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    // Not JSON: the text goes into the error below.
  }
  if (!response.ok) {
    const where = `${init.method ?? 'GET'} ${new URL(url).pathname}`;
    throw new Error(`${where} -> ${response.status} ${text}`);
  }
  return body;
}

async function main() {
  const [zipPath] = process.argv.slice(2);
  if (!zipPath) throw new Error('usage: cws-upload.mjs <zip>');
  const keyPath = process.env['GOOGLE_APPLICATION_CREDENTIALS'];
  if (!keyPath) throw new Error('GOOGLE_APPLICATION_CREDENTIALS is not set');

  const urls = endpoints(
    process.env['CWS_PUBLISHER_ID'] ?? '',
    process.env['CWS_EXTENSION_ID'] ?? '',
  );
  const type = publishType(process.env['CWS_PUBLISH_TYPE']);
  const account = parseServiceAccount(JSON.parse(readFileSync(resolve(keyPath), 'utf8')));
  const zip = readFileSync(resolve(zipPath));

  const assertion = buildAssertion(account, Math.floor(Date.now() / 1000));
  const token = await request(TOKEN_URL, { method: 'POST', body: tokenRequestBody(assertion) });
  const auth = { authorization: `Bearer ${token.access_token}` };

  console.log(`uploading ${zipPath} (${zip.length} bytes)`);
  const uploaded = await request(urls.upload, { method: 'POST', headers: auth, body: zip });
  let state = uploadStateOf(uploaded);
  for (let i = 0; classifyUploadState(state) === 'wait' && i < POLL_LIMIT; i++) {
    await sleep(POLL_INTERVAL_MS);
    state = uploadStateOf(await request(urls.fetchStatus, { headers: auth }));
  }
  if (classifyUploadState(state) !== 'done') throw new Error(`upload ended in state ${state}`);
  console.log(`upload: ${state}`);

  const published = await request(urls.publish, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: publishBody(type),
  });
  console.log(`submitted as ${type}: ${describePublish(published)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  main().catch((error) => {
    console.error(`cws-upload: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
