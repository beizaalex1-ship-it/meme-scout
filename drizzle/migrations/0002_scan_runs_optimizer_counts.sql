ALTER TABLE public.scan_runs ADD COLUMN IF NOT EXISTS early_rejected integer NOT NULL DEFAULT 0;
ALTER TABLE public.scan_runs ADD COLUMN IF NOT EXISTS skipped_unverified integer NOT NULL DEFAULT 0;
ALTER TABLE public.scan_runs ADD COLUMN IF NOT EXISTS holder_rejected integer NOT NULL DEFAULT 0;