# Banco local del servidor MCP

Prueba el binario real (`dist/cli.js`) con un cliente MCP real contra una 1Platform API
levantada en local, sin tocar QA ni producción. No entra al paquete (`files` sólo publica
`dist/`).

## Qué hace falta levantado

| Pieza | Cómo | Puerto (slot 3) |
|---|---|---|
| Mongo propio | `docker run -d --rm --name mongo-e2e-<slug> -p 27103:27017 --ulimit nofile=64000:64000 --tmpfs /data/db mongo:7` | 27103 |
| API del Core | worktree de `1platform-api` en `origin/main`, venv propio (Python 3.13, `requirements.txt`), `uvicorn app.main:app --port 8310` con un `env.sh` privado (`MONGODB_URL`, `MONGODB_DB_NAME` con `e2e`, `JWT_SECRET_KEY`, `ENCRYPTION_KEY`, …) | 8310 |
| Portal | build de `1platform-api-developer` servido por su nginx de producción (`deploy/docker/nginx.conf` montado en `nginx:1.27-alpine`) | 3301 |

El nginx del portal sólo atiende `developer.1platform.pro`. El preload `bench-fetch.mjs`
resuelve ese nombre a 127.0.0.1, por eso necesita un paquete `undici`
(`BENCH_UNDICI=<ruta>`). No es una dependencia del proyecto.

## Correr

```bash
BENCH_UNDICI=<ruta a undici> e2e/run-bench.sh <dir-del-banco> <worktree-api> 8310 3301 <salida>
```

`run-bench.sh` siembra con `seed_bench.py` (cuentas `a`, `b`, `r`; etiqueta `E2E-IPA-1`)
y corre `probe.mjs`, que asierta IPA-04 CA-1…CA-9 mirando tres cosas: la respuesta de la
tool, la bitácora de red del preload y la base del banco (`mongo_check.py`).

El paquete no deja cambiar la URL del API (D-8). El preload redirige los orígenes reales
(`api-qa`, `developer`) al banco y bloquea cualquier otro origen. Así la bitácora también
prueba que, sin `ONEPLATFORM_ENV`, todo pedido sale hacia QA (CA-3).

El tope de canjes del API es de un minuto: entre dos corridas seguidas hay que esperar
60 s, o el primer canje da 429.
