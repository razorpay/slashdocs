import { describe, expect, it } from "vitest";
import { principalColor } from "./principals";

const user = (id: string) => ({ type: "user" as const, id });

describe("principalColor", () => {
  it("gives a person the same color every time", () => {
    expect(principalColor(user("usr_1"))).toBe(principalColor(user("usr_1")));
  });

  it("tells apart ids that share a long prefix", () => {
    // The ids of the admin and the reviewer of the dev stack, which the old
    // hash gave the same color.
    const admin = user(
      "usr_oidc_cfa2f77494e2278de7e7c9f049473fe94e7d0aa101f61c495983b02d198cc44f",
    );
    const reviewer = user(
      "usr_oidc_c7ff313d3bae59aca9ff452030a334157044af77739c8498232db545fa68957c",
    );
    expect(principalColor(admin)).not.toBe(principalColor(reviewer));
  });

  it("spreads people over every color", () => {
    const colors = new Set(
      Array.from({ length: 200 }, (_, i) => principalColor(user(`usr_${i}`))),
    );
    expect(colors.size).toBe(10);
  });

  it("gives nobody a blue that looks like the selection of the reader", () => {
    const hue = (color: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
      const [max, min] = [Math.max(r, g, b), Math.min(r, g, b)];
      const part =
        max === r
          ? (g - b) / (max - min)
          : max === g
            ? 2 + (b - r) / (max - min)
            : 4 + (r - g) / (max - min);
      return (part * 60 + 360) % 360;
    };
    // The accent color of the app, light and dark, and the selection color
    // of the browser are blues at hues 207 to 218.
    for (let i = 0; i < 200; i++) {
      const h = hue(principalColor(user(`usr_${i}`)));
      expect(h < 195 || h > 245).toBe(true);
    }
  });
});
