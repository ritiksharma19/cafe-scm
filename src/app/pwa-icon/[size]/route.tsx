import { ImageResponse } from "next/og";

const SIZES = ["180", "192", "512"] as const;

export const dynamicParams = false;

export function generateStaticParams() {
  return SIZES.map((size) => ({ size }));
}

export async function GET(_request: Request, ctx: RouteContext<"/pwa-icon/[size]">) {
  const { size } = await ctx.params;
  const px = Number(size);
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0f5132",
          color: "#ffffff",
          fontSize: px * 0.34,
          fontWeight: 800,
        }}
      >
        SCM
      </div>
    ),
    { width: px, height: px },
  );
}
