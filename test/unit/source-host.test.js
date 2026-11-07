// @ts-check
/**
 * Tests for src/lib/source-host.js: the host name of the captured page. Only the host name is
 * kept (no scheme, port, path, query or fragment), and a URL that has none gives ''.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sourceHostOf } from '../../src/lib/source-host.js';
import { isSourceHost } from '../../src/shared/protocol.js';

describe('sourceHostOf', () => {
  it('keeps the host name and nothing else of the page', () => {
    assert.equal(sourceHostOf('https://github.com/pujari/spool/pull/1?tab=files#diff'), 'github.com');
    assert.equal(sourceHostOf('https://user:secret@mail.example.com:8443/u/0/#inbox'), 'mail.example.com');
    assert.equal(sourceHostOf('http://localhost:3000/app'), 'localhost');
    assert.equal(sourceHostOf('http://127.0.0.1:8080/'), '127.0.0.1');
  });

  it('writes the host in lower case, as URL does', () => {
    assert.equal(sourceHostOf('https://GitHub.COM/'), 'github.com');
  });

  it('keeps an IPv6 address in brackets, and gives punycode for a name with other letters', () => {
    assert.equal(sourceHostOf('http://[::1]:8080/'), '[::1]');
    assert.equal(sourceHostOf('https://bücher.example/'), 'xn--bcher-kva.example');
  });

  it('gives an empty text for a page that has no host', () => {
    assert.equal(sourceHostOf('file:///C:/Users/me/report.html'), '');
    assert.equal(sourceHostOf('about:blank'), '');
    assert.equal(sourceHostOf('data:text/html,hello'), '');
  });

  it('gives an empty text for a value that is not a URL', () => {
    for (const value of ['', 'not a url', undefined, null, 7, {}, [], ' ']) {
      assert.equal(sourceHostOf(value), '', JSON.stringify(value));
    }
  });

  it('gives an empty text for a host that the protocol would refuse', () => {
    // A scheme that URL does not treat as special can have a host with other characters.
    assert.equal(sourceHostOf('foo://bar%20baz/'), '');
    assert.equal(sourceHostOf(`https://${'a'.repeat(300)}.example/`), '');
  });

  it('what it gives always passes the validator of the message', () => {
    for (const url of [
      'https://github.com/',
      'http://[2001:db8::1]/',
      'https://bücher.example/',
      'file:///x',
      'foo://bar%20baz/',
    ]) {
      assert.equal(isSourceHost(sourceHostOf(url)), true, url);
    }
  });
});
