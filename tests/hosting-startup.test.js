import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('hosted startup honors PORT, preserves OAuth and serves MCP', { timeout: 15000 }, async () => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/index.js'], {
    env: {
      ...process.env,
      MCP_TRANSPORT: 'http', PORT: String(port), MCP_PORT: 'invalid',
      MCP_BASE_URL: origin, MCP_AUTH: 'true',
      MCP_AUTH_SECRET: 'local-test-secret-not-for-deployment',
      AUTH_STORE_PATH: '', MCP_TRUST_PROXY: 'false',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let errors = '';
  child.stderr.on('data', data => { errors += data; });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      assert.equal(child.exitCode, null, errors);
      try {
        const response = await fetch(`${origin}/health`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { status: 'ok' });
        ready = true;
        break;
      } catch { await delay(50); }
    }
    assert.ok(ready, errors);
    const protectedResponse = await fetch(`${origin}/mcp`);
    assert.equal(protectedResponse.status, 401);
    const metadata = await fetch(`${origin}/.well-known/oauth-authorization-server`);
    assert.equal(metadata.status, 200);
    assert.equal((await metadata.json()).issuer, origin);
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
  }
});

test('hosted startup rejects an invalid assigned port', async () => {
  const child = spawn(process.execPath, ['src/index.js'], {
    env: { ...process.env, MCP_TRANSPORT: 'http', PORT: '3000oops' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let errors = '';
  child.stderr.on('data', data => { errors += data; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 1);
  assert.match(errors, /PORT or MCP_PORT must be an integer/);
});
