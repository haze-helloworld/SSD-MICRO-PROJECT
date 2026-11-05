import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MemoryBackplane, MemoryHub } from '../src/backplane/memory.js';
import { loadConfig } from '../src/config.js';
import { Gateway } from '../src/gateway.js';

describe('observability & simulation endpoints', () => {
  it('serves system status, traces, and services status via REST API', async () => {
    const hub = new MemoryHub();
    const gw = new Gateway(
      loadConfig({ port: 0, nodeId: 'test-gw', devTokens: true, backplane: 'memory' }, {}),
      new MemoryBackplane(hub),
    );
    await gw.start();

    try {
      // Test /api/system/status
      const resStatus = await fetch(`http://127.0.0.1:${gw.port}/api/system/status`);
      assert.equal(resStatus.status, 200);
      const dataStatus = await resStatus.json();
      assert.equal(dataStatus.node, 'test-gw');
      assert.equal(typeof dataStatus.uptimeSec, 'number');
      assert.equal(dataStatus.backplane, 'memory');

      // Test /api/services/status
      const resServices = await fetch(`http://127.0.0.1:${gw.port}/api/services/status`);
      assert.equal(resServices.status, 200);
      const dataServices = await resServices.json();
      assert.ok(Array.isArray(dataServices.services));
      assert.ok(dataServices.services.some((s: any) => s.id === 'api-gateway'));
      assert.ok(dataServices.services.some((s: any) => s.id === 'aws-cloudwatch'));

      // Test /api/simulation/start & stop
      const resSimStart = await fetch(`http://127.0.0.1:${gw.port}/api/simulation/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clients: 5, ratePerSec: 10, pattern: 'steady' }),
      });
      assert.equal(resSimStart.status, 200);
      const dataSimStart = await resSimStart.json();
      assert.equal(dataSimStart.active, true);

      // Trigger spike
      const resSpike = await fetch(`http://127.0.0.1:${gw.port}/api/simulation/spike`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: 5 }),
      });
      assert.equal(resSpike.status, 200);

      // Verify traces generated
      const resTraces = await fetch(`http://127.0.0.1:${gw.port}/api/system/traces`);
      assert.equal(resTraces.status, 200);
      const dataTraces = await resTraces.json();
      assert.ok(Array.isArray(dataTraces.traces));
      assert.ok(dataTraces.traces.length > 0);

      // Check hop detail
      const sampleTrace = dataTraces.traces[0];
      assert.ok(sampleTrace.hops.length >= 3);
      assert.equal(sampleTrace.hops[0].from, 'Client Fleet');

      // Stop simulation
      const resSimStop = await fetch(`http://127.0.0.1:${gw.port}/api/simulation/stop`, { method: 'POST' });
      assert.equal(resSimStop.status, 200);

      // Test CloudWatch config endpoint
      const resCwConfig = await fetch(`http://127.0.0.1:${gw.port}/api/cloudwatch/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accessKeyId: 'AKIA_TEST_KEY',
          secretAccessKey: 'SECRET_TEST_KEY',
          region: 'us-east-1',
        }),
      });
      assert.equal(resCwConfig.status, 200);
      const dataCwConfig = await resCwConfig.json();
      assert.equal(dataCwConfig.success, true);

      // Test Production Auth /api/auth/login
      const resLogin = await fetch(`http://127.0.0.1:${gw.port}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: 'alice', password: 'admin123', tenant: 'acme' }),
      });
      assert.equal(resLogin.status, 200);
      const dataLogin = await resLogin.json();
      assert.equal(dataLogin.ok, true);
      assert.ok(dataLogin.token);
      assert.equal(dataLogin.user, 'alice');

      // Test /api/auth/verify
      const resVerify = await fetch(`http://127.0.0.1:${gw.port}/api/auth/verify?token=${dataLogin.token}`);
      assert.equal(resVerify.status, 200);
      const dataVerify = await resVerify.json();
      assert.equal(dataVerify.ok, true);
      assert.equal(dataVerify.claims.user, 'alice');
    } finally {
      await gw.stop(0);
    }
  });
});

