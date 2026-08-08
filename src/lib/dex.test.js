import { describe, it, expect } from "vitest";
import {
  defensiveMatchups, multLabel, formatHeight, formatWeight, genderSplit,
  genderLabel, catchLabel, evolutionSteps, splitLearnset,
} from "./dex.js";

/**
 * The Pokédex's arithmetic. The matchup numbers below were worked out by hand
 * from the type chart, the same way battle.test.js does it — if one of these
 * fails, the code is wrong, not the expectation.
 */

describe("defensiveMatchups", () => {
  it("multiplies both of a dual type's weaknesses together", () => {
    // Charizard is Fire/Flying. Rock hits Fire 2x and Flying 2x → 4x.
    const { weak } = defensiveMatchups(["fire", "flying"]);
    expect(weak.find((w) => w.type === "rock").mult).toBe(4);
    // Water is 2x on Fire and neutral on Flying → 2x.
    expect(weak.find((w) => w.type === "water").mult).toBe(2);
    // The hardest hit sorts to the front.
    expect(weak[0].type).toBe("rock");
  });

  it("stacks resistances the same way", () => {
    // Grass is 0.5x on Fire and 0.5x on Flying → 0.25x.
    const { resist } = defensiveMatchups(["fire", "flying"]);
    expect(resist.find((r) => r.type === "grass").mult).toBe(0.25);
    expect(resist[0].mult).toBe(0.25);
  });

  it("finds the immunity a dual type inherits from one half", () => {
    // Ground does nothing to Flying, so Charizard is immune.
    const { immune } = defensiveMatchups(["fire", "flying"]);
    expect(immune.map((i) => i.type)).toEqual(["ground"]);
  });

  it("puts every type in exactly one bucket", () => {
    const b = defensiveMatchups(["steel", "fairy"]);
    const all = [...b.weak, ...b.resist, ...b.immune, ...b.neutral];
    expect(all).toHaveLength(18);
    expect(new Set(all.map((e) => e.type)).size).toBe(18);
  });

  it("handles a single type", () => {
    // Normal resists nothing, is immune to nothing, and only Fighting beats it.
    const b = defensiveMatchups(["normal"]);
    expect(b.weak).toEqual([{ type: "fighting", mult: 2 }]);
    expect(b.resist).toEqual([]);
    expect(b.immune).toEqual([{ type: "ghost", mult: 0 }]);
  });
});

describe("multLabel", () => {
  it("writes the fractions the way a player says them", () => {
    expect(multLabel(4)).toBe("4×");
    expect(multLabel(2)).toBe("2×");
    expect(multLabel(0.5)).toBe("½×");
    expect(multLabel(0.25)).toBe("¼×");
    expect(multLabel(0)).toBe("0×");
  });
});

describe("sizes", () => {
  it("converts decimetres and hectograms", () => {
    expect(formatHeight(7)).toBe("0.7 m"); // Bulbasaur
    expect(formatWeight(69)).toBe("6.9 kg");
    expect(formatHeight(170)).toBe("17.0 m"); // Wailord
    expect(formatWeight(3985)).toBe("398.5 kg");
  });

  it("says nothing rather than zero when the size is unknown", () => {
    expect(formatHeight(null)).toBe(null);
    expect(formatWeight(undefined)).toBe(null);
  });
});

describe("gender", () => {
  it("reads PokéAPI's eighths", () => {
    expect(genderSplit(1)).toEqual({ female: 12.5, male: 87.5 });
    expect(genderSplit(4)).toEqual({ female: 50, male: 50 });
    expect(genderSplit(8)).toEqual({ female: 100, male: 0 });
  });

  it("treats -1 as genderless rather than 0% female", () => {
    expect(genderSplit(-1)).toBe(null);
    expect(genderLabel(-1)).toBe("No gender");
  });

  it("labels the one-sided cases plainly", () => {
    expect(genderLabel(0)).toBe("Always male");
    expect(genderLabel(8)).toBe("Always female");
    expect(genderLabel(1)).toBe("87.5% male · 12.5% female");
    expect(genderLabel(4)).toBe("50% male · 50% female");
  });
});

describe("catchLabel", () => {
  it("says which end of the scale the number is at", () => {
    expect(catchLabel(255)).toBe("255 · very easy to catch");
    expect(catchLabel(45)).toBe("45 · hard to catch");
    expect(catchLabel(3)).toBe("3 · very hard to catch");
  });
});

describe("evolutionSteps", () => {
  const bulbasaur = [
    { id: 1, name: "Bulbasaur", from: null, how: [] },
    { id: 2, name: "Ivysaur", from: 1, how: ["Level 16"] },
    { id: 3, name: "Venusaur", from: 2, how: ["Level 32"] },
  ];

  it("pairs each stage with the one it came from", () => {
    const steps = evolutionSteps(bulbasaur);
    expect(steps).toHaveLength(2);
    expect(steps[0].from.name).toBe("Bulbasaur");
    expect(steps[0].to.name).toBe("Ivysaur");
    expect(steps[0].how).toBe("Level 16");
  });

  it("has nothing to draw for a Pokémon that doesn't evolve", () => {
    expect(evolutionSteps([{ id: 132, name: "Ditto", from: null, how: [] }])).toEqual([]);
    expect(evolutionSteps([])).toEqual([]);
    expect(evolutionSteps(undefined)).toEqual([]);
  });

  it("keeps every route to a stage instead of picking one", () => {
    const steps = evolutionSteps([
      { id: 133, name: "Eevee", from: null, how: [] },
      { id: 700, name: "Sylveon", from: 133, how: ["Level up knowing a Fairy move", "Level up with high affection"] },
    ]);
    expect(steps[0].how).toBe("Level up knowing a Fairy move or Level up with high affection");
  });

  it("draws a branching line as one step per branch", () => {
    const steps = evolutionSteps([
      { id: 133, name: "Eevee", from: null, how: [] },
      { id: 134, name: "Vaporeon", from: 133, how: ["Use a Water Stone"] },
      { id: 135, name: "Jolteon", from: 133, how: ["Use a Thunder Stone"] },
    ]);
    expect(steps.map((s) => s.to.name)).toEqual(["Vaporeon", "Jolteon"]);
    expect(steps.every((s) => s.from.name === "Eevee")).toBe(true);
  });
});

describe("splitLearnset", () => {
  const moves = [
    { id: 33, name: "Tackle" },
    { id: 22, name: "Vine Whip" },
    { id: 14, name: "Swords Dance" },
    { id: 45, name: "Growl" },
  ];

  it("orders the level-up moves by level, not by id", () => {
    const { byLevel } = splitLearnset(moves, { 33: 1, 22: 13, 45: 1 });
    expect(byLevel.map((r) => [r.move.name, r.level])).toEqual([
      ["Growl", 1], ["Tackle", 1], ["Vine Whip", 13],
    ]);
  });

  it("keeps moves with no known level rather than inventing one", () => {
    const { other } = splitLearnset(moves, { 33: 1, 22: 13, 45: 1 });
    expect(other.map((r) => r.move.name)).toEqual(["Swords Dance"]);
    expect(other[0].level).toBe(null);
  });

  it("puts everything in the second list when no levels are known at all", () => {
    const { byLevel, other } = splitLearnset(moves, {});
    expect(byLevel).toEqual([]);
    expect(other).toHaveLength(4);
  });
});
