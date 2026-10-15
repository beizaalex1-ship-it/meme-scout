ALTER TABLE public.scanner_state ADD COLUMN IF NOT EXISTS max_coins_per_run integer NOT NULL DEFAULT 3 CHECK (max_coins_per_run BETWEEN 1 AND 10);
CREATE TABLE public.scan_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at timestamptz NOT NULL DEFAULT now(),
  coins_checked integer NOT NULL DEFAULT 0,
  rpc_calls integer NOT NULL DEFAULT 0,
  calls_by_method jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary text
);
GRANT SELECT ON public.scan_runs TO anon, authenticated;
GRANT ALL ON public.scan_runs TO service_role;
ALTER TABLE public.scan_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read scan runs" ON public.scan_runs FOR SELECT TO anon, authenticated USING (true);
CREATE INDEX scan_runs_run_at_idx ON public.scan_runs (run_at DESC);