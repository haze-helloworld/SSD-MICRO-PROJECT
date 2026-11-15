import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { signToken } from '../src/auth.js';
import { MemoryBackplane, MemoryHub } from '../src/backplane/memory.js';
import { loadConfig } from '../src/config.js';
import { Gateway } from '../src/gateway.js';
import { decryptSecret, encryptSecret } from '../src/secret-crypto.js';

describe('secret-crypto', () => {
  const secret = 'my-super-secret-jwt-key-for-testing';

  it('encrypts and decrypts round-trip correctly', () => {
    const original = JSON.stringify({ accessKeyId: 'ASIAEXAMPLE', secretAccessKey: 'sec', token: 'tok' });
    const encrypted = encryptSecret(original, secret);
    assert.notEqual(encrypted, original);
    const decrypted = decryptSecret(encrypted, secret);
    assert.equal(decrypted, original);
  });

  it('fails decryption with wrong secret', () => {
    const encrypted = encryptSecret('hello world', secret);
    assert.throws(() => {
      decryptSecret(encrypted, 'wrong-secret-key-123');
    });
  });

  it('fails decryption on tampered data', () => {
    const encrypted = encryptSecret('sensitive data', secret);
    const buf = Buffer.from(encrypted, 'base64');
    buf[buf.length - 1] ^= 0xff;
    const tampered = buf.toString('base64');
    assert.throws(() => {
      decryptSecret(tampered, secret);
    });
  });
});

describe('memory backplane secrets', () => {
  it('returns value before TTL and null after expiry', async () => {
    const hub = new MemoryHub();
    const bp = new MemoryBackplane(hub);

    await bp.saveSecret('key1', 'value1', 0.1);
    const immediate = await bp.loadSecret('key1');
    assert.equal(immediate, 'value1');

    await new Promise((r) => setTimeout(r, 150));
    const expired = await bp.loadSecret('key1');
    assert.equal(expired, null);
  });
});

describe('cloudwatch config and test endpoints auth', () => {
  it('rejects without token (401) and succeeds or validates with valid token', async () => {
    const jwtSecret = 'test-jwt-secret-for-cloudwatch-32chars';
    const hub = new MemoryHub();
    const cfg = loadConfig({
      port: 0,
      nodeId: 'test-gw',
      devTokens: true,
      backplane: 'memory',
      jwtSecret,
    }, {});
    const gw = new Gateway(cfg, new MemoryBackplane(hub));
    await gw.start();

    try {
      const baseUrl = `http://127.0.0.1:${gw.port}`;

      // (1) POST /api/cloudwatch/config without token
      const resConfigNoToken = await fetch(`${baseUrl}/api/cloudwatch/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessKeyId: 'ASIA123', secretAccessKey: 'sec123' }),
      });
      assert.equal(resConfigNoToken.status, 401, 'expected 401 on /api/cloudwatch/config without token');

      // (2) POST /api/cloudwatch/test without token
      const resTestNoToken = await fetch(`${baseUrl}/api/cloudwatch/test`, {
        method: 'POST',
      });
      assert.equal(resTestNoToken.status, 401, 'expected 401 on /api/cloudwatch/test without token');

      // (3) With valid token
      const token = signToken(jwtSecret, { user: 'admin', tenant: 'acme' });
      const authHeader = { 'Authorization': `Bearer ${token}` };

      const resConfigWithToken = await fetch(`${baseUrl}/api/cloudwatch/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ accessKeyId: 'ASIA123', secretAccessKey: 'sec123', region: 'us-east-1' }),
      });
      assert.notEqual(resConfigWithToken.status, 401, 'expected authenticated response on /api/cloudwatch/config');
      assert.ok([200, 400].includes(resConfigWithToken.status));

      const resTestWithToken = await fetch(`${baseUrl}/api/cloudwatch/test`, {
        method: 'POST',
        headers: authHeader,
      });
      assert.notEqual(resTestWithToken.status, 401, 'expected authenticated response on /api/cloudwatch/test');
      assert.equal(resTestWithToken.status, 200);
    } finally {
      await gw.stop();
    }
  });
});
