import { RazorSense } from "@/vendor/razorsense";
import { cn } from "@/lib/cn";
import { useResolvedTheme } from "@/lib/theme";
import { usePrefersReducedMotion } from "@/lib/use-media-query";

// The two framings Slash uses: the halo behind the home hero, and the closer
// zoomed wash at the top of every other page. Both hold one paused frame and
// move only the light sweep.
const FRAMING = {
  halo: {
    paused: true,
    startTime: 8,
    animateLightIndependently: true,
    lightStartFrame: 0,
    slitAngle: (20 * Math.PI) / 180,
    numSegments: 20,
    zoom: 3,
  },
  page: { preset: "zoomed" },
} as const;

// Slash's scrim for the dark halo: it dims the middle, so text over it reads.
const DARK_SCRIM =
  "radial-gradient(56% 78% at 50% 62%,#000000f2,#000000bf 40%,#00000059 64%,#0000 84%),radial-gradient(52% 50% at 50% 100%,#000000e6,#00000080 55%,#0000 80%)";

// RazorSense behind the top of a page. The parent must be `relative isolate`.
// The blend mode drops the canvas plate: white multiplies away in light mode,
// and black screens away in dark mode.
export function RazorSenseBackdrop({
  framing = "page",
  className,
}: {
  framing?: keyof typeof FRAMING;
  className?: string;
}) {
  const dark = useResolvedTheme() === "dark";
  if (usePrefersReducedMotion()) return null;
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-x-0 top-0 -z-10 h-[520px] overflow-hidden mix-blend-multiply [mask-image:linear-gradient(black_45%,transparent_92%)] dark:mix-blend-screen",
        className,
      )}
    >
      <RazorSense
        assetsPath={`${import.meta.env.BASE_URL}razorsense`}
        {...FRAMING[framing]}
      />
      {dark && framing === "halo" && (
        <div className="absolute inset-0" style={{ background: DARK_SCRIM }} />
      )}
    </div>
  );
}
