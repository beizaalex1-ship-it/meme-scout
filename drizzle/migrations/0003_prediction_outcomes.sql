CREATE TABLE public.predictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mint text NOT NULL,
  discovery_key text NOT NULL UNIQUE,
  detected_at timestamptz NOT NULL DEFAULT now(),
  pair_created_at timestamptz,
  name text,
  symbol text,
  status text NOT NULL,
  verdict text,
  score integer,
  security_verdict text,
  wallet_risk text,
  initial_price_usd double precision,
  initial_liquidity_usd double precision,
  initial_market_cap_usd double precision,
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX predictions_mint_idx ON public.predictions(mint);
CREATE INDEX predictions_detected_idx ON public.predictions(detected_at DESC);
GRANT SELECT ON public.predictions TO anon, authenticated;
GRANT ALL ON public.predictions TO service_role;
ALTER TABLE public.predictions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public can read predictions" ON public.predictions FOR SELECT TO anon, authenticated USING (true);

CREATE OR REPLACE FUNCTION public.block_prediction_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'predictions are immutable';
END;
$$;
CREATE TRIGGER predictions_immutable BEFORE UPDATE ON public.predictions
FOR EACH ROW EXECUTE FUNCTION public.block_prediction_update();

CREATE TABLE public.prediction_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prediction_id uuid NOT NULL REFERENCES public.predictions(id) ON DELETE CASCADE,
  checkpoint text NOT NULL,
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  observed_at timestamptz,
  price_usd double precision,
  liquidity_usd double precision,
  market_cap_usd double precision,
  volume_h1_usd double precision,
  volume_h24_usd double precision,
  price_change_pct double precision,
  reason text,
  UNIQUE (prediction_id, checkpoint)
);
CREATE INDEX prediction_obs_due_idx ON public.prediction_observations(status, due_at);
GRANT SELECT ON public.prediction_observations TO anon, authenticated;
GRANT ALL ON public.prediction_observations TO service_role;
ALTER TABLE public.prediction_observations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public can read observations" ON public.prediction_observations FOR SELECT TO anon, authenticated USING (true);