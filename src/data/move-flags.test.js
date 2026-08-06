import { describe, it, expect } from "vitest";
import flags from "./move-flags.json";
import { ALL_MOVES, moveByName } from "./index.js";

/**
 * The flag file is baked by `npm run refresh-flags` from a second source,
 * because PokéAPI doesn't publish move flags at all. A silently empty or
 * half-written file would switch Static, Rocky Helmet and Iron Fist off
 * without anything else failing, so it gets its own guard.
 */
describe("baked move flags", () => {
  it("carries every flag the engine reads", () => {
    for (const flag of ["contact", "punch", "bite", "sound", "powder", "bullet", "pulse", "slicing", "wind", "heal"]) {
      expect(Array.isArray(flags[flag])).toBe(true);
      expect(flags[flag].length).toBeGreaterThan(0);
    }
  });

  it("agrees with the published flags on moves everyone knows", () => {
    expect(flags.contact).toContain("tackle");
    expect(flags.contact).toContain("close-combat");
    expect(flags.contact).not.toContain("earthquake");
    expect(flags.contact).not.toContain("flamethrower");
    expect(flags.punch).toContain("fire-punch");
    expect(flags.bite).toContain("crunch");
    expect(flags.sound).toContain("hyper-voice");
    expect(flags.powder).toContain("spore");
    expect(flags.bullet).toContain("shadow-ball");
    expect(flags.pulse).toContain("dragon-pulse");
  });

  it("has roughly the coverage the real flag list has", () => {
    // ~277 contact moves, 8 powder moves. A bake that lost most of the file
    // would sail past the spot checks above but not past this.
    expect(flags.contact.length).toBeGreaterThan(200);
    expect(flags.powder.length).toBe(8);
  });

  it("names only moves that exist in the dataset", () => {
    const known = new Set(ALL_MOVES.map((m) => m.slug ?? m.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")));
    for (const slugs of Object.values(flags)) {
      for (const slug of slugs) expect(known.has(slug)).toBe(true);
    }
  });

  it("attaches the flags to the move objects the app hands the sim", () => {
    // Only meaningful with the full dex baked; the sample set has no Tackle.
    const tackle = moveByName("Tackle");
    if (tackle) expect(tackle.flags).toContain("contact");
  });
});
