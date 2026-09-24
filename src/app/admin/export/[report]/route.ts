import { getCurrentUser } from "@/lib/auth";
import { buildExport, type ExportFormat } from "@/lib/export";
import { resolveRange } from "@/lib/range";
import { buildReport, REPORTS, type ReportKey } from "@/lib/reports";

/**
 * GET /admin/export/<report>?format=csv|xlsx&range=…|from=…&to=…&location=…
 * Admin only. Data is read as the signed-in admin, so RLS and the admin-only
 * analytics functions apply exactly as on screen.
 */
export async function GET(request: Request, ctx: RouteContext<"/admin/export/[report]">) {
  const user = await getCurrentUser();
  if (!user || user.profile.role !== "admin") return new Response("Not authorised", { status: 403 });

  const { report } = await ctx.params;
  if (!(report in REPORTS)) return new Response("Unknown report", { status: 404 });

  const url = new URL(request.url);
  const params = Object.fromEntries(url.searchParams.entries());
  const format: ExportFormat = params.format === "csv" ? "csv" : "xlsx";
  const range = resolveRange(params, new Date(), "7d");
  const locationId = params.location && /^[0-9a-f-]{36}$/i.test(params.location) ? params.location : null;

  try {
    const data = await buildReport(report as ReportKey, { from: range.from, to: range.to, locationId });
    const { body, contentType } = buildExport(format, data.sheet, data.header, data.rows);
    const period = report === "inventory" || report === "recipes" ? range.toDate : `${range.fromDate}_to_${range.toDate}`;
    const filename = `cafe-scm-${report}-${period}.${format}`;
    return new Response(body as BodyInit, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return new Response(`Export failed: ${(e as Error).message}`, { status: 500 });
  }
}
