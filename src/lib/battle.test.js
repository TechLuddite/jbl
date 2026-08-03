import { describe, it, expect } from "vitest";
import { calcStat, calcDamage, resolveMatchup } from "./battle.js";
import { typeEffectiveness } from "./typeChart.js";
import { natureModFor } from "./natures.js";

/**
 * These tests exist to stop the battle math from drifting.
 *
 * If you are an agent and one of these fails after your change: your change is
 * wrong. Do not update the expected values to match your output. The numbers
 * below were derived by hand from the published formulas.
 */

const CHARIZARD = { name: "Charizard", types: ["fire", "flying"],
  stats: { hp: 78, atk: 84, def: 78, spa: 109, spd: 85, spe: 100 } };
const SWAMPERT = { name: "Swampert", types: ["water", "ground"],
  stats: { hp: 100, atk: 110, def: 90, spa: 85, spd: 90, spe: 60 } };
const SNORLAX = { name: "Snorlax", types: ["normal"],
  stats: { hp: 160, atk: 110, def: 65, spa: 65, spd: 110, spe: 30 } };

const FLAMETHROWER = { name: "Flamethrower", type: "fire", power: 90, category: "special" };
const EARTHQUAKE = { name: "Earthquake", type: "ground", power: 100, category: "physical" };

describe("calcStat", () => {
  it("computes a max-investment special attacker at level 50", () => {
    // Charizard, base SpA 109, 31 IV, 252 EV, Modest, level 50.
    // core = floor((218 + 31 + 63) * 50 / 100) = 156
    // stat = floor((156 + 5) * 1.1) = 177
    expect(calcStat({ base: 109, iv: 31, ev: 252, level: 50, natureMod: 1.1 })).toBe(177);
  });

  it("uses the separate HP formula", () => {
    // Snorlax, base HP 160, 31 IV, 0 EV, level 100.
    // floor((320 + 31 + 0) * 100 / 100) + 100 + 10 = 461
    expect(calcStat({ base: 160, level: 100, isHP: true })).toBe(461);
  });

  it("never applies a nature modifier to HP", () => {
    const withNature = calcStat({ base: 100, level: 50, natureMod: 1.1, isHP: true });
    const without = calcStat({ base: 100, level: 50, natureMod: 1, isHP: true });
    expect(withNature).toBe(without);
  });

  it("floors EVs in groups of four", () => {
    // 4 EVs and 7 EVs both contribute floor(ev/4) = 1
    expect(calcStat({ base: 100, ev: 4, level: 50 }))
      .toBe(calcStat({ base: 100, ev: 7, level: 50 }));
  });
});

describe("typeEffectiveness", () => {
  it("multiplies across both defending types", () => {
    // Fire vs Water/Ground: resisted by Water, neutral vs Ground.
    // Ground does NOT resist Fire — an easy one to get wrong.
    expect(typeEffectiveness("fire", ["water", "ground"])).toBe(0.5);
    // Fire vs Water/Rock is the genuine double resist.
    expect(typeEffectiveness("fire", ["water", "rock"])).toBe(0.25);
  });

  it("reaches 4x on doubly-weak dual types", () => {
    // Rock vs Fire/Flying
    expect(typeEffectiveness("rock", ["fire", "flying"])).toBe(4);
  });

  it("respects immunities", () => {
    expect(typeEffectiveness("electric", ["ground"])).toBe(0);
    expect(typeEffectiveness("normal", ["ghost"])).toBe(0);
    expect(typeEffectiveness("dragon", ["fairy"])).toBe(0);
    expect(typeEffectiveness("poison", ["steel"])).toBe(0);
  });

  it("keeps an immunity even when the other type is weak", () => {
    // Ground hits Electric 2x but Flying is immune -> 0
    expect(typeEffectiveness("ground", ["electric", "flying"])).toBe(0);
  });
});

describe("natureModFor", () => {
  it("raises, lowers, and leaves neutral stats alone", () => {
    expect(natureModFor("modest", "spa")).toBe(1.1);
    expect(natureModFor("modest", "atk")).toBe(0.9);
    expect(natureModFor("modest", "spe")).toBe(1);
    expect(natureModFor("hardy", "atk")).toBe(1);
  });
});

