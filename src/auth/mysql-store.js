import { createHash } from 'node:crypto';
import mysql from 'mysql2/promise';
import { InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

const hash = value => createHash('sha256').update(value).digest('hex');

// Preview and production share GoDaddy's database. Bind every row to its MCP URL.
export async function createMysqlAuthStore(env, resourceUrl) {
  for (const name of ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']) {
    if (!env[name]) throw new Error(`${name} is required for MySQL auth storage`);
  }
  const port = Number(env.DB_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('DB_PORT must be an integer between 1 and 65535');
  }
  const pool = mysql.createPool({
    host: env.DB_HOST, port, database: env.DB_NAME,
    user: env.DB_USER, password: env.DB_PASSWORD,
    connectionLimit: 4, connectTimeout: 10000,
  });
  const namespace = hash(resourceUrl);
  try {
    await pool.execute(`CREATE TABLE IF NOT EXISTS mph_oauth_v1 (
      namespace CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      kind VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      payload LONGTEXT NOT NULL,
      PRIMARY KEY (namespace, kind, id)
    ) ENGINE=InnoDB`);
  } catch {
    await pool.end();
    // Never include database credentials or connection details in server logs.
    throw new Error('Could not initialize MySQL auth storage; check hosted database settings');
  }
  async function get(kind, id) {
    const [rows] = await pool.execute(
      'SELECT payload FROM mph_oauth_v1 WHERE namespace = ? AND kind = ? AND id = ?',
      [namespace, kind, hash(id)]);
    return rows.length ? JSON.parse(rows[0].payload) : undefined;
  }
  async function put(kind, id, data, connection = pool) {
    await connection.execute(
      `INSERT INTO mph_oauth_v1 (namespace, kind, id, payload) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE payload = ?`,
      [namespace, kind, hash(id), JSON.stringify(data), JSON.stringify(data)]);
  }
  async function remove(kind, id, connection = pool) {
    const [result] = await connection.execute(
      'DELETE FROM mph_oauth_v1 WHERE namespace = ? AND kind = ? AND id = ?',
      [namespace, kind, hash(id)]);
    return result.affectedRows;
  }
  return {
    clientsStore: {
      getClient: id => get('client', id),
      async registerClient(client) {
        await put('client', client.client_id, client);
        return structuredClone(client);
      },
    },
    tokens: {
      saveAccess: (token, data) => put('access', token, data),
      saveRefresh: (token, data) => put('refresh', token, data),
      getAccess: token => get('access', token),
      getRefresh: token => get('refresh', token),
      deleteAccess: token => remove('access', token),
      deleteRefresh: token => remove('refresh', token),
      async rotateRefresh(oldRefresh, newAccess, newRefresh, accessData, refreshData) {
        const connection = await pool.getConnection();
        try {
          await connection.beginTransaction();
          // Atomic consumption also prevents two instances redeeming the same token.
          if (!await remove('refresh', oldRefresh, connection)) {
            throw new InvalidGrantError('Refresh token has already been used or revoked');
          }
          await put('access', newAccess, accessData, connection);
          await put('refresh', newRefresh, refreshData, connection);
          await connection.commit();
        } catch (error) {
          await connection.rollback();
          throw error;
        } finally {
          connection.release();
        }
      },
    },
    close: () => pool.end(),
  };
}
