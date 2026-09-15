# Meeting Prep Helper on GoDaddy

This fork preserves JW-MCP's tools and OAuth login. GoDaddy installs the locked
dependencies, runs `npm run build`, then runs `npm start`.

## Configuration

Enter these in GoDaddy's app settings, never in this repository:

| Name | Value |
| --- | --- |
| `MCP_TRANSPORT` | `http` |
| `MCP_AUTH` | `true` |
| `MCP_AUTH_SECRET` | A unique, strong access key of at least 16 characters, chosen and saved by the owner |
| `MCP_BASE_URL` | The actual HTTPS origin assigned to this app, without `/mcp` |
| `AUTH_STORE_PATH` | An absolute private persistent file path, once GoDaddy storage has been verified |

GoDaddy supplies `PORT`; do not set it or `MCP_PORT` yourself. `PORT` takes
precedence over `MCP_PORT`. The latter still works for the original Docker setup.
The default local transport remains stdio.

Do not set `MCP_TRUST_PROXY` unless GoDaddy's proxy is confirmed to overwrite
`X-Forwarded-For`. Do not disable authentication to get a deployment working.

## Before publishing

1. Confirm the app uses the existing Economy plan's included published-app slot.
2. Confirm the final HTTPS origin and use it for `MCP_BASE_URL`.
3. Verify a **private** persistent location for the OAuth token file. GoDaddy's
   generic documentation mentions `/public/assets/` for persistent files; do not
   put plaintext login tokens there. A private storage location or a separate
   secure storage integration needs verification before relying on reconnects.
   With no store path, login tokens are in memory and restarts require reconnecting.
4. In preview, verify `/health`, OAuth discovery and a complete authenticated MCP
   handshake. A GoDaddy login-protected preview cannot be connected directly to
   ChatGPT as a public server.
5. Obtain the owner's approval to publish. Test a real lookup from ChatGPT at
   `https://<actual-host>/mcp`, then test reconnecting after a restart.

## Updates

This fork does not automatically receive the original developer's changes yet.
The intended update flow is to bring upstream changes into a review branch,
run tests, review conflicts, and approve the update before publishing it.
Do not point an automatic production deployment at unreviewed upstream commits.

## Local checks

Use Node.js 22 or a compatible newer version:

```sh
npm ci --ignore-scripts
npm run build
npm test
npm audit --omit=dev
```

The startup tests verify that the hosting port is honored, malformed port values
fail clearly, the health endpoint responds, and unauthenticated MCP access stays
blocked. The original tests cover OAuth and persistent token storage locally;
they do not establish GoDaddy's storage behavior.
