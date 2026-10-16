import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/reset-password")({
  head: () => ({
    meta: [
      { title: "Set password — Coin Hunter" },
      { name: "description", content: "Choose a new password for your Coin Hunter account." },
      { property: "og:title", content: "Set password — Coin Hunter" },
      { property: "og:description", content: "Choose a new password for your Coin Hunter account." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ResetPage,
});

function ResetPage() {
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    const { error } = await supabase.auth.updateUser({ password });
    if (error) return setMsg(error.message);
    navigate({ to: "/dashboard" });
  }
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
      <form onSubmit={save} className="w-full max-w-sm space-y-3 rounded-md border border-border bg-card p-6">
        <h1 className="text-2xl font-bold">Set a new password</h1>
        <input type="password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="New password (10+ characters)" className="w-full rounded border border-border bg-background px-3 py-2" />
        <button className="w-full rounded-md bg-primary py-2 font-semibold text-primary-foreground">Save password</button>
        {msg && <p className="text-sm text-destructive">{msg}</p>}
      </form>
    </main>
  );
}
