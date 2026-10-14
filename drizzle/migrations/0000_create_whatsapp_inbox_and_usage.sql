CREATE TABLE public.whatsapp_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id text NOT NULL UNIQUE,
  event text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  processing_error text
);
GRANT ALL ON public.whatsapp_webhook_events TO service_role;
ALTER TABLE public.whatsapp_webhook_events ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.whatsapp_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wa_message_id text NOT NULL UNIQUE,
  customer_number text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('inbound','outbound')),
  body text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.whatsapp_messages TO service_role;
ALTER TABLE public.whatsapp_messages ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.whatsapp_monthly_usage (
  month date NOT NULL,
  customer_number text NOT NULL,
  conversations integer NOT NULL DEFAULT 0,
  PRIMARY KEY (month, customer_number)
);
GRANT ALL ON public.whatsapp_monthly_usage TO service_role;
ALTER TABLE public.whatsapp_monthly_usage ENABLE ROW LEVEL SECURITY;