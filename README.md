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
| `retiros` | Saldo retirable, movimientos, retiros, métodos de retiro (enmascarados) y cobros que pueden pasar al saldo retirable (sólo lectura) |
| `suscripciones` | Planes, suscripciones y clientes del comercio; **crear, editar, publicar y archivar** planes, **crear y editar** clientes, **emitir** una invitación y **cancelar** una suscripción |
| `terminal` | Solicitudes de terminal de tarjetas, su estado y el detalle de un pago con terminal; **crear, corregir y retirar** una solicitud (el envío y los documentos siguen en el panel) |
| `facturacion` | Facturas electrónicas (sólo lectura: el MCP no emite ni anula) |
| `envios` | Envíos (sólo lectura: el MCP no despacha) |
| `sitios` | Sitios, artículos, trabajos de generación, categorías y rendimiento en buscadores |
| `analitica` | Estado, propiedad, flujos, dimensiones, eventos clave, etiqueta y métricas de analítica; estado, cuentas, ingresos, alertas y problemas de políticas de anuncios; sitios, mapas e instantáneas de mapas de calor (sólo lectura) |
| `correo` | Remitentes, plantillas, cuota y mensajes del correo transaccional; conversaciones del correo del negocio |
| `dominios` | Dominios, disponibilidad, precios, transferencias y registros de correo (sólo lectura) |
| `telemetria` | Proyectos, errores, último evento, logs, rendimiento y uso; **marcar un error** como resuelto o ignorado |
| `ventas` | Preparación, canales, ofertas, prospectos, tablero y reporte del embudo |
| `agentes` | Agentes, catálogo, herramientas, presupuesto, ejecuciones y acciones pendientes; **detener** una ejecución |
| `agenda` | Calendario, visitas, horarios libres, asesores y enlaces de reserva; **agendar, mover, reasignar, completar y cancelar** una visita; **obtener** el enlace de reserva de un registro o el propio de una oferta (sin revocar el vigente) |
| `redes` | Configuración, portafolios, cuentas conectadas, publicaciones, calendario, comentarios, analítica y aprobaciones; **crear y editar** un borrador, **programar** (o mandar a aprobación), **mover** y **cancelar** una publicación |
| `tareas` | Tareas, subtareas, bandeja de subtareas disponibles y archivos; **crear, editar y asignar** tareas, **crear** subtareas y **tomar o completar** una subtarea |
| `estudio` | Catálogo de plantillas, pedidos, piezas entregadas y sus enlaces, deudas y presentadores del estudio creativo (sólo lectura) |

Por defecto se listan todos. Para un cliente que admite pocas herramientas, elija las verticales que usa:
`ONEPLATFORM_TOOLSETS=pagos,envios` (local) o la cabecera `X-OnePlatform-Toolsets: pagos,envios` (alojado).

Las escrituras (en negrita) no cobran saldo en el acto, no emiten documentos fiscales ni mueven dinero, y el cliente
pide confirmación antes de ejecutarlas. Dos excepciones conocidas, iguales a las del panel: agendar, mover o cancelar
una visita dispara los avisos de la agenda a la persona y al asesor, y programar una publicación la deja en cola para
salir en la red en la fecha elegida, cuando se cobra (cancelarla antes no cobra nada). Publicar ya, aprobar, responder
comentarios, encargar piezas del estudio y pagar quedan fuera del MCP. En `redes` las herramientas trabajan sobre el portafolio
propio de la persona: el MCP no reenvía la cabecera para actuar en un portafolio ajeno. La lista exacta está en
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

Esa red es `mcp-net-{qa,prod}`: la crea el compose del Core con subred explícita y sólo el API y este
contenedor están en ella (hasta #6 el MCP compartía la red del motor de telemetría). Por eso el Core se
despliega antes: sin la red, el `up` falla y el deploy vuelve a la imagen anterior. Una rama vieja del Core
en QA saca al API de la red hasta que traiga `main`.

`deploy/compose.{qa,prod}.yml` y [`deploy/remote-deploy.sh`](deploy/remote-deploy.sh) (comando forzado de la llave
de despliegue: `<qa|prod> <sha de main>` o `<qa|prod> rollback`); el workflow `Deploy hosted MCP` despliega QA y
luego producción en cada push a `main` cuando la variable `MCP_DEPLOY_ENABLED` vale `true`.

## Vigencia de la documentación

Las herramientas de documentación leen `llms.txt`, los Markdown y el OpenAPI publicados por el portal,
con caché de diez minutos. El portal debe publicar su contrato actualizado para que `api_get_operation`
lo entregue; instalar de nuevo el paquete MCP no corrige una especificación atrasada en el portal.

`npm run check:docs-freshness` compara rutas, operaciones, esquemas y autenticación del portal con la API viva.
Falla ante diferencias o errores de descarga, sin respaldo silencioso; cada descarga tiene 120 s y un
solo reintento ante error de red o tiempo agotado (no ante HTTP de error). Ignora prosa y ejemplos saneados;
no sustituye la revisión editorial. Se ejecuta cada dos horas mediante un workflow de sólo lectura.
Para verificar un portal candidato, configure `ONEPLATFORM_DOCS_OPENAPI_URL` con su OpenAPI; para un
banco local también puede configurar `ONEP_API_OPENAPI_URL`. No se imprimen esas URLs.

La generación de herramientas (`fetch-openapi` y `check:tools`) usa directamente el OpenAPI público de la API.
Así, una copia atrasada en el portal no puede ocultar cambios de las herramientas ejecutables. La allowlist,
los toolsets y los límites de escritura siguen en `tools.manifest.json` y `denylist.json`.
