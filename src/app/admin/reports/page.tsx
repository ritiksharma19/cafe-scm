import { RangeFilter } from "@/components/RangeFilter";
import { resolveRange } from "@/lib/range";
import { REPORTS, type ReportKey } from "@/lib/reports";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Reports & export" };

const PERIODLESS: ReportKey[] = ["inventory", "recipes"];

export default async function ReportsPage({ searchParams }: PageProps<"/admin/reports">) {
  const params = await searchParams;
  const range = resolveRange(params, new Date(), "7d");
  const supabase = await createClient();
  const { data: locations } = await supabase
    .from("locations")
    .select("id, name")
    .eq("is_active", true)
    .order("sort_order")
    .returns<{ id: string; name: string }[]>();
  const locationId = typeof params.location === "string" && (locations ?? []).some((l) => l.id === params.location) ? params.location : "";

  const query = (key: ReportKey, format: "csv" | "xlsx") => {
    const q = new URLSearchParams({ format, from: range.fromDate, to: range.toDate });
    if (locationId && !PERIODLESS.includes(key)) q.set("location", locationId);
    return `/admin/export/${key}?${q.toString()}`;
  };

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-bold">Reports &amp; export</h1>
        <p className="mt-1 text-sm text-muted">
          Download data as Excel or CSV. Supabase stays the source of truth — these files are copies for analysis and
          record-keeping. Times are India time.
        </p>
      </div>
      <RangeFilter path="/admin/reports" range={range} locations={locations ?? []} locationId={locationId || undefined} />

      <div className="grid gap-3 md:grid-cols-2">
        {(Object.keys(REPORTS) as ReportKey[]).map((key) => (
          <article key={key} className="card flex flex-col gap-3 p-4">
            <div>
              <h2 className="font-bold">{REPORTS[key].title}</h2>
              <p className="text-sm text-muted">{REPORTS[key].description}</p>
              <p className="mt-1 text-xs text-muted">
                {PERIODLESS.includes(key) ? "As of now" : `${range.fromDate} to ${range.toDate}`}
                {locationId && !PERIODLESS.includes(key) ? ` · ${(locations ?? []).find((l) => l.id === locationId)?.name}` : ""}
              </p>
            </div>
            <div className="flex gap-2">
              <a href={query(key, "xlsx")} className="btn btn-secondary min-h-10 text-sm" download>
                Excel
              </a>
              <a href={query(key, "csv")} className="btn btn-secondary min-h-10 text-sm" download>
                CSV
              </a>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
