#!/usr/bin/env node
import {createServer as createHttpServer} from 'node:http';

import {apiBaseFromEnv, DEFAULT_DOCS_BASE, parseEnv} from './config.js';
import {buildHops, trustedCidrsFromEnv} from './http/client-address.js';
import {logLine} from './log.js';
import {Docs} from './tools/docs.js';
import {createHttpHandler} from './transports/http.js';
import {runStdio} from './transports/stdio.js';

if (process.argv.includes('--http')) {
  const env = parseEnv(process.env.ONEPLATFORM_ENV);
  const docs = new Docs({docsBase: process.env.ONEPLATFORM_DOCS_URL || DEFAULT_DOCS_BASE, fetch});
  // Both read once at startup; an invalid value stops the process (T-26).
  const trusted = trustedCidrsFromEnv(process.env.MCP_TRUSTED_PROXY_CIDRS);
  const hops = buildHops(trusted);
  const apiBase = apiBaseFromEnv(env, process.env.ONEPLATFORM_API_URL);
  const handler = createHttpHandler({env, fetch, docs, log: logLine, hops, apiBase});
  const port = Number(process.env.PORT || 3000);
  createHttpServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, {'content-type': 'application/json'});
      res.end(JSON.stringify({jsonrpc: '2.0', error: {code: -32603, message: 'Internal error'}, id: null}));
    });
  }).listen(port, () => logLine({event: 'listening', port, env, trusted_proxies: trusted.length, internal_api: apiBase !== undefined}));
} else {
  runStdio().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
