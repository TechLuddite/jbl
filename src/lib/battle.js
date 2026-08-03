/**
 * THE BATTLE MATH.
 *
 * ⚠️  This module is the reference implementation for the whole app and it is
 *     covered by battle.test.js. If you change anything here, the tests must
 *     still pass. If a test fails, the change is wrong — not the test.
 *
 * Two things are easy to get subtly wrong and are wrong in most naive
 * implementations:
 *
 *   1. Flooring happens at specific points inside the formula, not once at
 *      the end. Integer truncation mid-formula changes the result.
 *
 *   2. In Gen 5+, the random factor (85-100%) is applied BEFORE STAB and type
 *      effectiveness, not after. Reordering these shifts results by a few
 *      points, which looks fine until someone compares against Showdown.
 *
 * Generation targeted: Gen 5 onward (crit is 1.5x, which is Gen 6+).
 */

import { typeEffectiveness } from "./typeChart.js";
import { natureModFor } from "./natures.js";

/**
 * Gen 3+ stat formula. HP uses a different shape from every other stat.
 *
 * @param {object}  o
 * @param {number}  o.base       Base stat from the dex
 * @param {number}  [o.iv=31]    0-31
 * @param {number}  [o.ev=0]     0-252
 * @param {number}  [o.level=50]
 * @param {number}  [o.natureMod=1] 1.1 / 1 / 0.9
 * @param {boolean} [o.isHP=false]
 */
export function calcStat({ base, iv = 31, ev = 0, level = 50, natureMod = 1, isHP = false }) {
  const core = Math.floor(((2 * base + iv + Math.floor(ev / 4)) * level) / 100);
  if (isHP) return core + level + 10;
  return Math.floor((core + 5) * natureMod);
}

/** Convenience: compute all six real stats for a dex entry. */
export function calcAllStats(pokemon, { level = 50, nature = "hardy", evs = {}, ivs = {} } = {}) {
  const out = {};
  for (const key of ["hp", "atk", "def", "spa", "spd", "spe"]) {
    out[key] = calcStat({
      base: pokemon.stats[key],
      iv: ivs[key] ?? 31,
      ev: evs[key] ?? 0,
      level,
      natureMod: natureModFor(nature, key),
      isHP: key === "hp",
    });
  }
  return out;
}

/**
 * Gen 5+ damage. Returns every intermediate value so the UI can show its work —
 * that transparency is the point of this app, so don't collapse it to a number.
 *
 * @returns {{levelTerm:number, baseDamage:number, afterCrit:number, rolls:number[]}}
 *          rolls is always length 16, index 0 = the 85% roll, index 15 = 100%.
 */
export function calcDamage({
  level,
  power,
  atk,
  def,
  stab = 1,
  effectiveness = 1,
  crit = false,
  burn = false,
  other = 1,
}) {
  const levelTerm = Math.floor((2 * level) / 5 + 2);

  const baseDamage =
    Math.floor(Math.floor((levelTerm * power * atk) / def) / 50) + 2;

  // Crit lands before the random roll in the Gen 5+ modifier order.
  const afterCrit = crit ? Math.floor(baseDamage * 1.5) : baseDamage;

  const rolls = [];
  for (let r = 85; r <= 100; r++) {
    let d = Math.floor((afterCrit * r) / 100); // random factor
    d = Math.floor(d * stab);                  // then STAB
    d = Math.floor(d * effectiveness);         // then type
    if (burn) d = Math.floor(d * 0.5);         // then burn
    if (other !== 1) d = Math.floor(d * other); // items, screens, abilities

    // Immunity stays at zero; everything else deals at least 1.
    rolls.push(effectiveness === 0 ? 0 : Math.max(1, d));
  }

  return { levelTerm, baseDamage, afterCrit, rolls };
}

/**
 * Full matchup: dex entries in, damage range and KO maths out.
 * This is what the UI calls; calcDamage is the primitive underneath.
 */
export function resolveMatchup({
  attacker,
  defender,
  move,
  level = 50,
  attackerNature = "hardy",
  defenderNature = "hardy",
  attackerEV = 0,
  defenderEV = 0,
  crit = false,
  burn = false,
}) {
  const isPhysical = move.category === "physical";
  const atkKey = isPhysical ? "atk" : "spa";
  const defKey = isPhysical ? "def" : "spd";

  const atkStat = calcStat({
    base: attacker.stats[atkKey], ev: attackerEV, level,
    natureMod: natureModFor(attackerNature, atkKey),
  });
  const defStat = calcStat({
    base: defender.stats[defKey], ev: defenderEV, level,
    natureMod: natureModFor(defenderNature, defKey),
  });
  const defenderHP = calcStat({ base: defender.stats.hp, level, isHP: true });

  const stab = attacker.types.includes(move.type) ? 1.5 : 1;
  const effectiveness = typeEffectiveness(move.type, defender.types);

  const damage = calcDamage({
    level, power: move.power, atk: atkStat, def: defStat,
    stab, effectiveness, crit, burn,
  });

  const min = damage.rolls[0];
  const max = damage.rolls[damage.rolls.length - 1];
  const ohkoRolls = damage.rolls.filter((r) => r >= defenderHP).length;

  return {
    ...damage,
    atkKey, defKey, isPhysical,
    atkStat, defStat, defenderHP,
    stab, effectiveness,
    min, max,
    minPercent: (min / defenderHP) * 100,
    maxPercent: (max / defenderHP) * 100,
    /** Fewest hits needed if every roll is high. */
    bestCaseHits: max > 0 ? Math.ceil(defenderHP / max) : Infinity,
    /** Hits needed even on the worst rolls. */
    guaranteedHits: min > 0 ? Math.ceil(defenderHP / min) : Infinity,
    /** How many of the 16 rolls one-shot the defender. */
    ohkoRolls,
    ohkoChance: ohkoRolls / 16,
  };
}
