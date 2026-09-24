/** The business runs on India time (no DST, fixed +05:30). */
export const BUSINESS_TZ = "Asia/Kolkata";
const IST_OFFSET_MS = 330 * 60 * 1000;

/** Start of the business day (00:00 IST) containing `at`, as a UTC Date. */
export function istDayStart(at: Date = new Date()): Date {
  const shifted = new Date(at.getTime() + IST_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - IST_OFFSET_MS);
}

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 });
const time = new Intl.DateTimeFormat("en-IN", { timeZone: BUSINESS_TZ, hour: "numeric", minute: "2-digit" });
const dateTime = new Intl.DateTimeFormat("en-IN", {
  timeZone: BUSINESS_TZ,
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
});

export function formatINR(amount: number | string): string {
  return inr.format(Number(amount)).replace(/\.00$/, "");
}

export function formatTime(iso: string | Date): string {
  return time.format(new Date(iso));
}

export function formatDateTime(iso: string | Date): string {
  return dateTime.format(new Date(iso));
}
