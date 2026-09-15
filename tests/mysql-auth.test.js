import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createMysqlAuthStore } from '../src/auth/mysql-store.js';
import { McpOAuthProvider } from '../src/auth/provider.js';

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
