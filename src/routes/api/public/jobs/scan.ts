import { createFileRoute } from "@tanstack/react-router";
import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";

export const Route = createFileRoute("/api/public/jobs/scan")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authFailure = await authenticateCronRequest(request);
        if (authFailure) return authFailure;
        const started = Date.now();
        try {
          // Outcome checks first: they are time-sensitive and a scan can take minutes.
          try {
            const { collectDueObservations } = await import("@/lib/scanner/outcomes.server");
            console.log(JSON.stringify({ evt: "outcome_checks", ok: true, ...(await collectDueObservations()) }));
          } catch (e) {
            console.error(JSON.stringify({ evt: "outcome_checks", ok: false, error: e instanceof Error ? e.message.slice(0, 300) : String(e) }));
          }
          const { runScan } = await import("@/lib/scanner/run.server");
          const summary = await runScan();
          console.log(JSON.stringify({ evt: "scheduled_scan", ok: true, summary, ms: Date.now() - started }));
          return Response.json({ ok: true, summary });
        } catch (e) {
          const msg = e instanceof Error ? e.message.slice(0, 300) : String(e);
          console.error(JSON.stringify({ evt: "scheduled_scan", ok: false, error: msg, ms: Date.now() - started }));
          return Response.json({ ok: false, error: "Scan failed" }, { status: 500 });
        }
      },
    },
  },
});