describe("calcDamage", () => {
  it("always returns exactly 16 rolls, low to high", () => {
    const { rolls } = calcDamage({ level: 50, power: 90, atk: 177, def: 110 });
    expect(rolls).toHaveLength(16);
    expect(rolls[0]).toBeLessThanOrEqual(rolls[15]);
  });

  it("matches a hand-computed resisted STAB hit", () => {
    // Charizard Flamethrower vs Swampert, level 50, 252 SpA Modest, 0 SpD.
    //   levelTerm  = floor(2*50/5 + 2)                  = 22
    //   baseDamage = floor(floor(22*90*177/110)/50) + 2 = 65
    //   effectiveness = Fire vs Water/Ground            = 0.5
    //   100% roll = 65 -> STAB floor(65*1.5)=97 -> type floor(97*0.5)=48
    //   85%  roll = floor(65*0.85)=55 -> floor(55*1.5)=82 -> floor(82*0.5)=41
    const { baseDamage, rolls } = calcDamage({
      level: 50, power: 90, atk: 177, def: 110, stab: 1.5, effectiveness: 0.5,
    });
    expect(baseDamage).toBe(65);
    expect(rolls[0]).toBe(41);
    expect(rolls[15]).toBe(48);
  });

  it("returns straight zeros against an immunity", () => {
    const { rolls } = calcDamage({
      level: 50, power: 100, atk: 200, def: 100, effectiveness: 0,
    });
    expect(rolls.every((r) => r === 0)).toBe(true);
  });

  it("floors every hit at 1 when not immune", () => {
    const { rolls } = calcDamage({
      level: 1, power: 10, atk: 5, def: 500, effectiveness: 0.25,
    });
    expect(rolls.every((r) => r >= 1)).toBe(true);
  });

  it("applies the random roll before STAB, not after", () => {
    // Gen 5+ order is: random, then STAB, then type.
    // base 65 -> correct: floor(floor(65*0.85) * 1.5) = floor(55*1.5) = 82
    const { baseDamage, rolls } = calcDamage({
      level: 50, power: 90, atk: 177, def: 110, stab: 1.5,
    });
    expect(baseDamage).toBe(65);
    expect(rolls[0]).toBe(Math.floor(Math.floor(baseDamage * 0.85) * 1.5));
  });

  it("increases damage on a crit", () => {
    const normal = calcDamage({ level: 50, power: 90, atk: 177, def: 110 });
    const critical = calcDamage({ level: 50, power: 90, atk: 177, def: 110, crit: true });
    expect(critical.rolls[15]).toBeGreaterThan(normal.rolls[15]);
  });

  it("roughly halves physical damage under burn", () => {
    const normal = calcDamage({ level: 50, power: 100, atk: 200, def: 100 });
    const burned = calcDamage({ level: 50, power: 100, atk: 200, def: 100, burn: true });
    expect(burned.rolls[15]).toBeLessThanOrEqual(Math.ceil(normal.rolls[15] / 2));
  });
});

describe("resolveMatchup", () => {
  it("picks Attack/Defense for physical moves and SpA/SpD for special", () => {
    const special = resolveMatchup({
      attacker: CHARIZARD, defender: SWAMPERT, move: FLAMETHROWER,
    });
    expect(special.atkKey).toBe("spa");
    expect(special.defKey).toBe("spd");

    const physical = resolveMatchup({
      attacker: SWAMPERT, defender: CHARIZARD, move: EARTHQUAKE,
    });
    expect(physical.atkKey).toBe("atk");
    expect(physical.defKey).toBe("def");
  });

  it("reproduces the hand-computed Charizard vs Swampert numbers", () => {
    const r = resolveMatchup({
      attacker: CHARIZARD, defender: SWAMPERT, move: FLAMETHROWER,
      level: 50, attackerNature: "modest", attackerEV: 252,
    });
    expect(r.atkStat).toBe(177);
    expect(r.defStat).toBe(110);
    expect(r.defenderHP).toBe(175);
    expect(r.stab).toBe(1.5);
    expect(r.effectiveness).toBe(0.5);
    expect(r.min).toBe(41);
    expect(r.max).toBe(48);
  });

  it("reports no OHKO chance when the move barely dents the target", () => {
    const r = resolveMatchup({
      attacker: CHARIZARD, defender: SNORLAX, move: FLAMETHROWER, level: 50,
    });
    expect(r.ohkoRolls).toBe(0);
    expect(r.guaranteedHits).toBeGreaterThan(1);
  });

  it("treats Earthquake against a Flying type as a no-op", () => {
    const r = resolveMatchup({
      attacker: SWAMPERT, defender: CHARIZARD, move: EARTHQUAKE, level: 50,
    });
    expect(r.effectiveness).toBe(0);
    expect(r.max).toBe(0);
    expect(r.guaranteedHits).toBe(Infinity);
  });
});
