import { ComingSoon } from "@/components/ComingSoon";

export const metadata = { title: "Sell" };

export default function SellPage() {
  return (
    <ComingSoon title="New sale" phase={2}>
      Tap products, press Submit — ingredients are deducted automatically.
    </ComingSoon>
  );
}
