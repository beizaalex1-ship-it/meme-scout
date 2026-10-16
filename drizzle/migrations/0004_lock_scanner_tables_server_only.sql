DROP POLICY IF EXISTS "Public can read predictions" ON public.predictions;
DROP POLICY IF EXISTS "Public can read observations" ON public.prediction_observations;
DROP POLICY IF EXISTS "Anyone can read scan runs" ON public.scan_runs;
DROP POLICY IF EXISTS "Public can read scan results" ON public.scanned_tokens;
DROP POLICY IF EXISTS "Public can read scanner status" ON public.scanner_state;
REVOKE ALL ON public.predictions, public.prediction_observations, public.scan_runs, public.scanned_tokens, public.scanner_state FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.acquire_scanner_lock(integer) FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.acquire_scanner_lock(integer) TO service_role;