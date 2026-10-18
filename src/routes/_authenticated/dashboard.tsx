import { createFileRoute, useRouter } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { getDashboard, resumeScanner, scanNow, sendTestAlert, setMaxCoins, setHeliusLimits } from "@/lib/scanner/scanner.functions";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";

const dashboardQuery = queryOptions({
  queryKey: ["dashboard"],
  queryFn: () => getDashboard(),
  refetchInterval: 30_000,
});

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({
    meta: [
      { title: "Dashboard — Coin Hunter" },
      { name: "description", content: "Seven research agents scan brand-new Pump.fun launches, filter rugs and push alerts to Telegram." },
      { property: "og:title", content: "Coin Hunter — Pump.fun Meme Coin Scanner" },
      { property: "og:description", content: "Seven research agents scan brand-new Pump.fun launches, filter rugs and push alerts to Telegram." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(dashboardQuery),
  component: Dashboard,
  errorComponent: ({ error }) => (
    <main className="flex min-h-screen items-center justify-center bg-background p-6 text-center text-foreground">
      <div>
        <h1 className="text-xl font-semibold">No access</h1>
        <p className="mt-2 text-sm text-muted-foreground">{String((error as Error)?.message ?? "").includes("Forbidden") ? "This account is not allowed to use the scanner." : "The dashboard couldn't load."}</p>
        <Button onClick={() => supabase.auth.signOut()} className="mt-4 rounded-md border border-border px-4 py-2 text-sm">Sign out</Button>
      </div>
    </main>
  ),
});

type Token = Awaited<ReturnType<typeof getDashboard>>["tokens"][number];

const statusStyle: Record<string, string> = {
  alerted: "bg-primary text-primary-foreground",
  passed: "bg-accent text-accent-foreground",
  rejected: "bg-destructive text-destructive-foreground",
  error: "bg-warning text-primary-foreground",
  pending: "bg-muted text-muted-foreground",
  unanalyzed: "bg-muted text-warning",
};

function Dashboard() {
  const { data } = useSuspenseQuery(dashboardQuery);
  const qc = useQueryClient();
  const router = useRouter();
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function test() {
    setBusy(true);
    setTestMsg(null);
    const r = await sendTestAlert();
    setTestMsg(r.ok ? "Test alert sent — check your Telegram channel." : `Failed: ${r.error}`);
    setBusy(false);
  }
  const [scanning, setScanning] = useState(false);
  async function scan() {
    setScanning(true);
    setTestMsg(null);
    const r = await scanNow();
    setTestMsg(r.ok ? `Scan finished: ${r.summary}` : `Scan failed: ${r.summary}`);
    await qc.invalidateQueries({ queryKey: ["dashboard"] });
    setScanning(false);
  }
  async function signOut() {
    await qc.cancelQueries();
    qc.clear();
    await supabase.auth.signOut();
    router.navigate({ to: "/auth", replace: true });
  }
  async function resume() {
    await resumeScanner();
    await qc.invalidateQueries({ queryKey: ["dashboard"] });
    router.invalidate();
  }

  const counts = data.tokens.reduce<Record<string, number>>((a, t) => ((a[t.status] = (a[t.status] ?? 0) + 1), a), {});

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-5xl px-4 py-10">
        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-6">
          <div>
            <p className="font-mono text-xs uppercase tracking-widest text-primary">Solana · Pump.fun · every 5 min</p>
            <h1 className="mt-1 text-4xl font-bold">Coin Hunter</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Brand-new launches · Approved opportunities only
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
          <Button
            onClick={scan}
            disabled={scanning}
            className="rounded-md border border-primary px-4 py-2 font-semibold text-primary hover:bg-primary hover:text-primary-foreground disabled:opacity-50"
          >
            {scanning ? "Scanning…" : "Scan now"}
          </Button>
          <Button
            onClick={test}
            disabled={busy}
            className="rounded-md bg-primary px-4 py-2 font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Sending…" : "Send test alert"}
          </Button>
          <Button onClick={signOut} className="rounded-md border border-border px-4 py-2 text-sm text-muted-foreground">Sign out</Button>
          </div>
        </header>

        {testMsg && <p className="mt-4 rounded-md border border-border bg-card p-3 font-mono text-sm">{testMsg}</p>}
        {!data.chatIdSet && (
          <p className="mt-4 rounded-md border border-warning p-3 text-sm text-warning">
            Telegram channel ID is not set yet, so alerts can't be delivered.
          </p>
        )}
        {data.state?.paused_reason && (
          <div className="mt-4 flex items-center justify-between gap-4 rounded-md border border-destructive p-3 text-sm">
            <span>Scanner paused: {data.state.paused_reason}</span>
            <Button onClick={resume} className="rounded bg-destructive px-3 py-1 text-destructive-foreground">
              Resume
            </Button>
          </div>
        )}

        <section className="mt-6 grid grid-cols-2 gap-3 font-mono sm:grid-cols-5">
          <Stat label="Last run" value={data.state?.last_run_at ? new Date(data.state.last_run_at).toLocaleTimeString() : "never"} />
          {["alerted", "passed", "rejected", "unanalyzed"].map((s) => (
            <Stat key={s} label={s} value={String(counts[s] ?? 0)} />
          ))}
        </section>
        {data.state?.last_run_summary && (
          <p className="mt-2 font-mono text-xs text-muted-foreground">{data.state.last_run_summary}</p>
        )}

        <section className="mt-6 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4 font-mono text-xs">
          <span>Next scan estimate: {data.costEstimate?.normalMax ?? "—"} Helius attempts · with retries: up to {data.costEstimate?.retryMax ?? "—"}</span>
          <span className="text-muted-foreground">Limited by remaining monthly allowance</span>
        </section>
        <CreditsPanel credits={data.credits} maxCoins={data.state?.max_coins_per_run ?? 3} />
        <DiscoveryPanel
          runs={data.credits?.recent ?? []}
          monthUsed={data.monthUsed ?? 0}
          budget={data.state?.helius_monthly_budget ?? 1_000_000}
          maxTx={data.state?.helius_discovery_max_tx ?? 30}
        />

        <OutcomePanel predictions={data.predictions ?? []} />

        <section className="mt-8 space-y-3">
          {data.tokens.length === 0 && (
            <p className="rounded-md border border-dashed border-border p-8 text-center text-muted-foreground">
              No tokens scanned yet. The first scan runs within 5 minutes.
            </p>
          )}
          {data.tokens.map((t) => (
            <TokenRow key={t.mint} t={t} />
          ))}
        </section>
      </div>
    </main>
  );
}

