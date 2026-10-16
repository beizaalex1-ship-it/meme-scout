import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Coin Hunter — Private Pump.fun Scanner" },
      { name: "description", content: "Private scanner for brand-new Pump.fun launches with safety checks and Telegram alerts." },
      { property: "og:title", content: "Coin Hunter — Private Pump.fun Scanner" },
      { property: "og:description", content: "Private scanner for brand-new Pump.fun launches with safety checks and Telegram alerts." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Landing,
});

function Landing() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
      <div className="max-w-md text-center">
        <p className="font-mono text-xs uppercase tracking-widest text-primary">Solana · Pump.fun</p>
        <h1 className="mt-2 text-4xl font-bold">Coin Hunter</h1>
        <p className="mt-3 text-sm text-muted-foreground">A private scanner. Sign in to view results and controls.</p>
        <Link to="/dashboard" className="mt-6 inline-block rounded-md bg-primary px-5 py-2 font-semibold text-primary-foreground">
          Open dashboard
        </Link>
      </div>
    </main>
  );
}
