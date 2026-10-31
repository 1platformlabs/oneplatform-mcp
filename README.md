# Servidor MCP de 1Platform

Conecta un agente de código a la documentación de 1Platform y a la 1Platform API con sus propias claves, en
**QA por defecto**.

## Herramientas

| Grupo | Herramientas | Claves |
|---|---|---|
| Documentación | `docs_search`, `docs_get_page`, `api_get_operation` | No |
| Lectura | perfil, historial de saldo, consumo, comercios, links de pago, transacciones, facturas, envíos, sitios y avisos | Sí |
| Escritura sin dinero | `createPaymentLink` (sin `customer_email`) y `cancelPaymentLink` | Sí |

La lista exacta está en [`tools.manifest.json`](tools.manifest.json) y lo que nunca puede exponerse, en
[`denylist.json`](denylist.json): administración, credenciales, webhooks y toda operación que cobre saldo, emita
documentos fiscales o mueva dinero.

## Uso local (stdio)

```bash
ONEPLATFORM_APP_KEY=ak-XXXX… ONEPLATFORM_USER_KEY=sk-XXXX… npx -y @oneplatformlabs/mcp
```

| Variable | Valor |
|---|---|
| `ONEPLATFORM_APP_KEY` | Clave de aplicación (`ak-…`). Opcional: sin claves sólo están las herramientas de documentación |
| `ONEPLATFORM_USER_KEY` | Clave de usuario (`sk-…`) |
| `ONEPLATFORM_ENV` | `qa` (por defecto) o `prod` |

Instalación por cliente: https://developer.1platform.pro/docs/saas/1platform-api/integrar-con-ia

## Uso alojado (HTTP)

`node dist/cli.js --http` sirve Streamable HTTP sin estado en `POST /mcp` y `GET /healthz`. Las claves llegan en
`X-1Platform-App-Key` y `X-1Platform-User-Key` en cada solicitud; el entorno lo fija `ONEPLATFORM_ENV` al arrancar.
Límites: 30 solicitudes por minuto por IP, 120 por par de claves y 256 KiB por cuerpo.

> El despliegue alojado (contenedor junto al API, IP del cliente hacia el API) está pendiente de medir la cadena de
> proxies en el host real. Hasta entonces el transporte HTTP no escribe `X-Forwarded-For` y no debe exponerse.

## Comportamiento

- Canjea las claves por los dos tokens una vez y los reutiliza hasta dos minutos antes de vencer; un canje fallido se
  recuerda 60 s.
- Ante un `401` vuelve a canjear el token de usuario y, si sigue, el de aplicación (como mucho una vez por minuto). Un
  `429` no se reintenta.
- Devuelve el cuerpo y el código de estado del API tal cual, marcados como datos no confiables, recortados a 100 KiB.
  Quita `bank_authorization` de las transacciones y el token de los sitios.
- Los parámetros de ruta se validan contra un patrón fijo: `..`, `/` o `%` se rechazan sin llamar a la red.
- Ninguna clave ni token aparece en los registros.

## Desarrollo

```bash
npm ci
npm run fetch-openapi   # copia del OpenAPI público (no se versiona)
npm run build-tools     # regenera src/generated/tools.ts desde el manifiesto
npm test
npm run build
```

Publicar en npm lo decide el dueño del paquete: ningún flujo de CI publica.
