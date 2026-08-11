import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { timingSafeEqual } from 'crypto'
import { decrypt } from '@/lib/whatsapp/encryption'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'

/**
 * YCloud inbound webhook — the YCloud analogue of
 * src/app/api/whatsapp/webhook/route.ts (Meta), for accounts connected
 * via `whatsapp_config.provider = 'ycloud'` instead of Meta Business
 * Manager.
 *
 * ── Payload shape ──────────────────────────────────────────────────
 * Confirmed from a live YCloud `whatsapp.message.updated` delivery
 * (the n8n workflow "YCloud - Webhook confirmación de entrega" this
 * account already runs for another number):
 *
 *   { "type": "whatsapp.message.updated", "whatsappMessage": {
 *       "id": "<wamid>", "status": "sent"|"delivered"|"read"|"failed",
 *       "to": "<E.164, no +>", "from": "<E.164, no +>",
 *       "text": { "body": "..." }, "image": {...}, "video": {...},
 *       "document": {...}, "audio": {...}, "template": {...},
 *       "createTime": "<ISO>",
 *       "errorMessage": "...", "whatsappApiError": { "message": "..." }
 *   } }
 *
 * The inbound-message event's exact `type` string and whether it
 * nests under `whatsappMessage` or `whatsappInboundMessage` is NOT
 * independently confirmed (only the status-update shape has been
 * observed live) — this handler tries both field names and logs the
 * raw body's top-level keys when neither is present, so the first
 * real inbound delivery in production logs surfaces the real shape
 * for a quick fix. See docs/ycloud.md before going live.
 *
 * ── Auth ───────────────────────────────────────────────────────────
 * YCloud's webhook has no confirmed Meta-style HMAC signature, so
 * this route is protected by a random per-account secret passed as
 * `?key=` on the URL (generated + shown to the user when they save a
 * YCloud config — see api/whatsapp/config/route.ts).
 *
 * ── Scope (v1) ─────────────────────────────────────────────────────
 * Ingests contacts / conversations / messages / delivery statuses.
 * Deliberately does NOT run wacrm's own Automations / Flows / AI
 * auto-reply engines against YCloud inbound — those exist to let
 * wacrm itself act as the chatbot, and Instituto ALONE's bot ("Angela")
 * already runs in n8n. Wiring both up would race two bots against the
 * same inbound message. `message.received` / `conversation.created`
 * ARE still dispatched to the account's public-API webhook endpoints
 * (if any are configured), matching the Meta webhook's behavior.
 */

export const maxDuration = 60

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

