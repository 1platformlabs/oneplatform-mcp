# Servidor MCP de OnePlatform

Conecta un agente de código a la documentación de OnePlatform y a la OnePlatform API con sus propias claves, en
**QA por defecto**.

## Herramientas

Tres herramientas de documentación funcionan sin claves: `docs_search`, `docs_get_page` y `api_get_operation`. Con
claves, el servidor suma las de la API, agrupadas por vertical (*toolset*):

| Toolset | Qué puede hacer el agente |
|---|---|
| `cuenta` | Perfil, historial de saldo, consumo, comercios y avisos. Siempre activo: de acá sale el `businessId` |
| `pagos` | Links de pago (listar, ver, **crear** y **cancelar**) y transacciones |
| `retiros` | Saldo retirable, movimientos, retiros y cobros que pueden pasar al saldo retirable (sólo lectura) |
| `suscripciones` | Planes, suscripciones y clientes del comercio |
| `terminal` | Solicitudes de terminal de tarjetas y su estado |
| `facturacion` | Facturas electrónicas (sólo lectura: el MCP no emite ni anula) |
| `envios` | Envíos (sólo lectura: el MCP no despacha) |
| `sitios` | Sitios, artículos, trabajos de generación, categorías y rendimiento en buscadores |
| `analitica` | Estado y métricas de analítica, ingresos y alertas de anuncios, mapas de calor |
| `correo` | Remitentes, plantillas, cuota y mensajes del correo transaccional; conversaciones del correo del negocio |
| `dominios` | Dominios, disponibilidad, precios, transferencias y registros de correo (sólo lectura) |
| `telemetria` | Proyectos, errores, último evento, logs, rendimiento y uso; **marcar un error** como resuelto o ignorado |
| `ventas` | Preparación, canales, ofertas, prospectos, tablero y reporte del embudo |
| `agentes` | Agentes, catálogo, herramientas, presupuesto, ejecuciones y acciones pendientes; **detener** una ejecución |

Por defecto se listan todos. Para un cliente que admite pocas herramientas, elija las verticales que usa:
`ONEPLATFORM_TOOLSETS=pagos,envios` (local) o la cabecera `X-OnePlatform-Toolsets: pagos,envios` (alojado).

Las escrituras (en negrita) no cobran saldo, no emiten documentos fiscales, no mueven dinero ni envían mensajes a
terceros, y el cliente pide confirmación antes de ejecutarlas. La lista exacta está en
[`tools.manifest.json`](tools.manifest.json) y lo que nunca puede exponerse, en [`denylist.json`](denylist.json):
administración, credenciales, webhooks, cobros, emisión fiscal y movimientos de dinero. En retiros y dominios sólo se
permiten lecturas.

## Uso local (stdio)

```bash
ONEPLATFORM_APP_KEY=ak-XXXX… ONEPLATFORM_USER_KEY=sk-XXXX… npx -y @oneplatformlabs/mcp
```

| Variable | Valor |
|---|---|
| `ONEPLATFORM_APP_KEY` | Clave de aplicación (`ak-…`). Opcional: sin claves sólo están las herramientas de documentación |
| `ONEPLATFORM_USER_KEY` | Clave de usuario (`sk-…`) |
| `ONEPLATFORM_ENV` | `qa` (por defecto) o `prod` |
| `ONEPLATFORM_TOOLSETS` | Opcional: verticales a listar, separadas por comas (por defecto, todas) |

Instalación por cliente: https://developer.1platform.pro/docs/saas/1platform-api/integrar-con-ia

## Uso alojado (HTTP)

`node dist/cli.js --http` sirve Streamable HTTP sin estado en `POST /mcp` y `GET /healthz`. Las claves llegan en
`X-OnePlatform-App-Key` y `X-OnePlatform-User-Key` en cada solicitud; el entorno lo fija `ONEPLATFORM_ENV` al arrancar.
Límites: 30 solicitudes por minuto por IP, 120 por par de claves y 256 KiB por cuerpo.

| URL | API |
|---|---|
| `https://mcp-qa.1platform.pro/mcp` | QA |
| `https://mcp.1platform.pro/mcp` | Producción |

El entorno lo decide la URL; ninguna cabecera o parámetro lo cambia.

```bash
claude mcp add --transport http oneplatform https://mcp-qa.1platform.pro/mcp \
  --header "X-OnePlatform-App-Key: $ONEPLATFORM_APP_KEY" \
  --header "X-OnePlatform-User-Key: $ONEPLATFORM_USER_KEY"
```

### Despliegue

| Variable | Valor |
|---|---|
| `ONEPLATFORM_API_URL` | URL interna del API del mismo entorno (`http(s)://host[:puerto]/api/v1`). Sin ella, la pública |
| `MCP_TRUSTED_PROXY_CIDRS` | Saltos públicos de confianza además de los privados (`["185.125.168.236/32"]`). Una entrada inválida o más amplia que /16 (IPv4) o /32 (IPv6) detiene el proceso |

La IP del cliente se resuelve detrás de Cloudflare y del front door con un port del resolver del API
([`src/http/client-address.ts`](src/http/client-address.ts), vectores compartidos en
[`test/vectors/client-address.json`](test/vectors/client-address.json)). Esa IP limita al cliente en el MCP y viaja
al API como única entrada de `X-Forwarded-For`, escrita de nuevo y nunca copiada de la solicitud: el contenedor
llama al API por la red privada de Docker, así que el API cuenta un balde por cliente.

`deploy/compose.{qa,prod}.yml` y [`deploy/remote-deploy.sh`](deploy/remote-deploy.sh) (comando forzado de la llave
de despliegue: `<qa|prod> <sha de main>` o `<qa|prod> rollback`); el workflow `Deploy hosted MCP` despliega QA y
luego producción en cada push a `main` cuando la variable `MCP_DEPLOY_ENABLED` vale `true`.
