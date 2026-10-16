ALTER TABLE public.scanner_state
  ADD COLUMN IF NOT EXISTS helius_monthly_budget integer NOT NULL DEFAULT 1000000 CHECK (helius_monthly_budget > 0),
  ADD COLUMN IF NOT EXISTS helius_discovery_max_tx integer NOT NULL DEFAULT 30 CHECK (helius_discovery_max_tx BETWEEN 0 AND 100);

ALTER TABLE public.scan_runs
  ADD COLUMN IF NOT EXISTS discovery_provider text,
  ADD COLUMN IF NOT EXISTS launches_retrieved integer,
  ADD COLUMN IF NOT EXISTS launches_eligible integer,
  ADD COLUMN IF NOT EXISTS discovery_failures integer,
  ADD COLUMN IF NOT EXISTS discovery_credits integer,
  ADD COLUMN IF NOT EXISTS discovery_note text;

CREATE TABLE public.helius_launches (
  signature text PRIMARY KEY,
  mint text,
  block_time timestamptz,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.helius_launches TO service_role;
ALTER TABLE public.helius_launches ENABLE ROW LEVEL SECURITY;

CREATE TYPE public.app_role AS ENUM ('admin', 'moderator', 'user');
CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  role public.app_role NOT NULL,
  UNIQUE (user_id, role)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
$$;

CREATE POLICY "Users read own roles" ON public.user_roles FOR SELECT TO authenticated USING (auth.uid() = user_id);