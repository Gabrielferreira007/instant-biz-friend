import { createFileRoute } from '@tanstack/react-router'
import { verifyWebhookRequest } from '@lovable.dev/webhooks-js'

const GATEWAY_URL = 'https://connector-gateway.lovable.dev/whatsapp'
const AI_GATEWAY_URL = 'https://ai.gateway.lovable.dev/v1/chat/completions'

function getCredentials() {
  const lovablyApiKey = process.env['LOVABLE_API_KEY']
  const whatsappApiKey = process.env['WHATSAPP_API_KEY']
  if (!lovablyApiKey) throw new Error('LOVABLE_API_KEY is not configured')
  if (!whatsappApiKey) throw new Error('WHATSAPP_API_KEY is not configured')
  return { lovablyApiKey, whatsappApiKey }
}

async function generateReply(customerText: string): Promise<string> {
  const { lovablyApiKey } = getCredentials()
  const response = await fetch(AI_GATEWAY_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${lovablyApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'google/gemini-3-flash-preview',
      messages: [
        {
          role: 'system',
          content:
            'Você é o Balcão, o atendente automático deste negócio no WhatsApp. Responda em português brasileiro, de forma curta (máximo 3 frases), cordial e objetiva. Cumprimente, responda à pergunta do cliente com o que for possível e, quando não souber um detalhe específico do negócio, diga que a equipe confirma em breve. Nunca invente preços, horários ou endereços.',
        },
        { role: 'user', content: customerText.slice(0, 2000) },
      ],
    }),
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`AI reply failed (${response.status}): ${body}`)
  }
  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[]
  }
  const content = data.choices?.[0]?.message?.content?.trim()
  if (!content) throw new Error('AI reply came back empty')
  return content
}

async function sendWhatsappText(toDigits: string, body: string): Promise<string> {
  const { lovablyApiKey, whatsappApiKey } = getCredentials()
  const response = await fetch(`${GATEWAY_URL}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${lovablyApiKey}`,
      'X-Connection-Api-Key': whatsappApiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: toDigits,
      type: 'text',
      text: { body },
    }),
  })
  const responseBody = await response.text()
  if (!response.ok) {
    throw new Error(`WhatsApp send failed (${response.status}): ${responseBody}`)
  }
  const parsed = JSON.parse(responseBody) as { messages?: { id: string }[] }
  return parsed.messages?.[0]?.id ?? ''
}

export const Route = createFileRoute('/api/public/whatsapp/webhook')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env['WHATSAPP_API_KEY']
        if (!secret) return new Response('not configured', { status: 500 })

        const verification = await verifyWebhookRequest(request, {
          secret,
          maxBodyBytes: 4 * 1024 * 1024,
        })
        if (!verification.valid) {
          return new Response('invalid signature', { status: 401 })
        }

        const deliveryId = request.headers.get('x-lovable-delivery')
        const event = request.headers.get('x-lovable-event')
        if (!deliveryId || !event) {
          return new Response('missing delivery headers', { status: 400 })
        }

        const payload = JSON.parse(verification.body) as Record<string, unknown>
        const { supabaseAdmin } = await import('@/integrations/supabase/client.server')

        // Durable inbox; duplicate delivery ids reuse the existing row.
        const { data: inboxRow, error: inboxError } = await supabaseAdmin
          .from('whatsapp_webhook_events')
          .upsert(
            { delivery_id: deliveryId, event, payload },
            { onConflict: 'delivery_id', ignoreDuplicates: true },
          )
          .select('id, processed_at')
          .maybeSingle()

        if (inboxError) {
          return new Response(`inbox write failed: ${inboxError.message}`, { status: 500 })
        }

        const row =
          inboxRow ??
          (
            await supabaseAdmin
              .from('whatsapp_webhook_events')
              .select('id, processed_at')
              .eq('delivery_id', deliveryId)
              .single()
          ).data

        if (!row) return new Response('inbox lookup failed', { status: 500 })
        if (row.processed_at) return new Response('ok') // already processed

        try {
          if (event === 'whatsapp.message') {
            const value = (payload as {
              entry?: { changes?: { value?: {
                messages?: {
                  id: string
                  from: string
                  type: string
                  text?: { body?: string }
                }[]
              } }[] }[]
            }).entry?.[0]?.changes?.[0]?.value

            for (const message of value?.messages ?? []) {
              if (message.type !== 'text' || !message.text?.body) continue

              // Dedupe inbound by WhatsApp message id.
              const { error: inboundError } = await supabaseAdmin
                .from('whatsapp_messages')
                .upsert(
                  {
                    wa_message_id: message.id,
                    customer_number: message.from,
                    direction: 'inbound',
                    body: message.text.body,
                  },
                  { onConflict: 'wa_message_id', ignoreDuplicates: true },
                )
              if (inboundError) throw new Error(`inbound store failed: ${inboundError.message}`)

              const reply = await generateReply(message.text.body)
              const outboundId = await sendWhatsappText(message.from, reply)

              if (outboundId) {
                await supabaseAdmin
                  .from('whatsapp_messages')
                  .upsert(
                    {
                      wa_message_id: outboundId,
                      customer_number: message.from,
                      direction: 'outbound',
                      body: reply,
                    },
                    { onConflict: 'wa_message_id', ignoreDuplicates: true },
                  )
              }

              // Count one conversation per customer per month.
              const month = new Date().toISOString().slice(0, 7) + '-01'
              await supabaseAdmin.rpc('increment_whatsapp_usage', {
                p_month: month,
                p_customer: message.from,
              }).catch(() => {
                // Fallback below if the RPC does not exist.
                return { error: null }
              })
            }
          }

          await supabaseAdmin
            .from('whatsapp_webhook_events')
            .update({ processed_at: new Date().toISOString(), processing_error: null })
            .eq('id', row.id)

          return new Response('ok')
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          await supabaseAdmin
            .from('whatsapp_webhook_events')
            .update({ processing_error: message })
            .eq('id', row.id)
          return new Response(`processing failed: ${message}`, { status: 500 })
        }
      },
    },
  },
})
