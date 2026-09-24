import { createClient } from "@/lib/supabase/server";
import { SettingsForm, type Settings } from "./SettingsForm";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("app_settings")
    .select("business_name, timezone, currency, runway_window_days, min_history_days, reorder_cover_days, allow_negative_on_sale, allow_negative_other")
    .single<Settings>();

  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <h1 className="text-2xl font-bold">Settings</h1>
      {data ? <SettingsForm settings={data} /> : <p className="text-danger">Could not load settings.</p>}
    </div>
  );
}
