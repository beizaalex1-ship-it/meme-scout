CREATE TABLE public.scanned_tokens (
  mint text PRIMARY KEY,
  name text,
  symbol text,
  status text NOT NULL DEFAULT 'pending', -- pending | rejected | passed | alerted | error
  score integer,
  verdict text,
  reports jsonb NOT NULL DEFAULT '{}'::jsonb,
  alert_text text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.scanned_tokens TO anon, authenticated;
GRANT ALL ON public.scanned_tokens TO service_role;
ALTER TABLE public.scanned_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public can read scan results" ON public.scanned_tokens FOR SELECT TO anon, authenticated USING (true);
CREATE INDEX scanned_tokens_created_idx ON public.scanned_tokens (created_at DESC);

CREATE TABLE public.scanner_state (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  lock_until timestamptz,
  paused_reason text,
  last_run_at timestamptz,
  last_run_summary text
);
GRANT SELECT ON public.scanner_state TO anon, authenticated;
GRANT ALL ON public.scanner_state TO service_role;
ALTER TABLE public.scanner_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public can read scanner status" ON public.scanner_state FOR SELECT TO anon, authenticated USING (true);
INSERT INTO public.scanner_state (id) VALUES (1);

CREATE OR REPLACE FUNCTION public.acquire_scanner_lock(_seconds integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE ok boolean;
BEGIN
  UPDATE public.scanner_state SET lock_until = now() + make_interval(secs => _seconds)
  WHERE id = 1 AND (lock_until IS NULL OR lock_until < now())
  RETURNING true INTO ok;
  RETURN coalesce(ok, false);
END $$;
REVOKE EXECUTE ON FUNCTION public.acquire_scanner_lock(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acquire_scanner_lock(integer) TO service_role;