/**
 * The Pokédex tab's arithmetic, kept out of the component so it can be tested.
 *
 * Nothing here invents data. Everything is either a straight unit conversion of
 * what PokéAPI stores, or a fold over the type chart in typeChart.js — which,
 * like battle.js, is the reference and stays untouched.
 */

import { TYPES, typeEffectiveness } from "./typeChart.js";

/**
 * How every attacking type fares against this Pokémon, split into the four
 * buckets a player thinks in. Hardest-hitting first inside each bucket, so the
 * 4x weaknesses sit at the top where they belong.
 *
 * Note this is the type chart only. Levitate, Wonder Guard, Thick Fat and the
 * rest do change these numbers in a real battle, and the sim applies them — but
 * a Pokémon has up to three possible abilities and only one of them in any
 * given battle, so folding them in here would state something we don't know.
 */
export function defensiveMatchups(types) {
  const buckets = { weak: [], resist: [], immune: [], neutral: [] };
  for (const type of TYPES) {
    const mult = typeEffectiveness(type, types);
    const bucket = mult === 0 ? "immune" : mult > 1 ? "weak" : mult < 1 ? "resist" : "neutral";
    buckets[bucket].push({ type, mult });
  }
  buckets.weak.sort((a, b) => b.mult - a.mult);
  buckets.resist.sort((a, b) => a.mult - b.mult);
  return buckets;
}

/** 2 → "2×", 0.5 → "½×", 0.25 → "¼×", 0 → "0×". */
export function multLabel(mult) {
  if (mult === 0.5) return "½×";
  if (mult === 0.25) return "¼×";
  return `${mult}×`;
}

/** PokéAPI stores height in decimetres. 7 → "0.7 m". */
export const formatHeight = (dm) =>
  dm == null ? null : `${(dm / 10).toFixed(1)} m`;

/** PokéAPI stores weight in hectograms. 69 → "6.9 kg". */
export const formatWeight = (hg) =>
  hg == null ? null : `${(hg / 10).toFixed(1)} kg`;

/**
 * Gender ratio. PokéAPI counts in eighths female, with -1 meaning the species
 * has no gender at all. Returns null for those rather than "0% female", which
 * would be true but misleading.
 */
export function genderSplit(rate) {
  if (rate == null || rate < 0) return null;
  const female = (rate / 8) * 100;
  return { female, male: 100 - female };
}

/** "87.5% male · 12.5% female", trimming the pointless ".0". */
export function genderLabel(rate) {
  const split = genderSplit(rate);
  if (!split) return "No gender";
  const pct = (n) => `${Number(n.toFixed(1))}%`;
  if (split.female === 0) return "Always male";
  if (split.male === 0) return "Always female";
  return `${pct(split.male)} male · ${pct(split.female)} female`;
}

/**
 * The catch rate as the games store it: 3 is a legendary you'll be there all
 * day for, 255 is a Caterpie. Worth a word of context, because the bare number
 * reads backwards to anyone who hasn't met it before.
 */
export function catchLabel(rate) {
  if (rate == null) return null;
  const ease =
    rate >= 190 ? "very easy" : rate >= 120 ? "easy" : rate >= 60 ? "tricky"
      : rate >= 25 ? "hard" : "very hard";
  return `${rate} · ${ease} to catch`;
}

/**
 * A Pokémon's evolution line arranged as rows to draw: each stage after the
 * first carries the stage it came from and how it got there. Stages are kept
 * in the order the chain lists them, which is oldest first.
 */
export function evolutionSteps(chain) {
  if (!Array.isArray(chain) || chain.length < 2) return [];
  const byId = new Map(chain.map((stage) => [stage.id, stage]));
  return chain
    .filter((stage) => stage.from != null)
    .map((stage) => ({
      from: byId.get(stage.from) ?? null,
      to: stage,
      // Several routes to the same stage (Level 30, or a Water Stone) are all
      // kept by the bake; joining them with "or" says so rather than picking.
      how: (stage.how ?? []).join(" or "),
    }))
    .filter((step) => step.from);
}

/**
 * Split a learnset into the moves it picks up as it grows and the rest.
 * `levelUp` is species.json's move-id → level map; anything missing from it is
 * still a move this Pokémon can learn, we just don't know a level for it, so it
 * goes in the second list rather than being given a made-up one.
 */
export function splitLearnset(moves, levelUp = {}) {
  const byLevel = [];
  const other = [];
  for (const move of moves) {
    const level = levelUp[move.id];
    if (level != null) byLevel.push({ move, level });
    else other.push({ move, level: null });
  }
  byLevel.sort((a, b) => a.level - b.level || a.move.name.localeCompare(b.move.name));
  other.sort((a, b) => a.move.name.localeCompare(b.move.name));
  return { byLevel, other };
}
