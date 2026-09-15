import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createMysqlAuthStore } from '../src/auth/mysql-store.js';
import { McpOAuthProvider } from '../src/auth/provider.js';
import { createHttpApp } from '../src/http-server.js';
import { completeOAuthHandshake, mcpRpc } from './handshake.js';

test('HTTP login and MCP tools work with the same tokens after an app restart', async () => {
  const secret = 'disposable-http-test-secret';
  let running;
  let origin;
  let port = 0;
  async function start() {
    // Reserve the port first so the database namespace matches the HTTP origin.
    const { createServer } = await import('node:net');
    if (!port) {
      const reservation = createServer();
      await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
      port = reservation.address().port;
      await new Promise(resolve => reservation.close(resolve));
      origin = `http://127.0.0.1:${port}`;
    }
    const store = await createMysqlAuthStore(process.env, `${origin}/mcp`);
    const app = createHttpApp({ authSecret: secret, baseUrl: origin, authStore: store });
    const server = app.app.listen(port, '127.0.0.1');
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    running = { async close() {
      app.stop();
      await new Promise(resolve => server.close(resolve));
      await store.close();
    } };
  }
  async function listTools(token) {
    const init = await mcpRpc(`${origin}/mcp`, token, undefined, {
      jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2025-03-26', capabilities: {},
        clientInfo: { name: 'mph-restart-test', version: '1.0.0' },
      },
    });
    assert.equal(init.status, 200);
    await mcpRpc(`${origin}/mcp`, token, init.sessionId, {
      jsonrpc: '2.0', method: 'notifications/initialized',
    });
    const result = await mcpRpc(`${origin}/mcp`, token, init.sessionId, {
      jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
    });
    assert.equal(result.status, 200);
    assert.ok(result.body.result.tools.some(tool => tool.name === 'get_bible_verse'));
  }
  try {
    await start();
    const { client, tokens } = await completeOAuthHandshake(origin, secret);
    await listTools(tokens.access_token);
    await running.close();
    running = undefined;
    await start();
    await listTools(tokens.access_token);
    const response = await fetch(`${origin}/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token, client_id: client.client_id,
        resource: `${origin}/mcp` }),
    });
    assert.equal(response.status, 200);
    const refreshed = await response.json();
    await listTools(refreshed.access_token);
  } finally {
    await running?.close();
  }
});

// Run explicitly against a disposable database: npm run test:mysql.
test('MySQL preserves OAuth across restarts, isolates origins and consumes refresh tokens once', async () => {
  const resourceUrl = `https://${randomUUID()}.example.test/mcp`;
  const stores = [];
  async function open(url = resourceUrl) {
    const store = await createMysqlAuthStore(process.env, url);
    stores.push(store);
    return store;
  }
  const provider = store => new McpOAuthProvider({
    authSecret: 'disposable-test-secret-only', resourceUrl, authStore: store,
  });
  try {
    const first = await open();
    const client = { client_id: 'test-client', redirect_uris: ['https://client.example/callback'] };
    await first.clientsStore.registerClient(client);
    const data = { clientId: client.client_id, scopes: ['mcp:tools'],
      expiresAt: Date.now() + 60000, resource: resourceUrl };
    await first.tokens.saveAccess('access', data);
    await first.tokens.saveRefresh('refresh', data);
    await first.close();
    stores.splice(stores.indexOf(first), 1);
    const second = await open();
    assert.deepEqual(await second.clientsStore.getClient(client.client_id), client);
    assert.equal((await provider(second).verifyAccessToken('access')).clientId, client.client_id);
    const other = await open('https://production.example.test/mcp');
    assert.equal(await other.tokens.getAccess('access'), undefined);
    assert.equal(await other.clientsStore.getClient(client.client_id), undefined);
    const third = await open();
    const results = await Promise.allSettled([
      provider(second).exchangeRefreshToken(client, 'refresh'),
      provider(third).exchangeRefreshToken(client, 'refresh'),
    ]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter(r => r.status === 'rejected').length, 1);
    const issued = results.find(r => r.status === 'fulfilled').value;
    assert.equal(await third.tokens.getRefresh('refresh'), undefined);
    assert.equal((await provider(third).verifyAccessToken(issued.access_token)).clientId, client.client_id);
    await provider(second).revokeToken(client, { token: issued.access_token });
    await assert.rejects(provider(third).verifyAccessToken(issued.access_token));
    // Failed writes roll back consumption of the old refresh token.
    await assert.rejects(second.tokens.rotateRefresh(issued.refresh_token, 'bad', 'bad-refresh', { value: 1n }, data));
    assert.ok(await third.tokens.getRefresh(issued.refresh_token));
    assert.equal(await third.tokens.getAccess('bad'), undefined);
  } finally {
    await Promise.all(stores.map(store => store.close()));
  }
});
