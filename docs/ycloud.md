# Proveedor YCloud (alternativa a Meta Business Manager)

wacrm hablaba solo con la API de WhatsApp de Meta, que exige una app y un
WABA aprobados en Meta Business Manager. Esta integración añade **YCloud**
(un BSP oficial de WhatsApp) como segundo proveedor: basta con una API key
de YCloud, sin pasar por Business Manager.

## Qué incluye (v1)

- Conectar una cuenta vía YCloud desde Configuración → WhatsApp (selector
  Meta / YCloud).
- Recibir mensajes entrantes (texto, imagen, video, documento, audio,
  ubicación) → se crean/actualizan contacto, conversación y mensaje igual
  que con Meta.
- Recibir actualizaciones de estado (sent/delivered/read/failed) sobre
  mensajes salientes.
- Enviar mensajes de **texto y multimedia** desde el inbox (composer del
  dashboard), desde la API pública `/api/v1/messages`, y desde el paso
  "send_message"/"send_media" de Automations y Flows.

## Qué NO incluye todavía (limitación conocida, no un bug)

- **Plantillas (templates)** — Meta-only. Un envío de plantilla sobre una
  cuenta YCloud responde con un error claro (`provider_unsupported`) en
  vez de fallar en silencio.
- **Mensajes interactivos** (botones / listas) — Meta-only, mismo error
  claro. Los pasos de Flow que envían botones/listas fallan con un
  mensaje explícito si la cuenta está en YCloud.
- **Broadcasts, reacciones, sync de plantillas, proxy de media de Meta** —
  siguen siendo rutas Meta-only sin tocar; no se probaron ni adaptaron
  para YCloud en esta pasada.
- **Automations / Flows / respuesta con IA no se disparan** sobre mensajes
  entrantes de YCloud a propósito — el chatbot de Instituto ALONE
  ("Angela") ya corre en n8n; activar también los motores propios de
  wacrm haría que dos bots compitieran por responder el mismo mensaje.
  El CRM vía YCloud queda como bandeja + historial + envío manual/API,
  no como bot. Si más adelante se quiere que wacrm mismo automatice,
  hay que decidir conscientemente cuál de los dos sistemas (n8n o wacrm)
  es dueño de las respuestas automáticas.

## Cosas a verificar contra un webhook real de YCloud

El código de ingesta se escribió a partir de:
1. La forma confirmada de `whatsapp.message.updated` (tomada de un
   workflow de n8n ya en producción para otro número:
   `{ type, whatsappMessage: { id, status, to, from, text, image, ... } }`).
2. La documentación pública de YCloud para el resto (envío, listado de
   números, nombre de evento de mensaje entrante).

**No se probó contra una API key ni un webhook reales.** Antes de dar por
buena la integración:

- Guarda una configuración YCloud y dispara un mensaje de prueba real al
  número conectado.
- Revisa los logs del contenedor en Easypanel tras el primer webhook
  entrante — si el evento no trae `whatsappMessage` ni
  `whatsappInboundMessage`, `src/app/api/whatsapp/ycloud-webhook/route.ts`
  loguea las claves de nivel superior del body (`console.warn`) para
  poder ajustar el nombre del campo en un minuto.
- Si YCloud manda una firma HMAC en el webhook (revisar sus headers),
  vale la pena añadirla como capa extra sobre el secreto `?key=` actual.

## Esquema (migración `037_ycloud_provider.sql`)

`whatsapp_config` gana:
- `provider` (`'meta'` default | `'ycloud'`)
- `ycloud_api_key`, `ycloud_whatsapp_number`, `ycloud_webhook_secret`
  (los tres cifrados igual que `access_token`)

`phone_number_id` y `access_token` pasan a ser nullable — solo son
obligatorios cuando `provider = 'meta'` (constraint
`whatsapp_config_provider_fields_check`). Una cuenta solo puede estar
conectada a un proveedor a la vez (una fila por `account_id`, como antes).

## Aplicar la migración

Desde el SQL editor de Supabase Studio (self-hosted), pega y ejecuta el
contenido de `supabase/migrations/037_ycloud_provider.sql`. Es idempotente
— se puede volver a correr sin problema.
