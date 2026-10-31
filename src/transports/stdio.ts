import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';

import {TokenBroker} from '../auth/token-cache.js';
import {API_BASES, credentialsFrom, DEFAULT_DOCS_BASE, parseEnv} from '../config.js';
import {logLine} from '../log.js';
import {createServer} from '../server.js';
import {Docs} from '../tools/docs.js';

/** Local package: keys from the environment, QA unless ONEPLATFORM_ENV=prod. */
export async function runStdio(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const target = parseEnv(env.ONEPLATFORM_ENV);
  const apiBase = API_BASES[target];
  const broker = new TokenBroker({apiBase, fetch});
  const docs = new Docs({docsBase: env.ONEPLATFORM_DOCS_URL || DEFAULT_DOCS_BASE, fetch});
  const server = createServer({credentials: credentialsFrom(env.ONEPLATFORM_APP_KEY, env.ONEPLATFORM_USER_KEY), apiBase, fetch, broker, docs, log: logLine});
  await server.connect(new StdioServerTransport());
}
