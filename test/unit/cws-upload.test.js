// @ts-check
/**
 * Tests for the pure parts of .github/scripts/cws-upload.mjs: URLs, request bodies, the token
 * assertion and the reading of store responses. The network calls are not tested.
 */
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  buildAssertion,
  classifyUploadState,
  describePublish,
  endpoints,
  parseServiceAccount,
  publishBody,
  publishType,
  tokenRequestBody,
  uploadStateOf,
} from '../../.github/scripts/cws-upload.mjs';

const EXTENSION = 'a'.repeat(32);

describe('endpoints', () => {
  it('builds the three v2 URLs', () => {
    const urls = endpoints('pub_1', EXTENSION);
    const item = `publishers/pub_1/items/${EXTENSION}`;
    assert.equal(
      urls.upload,
      `https://chromewebstore.googleapis.com/upload/v2/${item}:upload`,
    );
    assert.equal(urls.publish, `https://chromewebstore.googleapis.com/v2/${item}:publish`);
    assert.equal(
      urls.fetchStatus,
      `https://chromewebstore.googleapis.com/v2/${item}:fetchStatus`,
    );
  });

  it('refuses IDs that could change the path', () => {
    assert.throws(() => endpoints('a/b', EXTENSION), /CWS_PUBLISHER_ID/);
    assert.throws(() => endpoints('', EXTENSION), /CWS_PUBLISHER_ID/);
    assert.throws(() => endpoints('pub', 'short'), /CWS_EXTENSION_ID/);
    assert.throws(() => endpoints('pub', `${'a'.repeat(31)}/`), /CWS_EXTENSION_ID/);
  });
});

describe('publish type and body', () => {
  it('defaults to a staged publish and rejects unknown values', () => {
    assert.equal(publishType(undefined), 'STAGED_PUBLISH');
    assert.equal(publishType(''), 'STAGED_PUBLISH');
    assert.equal(publishType('DEFAULT_PUBLISH'), 'DEFAULT_PUBLISH');
    assert.throws(() => publishType('NOW'), /CWS_PUBLISH_TYPE/);
  });

  it('puts only the type in the JSON body, so review is never skipped', () => {
    assert.deepEqual(JSON.parse(publishBody('STAGED_PUBLISH')), { publishType: 'STAGED_PUBLISH' });
  });
});

describe('service account', () => {
  it('reads a key file and rejects other shapes', () => {
    const account = parseServiceAccount({
      type: 'service_account',
      client_email: 'a@b.iam.gserviceaccount.com',
      private_key: 'k',
      extra: 1,
    });
    assert.deepEqual(account, { client_email: 'a@b.iam.gserviceaccount.com', private_key: 'k' });
    assert.throws(() => parseServiceAccount({ type: 'authorized_user' }), /service account/);
    assert.throws(() => parseServiceAccount({ type: 'service_account' }), /client_email/);
    assert.throws(() => parseServiceAccount(null), /service account/);
  });

  it('signs a JWT with the store scope that the public key verifies', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const jwt = buildAssertion({ client_email: 'sa@x.test', private_key: pem }, 1000);
    const [header, claims, signature] = jwt.split('.');
    assert.deepEqual(JSON.parse(Buffer.from(header ?? '', 'base64url').toString()), {
      alg: 'RS256',
      typ: 'JWT',
    });
    assert.deepEqual(JSON.parse(Buffer.from(claims ?? '', 'base64url').toString()), {
      iss: 'sa@x.test',
      scope: 'https://www.googleapis.com/auth/chromewebstore',
      aud: 'https://oauth2.googleapis.com/token',
      iat: 1000,
      exp: 4000,
    });
    const verifier = createVerify('RSA-SHA256').update(`${header}.${claims}`);
    assert.ok(verifier.verify(publicKey, Buffer.from(signature ?? '', 'base64url')));
  });

  it('sends the assertion as a jwt-bearer grant', () => {
    const body = tokenRequestBody('abc');
    assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    assert.equal(body.get('assertion'), 'abc');
  });
});

describe('store responses', () => {
  it('classifies upload states', () => {
    assert.equal(classifyUploadState('SUCCEEDED'), 'done');
    assert.equal(classifyUploadState('IN_PROGRESS'), 'wait');
    assert.equal(classifyUploadState('UPLOAD_IN_PROGRESS'), 'wait');
    assert.equal(classifyUploadState('FAILED'), 'failed');
    assert.equal(classifyUploadState('NOT_FOUND'), 'failed');
    assert.equal(classifyUploadState(undefined), 'failed');
  });

  it('reads the state from an upload or a status response', () => {
    assert.equal(uploadStateOf({ uploadState: 'SUCCEEDED' }), 'SUCCEEDED');
    assert.equal(uploadStateOf({ lastAsyncUploadState: 'IN_PROGRESS' }), 'IN_PROGRESS');
    assert.equal(uploadStateOf({}), undefined);
    assert.equal(uploadStateOf(null), undefined);
  });

  it('summarizes a publish answer and fails on rejection', () => {
    assert.equal(
      describePublish({ itemId: EXTENSION, state: 'PENDING_REVIEW' }),
      `item ${EXTENSION} is PENDING_REVIEW`,
    );
    assert.throws(() => describePublish({ state: 'REJECTED' }), /REJECTED/);
    assert.throws(() => describePublish({ state: 'CANCELLED' }), /CANCELLED/);
    assert.equal(describePublish({}), 'item ? is UNKNOWN');
  });
});