interface YCloudWhatsAppMessage {
  id: string
  status?: string
  to?: string
  from?: string
  createTime?: string
  text?: { body?: string }
  image?: { link?: string; url?: string; caption?: string }
  video?: { link?: string; url?: string; caption?: string }
  document?: { link?: string; url?: string; caption?: string; filename?: string }
  audio?: { link?: string; url?: string }
  location?: { latitude?: number; longitude?: number; name?: string; address?: string }
  template?: { name?: string }
  errorMessage?: string
  whatsappApiError?: { message?: string }
  customerProfile?: { name?: string }
  profileName?: string
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

export async function POST(request: Request) {
  const { searchParams } = new URL(request.url)
  const key = searchParams.get('key') || ''

  if (!key) {
    return NextResponse.json({ error: 'Missing ?key=' }, { status: 401 })
  }

  // Small, bounded set — one row per account connected via YCloud.
  // Decrypt-and-compare rather than a plaintext column lookup, so the
  // secret is protected at rest the same way access_token/verify_token
  // already are in this table.
  const { data: candidates, error: candidatesError } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('*')
    .eq('provider', 'ycloud')

  if (candidatesError) {
    console.error('[ycloud-webhook] failed to load ycloud configs:', candidatesError)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let config: any = null
  for (const candidate of candidates ?? []) {
    if (!candidate.ycloud_webhook_secret) continue
    try {
      if (safeEqual(decrypt(candidate.ycloud_webhook_secret), key)) {
        config = candidate
        break
      }
    } catch {
      // Malformed/undecryptable row — skip it and keep checking.
    }
  }

  if (!config) {
    console.warn('[ycloud-webhook] rejected request with unknown/invalid key')
    return NextResponse.json({ error: 'Invalid key' }, { status: 401 })
  }

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Same reasoning as the Meta webhook: ack fast, do the DB work in
  // `after()` so it's guaranteed to run to completion even if the
  // platform freezes the function right after the response is sent.
  after(async () => {
    try {
      await processYCloudEvent(body, config)
    } catch (error) {
      console.error('[ycloud-webhook] error processing event:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

async function processYCloudEvent(
  body: Record<string, unknown>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: any
) {
  const eventType = typeof body.type === 'string' ? body.type : ''
  const wm = (body.whatsappInboundMessage ?? body.whatsappMessage) as
    | YCloudWhatsAppMessage
    | undefined

  if (!wm) {
    console.warn(
      '[ycloud-webhook] event had no whatsappMessage/whatsappInboundMessage field. type=',
      eventType,
      'top-level keys=',
      Object.keys(body)
    )
    return
  }

  if (eventType === 'whatsapp.message.updated') {
    await handleStatusUpdate(wm, config)
    return
  }

  // Anything else with a `from` we don't already recognize as an
  // update is treated as an inbound customer message. YCloud's exact
  // inbound event-type string isn't confirmed yet (see file header) —
  // this is deliberately permissive rather than an exact string match
  // so a real inbound delivery isn't silently dropped over a naming
  // guess. Tighten to an exact `eventType === 'whatsapp.inbound_message.received'`
  // check once confirmed against a live payload.
  if (wm.from) {
    await processInboundMessage(wm, config)
    return
  }

  console.warn('[ycloud-webhook] unrecognized event, ignoring. type=', eventType)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleStatusUpdate(wm: YCloudWhatsAppMessage, config: any) {
  if (!wm.id || !wm.status) return

  const ALLOWED_STATUSES = new Set(['sending', 'sent', 'delivered', 'read', 'failed'])
  if (!ALLOWED_STATUSES.has(wm.status)) {
    console.warn('[ycloud-webhook] unknown status value, ignoring:', wm.status)
    return
  }

  const db = supabaseAdmin()

  // message_id isn't unique (same reasoning as the Meta webhook — see
  // its migration-009 comment), so this updates 0..N rows. `.select('id')`
  // lets us tell "matched nothing" apart from "matched and updated" below.
  const { data: updatedRows, error } = await db
    .from('messages')
    .update({ status: wm.status })
    .eq('message_id', wm.id)
    .select('id')

  if (error) {
    console.error('[ycloud-webhook] error updating message status:', error)
    return
  }

  if (wm.status === 'failed') {
    const reason = wm.errorMessage || wm.whatsappApiError?.message
    if (reason) console.warn('[ycloud-webhook] message failed:', wm.id, reason)
  }

  // A status update for a message wacrm never inserted means it was
  // sent from outside wacrm — a human agent typing directly in the
  // YCloud dashboard/app, since anything sent through wacrm itself (or
  // through a bot calling the public API) already gets its own row at
  // send time. Register it now so the conversation history in wacrm
  // stays complete.
  if (!updatedRows || updatedRows.length === 0) {
    await recordExternalOutboundMessage(wm, config)
  }
}

/**
 * Insert a message wacrm first learns about via a `whatsapp.message.updated`
 * status event (i.e. it wasn't sent through wacrm or the public API).
 * Always tagged `sender_type: 'agent'` — a human wrote it directly on
 * the WhatsApp/YCloud side.
 */
async function recordExternalOutboundMessage(
  wm: YCloudWhatsAppMessage,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: any
) {
  const db = supabaseAdmin()
  const accountId = config.account_id as string

  const ourNumber = normalizePhone(config.ycloud_whatsapp_number ?? '')
  const from = normalizePhone(wm.from ?? '')
  const customerPhone = from === ourNumber ? wm.to : wm.from
  if (!customerPhone) {
    console.warn('[ycloud-webhook] could not resolve customer phone for external outbound message', wm.id)
    return
  }

  // Requires an existing contact/conversation (created by a prior
  // inbound message). A brand-new contact with no prior conversation
  // shouldn't happen here — nobody messages a customer who has never
  // written in first, on an inbound-only account like this one.
  const contact = await findExistingContact(db, accountId, customerPhone)
  if (!contact) {
    console.warn('[ycloud-webhook] no contact found for external outbound message, skipping', wm.id)
    return
  }

  const { data: existingConvRows, error: findConvError } = await db
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contact.id)
    .order('created_at', { ascending: true })
    .limit(1)

  const conversation = existingConvRows?.[0]
  if (findConvError || !conversation) {
    console.error('[ycloud-webhook] error finding conversation for external outbound message:', findConvError)
    return
  }

  const { contentType, contentText, mediaUrl } = parseContent(wm)

  const { error: msgError } = await db.from('messages').insert({
    conversation_id: conversation.id,
    sender_type: 'agent',
    content_type: contentType,
    content_text: contentText,
    media_url: mediaUrl,
    message_id: wm.id,
    status: wm.status,
    created_at: wm.createTime ? new Date(wm.createTime).toISOString() : new Date().toISOString(),
  })

  if (msgError) {
    console.error('[ycloud-webhook] error inserting external outbound message:', msgError)
    return
  }

  await db
    .from('conversations')
    .update({
      last_message_text: contentText || `[${contentType}]`,
      last_message_at: new Date().toISOString(),
      status: 'open',
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)
}

function parseContent(wm: YCloudWhatsAppMessage): {
  contentType: string
  contentText: string | null
  mediaUrl: string | null
} {
  if (wm.text?.body) return { contentType: 'text', contentText: wm.text.body, mediaUrl: null }
  if (wm.image) {
    return {
      contentType: 'image',
      contentText: wm.image.caption ?? null,
      mediaUrl: wm.image.link ?? wm.image.url ?? null,
    }
  }
  if (wm.video) {
    return {
      contentType: 'video',
      contentText: wm.video.caption ?? null,
      mediaUrl: wm.video.link ?? wm.video.url ?? null,
    }
  }
  if (wm.document) {
    return {
      contentType: 'document',
      contentText: wm.document.caption ?? wm.document.filename ?? null,
      mediaUrl: wm.document.link ?? wm.document.url ?? null,
    }
  }
  if (wm.audio) {
    return { contentType: 'audio', contentText: null, mediaUrl: wm.audio.link ?? wm.audio.url ?? null }
  }
  if (wm.location) {
    const loc = wm.location
    const text = [loc.name, loc.address, loc.latitude && loc.longitude ? `${loc.latitude},${loc.longitude}` : null]
      .filter(Boolean)
      .join(' - ')
    return { contentType: 'location', contentText: text || null, mediaUrl: null }
  }
  if (wm.template) {
    return { contentType: 'template', contentText: `[${wm.template.name ?? 'template'}]`, mediaUrl: null }
  }
  return { contentType: 'text', contentText: '[Unsupported message type]', mediaUrl: null }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function processInboundMessage(wm: YCloudWhatsAppMessage, config: any) {
  const db = supabaseAdmin()
  const accountId = config.account_id as string
  const configOwnerUserId = config.user_id as string

  // Direction-agnostic routing: exactly one of `to`/`from` is our own
  // configured number (see file header) — whichever one matches is
  // discarded as "us"; the other is the customer.
  const ourNumber = normalizePhone(config.ycloud_whatsapp_number ?? '')
  const from = normalizePhone(wm.from ?? '')
  const to = normalizePhone(wm.to ?? '')
  const customerPhone = from === ourNumber ? wm.to : wm.from
  if (!customerPhone) {
    console.warn('[ycloud-webhook] could not resolve customer phone for inbound message', wm.id)
    return
  }
  void to // only used for the resolution above

  const contactName = wm.customerProfile?.name || wm.profileName || undefined

  const existingContact = await findExistingContact(db, accountId, customerPhone)
  let contact = existingContact
  let contactWasCreated = false

  if (contact) {
    if (contactName && contactName !== contact.name) {
      await db.from('contacts').update({ name: contactName, updated_at: new Date().toISOString() }).eq('id', contact.id)
    }
  } else {
    const { data: newContact, error: createError } = await db
      .from('contacts')
      .insert({
        account_id: accountId,
        user_id: configOwnerUserId,
        phone: customerPhone,
        name: contactName || customerPhone,
      })
      .select()
      .single()

    if (createError) {
      if (isUniqueViolation(createError)) {
        contact = await findExistingContact(db, accountId, customerPhone)
      }
      if (!contact) {
        console.error('[ycloud-webhook] error creating contact:', createError)
        return
      }
    } else {
      contact = newContact
      contactWasCreated = true
    }
  }

  if (!contact) return

  const { data: existingConvRows, error: findConvError } = await db
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contact.id)
    .order('created_at', { ascending: true })
    .limit(1)

  if (findConvError) {
    console.error('[ycloud-webhook] error finding conversation:', findConvError)
    return
  }

  let conversation = existingConvRows?.[0] ?? null
  let conversationWasCreated = false

  if (!conversation) {
    const { data: newConv, error: createConvError } = await db
      .from('conversations')
      .insert({ account_id: accountId, user_id: configOwnerUserId, contact_id: contact.id })
      .select()
      .single()

    if (createConvError) {
      console.error('[ycloud-webhook] error creating conversation:', createConvError)
      return
    }
    conversation = newConv
    conversationWasCreated = true
  }

  if (conversationWasCreated) {
    await dispatchWebhookEvent(db, accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contact.id,
    })
  }

  const { contentType, contentText, mediaUrl } = parseContent(wm)

  const { error: msgError } = await db.from('messages').insert({
    conversation_id: conversation.id,
    sender_type: 'customer',
    content_type: contentType,
    content_text: contentText,
    media_url: mediaUrl,
    message_id: wm.id,
    status: 'delivered',
    created_at: wm.createTime ? new Date(wm.createTime).toISOString() : new Date().toISOString(),
  })

  if (msgError) {
    console.error('[ycloud-webhook] error inserting message:', msgError)
    return
  }

  const { error: convUpdateError } = await db
    .from('conversations')
    .update({
      last_message_text: contentText || `[${contentType}]`,
      last_message_at: new Date().toISOString(),
      unread_count: (conversation.unread_count || 0) + 1,
      status: 'open',
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)

  if (convUpdateError) {
    console.error('[ycloud-webhook] error updating conversation:', convUpdateError)
  }

  void contactWasCreated // reserved for a future new_contact_created dispatch

  await dispatchWebhookEvent(db, accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contact.id,
    whatsapp_message_id: wm.id,
    content_type: contentType,
    text: contentText,
  })
}
