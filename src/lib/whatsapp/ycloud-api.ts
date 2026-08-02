/**
 * YCloud WhatsApp Business API helpers.
 *
 * YCloud is a WhatsApp BSP (Business Solution Provider) — it fronts
 * the official WhatsApp Cloud API so an account can send/receive
 * without going through Meta Business Manager / an approved Meta app.
 * Auth is a single API key (`X-API-Key` header), and numbers are
 * addressed by their E.164 string rather than a Meta phone_number_id.
 *
 * Mirrors `meta-api.ts`'s shape (named-args functions, `MetaSendResult`-
 * like return type) so the provider branch at each call site
 * (`send-message.ts`, `automations/meta-send.ts`, `flows/meta-send.ts`)
 * stays a thin `if (provider === 'ycloud')` swap.
 *
 * IMPORTANT: written against YCloud's published WhatsApp API shape
 * (https://docs.ycloud.com/reference/whatsapp-send-message) without a
 * live API key to test against. Verify the exact request/response
 * field names against a real send once credentials are available —
 * see docs/ycloud.md for the smoke-test steps.
 */

const YCLOUD_API_BASE = 'https://api.ycloud.com/v2'

export interface YCloudSendResult {
  messageId: string
}

interface YCloudErrorResponse {
  message?: string
  error?: { message?: string }
}

async function throwYCloudError(response: Response, fallback: string): Promise<never> {
  let message = fallback
  try {
    const data = (await response.json()) as YCloudErrorResponse
    message = data.error?.message || data.message || fallback
  } catch {
    // response body wasn't JSON — keep the fallback
  }
  throw new Error(message)
}

/** Read a wamid-shaped id off whatever field name the response used. */
function extractMessageId(data: Record<string, unknown>): string {
  const id = data.id ?? data.whatsappMessageId ?? data.wamid
  if (typeof id !== 'string' || !id) {
    throw new Error('YCloud response did not include a message id')
  }
  return id
}

// ============================================================
// Account / connectivity
// ============================================================

export interface VerifyYCloudApiKeyResult {
  /** Numbers currently reachable with this API key, if the endpoint returns any. */
  phoneNumbers: string[]
}

/**
 * Confirm an API key is valid by listing the account's WhatsApp
 * senders. Used by the config "Test connection" action — mirrors
 * `verifyPhoneNumber` in meta-api.ts (cheap read, throws on failure).
 */
export async function verifyYCloudApiKey(args: {
  apiKey: string
}): Promise<VerifyYCloudApiKeyResult> {
  const { apiKey } = args
  const response = await fetch(`${YCLOUD_API_BASE}/whatsapp/phoneNumbers`, {
    headers: { 'X-API-Key': apiKey },
  })
  if (!response.ok) {
    await throwYCloudError(response, `YCloud API error: ${response.status}`)
  }
  const data = (await response.json()) as { data?: Array<{ phoneNumber?: string }> }
  return {
    phoneNumbers: (data.data ?? [])
      .map((p) => p.phoneNumber)
      .filter((p): p is string => Boolean(p)),
  }
}

// ============================================================
// Sending
// ============================================================

export interface YCloudSendTextArgs {
  apiKey: string
  /** E.164, with leading `+` — the account's connected WhatsApp number. */
  from: string
  to: string
  text: string
  /** wamid of the message being replied to (quote preview). */
  contextMessageId?: string
}

export async function sendTextMessage(args: YCloudSendTextArgs): Promise<YCloudSendResult> {
  const { apiKey, from, to, text, contextMessageId } = args
  const body: Record<string, unknown> = {
    from,
    to,
    type: 'text',
    text: { body: text },
  }
  if (contextMessageId) {
    body.context = { messageId: contextMessageId }
  }
  const response = await fetch(`${YCLOUD_API_BASE}/whatsapp/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    await throwYCloudError(response, `YCloud API error: ${response.status}`)
  }
  return { messageId: extractMessageId(await response.json()) }
}

export type YCloudMediaKind = 'image' | 'video' | 'document' | 'audio'

export interface YCloudSendMediaArgs {
  apiKey: string
  from: string
  to: string
  kind: YCloudMediaKind
  /** Public URL YCloud fetches at send time. */
  link: string
  caption?: string
  /** Document-only. */
  filename?: string
  contextMessageId?: string
}

export async function sendMediaMessage(args: YCloudSendMediaArgs): Promise<YCloudSendResult> {
  const { apiKey, from, to, kind, link, caption, filename, contextMessageId } = args
  if (!link) throw new Error('sendMediaMessage requires a link.')

  const media: Record<string, unknown> = { link }
  if (caption && kind !== 'audio') media.caption = caption
  if (kind === 'document' && filename) media.filename = filename

  const body: Record<string, unknown> = {
    from,
    to,
    type: kind,
    [kind]: media,
  }
  if (contextMessageId) body.context = { messageId: contextMessageId }

  const response = await fetch(`${YCLOUD_API_BASE}/whatsapp/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    await throwYCloudError(response, `YCloud API error: ${response.status}`)
  }
  return { messageId: extractMessageId(await response.json()) }
}
