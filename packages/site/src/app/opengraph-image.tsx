import { ImageResponse } from "next/og";

export const alt = "Tailored AI — Build agents that keep working";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const dynamic = "force-static";

function BrandMark() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-end",
        gap: 5,
        width: 48,
        height: 48,
        border: "2px solid #45504b",
        padding: 9,
      }}
    >
      <div style={{ width: 8, height: 13, background: "#c8f36d" }} />
      <div style={{ width: 8, height: 28, background: "#c8f36d" }} />
      <div style={{ width: 8, height: 20, background: "#c8f36d" }} />
    </div>
  );
}

export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        width: "100%",
        height: "100%",
        padding: "66px 72px",
        color: "#f2f2e9",
        backgroundColor: "#0a0e0d",
        backgroundImage:
          "linear-gradient(#1b2420 1px, transparent 1px), linear-gradient(90deg, #1b2420 1px, transparent 1px)",
        backgroundSize: "64px 64px",
        fontFamily: "Arial, Helvetica, sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
        <BrandMark />
        <div style={{ fontSize: 25, fontWeight: 700, letterSpacing: "-0.02em" }}>Tailored AI</div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
        <div style={{ width: 84, height: 4, background: "#c8f36d" }} />
        <div style={{ maxWidth: 890, fontSize: 82, fontWeight: 600, letterSpacing: "-0.055em", lineHeight: 0.98 }}>
          Build agents that keep working.
        </div>
        <div style={{ color: "#aeb7b2", fontSize: 25, letterSpacing: "-0.01em" }}>
          Self-hosted runtime · tools · memory · schedules · your models
        </div>
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          borderTop: "1px solid #34403a",
          paddingTop: 20,
          color: "#829088",
          fontSize: 17,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
        }}
      >
        <span>Open source · active development</span>
        <span>quinton.dev/tailored-ai</span>
      </div>
    </div>,
    size,
  );
}
