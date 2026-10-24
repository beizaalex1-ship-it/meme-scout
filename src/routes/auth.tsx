import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Sign in — Coin Hunter" },
      { name: "description", content: "Sign in to the private Coin Hunter dashboard." },
      { property: "og:title", content: "Sign in — Coin Hunter" },
      { property: "og:description", content: "Sign in to the private Coin Hunter dashboard." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AuthPage,
});

const MAX_ATTEMPTS = 5;

function AuthPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempts, setAttempts] = useState(0);

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    if (attempts >= MAX_ATTEMPTS) return setMsg("Too many login attempts. Please wait and try again.");
    setBusy(true);
    setMsg(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) {
      const next = attempts + 1;
      setAttempts(next);
      return setMsg(
        next >= MAX_ATTEMPTS
          ? "Too many login attempts. Please wait and try again."
          : "Sign-in failed. Check your email and password.",
      );
    }
    setAttempts(0);
    navigate({ to: "/dashboard" });
  }
  async function forgot() {
    if (!email) return setMsg("Enter your email first.");
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/reset-password` });
    if (error) {
      console.error(error);
      return setMsg("Unable to send password reset email.");
    }
    setMsg("If that account exists, a reset link is on its way.");
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
      <form onSubmit={signIn} className="w-full max-w-sm space-y-3 rounded-md border border-border bg-card p-6">
        <h1 className="text-2xl font-bold">Sign in</h1>
        <p className="text-xs text-muted-foreground">Private dashboard. New accounts can't be created here.</p>
        <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" className="w-full rounded border border-border bg-background px-3 py-2" />
        <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" className="w-full rounded border border-border bg-background px-3 py-2" />
        <button disabled={busy} className="w-full rounded-md bg-primary py-2 font-semibold text-primary-foreground disabled:opacity-50">
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <button type="button" onClick={forgot} className="w-full text-xs text-muted-foreground underline">Forgot or set password</button>
        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
      </form>
    </main>
  );
}