type Prediction = Awaited<ReturnType<typeof getDashboard>>["predictions"][number];
const CHECKS = ["5m", "15m", "30m", "60m", "24h"];
const fmtPrice = (n: number | null | undefined) => (n == null ? "—" : `$${n < 0.01 ? n.toPrecision(3) : n.toFixed(4)}`);

function OutcomePanel({ predictions }: { predictions: Prediction[] }) {
  return (
    <section className="mt-8 rounded-md border border-border bg-card p-4">
      <h2 className="font-mono text-sm uppercase tracking-wider text-muted-foreground">Outcome history</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Original predictions are frozen when a coin is found. Later prices are measured separately — a short-term price move is not a verdict.
      </p>
      {predictions.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">No predictions recorded yet. They appear after the next analyzed coin.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full font-mono text-xs">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-1 pr-3">Coin</th>
                <th className="pr-3">Predicted</th>
                <th className="pr-3">Score / risk</th>
                <th className="pr-3">Start price</th>
                <th className="pr-3">Latest</th>
                {CHECKS.map((c) => (
                  <th key={c} className="pr-2">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {predictions.map((p) => {
                const obs = p.prediction_observations ?? [];
                const latest = [...obs].filter((o) => o.status === "recorded" && o.price_usd != null).sort((a, b) => (b.observed_at ?? "").localeCompare(a.observed_at ?? ""))[0];
                return (
                  <tr key={p.id} className="border-t border-border">
                    <td className="py-1 pr-3">${p.symbol ?? "?"}</td>
                    <td className="pr-3 text-muted-foreground">{new Date(p.detected_at).toLocaleString()} · {p.status}</td>
                    <td className="pr-3">{p.score ?? "—"} / {p.wallet_risk ?? "—"} · {p.security_verdict ?? "—"}</td>
                    <td className="pr-3">{fmtPrice(p.initial_price_usd)}</td>
                    <td className="pr-3">
                      {latest ? `${fmtPrice(latest.price_usd)} (${latest.price_change_pct == null ? "n/a" : `${latest.price_change_pct > 0 ? "+" : ""}${latest.price_change_pct}%`})` : "—"}
                    </td>
                    {CHECKS.map((c) => {
                      const o = obs.find((x) => x.checkpoint === c);
                      const label = !o ? "—" : o.status === "recorded" ? (o.price_change_pct == null ? "✓" : `${o.price_change_pct > 0 ? "+" : ""}${o.price_change_pct}%`) : o.status === "unavailable" ? "n/a" : "…";
                      return (
                        <td key={c} className="pr-2" title={o?.reason ?? o?.status ?? ""}>
                          <span className={o?.status === "unavailable" ? "text-warning" : o?.status === "pending" ? "text-muted-foreground" : ""}>{label}</span>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-muted-foreground">… pending · n/a unavailable (hover for reason) · % = change from start price</p>
        </div>
      )}
    </section>
  );
}

const EMPTY_CREDITS = { runs24h: 0, calls24h: 0, coins24h: 0, avgPerRun: null, avgPerCoin: null, projected30d: null, earlyRejected24h: 0, skipped24h: 0, holderRejected24h: 0, estSaved24h: 0, recent: [] };

function CreditsPanel({ credits: raw, maxCoins }: { credits: Awaited<ReturnType<typeof getDashboard>>["credits"] | undefined; maxCoins: number }) {
  // Data cached from before the credits field existed (or a failed lookup) has no credits object.
  const credits = raw ?? EMPTY_CREDITS;
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);
  async function change(v: number) {
    setSaving(true);
    await setMaxCoins({ data: { value: v } });
    await qc.invalidateQueries({ queryKey: ["dashboard"] });
    setSaving(false);
  }
  const fmt = (n: number | null) => (n === null ? "—" : n.toLocaleString("en-US"));
  return (
    <section className="mt-8 rounded-md border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-mono text-xs uppercase tracking-widest text-primary">Helius credits (estimated)</h2>
        <label className="flex items-center gap-2 text-sm">
          Coins checked per scan
          <select
            value={maxCoins}
            disabled={saving}
            onChange={(e) => change(Number(e.target.value))}
            className="rounded border border-border bg-background px-2 py-1 font-mono"
          >
            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 font-mono sm:grid-cols-4">
        <Stat label="Last 24h" value={fmt(credits.calls24h)} />
        <Stat label="Per scan (avg)" value={fmt(credits.avgPerRun)} />
        <Stat label="Per coin (avg)" value={fmt(credits.avgPerCoin)} />
        <Stat label="30-day projection" value={fmt(credits.projected30d)} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 font-mono sm:grid-cols-4">
        <Stat label="Failed safety (rejected early)" value={fmt(credits.earlyRejected24h)} />
        <Stat label="Unverified (skipped)" value={fmt(credits.skipped24h)} />
        <Stat label="Holder risk (rejected early)" value={fmt(credits.holderRejected24h)} />
        <Stat label="Credits saved (est.)" value={`~${fmt(credits.estSaved24h)}`} />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Optimizer: one request checks every candidate's safety; only verified-safe coins get the full wallet checks.
        Counts every request sent to Helius (≈1 credit each, retries included). Projection assumes a scan every 5 minutes all month.
        {credits.runs24h === 0 && " No scans recorded in the last 24 hours yet."}
      </p>
      {credits.recent.length > 0 && (
        <ul className="mt-3 space-y-1 font-mono text-xs text-muted-foreground">
          {credits.recent.map((r) => (
            <li key={r.run_at}>
              {new Date(r.run_at).toLocaleTimeString()} · {r.coins_checked} checked · {r.early_rejected ?? 0} rejected early · {r.skipped_unverified ?? 0} skipped · {r.rpc_calls} credits
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="text-xs uppercase text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg">{value}</div>
    </div>
  );
}

function TokenRow({ t }: { t: Token }) {
  const [open, setOpen] = useState(false);
  const r = JSON.parse(t.reports) as Record<string, Record<string, unknown>>;
  return (
    <article className="rounded-md border border-border bg-card">
      <Button variant="ghost" onClick={() => setOpen(!open)} className="flex h-auto w-full flex-wrap justify-start gap-3 p-4 text-left">
        <span className={`rounded px-2 py-0.5 font-mono text-xs uppercase ${statusStyle[t.status] ?? ""}`}>{t.status}</span>
        <span className="font-semibold">{t.name ?? "Unknown"}</span>
        <span className="font-mono text-sm text-muted-foreground">${t.symbol}</span>
        <span className="ml-auto font-mono text-lg text-primary">{t.score ?? "—"}</span>
      </Button>
      {open && (
        <div className="space-y-3 border-t border-border p-4 text-sm">
          <p className="break-all font-mono text-xs text-muted-foreground">CA: {t.mint}</p>
          {t.verdict && <p><b>Verdict:</b> {t.verdict}</p>}
          {t.error && <p className="text-destructive">Error: {t.error}</p>}
          {(["hunter", "market", "marketData", "approval", "social", "wallet", "security", "opportunity", "chief"] as const).map(
            (k) =>
              r[k] && (
                <details key={k} className="rounded border border-border p-2">
                  <summary className="cursor-pointer font-mono text-xs uppercase text-primary">{agentName[k]}</summary>
                  <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-xs">{JSON.stringify(r[k], null, 2)}</pre>
                </details>
              ),
          )}
        </div>
      )}
    </article>
  );
}

const agentName = {
  hunter: "1 · Coin Hunter",
  market: "2 · Market Analyst",
  marketData: "Live market evidence",
  approval: "Approval checks",
  social: "3 · Social Intelligence",
  wallet: "4 · Wallet Investigator",
  security: "5 · Security Analyst",
  opportunity: "6 · Opportunity Analyst",
  chief: "7 · Chief Research Agent",
};

function DiscoveryPanel({ runs, monthUsed, budget, maxTx }: { runs: Awaited<ReturnType<typeof getDashboard>>["credits"]["recent"]; monthUsed: number; budget: number; maxTx: number }) {
  const save = useServerFn(setHeliusLimits);
  const qc = useQueryClient();
  const [b, setB] = useState(String(budget));
  const [t, setT] = useState(String(maxTx));
  const [msg, setMsg] = useState<string | null>(null);
  async function submit() {
    setMsg(null);
    try {
      await save({ data: { monthlyBudget: Number(b), maxTx: Number(t) } });
      setMsg("Saved.");
      await qc.invalidateQueries({ queryKey: ["dashboard"] });
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not save");
    }
  }
  return (
    <section className="mt-8 rounded-md border border-border bg-card p-4">
      <h2 className="font-mono text-xs uppercase tracking-widest text-primary">Coin discovery</h2>
      <p className="mt-1 text-xs text-muted-foreground">GeckoTerminal first (free). If it refuses, new launches are read from Helius within these limits.</p>
      <div className="mt-3 grid grid-cols-2 gap-3 font-mono sm:grid-cols-3">
        <Stat label="Helius used this month" value={`${monthUsed.toLocaleString("en-US")} / ${budget.toLocaleString("en-US")}`} />
        <label className="rounded-md border border-border p-3 text-xs uppercase text-muted-foreground">
          Monthly budget
          <input value={b} onChange={(e) => setB(e.target.value)} inputMode="numeric" className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-base text-foreground" />
        </label>
        <label className="rounded-md border border-border p-3 text-xs uppercase text-muted-foreground">
          Launches read per scan
          <input value={t} onChange={(e) => setT(e.target.value)} inputMode="numeric" className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-base text-foreground" />
        </label>
      </div>
      <div className="mt-2 flex items-center gap-3">
        <Button onClick={submit} className="rounded-md border border-primary px-3 py-1 text-sm text-primary">Save limits</Button>
        {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
      </div>
      {runs.length > 0 && (
        <ul className="mt-3 space-y-1 font-mono text-xs text-muted-foreground">
          {runs.map((r) => (
            <li key={r.run_at} title={r.discovery_note ?? ""}>
              {new Date(r.run_at).toLocaleTimeString()} · {r.discovery_provider ?? "—"} · {r.launches_retrieved ?? 0} read · {r.launches_eligible ?? 0} eligible · {r.coins_checked} analyzed · {r.discovery_failures ?? 0} failed · {r.discovery_credits ?? 0} discovery credits
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
