#!/usr/bin/env node
import {createServer as createHttpServer} from 'node:http';

import {DEFAULT_DOCS_BASE, parseEnv} from './config.js';
import {logLine} from './log.js';
import {Docs} from './tools/docs.js';
import {createHttpHandler} from './transports/http.js';
import {runStdio} from './transports/stdio.js';

if (process.argv.includes('--http')) {
  const env = parseEnv(process.env.ONEPLATFORM_ENV);
  const docs = new Docs({docsBase: process.env.ONEPLATFORM_DOCS_URL || DEFAULT_DOCS_BASE, fetch});
  const handler = createHttpHandler({env, fetch, docs, log: logLine});
  const port = Number(process.env.PORT || 3000);
  createHttpServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, {'content-type': 'application/json'});
      res.end(JSON.stringify({jsonrpc: '2.0', error: {code: -32603, message: 'Internal error'}, id: null}));
    });
  }).listen(port, () => logLine({event: 'listening', port, env}));
} else {
  runStdio().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
