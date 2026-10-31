/**
 * Preload del banco local (`node --import ./e2e/bench-fetch.mjs dist/cli.js`).
 *
 * El paquete NO tiene perilla para cambiar la URL del API (D-8: QA o prod, y
 * nada más). Para ejercer el binario real contra el banco, este preload
 * redirige los orígenes REALES a los puertos locales, resuelve sus nombres a
 * 127.0.0.1 y deja bitácora de cada pedido: así el banco también prueba a qué
 * origen apunta el paquete sin configuración (CA-3). Un origen fuera del mapa
 * se bloquea: nada sale a la red real.
 *
 *   BENCH_FETCH_MAP='{"https://api-qa.1platform.pro":"http://127.0.0.1:8310",
 *                     "https://developer.1platform.pro":"http://developer.1platform.pro:3301"}'
 *   BENCH_FETCH_LOG=/ruta/requests.jsonl
 */
import {appendFileSync} from 'node:fs';
import {createRequire} from 'node:module';

// El Host tiene que ser el real (el nginx del portal descarta cualquier otro con
// 444) y `fetch` no deja fijarlo: se resuelve el NOMBRE real a 127.0.0.1 con un
// dispatcher propio. `BENCH_UNDICI` = ruta a un paquete undici (no es dependencia).
const {Agent} = createRequire(import.meta.url)(process.env.BENCH_UNDICI);
const dispatcher = new Agent({connect: {lookup: (_host, opts, cb) => (opts?.all ? cb(null, [{address: '127.0.0.1', family: 4}]) : cb(null, '127.0.0.1', 4))}});

const map = JSON.parse(process.env.BENCH_FETCH_MAP ?? '{}');
const logFile = process.env.BENCH_FETCH_LOG;
const realFetch = globalThis.fetch;

globalThis.fetch = async (input, init = {}) => {
  const original = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  const target = map[original.origin];
  if (logFile) appendFileSync(logFile, `${JSON.stringify({origin: original.origin, path: original.pathname, search: original.search, method: init.method ?? 'GET', mapped: Boolean(target)})}\n`);
  if (!target) throw new TypeError(`bench: origen fuera del banco bloqueado (${original.origin})`);
  const local = new URL(original.pathname + original.search, target);
  return realFetch(local, {...init, dispatcher});
};
