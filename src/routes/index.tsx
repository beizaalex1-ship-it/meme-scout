import { createFileRoute, useRouter } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { getDashboard, resumeScanner, scanNow, sendTestAlert, setMaxCoins } from "@/lib/scanner/scanner.functions";

const dashboardQuery = queryOptions({
  queryKey: ["dashboard"],
  queryFn: () => getDashboard(),
  refetchInterval: 30_000,
});

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Coin Hunter — Pump.fun Meme Coin Scanner" },
      { name: "description", content: "Seven research agents scan graduating Pump.fun tokens, filter rugs and push alerts to Telegram." },
      { property: "og:title", content: "Coin Hunter — Pump.fun Meme Coin Scanner" },
      { property: "og:description", content: "Seven research agents scan graduating Pump.fun tokens, filter rugs and push alerts to Telegram." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(dashboardQuery),
  component: Dashboard,
});

type Token = Awaited<ReturnType<typeof getDashboard>>["tokens"][number];

const statusStyle: Record<string, string> = {
  alerted: "bg-primary text-primary-foreground",
  passed: "bg-accent text-accent-foreground",
  rejected: "bg-destructive text-destructive-foreground",
  error: "bg-warning text-primary-foreground",
  pending: "bg-muted text-muted-foreground",
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
              Brand-new launches (under 10 min old). Every analyzed coin is sent to Telegram; rugs are auto-rejected.
            </p>
          </div>
          <div className="flex gap-2">
          <button
            onClick={scan}
            disabled={scanning}
            className="rounded-md border border-primary px-4 py-2 font-semibold text-primary hover:bg-primary hover:text-primary-foreground disabled:opacity-50"
          >
            {scanning ? "Scanning…" : "Scan now"}
          </button>
          <button
            onClick={test}
            disabled={busy}
            className="rounded-md bg-primary px-4 py-2 font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Sending…" : "Send test alert"}
          </button>
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
            <button onClick={resume} className="rounded bg-destructive px-3 py-1 text-destructive-foreground">
              Resume
            </button>
          </div>
        )}

        <section className="mt-6 grid grid-cols-2 gap-3 font-mono sm:grid-cols-5">
          <Stat label="Last run" value={data.state?.last_run_at ? new Date(data.state.last_run_at).toLocaleTimeString() : "never"} />
          {["alerted", "passed", "rejected", "error"].map((s) => (
            <Stat key={s} label={s} value={String(counts[s] ?? 0)} />
          ))}
        </section>
        {data.state?.last_run_summary && (
          <p className="mt-2 font-mono text-xs text-muted-foreground">{data.state.last_run_summary}</p>
        )}

        <CreditsPanel credits={data.credits} maxCoins={data.state?.max_coins_per_run ?? 3} />

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

const EMPTY_CREDITS = { runs24h: 0, calls24h: 0, coins24h: 0, avgPerRun: null, avgPerCoin: null, projected30d: null, recent: [] };

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
      <p className="mt-2 text-xs text-muted-foreground">
        Counts every request sent to Helius (≈1 credit each, retries included). Projection assumes a scan every 5 minutes all month.
        {credits.runs24h === 0 && " No scans recorded in the last 24 hours yet."}
      </p>
      {credits.recent.length > 0 && (
        <ul className="mt-3 space-y-1 font-mono text-xs text-muted-foreground">
          {credits.recent.map((r) => (
            <li key={r.run_at}>
              {new Date(r.run_at).toLocaleTimeString()} · {r.coins_checked} coin(s) · {r.rpc_calls} credits
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
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-3 p-4 text-left">
        <span className={`rounded px-2 py-0.5 font-mono text-xs uppercase ${statusStyle[t.status] ?? ""}`}>{t.status}</span>
        <span className="font-semibold">{t.name ?? "Unknown"}</span>
        <span className="font-mono text-sm text-muted-foreground">${t.symbol}</span>
        <span className="ml-auto font-mono text-lg text-primary">{t.score ?? "—"}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-border p-4 text-sm">
          <p className="break-all font-mono text-xs text-muted-foreground">CA: {t.mint}</p>
          {t.verdict && <p><b>Verdict:</b> {t.verdict}</p>}
          {t.error && <p className="text-destructive">Error: {t.error}</p>}
          {(["hunter", "market", "social", "wallet", "security", "opportunity", "chief"] as const).map(
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
  social: "3 · Social Intelligence",
  wallet: "4 · Wallet Investigator",
  security: "5 · Security Analyst",
  opportunity: "6 · Opportunity Analyst",
  chief: "7 · Chief Research Agent",
};
