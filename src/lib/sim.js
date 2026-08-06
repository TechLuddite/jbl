/**
 * THE BATTLE SIM ENGINE.
 *
 * Same law as battle.js: this file is covered by sim.test.js with expected
 * values derived by hand from the published mechanics. If a test fails after
 * your change, the change is wrong — fix the code, not the test.
 *
 * Design rules:
 *   - All randomness goes through the injected `rng` object, so tests can
 *     script every coin flip and damage roll exactly.
 *   - Damage numbers come from calcDamage in battle.js, which stays untouched.
 *     This module only decides WHICH numbers to feed it.
 *   - playTurn never mutates its input; it clones, mutates the clone, and
 *     returns it with a list of structured events for the UI to narrate.
 *
 * Mechanics targeted: modern (Gen 6+) values — crit is 1/24 at 1.5x,
 * paralysis halves Speed and can't touch Electric types, burn halves physical
 * damage, confusion self-hits a third of the time.
 *
 * Slice 2 added weather, entry hazards, and a CURATED set of held items and
 * abilities (see ITEMS and ABILITIES below) — correctness over coverage, the
 * set grows as each addition can be tested. Modifier order inside a hit is
 * fixed and documented at executeMove; tests derive their numbers from it.
 *
 * Slice 3 is everything that spans more than one turn, because a battle where
 * Solar Beam fires instantly and Outrage never locks you in is not the game:
 *   - two-turn charge moves, with semi-invulnerability and Power Herb
 *   - recharge moves (Hyper Beam and friends)
 *   - rampage locks (Outrage) and the confusion they end in
 *   - confusion itself, and the momentum moves (Rollout, Fury Cutter)
 *   - partial trapping (Bind, Fire Spin...) and the switch block it applies
 *   - Leech Seed, Wish, Future Sight, Perish Song, Yawn
 *   - Taunt, Encore, Disable
 *   - Reflect / Light Screen / Aurora Veil, Tailwind, Trick Room
 *   - Protect and Substitute
 *   - the first-turn-only moves (Fake Out) and Focus Punch
 * Every one of those carries a counter, and the counters all tick in one
 * documented place: endOfTurn.
 *
 * Not yet implemented (tracked in ROADMAP.md): contact-triggered items and
 * abilities — which is why the Protect variants (Spiky Shield, King's Shield…)
 * block the move but skip their punish riders — terrain, Bide, infatuation,
 * and Torment. Unknown move ailments and unmodeled abilities are ignored
 * rather than guessed at.
 */

import { calcAllStats, calcDamage } from "./battle.js";
import { typeEffectiveness } from "./typeChart.js";

/* ---------------------------------------------------------------- RNG ---- */

/**
 * Deterministic PRNG (mulberry32). Everything the engine randomises goes
 * through these named methods so tests can substitute scripted versions.
 */
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  const next = () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    /** True with probability p (0-1). */
    chance: (p) => next() < p,
    /** Integer in [0, n). */
    int: (n) => Math.floor(next() * n),
    /** Which of the 16 damage rolls landed: 0 = 85%, 15 = 100%. */
    rollIndex: () => Math.floor(next() * 16),
  };
}

/* ------------------------------------------------------------- Battler --- */

/**
 * Everything that lives on a Pokémon only while it is on the field. All of it
 * is wiped when it switches out — that is the whole point of switching, and
 * several of the mechanics below (trapping, Perish Song) exist to stop you.
 */
function freshVolatiles() {
  return {
    confusion: 0,          // turns of confusion left
    charge: null,          // { moveIndex, slug, invuln } mid two-turn move
    recharge: false,       // spent the next turn getting its breath back
    locked: null,          // { moveIndex, turns, kind: "rampage" | "rollout" }
    momentum: null,        // { slug, hits } for Rollout / Fury Cutter power
    trap: null,            // { turns, by } — Bind, Fire Spin, Mean Look...
    seeded: false,         // Leech Seed
    perish: null,          // Perish Song countdown, faints at 0
    drowsy: 0,             // Yawn countdown, sleeps at 0
    taunt: 0,              // turns of status moves being off the table
    encore: null,          // { moveIndex, turns }
    disable: null,         // { moveIndex, turns }
    sub: 0,                // Substitute HP remaining
    protect: false,        // protected itself this turn
    protectedWith: null,   // which shield — they punish differently
    protectStreak: 0,      // consecutive protects, for the failure odds
    roosted: false,        // gave up its Flying type for the turn
    lastMoveIndex: null,   // what Encore and Disable latch onto
    turnsActive: 0,        // 1 on the turn it arrives — Fake Out reads this
    tookDamage: false,     // this turn, for Focus Punch
    unburdened: false,     // used up its held item, so Unburden is live
    repeat: null,          // { slug, uses } — Metronome's escalating boost
    unnerved: false,       // an Unnerve foe is staring at it, so no berries
  };
}

/**
 * Build a battle-ready Pokémon from a dex entry and a loadout.
 * `moves` is an array of move objects from the dex (1-4 of them).
 */
export function createBattler(pokemon, {
  level = 50, nature = "hardy", evs = {}, ivs = {}, moves = [],
  item = null, ability = null,
} = {}) {
  const stats = calcAllStats(pokemon, { level, nature, evs, ivs });
  return {
    pokemon: {
      id: pokemon.id, name: pokemon.name, types: pokemon.types,
      stats: pokemon.stats, sprite: pokemon.sprite,
    },
    level, nature,
    stats,
    maxHP: stats.hp,
    hp: stats.hp,
    moves: moves.map((m) => ({ move: m, pp: m.pp ?? 10 })),
    item: item && ITEMS[item] ? item : null,                 // unmodeled → null
    ability: ability && ABILITIES[ability] ? ability : null, // unmodeled → null
    status: null,          // burn | paralysis | sleep | freeze | poison | toxic
    sleepTurns: 0,         // turns of sleep remaining
    toxicCounter: 0,       // ramps 1, 2, 3... while badly poisoned
    stages: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, acc: 0, eva: 0 },
    flinched: false,
    choiceLock: null,      // move slot index a Choice item has locked in
    balloonPopped: false,
    berryUsed: false,
    vol: freshVolatiles(),
  };
}

/** A fresh side of the field: hazards underfoot, screens overhead. */
function freshSide(battlers) {
  return {
    battlers,
    active: 0,
    hazards: { stealthRock: false, spikes: 0, toxicSpikes: 0, stickyWeb: false },
    screens: { reflect: 0, lightScreen: 0, auroraVeil: 0 },
    tailwind: 0,
    wish: null,        // { turns, amount }
    future: null,      // { turns, move, user } — Future Sight / Doom Desire
  };
}

/** Two teams in, a fresh battle state out. Each team is 1-6 battlers. */
export function createBattle(teamA, teamB) {
  return {
    teams: [freshSide(teamA), freshSide(teamB)],
    weather: { kind: null, turns: 0 },
    trickRoom: 0,
    turn: 1,
    winner: null,           // 0 | 1 once a whole team has fainted
    pendingReplacement: [false, false],
  };
}

/**
 * Fire the leads' entry effects (weather abilities, Intimidate). Call once
 * after createBattle, before the first playTurn. Kept separate so tests can
 * build bare states without entry side-effects.
 */
export function openBattle(prevState) {
  const state = structuredClone(prevState);
  const events = [];
  const order = effectiveSpeed(active(state, 0)) >= effectiveSpeed(active(state, 1)) ? [0, 1] : [1, 0];
  for (const side of order) applyEntryEffects(state, side, events);
  return { state, events };
}

/* ------------------------------------------------------------ Helpers ---- */

const active = (state, side) => {
  const team = state.teams[side];
  return team.battlers[team.active];
};

/**
 * Battle-stat stage multiplier: (2+s)/2 up, 2/(2-s) down. Accuracy and
 * evasion use 3 as the base instead of 2 — that difference is real, not a typo.
 */
export function stageMult(stage, base = 2) {
  return stage >= 0 ? (base + stage) / base : base / (base - stage);
}

/**
 * Effective Speed: stage-modified, then the Speed abilities, then Tailwind,
 * then Choice Scarf, then halved by paralysis. Flooring after each step, so
 * the order is load-bearing.
 *
 * `team` is optional — without it Tailwind simply isn't in play — and so is
 * `weather`, which is what Swift Swim and the other three read.
 */
export function effectiveSpeed(b, team = null, weather = null) {
  let spe = Math.floor(b.stats.spe * stageMult(b.stages.spe));
  if (weather && WEATHER_SPEED_ABILITY[b.ability] === weather) spe = Math.floor(spe * 2);
  if (b.ability === "quick-feet" && b.status) spe = Math.floor(spe * 1.5);
  if (b.ability === "unburden" && b.vol.unburdened) spe = Math.floor(spe * 2);
  if (team?.tailwind > 0) spe = Math.floor(spe * 2);
  if (b.item === "choice-scarf") spe = Math.floor(spe * 1.5);
  // Quick Feet shrugs off the paralysis Speed cut as well as boosting.
  if (b.status === "paralysis" && b.ability !== "quick-feet") spe = Math.floor(spe / 2);
  return spe;
}

/**
 * The types a Pokémon defends with right now. Roost puts a Flying type on the
 * ground for the turn, which is the only thing that moves this off the dex.
 */
function defendingTypes(b) {
  if (!b.vol.roosted) return b.pokemon.types;
  const grounded = b.pokemon.types.filter((t) => t !== "flying");
  return grounded.length ? grounded : ["normal"]; // pure Flying becomes Normal
}

/** Nothing in the formula may reach zero — a 0 attack stat divides by nothing. */
const def0 = (n) => Math.max(1, n);

/**
 * Stage-modified attacking/defending stat, with the crit exemptions.
 * `ignoreStages` is Unaware on the other side: it doesn't reset the stages,
 * it just refuses to look at them.
 */
function battleStat(b, key, { crit = false, attacking = false, ignoreStages = false } = {}) {
  let stage = ignoreStages ? 0 : b.stages[key];
  // A crit ignores the attacker's drops and the defender's boosts.
  if (crit) stage = attacking ? Math.max(0, stage) : Math.min(0, stage);
  return Math.floor(b.stats[key] * stageMult(stage));
}

/**
 * The attacking stat fed to the damage formula. Modifier order is fixed:
 * stages → Choice item ×1.5 → Huge/Pure Power ×2 → Guts ×1.5 → Hustle ×1.5 →
 * Solar Power ×1.5 → Defeatist ×0.5, flooring after each step. Tests derive
 * their numbers from exactly this order.
 */
function attackStat(user, key, { crit, isPhysical, weather = null, ignoreStages = false }) {
  let atk = battleStat(user, key, { crit, attacking: true, ignoreStages });
  if (isPhysical && user.item === "choice-band") atk = Math.floor(atk * 1.5);
  if (!isPhysical && user.item === "choice-specs") atk = Math.floor(atk * 1.5);
  if (isPhysical && (user.ability === "huge-power" || user.ability === "pure-power")) atk *= 2;
  if (isPhysical && user.ability === "guts" && user.status) atk = Math.floor(atk * 1.5);
  if (isPhysical && user.ability === "hustle") atk = Math.floor(atk * 1.5);
  if (!isPhysical && user.ability === "solar-power" && weather === "sun") atk = Math.floor(atk * 1.5);
  if (user.ability === "defeatist" && user.hp * 2 <= user.maxHP) atk = Math.floor(atk * 0.5);
  return def0(atk);
}

/**
 * The defending stat: stages → Assault Vest → Fur Coat → Marvel Scale →
 * weather boosts, floored each step. `ability` is the defender's ability as
 * the attacker sees it, so Mold Breaker walks through Fur Coat.
 */
function defenseStat(foe, key, { crit, weather, ignoreStages = false, ability = foe.ability }) {
  let def = battleStat(foe, key, { crit, attacking: false, ignoreStages });
  if (key === "spd" && foe.item === "assault-vest") def = Math.floor(def * 1.5);
  if (key === "def" && ability === "fur-coat") def *= 2;
  if (key === "def" && ability === "marvel-scale" && foe.status) def = Math.floor(def * 1.5);
  if (key === "spd" && weather === "sand" && foe.pokemon.types.includes("rock")) def = Math.floor(def * 1.5);
  if (key === "def" && weather === "snow" && foe.pokemon.types.includes("ice")) def = Math.floor(def * 1.5);
  return def0(def);
}

/** Statuses a type simply cannot have. */
const STATUS_IMMUNE = {
  burn: ["fire"],
  paralysis: ["electric"],
  poison: ["poison", "steel"],
  toxic: ["poison", "steel"],
  freeze: ["ice"],
};

/** PokéAPI ailment name → our status key. Unknowns return null (ignored). */
function ailmentToStatus(ailment, moveSlug) {
  if (ailment === "poison" && moveSlug === "toxic") return "toxic";
  if (["burn", "paralysis", "sleep", "freeze", "poison"].includes(ailment)) {
    return ailment;
  }
  return null;
}

/** Ailments that are volatile (they live on the field, not on the Pokémon). */
const VOLATILE_AILMENTS = new Set(["confusion", "trap", "leech-seed", "perish-song", "yawn", "disable"]);

/**
 * Damaging moves whose stat changes hit the USER, not the target.
 *
 * The dataset almost always tells us this itself: PokéAPI files "damage then
 * change the USER's stats" under the meta category `damage-raise`, even when
 * the change is a drop (Close Combat, Draco Meteor). `damage-lower` is the one
 * that points at the target. This list is only the fallback for the handful of
 * newer moves PokéAPI has no meta block for at all.
 */
const SELF_STAT_MOVES = new Set([
  "make-it-rain", "headlong-rush", "armor-cannon", "clangorous-soul",
]);

/** True when this damaging move's stat changes land on its own user. */
function statChangesHitUser(move) {
  const cat = move.meta?.category;
  return cat === "damage-raise" || cat === "damage+raise" || SELF_STAT_MOVES.has(move.slug);
}

/* ------------------------------------------------- items & abilities ----- */

/**
 * The held items the sim offers. Every entry here is fully modeled and covered
 * by a test; anything not on this list simply cannot be picked. `group` is
 * what the picker sorts them under.
 *
 * The type-boosting items and the type-resist berries look like a lot of
 * entries for very little code, and that is exactly the point: one mechanic
 * each, eighteen slots filled.
 */
export const ITEMS = {
  // --- recovery ---
  "leftovers":    { group: "Recovery", name: "Leftovers",    desc: "Heals 1/16 max HP every turn." },
  "black-sludge": { group: "Recovery", name: "Black Sludge", desc: "Heals a Poison type 1/16 a turn; hurts anything else 1/8." },
  "sitrus-berry": { group: "Recovery", name: "Sitrus Berry", desc: "Heals 1/4 max HP once, below half." },
  "oran-berry":   { group: "Recovery", name: "Oran Berry",   desc: "Heals 10 HP once, below half." },
  "lum-berry":    { group: "Recovery", name: "Lum Berry",    desc: "Cures any status or confusion the moment it lands. One use." },
  "shell-bell":   { group: "Recovery", name: "Shell Bell",   desc: "Heals 1/8 of the damage it deals." },

  // --- attacking ---
  "choice-band":  { group: "Attack",  name: "Choice Band",   desc: "1.5× Attack, but locked into one move." },
  "choice-specs": { group: "Attack",  name: "Choice Specs",  desc: "1.5× Sp. Atk, but locked into one move." },
  "choice-scarf": { group: "Attack",  name: "Choice Scarf",  desc: "1.5× Speed, but locked into one move." },
  "life-orb":     { group: "Attack",  name: "Life Orb",      desc: "1.3× damage, costs 1/10 max HP per attack." },
  "expert-belt":  { group: "Attack",  name: "Expert Belt",   desc: "1.2× on super effective hits." },
  "muscle-band":  { group: "Attack",  name: "Muscle Band",   desc: "1.1× on physical moves." },
  "wise-glasses": { group: "Attack",  name: "Wise Glasses",  desc: "1.1× on special moves." },
  "scope-lens":   { group: "Attack",  name: "Scope Lens",    desc: "Critical hits come one stage more often." },
  "razor-claw":   { group: "Attack",  name: "Razor Claw",    desc: "Critical hits come one stage more often." },
  "kings-rock":   { group: "Attack",  name: "King's Rock",   desc: "10% chance to make the target flinch." },
  "metronome":    { group: "Attack",  name: "Metronome",     desc: "Same move again and again: +20% power each time, up to 2×." },
  "big-root":     { group: "Attack",  name: "Big Root",      desc: "Draining moves heal 1.3× as much." },
  "power-herb":   { group: "Attack",  name: "Power Herb",    desc: "Skips the charge turn of a two-turn move. One use." },

  // --- defending ---
  "assault-vest":      { group: "Defence", name: "Assault Vest",      desc: "1.5× Sp. Def." },
  "focus-sash":        { group: "Defence", name: "Focus Sash",        desc: "Survive a KO from full HP with 1 HP. One use." },
  "air-balloon":       { group: "Defence", name: "Air Balloon",       desc: "Immune to Ground until hit." },
  "rocky-helmet":      { group: "Defence", name: "Rocky Helmet",      desc: "Anything that touches it loses 1/6 max HP." },
  "heavy-duty-boots":  { group: "Defence", name: "Heavy-Duty Boots",  desc: "Walks straight past Stealth Rock, Spikes and Sticky Web." },
  "bright-powder":     { group: "Defence", name: "Bright Powder",     desc: "Moves aimed at it are 10% likelier to miss." },
  "safety-goggles":    { group: "Defence", name: "Safety Goggles",    desc: "Immune to powder moves and to the sandstorm." },
  "weakness-policy":   { group: "Defence", name: "Weakness Policy",   desc: "Taking a super effective hit gives +2 Attack and +2 Sp. Atk. One use." },
  "white-herb":        { group: "Defence", name: "White Herb",        desc: "Undoes any lowered stats, once." },
  "mental-herb":       { group: "Defence", name: "Mental Herb",       desc: "Shakes off Taunt, Encore or Disable, once." },

  // --- status and the field ---
  "flame-orb":   { group: "Field", name: "Flame Orb",   desc: "Burns its own holder at the end of the turn." },
  "toxic-orb":   { group: "Field", name: "Toxic Orb",   desc: "Badly poisons its own holder at the end of the turn." },
  "light-clay":  { group: "Field", name: "Light Clay",  desc: "Reflect and Light Screen last 8 turns instead of 5." },
  "damp-rock":   { group: "Field", name: "Damp Rock",   desc: "Rain it sets up lasts 8 turns." },
  "heat-rock":   { group: "Field", name: "Heat Rock",   desc: "Sun it sets up lasts 8 turns." },
  "smooth-rock": { group: "Field", name: "Smooth Rock", desc: "Sandstorm it sets up lasts 8 turns." },
  "icy-rock":    { group: "Field", name: "Icy Rock",    desc: "Snow it sets up lasts 8 turns." },
  "quick-claw":  { group: "Field", name: "Quick Claw",  desc: "20% chance to move first whatever the Speed." },
};

/** Type-boosting held items: 1.2× on that type. One line each, eighteen types. */
const TYPE_BOOST_ITEM = {
  "charcoal": "fire", "mystic-water": "water", "miracle-seed": "grass",
  "magnet": "electric", "never-melt-ice": "ice", "black-belt": "fighting",
  "poison-barb": "poison", "soft-sand": "ground", "sharp-beak": "flying",
  "twisted-spoon": "psychic", "silver-powder": "bug", "hard-stone": "rock",
  "spell-tag": "ghost", "dragon-fang": "dragon", "black-glasses": "dark",
  "metal-coat": "steel", "silk-scarf": "normal", "fairy-feather": "fairy",
};

/**
 * Type-resist berries: eaten on the way in to halve one super effective hit.
 * Chilan Berry is the odd one — Normal is never super effective, so it halves
 * any Normal move at all.
 */
const RESIST_BERRY = {
  "occa-berry": "fire", "passho-berry": "water", "wacan-berry": "electric",
  "rindo-berry": "grass", "yache-berry": "ice", "chople-berry": "fighting",
  "kebia-berry": "poison", "shuca-berry": "ground", "coba-berry": "flying",
  "payapa-berry": "psychic", "tanga-berry": "bug", "charti-berry": "rock",
  "kasib-berry": "ghost", "haban-berry": "dragon", "colbur-berry": "dark",
  "babiri-berry": "steel", "roseli-berry": "fairy", "chilan-berry": "normal",
};

const TYPE_ITEM_NAME = {
  fire: "Charcoal", water: "Mystic Water", grass: "Miracle Seed",
  electric: "Magnet", ice: "Never-Melt Ice", fighting: "Black Belt",
  poison: "Poison Barb", ground: "Soft Sand", flying: "Sharp Beak",
  psychic: "Twisted Spoon", bug: "Silver Powder", rock: "Hard Stone",
  ghost: "Spell Tag", dragon: "Dragon Fang", dark: "Black Glasses",
  steel: "Metal Coat", normal: "Silk Scarf", fairy: "Fairy Feather",
};

const BERRY_NAME = {
  fire: "Occa Berry", water: "Passho Berry", electric: "Wacan Berry",
  grass: "Rindo Berry", ice: "Yache Berry", fighting: "Chople Berry",
  poison: "Kebia Berry", ground: "Shuca Berry", flying: "Coba Berry",
  psychic: "Payapa Berry", bug: "Tanga Berry", rock: "Charti Berry",
  ghost: "Kasib Berry", dragon: "Haban Berry", dark: "Colbur Berry",
  steel: "Babiri Berry", fairy: "Roseli Berry", normal: "Chilan Berry",
};

for (const [slug, type] of Object.entries(TYPE_BOOST_ITEM)) {
  ITEMS[slug] = { group: "Type boosters", name: TYPE_ITEM_NAME[type], desc: `1.2× on ${type} moves.` };
}
for (const [slug, type] of Object.entries(RESIST_BERRY)) {
  ITEMS[slug] = {
    group: "Type berries",
    name: BERRY_NAME[type],
    desc: type === "normal"
      ? "Halves one Normal move. One use."
      : `Halves one super effective ${type} move. One use.`,
  };
}

/** Every berry the sim knows about — Unnerve stops all of them. */
const BERRIES = new Set(["sitrus-berry", "oran-berry", "lum-berry", ...Object.keys(RESIST_BERRY)]);

/**
 * The abilities the sim offers. Same rule as the items: modeled and hand-tested,
 * or not offered at all. Dex entries carry abilities outside this set — the UI
 * marks those as not in the sim yet and the engine ignores them rather than
 * guessing at what they do.
 *
 * `noop: true` means the ability is fully accounted for and genuinely does
 * nothing in a one-on-one battle (Pickup, Telepathy and friends only matter in
 * doubles or out in the overworld). Those are honest entries, not stubs.
 */
export const ABILITIES = {
  /* --- entry --- */
  "intimidate":   { group: "On entry", name: "Intimidate",   desc: "Lowers the foe's Attack on entry." },
  "download":     { group: "On entry", name: "Download",     desc: "On entry, +1 to whichever attack the foe defends worse against." },
  "drizzle":      { group: "Weather",  name: "Drizzle",      desc: "Summons rain on entry." },
  "drought":      { group: "Weather",  name: "Drought",      desc: "Summons sun on entry." },
  "sand-stream":  { group: "Weather",  name: "Sand Stream",  desc: "Summons a sandstorm on entry." },
  "snow-warning": { group: "Weather",  name: "Snow Warning", desc: "Summons snow on entry." },

  /* --- weather --- */
  "swift-swim":   { group: "Weather", name: "Swift Swim",   desc: "Doubles Speed in rain." },
  "chlorophyll":  { group: "Weather", name: "Chlorophyll",  desc: "Doubles Speed in sun." },
  "sand-rush":    { group: "Weather", name: "Sand Rush",    desc: "Doubles Speed in a sandstorm, and the sand doesn't hurt it." },
  "slush-rush":   { group: "Weather", name: "Slush Rush",   desc: "Doubles Speed in snow." },
  "sand-veil":    { group: "Weather", name: "Sand Veil",    desc: "1.25× evasion in a sandstorm, and the sand doesn't hurt it." },
  "snow-cloak":   { group: "Weather", name: "Snow Cloak",   desc: "1.25× evasion in snow." },
  "sand-force":   { group: "Weather", name: "Sand Force",   desc: "1.3× Rock, Ground and Steel power in a sandstorm." },
  "solar-power":  { group: "Weather", name: "Solar Power",  desc: "1.5× Sp. Atk in sun, but it loses 1/8 max HP a turn." },
  "rain-dish":    { group: "Weather", name: "Rain Dish",    desc: "Heals 1/16 max HP a turn in rain." },
  "ice-body":     { group: "Weather", name: "Ice Body",     desc: "Heals 1/16 max HP a turn in snow." },
  "dry-skin":     { group: "Weather", name: "Dry Skin",     desc: "Heals in rain, burns in sun, drinks Water moves, and Fire hurts more." },
  "leaf-guard":   { group: "Weather", name: "Leaf Guard",   desc: "Cannot be given a status while the sun is out." },
  "hydration":    { group: "Weather", name: "Hydration",    desc: "Shakes off any status at the end of a turn in rain." },
  "air-lock":     { group: "Weather", name: "Air Lock",     desc: "Switches the weather off while it is on the field." },
  "cloud-nine":   { group: "Weather", name: "Cloud Nine",   desc: "Switches the weather off while it is on the field." },

  /* --- damage dealt --- */
  "huge-power":   { group: "Damage", name: "Huge Power",   desc: "Doubles Attack." },
  "pure-power":   { group: "Damage", name: "Pure Power",   desc: "Doubles Attack." },
  "guts":         { group: "Damage", name: "Guts",         desc: "1.5× Attack when statused; burn doesn't halve." },
  "technician":   { group: "Damage", name: "Technician",   desc: "1.5× power on moves of 60 power or less." },
  "adaptability": { group: "Damage", name: "Adaptability", desc: "STAB is 2× instead of 1.5×." },
  "blaze":        { group: "Damage", name: "Blaze",        desc: "1.5× Fire power below 1/3 HP." },
  "torrent":      { group: "Damage", name: "Torrent",      desc: "1.5× Water power below 1/3 HP." },
  "overgrow":     { group: "Damage", name: "Overgrow",     desc: "1.5× Grass power below 1/3 HP." },
  "swarm":        { group: "Damage", name: "Swarm",        desc: "1.5× Bug power below 1/3 HP." },
  "sheer-force":  { group: "Damage", name: "Sheer Force",  desc: "1.3× power, but the move's extra effect never happens." },
  "tinted-lens":  { group: "Damage", name: "Tinted Lens",  desc: "Doubles damage on moves that aren't very effective." },
  "iron-fist":    { group: "Damage", name: "Iron Fist",    desc: "1.2× power on punching moves." },
  "strong-jaw":   { group: "Damage", name: "Strong Jaw",   desc: "1.5× power on biting moves." },
  "tough-claws":  { group: "Damage", name: "Tough Claws",  desc: "1.3× power on moves that make contact." },
  "sharpness":    { group: "Damage", name: "Sharpness",    desc: "1.5× power on slicing moves." },
  "mega-launcher":{ group: "Damage", name: "Mega Launcher",desc: "1.5× power on pulse and aura moves." },
  "punk-rock":    { group: "Damage", name: "Punk Rock",    desc: "1.3× power on sound moves, and halves sound damage taken." },
  "reckless":     { group: "Damage", name: "Reckless",     desc: "1.2× power on moves that hurt the user." },
  "rock-head":    { group: "Damage", name: "Rock Head",    desc: "Recoil moves cost it nothing." },
  "analytic":     { group: "Damage", name: "Analytic",     desc: "1.3× power when it moves second." },
  "sniper":       { group: "Damage", name: "Sniper",       desc: "Critical hits do 2.25× instead of 1.5×." },
  "super-luck":   { group: "Damage", name: "Super Luck",   desc: "Critical hits come one stage more often." },
  "serene-grace": { group: "Damage", name: "Serene Grace", desc: "Doubles the odds of a move's extra effect." },
  "skill-link":   { group: "Damage", name: "Skill Link",   desc: "Multi-hit moves always hit the full five times." },
  "hustle":       { group: "Damage", name: "Hustle",       desc: "1.5× Attack, but physical moves are 20% less accurate." },
  "compound-eyes":{ group: "Damage", name: "Compound Eyes",desc: "1.3× accuracy." },
  "victory-star": { group: "Damage", name: "Victory Star", desc: "1.1× accuracy." },
  "no-guard":     { group: "Damage", name: "No Guard",     desc: "Every move hits, in both directions." },
  "scrappy":      { group: "Damage", name: "Scrappy",      desc: "Normal and Fighting moves hit Ghost types." },
  "infiltrator":  { group: "Damage", name: "Infiltrator",  desc: "Ignores screens and Substitutes." },
  "mold-breaker": { group: "Damage", name: "Mold Breaker", desc: "Ignores abilities that would get in its move's way." },
  "turboblaze":   { group: "Damage", name: "Turboblaze",   desc: "Ignores abilities that would get in its move's way." },
  "teravolt":     { group: "Damage", name: "Teravolt",     desc: "Ignores abilities that would get in its move's way." },
  "unaware":      { group: "Damage", name: "Unaware",      desc: "Ignores the other side's stat changes." },
  "defeatist":    { group: "Damage", name: "Defeatist",    desc: "Halves both attacking stats below half HP." },

  /* --- damage taken --- */
  "thick-fat":     { group: "Defence", name: "Thick Fat",     desc: "Halves Fire and Ice damage taken." },
  "heatproof":     { group: "Defence", name: "Heatproof",     desc: "Halves Fire damage and burn damage." },
  "water-bubble":  { group: "Defence", name: "Water Bubble",  desc: "Doubles its Water power, halves Fire taken, and it can't be burned." },
  "fluffy":        { group: "Defence", name: "Fluffy",        desc: "Halves contact damage, but Fire hurts twice as much." },
  "fur-coat":      { group: "Defence", name: "Fur Coat",      desc: "Halves physical damage taken." },
  "ice-scales":    { group: "Defence", name: "Ice Scales",    desc: "Halves special damage taken." },
  "solid-rock":    { group: "Defence", name: "Solid Rock",    desc: "Super effective hits do 3/4 damage." },
  "filter":        { group: "Defence", name: "Filter",        desc: "Super effective hits do 3/4 damage." },
  "prism-armor":   { group: "Defence", name: "Prism Armor",   desc: "Super effective hits do 3/4 damage." },
  "multiscale":    { group: "Defence", name: "Multiscale",    desc: "Halves damage taken at full HP." },
  "shadow-shield": { group: "Defence", name: "Shadow Shield", desc: "Halves damage taken at full HP." },
  "marvel-scale":  { group: "Defence", name: "Marvel Scale",  desc: "1.5× Defence when statused." },
  "sturdy":        { group: "Defence", name: "Sturdy",        desc: "Survive a KO from full HP with 1 HP." },
  "magic-guard":   { group: "Defence", name: "Magic Guard",   desc: "Only direct attacks deal damage." },
  "shell-armor":   { group: "Defence", name: "Shell Armor",   desc: "Cannot be hit critically." },
  "battle-armor":  { group: "Defence", name: "Battle Armor",  desc: "Cannot be hit critically." },
  "shield-dust":   { group: "Defence", name: "Shield Dust",   desc: "Moves that hit it never land their extra effect." },
  "regenerator":   { group: "Defence", name: "Regenerator",   desc: "Heals 1/3 max HP on switching out." },
  "wonder-guard":  { group: "Defence", name: "Wonder Guard",  desc: "Only super effective moves can touch it." },

  /* --- immunities --- */
  "levitate":         { group: "Immunity", name: "Levitate",         desc: "Immune to Ground moves." },
  "water-absorb":     { group: "Immunity", name: "Water Absorb",     desc: "Heals 1/4 from Water moves instead of damage." },
  "volt-absorb":      { group: "Immunity", name: "Volt Absorb",      desc: "Heals 1/4 from Electric moves instead of damage." },
  "earth-eater":      { group: "Immunity", name: "Earth Eater",      desc: "Heals 1/4 from Ground moves instead of damage." },
  "flash-fire":       { group: "Immunity", name: "Flash Fire",       desc: "Immune to Fire moves." },
  "lightning-rod":    { group: "Immunity", name: "Lightning Rod",    desc: "Immune to Electric moves, and they give it +1 Sp. Atk." },
  "storm-drain":      { group: "Immunity", name: "Storm Drain",      desc: "Immune to Water moves, and they give it +1 Sp. Atk." },
  "motor-drive":      { group: "Immunity", name: "Motor Drive",      desc: "Immune to Electric moves, and they give it +1 Speed." },
  "sap-sipper":       { group: "Immunity", name: "Sap Sipper",       desc: "Immune to Grass moves, and they give it +1 Attack." },
  "well-baked-body":  { group: "Immunity", name: "Well-Baked Body",  desc: "Immune to Fire moves, and they give it +2 Defence." },
  "soundproof":       { group: "Immunity", name: "Soundproof",       desc: "Immune to sound moves." },
  "bulletproof":      { group: "Immunity", name: "Bulletproof",      desc: "Immune to ball and bomb moves." },
  "overcoat":         { group: "Immunity", name: "Overcoat",         desc: "Immune to powder moves and to the sandstorm." },

  /* --- status --- */
  "immunity":     { group: "Status", name: "Immunity",     desc: "Cannot be poisoned." },
  "pastel-veil":  { group: "Status", name: "Pastel Veil",  desc: "Cannot be poisoned." },
  "limber":       { group: "Status", name: "Limber",       desc: "Cannot be paralysed." },
  "insomnia":     { group: "Status", name: "Insomnia",     desc: "Cannot be put to sleep." },
  "vital-spirit": { group: "Status", name: "Vital Spirit", desc: "Cannot be put to sleep." },
  "sweet-veil":   { group: "Status", name: "Sweet Veil",   desc: "Cannot be put to sleep." },
  "water-veil":   { group: "Status", name: "Water Veil",   desc: "Cannot be burned." },
  "magma-armor":  { group: "Status", name: "Magma Armor",  desc: "Cannot be frozen." },
  "own-tempo":    { group: "Status", name: "Own Tempo",    desc: "Cannot be confused." },
  "oblivious":    { group: "Status", name: "Oblivious",    desc: "Cannot be confused or taunted." },
  "inner-focus":  { group: "Status", name: "Inner Focus",  desc: "Cannot be made to flinch." },
  "natural-cure": { group: "Status", name: "Natural Cure", desc: "Shakes off any status on switching out." },
  "shed-skin":    { group: "Status", name: "Shed Skin",    desc: "1 in 3 chance of shaking off a status each turn." },
  "early-bird":   { group: "Status", name: "Early Bird",   desc: "Wakes from sleep twice as fast." },
  "poison-heal":  { group: "Status", name: "Poison Heal",  desc: "Poison heals it 1/8 a turn instead of hurting." },
  "quick-feet":   { group: "Status", name: "Quick Feet",   desc: "1.5× Speed when statused, and paralysis doesn't slow it." },
  "unburden":     { group: "Status", name: "Unburden",     desc: "Doubles Speed once it has used up its held item." },
  "speed-boost":  { group: "Status", name: "Speed Boost",  desc: "+1 Speed every turn." },

  /* --- contact --- */
  "static":        { group: "Contact", name: "Static",        desc: "30% chance to paralyse anything that touches it." },
  "flame-body":    { group: "Contact", name: "Flame Body",    desc: "30% chance to burn anything that touches it." },
  "poison-point":  { group: "Contact", name: "Poison Point",  desc: "30% chance to poison anything that touches it." },
  "effect-spore":  { group: "Contact", name: "Effect Spore",  desc: "30% chance to poison, paralyse or sleep anything that touches it." },
  "cursed-body":   { group: "Contact", name: "Cursed Body",   desc: "30% chance to Disable the move that hit it." },
  "rough-skin":    { group: "Contact", name: "Rough Skin",    desc: "Anything that touches it loses 1/8 max HP." },
  "iron-barbs":    { group: "Contact", name: "Iron Barbs",    desc: "Anything that touches it loses 1/8 max HP." },
  "aftermath":     { group: "Contact", name: "Aftermath",     desc: "Whatever knocks it out by contact loses 1/4 max HP." },
  "gooey":         { group: "Contact", name: "Gooey",         desc: "Anything that touches it loses 1 stage of Speed." },
  "tangling-hair": { group: "Contact", name: "Tangling Hair", desc: "Anything that touches it loses 1 stage of Speed." },
  "poison-touch":  { group: "Contact", name: "Poison Touch",  desc: "30% chance to poison whatever it touches." },
  "stench":        { group: "Contact", name: "Stench",        desc: "10% chance to make the target flinch." },

  /* --- reacting --- */
  "moxie":          { group: "Reacting", name: "Moxie",          desc: "+1 Attack for every Pokémon it knocks out." },
  "chilling-neigh": { group: "Reacting", name: "Chilling Neigh", desc: "+1 Attack for every Pokémon it knocks out." },
  "grim-neigh":     { group: "Reacting", name: "Grim Neigh",     desc: "+1 Sp. Atk for every Pokémon it knocks out." },
  "beast-boost":    { group: "Reacting", name: "Beast Boost",    desc: "+1 to its best stat for every Pokémon it knocks out." },
  "defiant":        { group: "Reacting", name: "Defiant",        desc: "+2 Attack whenever the foe lowers one of its stats." },
  "competitive":    { group: "Reacting", name: "Competitive",    desc: "+2 Sp. Atk whenever the foe lowers one of its stats." },
  "weak-armor":     { group: "Reacting", name: "Weak Armor",     desc: "A physical hit costs it 1 Defence and gives it 2 Speed." },
  "steadfast":      { group: "Reacting", name: "Steadfast",      desc: "+1 Speed every time it flinches." },
  "anger-point":    { group: "Reacting", name: "Anger Point",    desc: "A critical hit sends its Attack straight to +6." },
  "justified":      { group: "Reacting", name: "Justified",      desc: "+1 Attack when a Dark move hits it." },
  "rattled":        { group: "Reacting", name: "Rattled",        desc: "+1 Speed when a Bug, Ghost or Dark move hits it, or Intimidate does." },
  "stamina":        { group: "Reacting", name: "Stamina",        desc: "+1 Defence every time it is hit." },
  "berserk":        { group: "Reacting", name: "Berserk",        desc: "+1 Sp. Atk when a hit drops it below half." },
  "water-compaction": { group: "Reacting", name: "Water Compaction", desc: "+2 Defence when a Water move hits it." },

  /* --- stat changes --- */
  "clear-body":      { group: "Stats", name: "Clear Body",      desc: "The foe cannot lower any of its stats." },
  "white-smoke":     { group: "Stats", name: "White Smoke",     desc: "The foe cannot lower any of its stats." },
  "full-metal-body": { group: "Stats", name: "Full Metal Body", desc: "The foe cannot lower any of its stats." },
  "hyper-cutter":    { group: "Stats", name: "Hyper Cutter",    desc: "The foe cannot lower its Attack." },
  "big-pecks":       { group: "Stats", name: "Big Pecks",       desc: "The foe cannot lower its Defence." },
  "keen-eye":        { group: "Stats", name: "Keen Eye",        desc: "Its accuracy can't be lowered, and it sees past evasion." },
  "illuminate":      { group: "Stats", name: "Illuminate",      desc: "Its accuracy can't be lowered, and it sees past evasion." },
  "minds-eye":       { group: "Stats", name: "Mind's Eye",      desc: "Sees past evasion, and hits Ghost types with Normal and Fighting." },
  "contrary":        { group: "Stats", name: "Contrary",        desc: "Stat changes work the other way round." },
  "simple":          { group: "Stats", name: "Simple",          desc: "Stat changes count double." },

  /* --- turn order --- */
  "prankster":  { group: "Turn order", name: "Prankster", desc: "Status moves go first — but Dark types ignore them." },
  "gale-wings": { group: "Turn order", name: "Gale Wings", desc: "Flying moves go first while it is at full HP." },
  "triage":     { group: "Turn order", name: "Triage",    desc: "Healing moves go well before anything else." },
  "stall":      { group: "Turn order", name: "Stall",     desc: "Always moves last." },
  "pressure":   { group: "Turn order", name: "Pressure",  desc: "Moves aimed at it cost the attacker 2 PP instead of 1." },
  "unnerve":    { group: "Turn order", name: "Unnerve",   desc: "The foe is too nervous to eat its berry." },

  /* --- nothing in a one-on-one battle --- */
  "run-away":          { group: "No effect one-on-one", noop: true, name: "Run Away",          desc: "Guarantees escape from wild Pokémon — nothing in a battle like this." },
  "pickup":            { group: "No effect one-on-one", noop: true, name: "Pickup",            desc: "Finds items after a battle — nothing during one." },
  "honey-gather":      { group: "No effect one-on-one", noop: true, name: "Honey Gather",      desc: "Finds honey after a battle — nothing during one." },
  "ball-fetch":        { group: "No effect one-on-one", noop: true, name: "Ball Fetch",        desc: "Retrieves a thrown Poké Ball — nothing in a battle like this." },
  "telepathy":         { group: "No effect one-on-one", noop: true, name: "Telepathy",         desc: "Dodges an ally's attack — needs a partner." },
  "friend-guard":      { group: "No effect one-on-one", noop: true, name: "Friend Guard",      desc: "Protects an ally — needs a partner." },
  "healer":            { group: "No effect one-on-one", noop: true, name: "Healer",            desc: "Cures an ally's status — needs a partner." },
  "plus":              { group: "No effect one-on-one", noop: true, name: "Plus",              desc: "Boosts with a Minus partner — needs a partner." },
  "minus":             { group: "No effect one-on-one", noop: true, name: "Minus",             desc: "Boosts with a Plus partner — needs a partner." },
  "battery":           { group: "No effect one-on-one", noop: true, name: "Battery",           desc: "Powers up an ally — needs a partner." },
  "power-spot":        { group: "No effect one-on-one", noop: true, name: "Power Spot",        desc: "Powers up an ally — needs a partner." },
  "symbiosis":         { group: "No effect one-on-one", noop: true, name: "Symbiosis",         desc: "Passes its item to an ally — needs a partner." },
  "receiver":          { group: "No effect one-on-one", noop: true, name: "Receiver",          desc: "Takes a fainted ally's ability — needs a partner." },
  "power-of-alchemy":  { group: "No effect one-on-one", noop: true, name: "Power of Alchemy",  desc: "Takes a fainted ally's ability — needs a partner." },
  "curious-medicine":  { group: "No effect one-on-one", noop: true, name: "Curious Medicine",  desc: "Resets an ally's stat changes — needs a partner." },
  "hospitality":       { group: "No effect one-on-one", noop: true, name: "Hospitality",       desc: "Heals an ally on entry — needs a partner." },
};

const PINCH_ABILITY_TYPE = {
  blaze: "fire", torrent: "water", overgrow: "grass", swarm: "bug",
};

/** Abilities that all do exactly the same thing, so the engine reads a set. */
const MOLD_BREAKERS = new Set(["mold-breaker", "turboblaze", "teravolt"]);
const CRIT_PROOF = new Set(["shell-armor", "battle-armor"]);
const STAT_LOCKED = new Set(["clear-body", "white-smoke", "full-metal-body"]);
const KO_BOOST_STAT = { "moxie": "atk", "chilling-neigh": "atk", "grim-neigh": "spa" };
const SLEEP_PROOF = new Set(["insomnia", "vital-spirit", "sweet-veil"]);
const QUARTER_DAMAGE_ON_SE = new Set(["solid-rock", "filter", "prism-armor"]);
const HALVE_AT_FULL_HP = new Set(["multiscale", "shadow-shield"]);
const SPEED_STAT_LOWER_ON_CONTACT = new Set(["gooey", "tangling-hair"]);
const CHIP_ON_CONTACT = new Set(["rough-skin", "iron-barbs"]);
const WEATHER_SPEED_ABILITY = {
  "swift-swim": "rain", "chlorophyll": "sun", "sand-rush": "sand", "slush-rush": "snow",
};
const EVASION_WEATHER_ABILITY = { "sand-veil": "sand", "snow-cloak": "snow" };
/** Contact abilities that hand out a status, and which one. */
const CONTACT_STATUS_ABILITY = {
  "static": "paralysis", "flame-body": "burn", "poison-point": "poison",
};
/** Status the ability simply refuses. */
const STATUS_PROOF_ABILITY = {
  burn: new Set(["water-veil", "water-bubble"]),
  paralysis: new Set(["limber"]),
  freeze: new Set(["magma-armor"]),
  poison: new Set(["immunity", "pastel-veil"]),
  toxic: new Set(["immunity", "pastel-veil"]),
};
/** Sees past evasion and can't have its accuracy lowered. */
const CLEAR_SIGHTED = new Set(["keen-eye", "illuminate", "minds-eye"]);
/** Normal and Fighting moves hit Ghost types. */
const GHOST_HITTERS = new Set(["scrappy", "minds-eye"]);

const WEATHER_MOVES = {
  "rain-dance": "rain", "sunny-day": "sun",
  "sandstorm": "sand", "snowscape": "snow", "hail": "snow",
};

const WEATHER_ABILITY = {
  drizzle: "rain", drought: "sun", "sand-stream": "sand", "snow-warning": "snow",
};

const HAZARD_MOVES = ["stealth-rock", "spikes", "toxic-spikes", "sticky-web"];

/** Swallows a move of this type and heals a quarter instead. */
const ABSORB_ABILITY_TYPE = {
  "water-absorb": "water", "volt-absorb": "electric",
  "earth-eater": "ground", "dry-skin": "water",
};

/** Swallows a move of this type and takes a stat boost instead. */
const REDIRECT_ABILITY = {
  "lightning-rod":   { type: "electric", stat: "spa", change: 1 },
  "storm-drain":     { type: "water",    stat: "spa", change: 1 },
  "motor-drive":     { type: "electric", stat: "spe", change: 1 },
  "sap-sipper":      { type: "grass",    stat: "atk", change: 1 },
  "well-baked-body": { type: "fire",     stat: "def", change: 2 },
};

/** Abilities that read a move flag and multiply its power. */
const FLAG_POWER_ABILITY = {
  "iron-fist":     { flag: "punch",   mult: 1.2 },
  "strong-jaw":    { flag: "bite",    mult: 1.5 },
  "tough-claws":   { flag: "contact", mult: 1.3 },
  "sharpness":     { flag: "slicing", mult: 1.5 },
  "mega-launcher": { flag: "pulse",   mult: 1.5 },
  "punk-rock":     { flag: "sound",   mult: 1.3 },
};

/** Abilities that turn a whole flag of moves away at the door. */
const FLAG_IMMUNE_ABILITY = { "soundproof": "sound", "bulletproof": "bullet", "overcoat": "powder" };

/** Weather-setting items: whoever set it holds one, the weather lasts 8 not 5. */
const WEATHER_ROCK = {
  "damp-rock": "rain", "heat-rock": "sun", "smooth-rock": "sand", "icy-rock": "snow",
};

/** The punish each protection move hands out to whatever touched it. */
const PROTECT_PUNISH = {
  "spiky-shield":    { chip: 8 },
  "kings-shield":    { stat: "atk", change: -1 },
  "obstruct":        { stat: "def", change: -2 },
  "silk-trap":       { stat: "spe", change: -1 },
  "baneful-bunker":  { status: "poison" },
  "burning-bulwark": { status: "burn" },
};

const isChoiceItem = (item) => item === "choice-band" || item === "choice-specs" || item === "choice-scarf";

/** Does this move carry the given baked flag? */
const hasFlag = (move, flag) => move.flags?.includes(flag) ?? false;

/**
 * The defender's ability as this attacker sees it. Mold Breaker and its two
 * cousins switch off anything that would get in the move's way — Levitate,
 * Sturdy, Thick Fat, Volt Absorb and the rest. They do NOT switch off the
 * abilities that punish a move after it lands, which is why Static and Rough
 * Skin read `foe.ability` directly instead of going through here.
 */
const seenAbility = (attacker, defender) =>
  MOLD_BREAKERS.has(attacker?.ability) ? null : defender.ability;

/**
 * The weather as the field actually experiences it. Air Lock and Cloud Nine
 * don't clear the weather — they just stop anything reading it, and the
 * moment their holder leaves, the sun is still there.
 */
function weatherOf(state) {
  for (const side of [0, 1]) {
    const b = active(state, side);
    if (b.hp > 0 && (b.ability === "air-lock" || b.ability === "cloud-nine")) return null;
  }
  return state.weather.kind;
}

/* ------------------------------------------------- multi-turn move data --- */

/**
 * Two-turn charge moves. `invuln` is where the user hides on the charge turn
 * (null = it stands there in the open and can be hit normally). `boost` is the
 * stat change that happens as it charges, and `skipIn` is the weather that
 * lets it fire the same turn.
 *
 * PokéAPI describes all of this in prose only, so it has to be curated. Same
 * rule as everything else here: on this list means modeled and tested.
 */
const CHARGE_MOVES = {
  "solar-beam":    { invuln: null, skipIn: "sun", weakIn: ["rain", "sand", "snow"] },
  "solar-blade":   { invuln: null, skipIn: "sun", weakIn: ["rain", "sand", "snow"] },
  "electro-shot":  { invuln: null, skipIn: "rain", boost: [{ stat: "spa", change: 1 }] },
  "fly":           { invuln: "air" },
  "bounce":        { invuln: "air" },
  "dig":           { invuln: "underground" },
  "dive":          { invuln: "underwater" },
  "phantom-force": { invuln: "vanished", breaksProtect: true },
  "shadow-force":  { invuln: "vanished", breaksProtect: true },
  "sky-attack":    { invuln: null },
  "razor-wind":    { invuln: null },
  "freeze-shock":  { invuln: null },
  "ice-burn":      { invuln: null },
  "skull-bash":    { invuln: null, boost: [{ stat: "def", change: 1 }] },
  "meteor-beam":   { invuln: null, boost: [{ stat: "spa", change: 1 }] },
  "geomancy":      { invuln: null },
};

/**
 * The moves that can reach a Pokémon while it is hiding, and the ones that hit
 * twice as hard for catching it there.
 */
const REACHES_INVULN = {
  air: ["gust", "twister", "thunder", "hurricane", "sky-uppercut", "smack-down", "thousand-arrows"],
  underground: ["earthquake", "magnitude", "fissure"],
  underwater: ["surf", "whirlpool"],
  vanished: [],
};
const DOUBLES_ON_INVULN = {
  air: ["gust", "twister"],
  underground: ["earthquake", "magnitude"],
  underwater: ["surf", "whirlpool"],
  vanished: [],
};

/** Moves that cost the user its next turn. */
const RECHARGE_MOVES = new Set([
  "hyper-beam", "giga-impact", "blast-burn", "frenzy-plant", "hydro-cannon",
  "rock-wrecker", "roar-of-time", "prismatic-laser", "eternabeam", "meteor-assault",
]);

/** Lock the user in for 2-3 turns, then confuse it. */
const RAMPAGE_MOVES = new Set(["outrage", "thrash", "petal-dance", "raging-fury"]);

/** Lock the user in for 5 turns, doubling power each turn, no confusion after. */
const ROLLOUT_MOVES = new Set(["rollout", "ice-ball"]);

/** Doubles power on each consecutive use, but never locks you in. */
const FURY_CUTTER_MOVES = new Set(["fury-cutter"]);

/**
 * Protection moves. The engine blocks the incoming move for all of them; the
 * contact-triggered riders (Spiky Shield's chip, King's Shield's Attack drop)
 * need a contact flag the dataset doesn't carry, so they are not modeled.
 */
const PROTECT_MOVES = new Set([
  "protect", "detect", "spiky-shield", "kings-shield", "baneful-bunker",
  "silk-trap", "obstruct", "burning-bulwark",
]);

/** Trapping moves with no timer: they hold until someone faints. */
const BINDING_MOVES = new Set(["mean-look", "block", "spider-web", "fairy-lock"]);

/** Only ever works on the turn the user came in. */
const FIRST_TURN_MOVES = new Set(["fake-out", "first-impression"]);

/** The user leaves the field after connecting. */
const SWITCH_OUT_MOVES = new Set(["u-turn", "volt-switch", "flip-turn"]);

/** Moves that strike two turns after they are called. */
const DELAYED_MOVES = new Set(["future-sight", "doom-desire"]);

/**
 * Status moves ignore type immunity — Encore, Yawn and Perish Song all work
 * on a Ghost, and Confuse Ray works on a Normal type, even though the type
 * chart says those matchups are zero. The exceptions are Electric and Poison
 * status moves, which really are turned away by Ground and Steel.
 */
const STATUS_TYPES_THAT_RESPECT_IMMUNITY = ["electric", "poison"];

const SCREEN_MOVES = { "reflect": "reflect", "light-screen": "lightScreen", "aurora-veil": "auroraVeil" };

/**
 * Grounded = takes Spikes, Toxic Spikes, Sticky Web, and Ground moves land.
 * `ability` is passed in when an attacker is asking, so Mold Breaker can walk
 * a Ground move straight through Levitate.
 */
function isGrounded(b, ability = b.ability) {
  if (defendingTypes(b).includes("flying")) return false;
  if (ability === "levitate") return false;
  if (b.item === "air-balloon" && !b.balloonPopped) return false;
  return true;
}

/** Indirect damage (status chip, weather, hazards, Life Orb, recoil). */
function takesIndirectDamage(b) {
  return b.ability !== "magic-guard";
}

/** What a Pokémon does when every move is out of PP. */
export const STRUGGLE = {
  slug: "struggle", name: "Struggle", type: "typeless",
  power: 50, accuracy: null, pp: null, category: "physical", priority: 0,
  meta: null, statChanges: [],
};

/* --------------------------------------------------------------- Turns --- */

/**
 * Play one full turn.
 *
 * @param {object} state    From createBattle (or a previous playTurn).
 * @param {Array}  actions  [actionForSide0, actionForSide1], each either
 *                          { type: "move", moveIndex } or
 *                          { type: "switch", to }.
 * @param {object} rng      From makeRng, or a scripted stand-in in tests.
 * @returns {{ state: object, events: object[] }}
 */
export function playTurn(prevState, actions, rng) {
  const state = structuredClone(prevState);
  const events = [];

  if (state.winner != null) return { state, events };

  refreshUnnerve(state);
  for (const b of [active(state, 0), active(state, 1)]) {
    b.flinched = false;
    b.vol.protect = false;
    b.vol.protectedWith = null;
    b.vol.roosted = false;
    b.vol.tookDamage = false;
    b.vol.turnsActive += 1;
  }

  // Switches resolve before any move, faster side first.
  const switchOrder = orderSides(state, rng);
  for (const side of switchOrder) {
    if (actions[side]?.type === "switch") doSwitch(state, side, actions[side].to, events);
  }

  // Moves: priority first, then Speed (inverted under Trick Room), ties by
  // coin flip.
  const moveOrder = orderSides(state, rng, actions);
  for (const [order, side] of moveOrder.entries()) {
    if (actions[side]?.type !== "move") continue;
    if (state.winner != null) break;
    const user = active(state, side);
    if (user.hp <= 0) continue; // fainted before it could move
    // Analytic wants to know whether it went second, which is exactly this.
    executeMove(state, side, actions[side].moveIndex, events, rng, { movesLast: order === 1 });
  }

  if (state.winner == null) endOfTurn(state, moveOrder, events, rng);

  state.turn += 1;
  return { state, events };
}

/**
 * Which side acts first this turn. Priority wins outright; after that it is
 * Speed, and Trick Room turns that comparison upside down for its five turns.
 */
function orderSides(state, rng, actions = null) {
  const weather = weatherOf(state);

  const prio = (side) => {
    if (!actions || actions[side]?.type !== "move") return 0;
    const user = active(state, side);
    // A user mid-charge, locked in or recharging uses that move's priority,
    // not whatever the caller passed in.
    const forced = forcedMoveIndex(user);
    const idx = forced ?? actions[side].moveIndex;
    const slot = user.moves[idx];
    if (!slot) return 0;
    return slot.move.priority ?? 0;
  };
  // The abilities that push a move up the queue.
  const bonus = (side) => {
    if (!actions || actions[side]?.type !== "move") return 0;
    const user = active(state, side);
    const forced = forcedMoveIndex(user);
    const move = user.moves[forced ?? actions[side].moveIndex]?.move;
    if (!move) return 0;
    if (user.ability === "prankster" && move.category === "status") return 1;
    if (user.ability === "gale-wings" && move.type === "flying" && user.hp === user.maxHP) return 1;
    if (user.ability === "triage" && hasFlag(move, "heal")) return 3;
    return 0;
  };

  const p0 = prio(0) + bonus(0), p1 = prio(1) + bonus(1);
  if (p0 !== p1) return p0 > p1 ? [0, 1] : [1, 0];

  // Stall and Quick Claw only decide who MOVES first; the switch pass runs
  // through here too and must not spend a Quick Claw roll on it.
  if (actions) {
    // Stall goes last however quick it is; two of them fall back to Speed.
    const stall0 = active(state, 0).ability === "stall";
    const stall1 = active(state, 1).ability === "stall";
    if (stall0 !== stall1) return stall0 ? [1, 0] : [0, 1];

    // A Quick Claw jumps the queue one time in five. Both sides get their
    // roll, in side order, so a scripted RNG reads the same way every run.
    const claw0 = active(state, 0).item === "quick-claw" && rng.chance(0.2);
    const claw1 = active(state, 1).item === "quick-claw" && rng.chance(0.2);
    if (claw0 !== claw1) return claw0 ? [0, 1] : [1, 0];
  }

  const s0 = effectiveSpeed(active(state, 0), state.teams[0], weather);
  const s1 = effectiveSpeed(active(state, 1), state.teams[1], weather);
  if (s0 !== s1) {
    const fasterFirst = state.trickRoom > 0 ? s0 < s1 : s0 > s1;
    return fasterFirst ? [0, 1] : [1, 0];
  }
  return rng.chance(0.5) ? [0, 1] : [1, 0];
}

/** The move slot a Pokémon has no say over this turn, or null if it is free. */
function forcedMoveIndex(user) {
  if (user.vol.charge) return user.vol.charge.moveIndex;
  if (user.vol.locked) return user.vol.locked.moveIndex;
  return null;
}

/** Can this side switch out at all? Trapping moves are the whole reason not. */
export function switchBlockedBy(state, side) {
  const b = active(state, side);
  if (b.hp <= 0) return null;                    // fainting frees you
  if (b.vol.trap) return b.vol.trap.by;
  if (b.vol.charge || b.vol.locked || b.vol.recharge) return "its own move";
  return null;
}

function doSwitch(state, side, to, events) {
  const team = state.teams[side];
  const target = team.battlers[to];
  if (!target || target.hp <= 0 || to === team.active) return;

  const blocker = switchBlockedBy(state, side);
  if (blocker) {
    events.push({ type: "trapped", side, name: active(state, side).pokemon.name, by: blocker });
    return;
  }

  const out = active(state, side);
  // Stages, volatiles, flinch and Choice locks are left at the door; status
  // rides along.
  out.stages = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, acc: 0, eva: 0 };
  out.flinched = false;
  out.choiceLock = null;
  out.vol = freshVolatiles();
  if (out.ability === "natural-cure" && out.hp > 0 && out.status) {
    out.status = null;
    out.sleepTurns = 0;
    events.push({ type: "cured", side, name: out.pokemon.name, by: "Natural Cure" });
  }
  if (out.ability === "regenerator" && out.hp > 0 && out.hp < out.maxHP) {
    const healed = Math.min(out.maxHP - out.hp, Math.floor(out.maxHP / 3));
    out.hp += healed;
    events.push({ type: "heal", side, name: out.pokemon.name, amount: healed });
  }
  team.active = to;
  target.vol = freshVolatiles();
  events.push({ type: "switch", side, out: out.pokemon.name, in: target.pokemon.name });
  applyEntryEffects(state, side, events);
  checkFaint(state, events);
}

/** Fill a fainted slot between turns. Returns true if the switch was legal. */
export function replaceFainted(prevState, side, to) {
  const state = structuredClone(prevState);
  const team = state.teams[side];
  const target = team.battlers[to];
  if (!state.pendingReplacement[side] || !target || target.hp <= 0 || to === team.active) {
    return { state: prevState, ok: false, events: [] };
  }
  // A Pokémon pulled out by its own U-turn leaves its field state behind too.
  const out = active(state, side);
  if (out.hp > 0) {
    out.stages = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, acc: 0, eva: 0 };
    out.choiceLock = null;
    out.vol = freshVolatiles();
  }
  team.active = to;
  target.vol = freshVolatiles();
  state.pendingReplacement[side] = false;
  const events = [];
  applyEntryEffects(state, side, events);
  checkFaint(state, events);
  return { state, ok: true, events };
}

/* ------------------------------------------------------- entry effects --- */

/**
 * Put weather up. Whoever set it holds the rock, so the rock is read off the
 * setter — five turns normally, eight with the matching one.
 */
function setWeather(state, kind, events, setter = null) {
  if (state.weather.kind === kind) {
    events.push({ type: "noEffect" });
    return;
  }
  const extended = setter && WEATHER_ROCK[setter.item] === kind;
  state.weather = { kind, turns: extended ? 8 : 5 };
  events.push({ type: "weather", kind, turns: state.weather.turns });
}

/**
 * Unnerve is the foe's ability but it lands on the holder's berry, so it is
 * stamped onto whoever is standing opposite whenever the field changes.
 */
function refreshUnnerve(state) {
  for (const side of [0, 1]) {
    active(state, side).vol.unnerved = active(state, 1 - side).ability === "unnerve";
  }
}

/**
 * Everything that happens when a Pokémon takes the field: hazards bite
 * first (they can faint it), then its ability announces itself.
 */
function applyEntryEffects(state, side, events) {
  const b = active(state, side);
  const hz = state.teams[side].hazards;
  const name = b.pokemon.name;
  refreshUnnerve(state);

  // Heavy-Duty Boots walk over the lot — rocks, spikes, web and all.
  if (b.item === "heavy-duty-boots") {
    if (hz.stealthRock || hz.spikes || hz.toxicSpikes || hz.stickyWeb) {
      events.push({ type: "hazardIgnored", side, name, item: "Heavy-Duty Boots" });
    }
    return applyEntryAbilities(state, side, events);
  }

  if (hz.stealthRock && takesIndirectDamage(b)) {
    // An eighth of max HP, scaled by how much Rock hurts this Pokémon.
    const eff = typeEffectiveness("rock", b.pokemon.types);
    const dmg = Math.min(b.hp, Math.max(1, Math.floor((b.maxHP * eff) / 8)));
    b.hp -= dmg;
    events.push({ type: "hazard", side, name, hazard: "Stealth Rock", amount: dmg, hpLeft: b.hp, maxHP: b.maxHP });
  }
  if (b.hp > 0 && hz.spikes > 0 && isGrounded(b) && takesIndirectDamage(b)) {
    const frac = [0, 8, 6, 4][hz.spikes];
    const dmg = Math.min(b.hp, Math.max(1, Math.floor(b.maxHP / frac)));
    b.hp -= dmg;
    events.push({ type: "hazard", side, name, hazard: "Spikes", amount: dmg, hpLeft: b.hp, maxHP: b.maxHP });
  }
  if (b.hp > 0 && hz.toxicSpikes > 0 && isGrounded(b)) {
    if (b.pokemon.types.includes("poison")) {
      // A grounded Poison type soaks the spikes up on the way in.
      hz.toxicSpikes = 0;
      events.push({ type: "hazardClear", side, hazard: "Toxic Spikes", by: name });
    } else if (!b.status) {
      inflictStatus(b, side, hz.toxicSpikes >= 2 ? "toxic" : "poison", events, null);
    }
  }
  if (b.hp > 0 && hz.stickyWeb && isGrounded(b)) {
    applyStatChanges(b, side, [{ stat: "spe", change: -1 }], events);
  }

  if (b.hp <= 0) return;
  applyEntryAbilities(state, side, events);
}

/** The half of an entrance that comes from the ability rather than the field. */
function applyEntryAbilities(state, side, events) {
  const b = active(state, side);
  const foe = active(state, 1 - side);
  const name = b.pokemon.name;

  const weatherKind = WEATHER_ABILITY[b.ability];
  if (weatherKind) setWeather(state, weatherKind, events, b);

  if (b.ability === "intimidate" && foe.hp > 0) {
    events.push({ type: "ability", side, name, ability: "Intimidate" });
    applyStatChanges(foe, 1 - side, [{ stat: "atk", change: -1 }], events, {
      fromFoe: true, ability: seenAbility(b, foe),
    });
    // Rattled is jumpy about being Intimidated, not just about being hit.
    if (foe.ability === "rattled") {
      applyStatChanges(foe, 1 - side, [{ stat: "spe", change: 1 }], events);
    }
  }

  // Download sizes the foe up and picks whichever attack it defends worse.
  if (b.ability === "download" && foe.hp > 0) {
    const stat = battleStat(foe, "def", {}) <= battleStat(foe, "spd", {}) ? "atk" : "spa";
    events.push({ type: "ability", side, name, ability: "Download" });
    applyStatChanges(b, side, [{ stat, change: 1 }], events);
  }
}

/* ------------------------------------------------------ Move execution --- */

/**
 * One Pokémon's action for the turn.
 *
 * The "can it move at all?" gate runs in the published order: recharge, then
 * flinch, sleep and freeze, then the move is chosen (which is where Encore,
 * Disable, Taunt and Choice locks bite), then confusion, then paralysis. PP is
 * only spent once every one of those is cleared — and only on the FIRST turn
 * of a multi-turn move, because that is when the move was chosen.
 */
function executeMove(state, side, moveIndex, events, rng, { movesLast = false } = {}) {
  const user = active(state, side);
  const foe = active(state, 1 - side);
  const name = user.pokemon.name;
  const weather = weatherOf(state);

  // Recharging costs the whole turn.
  if (user.vol.recharge) {
    user.vol.recharge = false;
    events.push({ type: "recharge", side, name });
    return;
  }

  if (user.flinched) {
    events.push({ type: "flinch", side, name });
    if (user.ability === "steadfast") {
      applyStatChanges(user, side, [{ stat: "spe", change: 1 }], events);
    }
    breakLocks(user, side, events);
    return;
  }
  if (user.status === "sleep") {
    // Early Bird burns through two turns of sleep for every one that passes.
    user.sleepTurns -= user.ability === "early-bird" ? 2 : 1;
    if (user.sleepTurns > 0) {
      events.push({ type: "asleep", side, name });
      return;
    }
    user.status = null;
    events.push({ type: "wake", side, name });
  }
  if (user.status === "freeze") {
    if (rng.chance(0.2)) {
      user.status = null;
      events.push({ type: "thaw", side, name });
    } else {
      events.push({ type: "frozen", side, name });
      return;
    }
  }

  // ---- Which move? ----
  const forced = forcedMoveIndex(user);
  const continuing = forced != null;
  if (continuing) {
    moveIndex = forced;
  } else {
    // Encore overrules the pick; a Choice item locks in the first thing used.
    if (user.vol.encore && user.moves[user.vol.encore.moveIndex]?.pp > 0) {
      moveIndex = user.vol.encore.moveIndex;
    } else if (user.choiceLock != null && isChoiceItem(user.item) && user.moves[user.choiceLock]?.pp > 0) {
      moveIndex = user.choiceLock;
    }
  }

  let slot = user.moves[moveIndex];
  let move = slot?.move;
  const anyPP = user.moves.some((s) => s.pp > 0);
  if (!continuing) {
    if (!anyPP) {
      move = STRUGGLE;
      slot = null;
    } else if (!slot || slot.pp <= 0) {
      events.push({ type: "noPP", side, name });
      return;
    } else if (user.vol.disable?.moveIndex === moveIndex) {
      events.push({ type: "blockedMove", side, name, move: move.name, by: "Disable" });
      return;
    } else if (user.vol.taunt > 0 && move.category === "status") {
      events.push({ type: "blockedMove", side, name, move: move.name, by: "Taunt" });
      return;
    }
  } else if (!move) {
    // The slot a lock pointed at has gone; let the commitment lapse.
    user.vol.charge = null;
    user.vol.locked = null;
    events.push({ type: "noPP", side, name });
    return;
  }

  // ---- Confusion, then paralysis: the last two things between it and the move ----
  if (user.vol.confusion > 0) {
    user.vol.confusion -= 1;
    if (user.vol.confusion === 0) {
      events.push({ type: "confusionEnd", side, name });
    } else if (rng.chance(1 / 3)) {
      hitSelfInConfusion(user, side, events, rng);
      breakLocks(user, side, events);
      checkFaint(state, events);
      return;
    }
  }
  if (user.status === "paralysis" && rng.chance(0.25)) {
    events.push({ type: "fullPara", side, name });
    return;
  }

  if (slot && !continuing) {
    // Pressure charges double, but only for moves aimed across the field.
    const cost = foe.ability === "pressure" && foe.hp > 0 && targetsFoe(move) ? 2 : 1;
    slot.pp = Math.max(0, slot.pp - cost);
    if (isChoiceItem(user.item) && user.choiceLock == null) user.choiceLock = moveIndex;
  }
  user.vol.lastMoveIndex = slot ? moveIndex : null;

  // ---- Two-turn charge moves ----
  const chargeInfo = CHARGE_MOVES[move.slug];
  if (chargeInfo && !user.vol.charge) {
    const weatherSkip = chargeInfo.skipIn && weather === chargeInfo.skipIn;
    const herbSkip = !weatherSkip && user.item === "power-herb";
    if (!weatherSkip && !herbSkip) {
      user.vol.charge = { moveIndex, slug: move.slug, invuln: chargeInfo.invuln ?? null };
      events.push({ type: "charge", side, name, move: move.name, invuln: chargeInfo.invuln ?? null });
      if (chargeInfo.boost) applyStatChanges(user, side, chargeInfo.boost, events);
      return;
    }
    // Fired the same turn: the charge-turn boost still happens either way.
    if (chargeInfo.boost) applyStatChanges(user, side, chargeInfo.boost, events);
    if (herbSkip) consumeItem(user, side, "Power Herb", events);
  }
  // Releasing: the user comes back out of hiding before it swings.
  user.vol.charge = null;

  events.push({ type: "move", side, name, move: move.name });

  // ---- Moves that simply refuse on the wrong turn ----
  if (FIRST_TURN_MOVES.has(move.slug) && user.vol.turnsActive > 1) {
    events.push({ type: "moveFailed", side, name, move: move.name, why: "it only works the turn you come in" });
    return;
  }
  if (move.slug === "focus-punch" && user.vol.tookDamage) {
    events.push({ type: "focusBroken", side, name });
    return;
  }

  // Delayed attacks are booked now and paid for two turns from now, so they
  // skip everything below — accuracy included.
  if (DELAYED_MOVES.has(move.slug)) {
    const targetSide = state.teams[1 - side];
    if (targetSide.future) {
      events.push({ type: "noEffect" });
      return;
    }
    const stabBase = user.ability === "adaptability" ? 2 : 1.5;
    targetSide.future = {
      turns: 3, name: move.name, type: move.type, power: move.power,
      level: user.level, spa: battleStat(user, "spa", { attacking: true }),
      stab: user.pokemon.types.includes(move.type) ? stabBase : 1,
    };
    events.push({ type: "futureSet", side, name, move: move.name });
    return;
  }

  // The foe's ability as this attacker sees it — Mold Breaker sees nothing.
  const foeAbility = seenAbility(user, foe);

  // A status move only bounces off a type immunity when it is one of the two
  // that really do (Thunder Wave into a Ground type, Poison Powder into Steel).
  const foeTypes = defendingTypes(foe);
  // Scrappy and Mind's Eye put Normal and Fighting through a Ghost type.
  const ignoresGhost = GHOST_HITTERS.has(user.ability) && (move.type === "normal" || move.type === "fighting");
  const eff = typeEffectiveness(move.type, ignoresGhost ? foeTypes.filter((t) => t !== "ghost") : foeTypes);
  if (
    move.category === "status" && targetsFoe(move) && eff === 0 &&
    STATUS_TYPES_THAT_RESPECT_IMMUNITY.includes(move.type)
  ) {
    events.push({ type: "immune", side: 1 - side, name: foe.pokemon.name });
    return;
  }

  // Whole categories of move a Pokémon simply doesn't have to deal with.
  if (targetsFoe(move) && foe.hp > 0) {
    const flagImmunity =
      FLAG_IMMUNE_ABILITY[foeAbility] && hasFlag(move, FLAG_IMMUNE_ABILITY[foeAbility])
        ? ABILITIES[foeAbility].name
        : hasFlag(move, "powder") && foe.item === "safety-goggles" ? "Safety Goggles"
        : hasFlag(move, "powder") && foeTypes.includes("grass") ? "being a Grass type"
        : null;
    if (flagImmunity) {
      events.push({ type: "moveBlocked", side: 1 - side, name: foe.pokemon.name, move: move.name, by: flagImmunity });
      breakLocks(user, side, events);
      return;
    }
    // A Dark type is far too cynical to be hit by a Prankster status move.
    if (user.ability === "prankster" && move.category === "status" && foeTypes.includes("dark")) {
      events.push({ type: "moveBlocked", side: 1 - side, name: foe.pokemon.name, move: move.name, by: "being a Dark type" });
      return;
    }
  }

  // ---- Protect, and the hiding places it can't reach into ----
  const breaksProtect = CHARGE_MOVES[move.slug]?.breaksProtect || move.slug === "feint";
  if (foe.vol.protect && targetsFoe(move) && !breaksProtect) {
    events.push({ type: "protected", side: 1 - side, name: foe.pokemon.name, move: move.name });
    // Now that moves carry a contact flag, the shields with teeth can use them.
    const punish = PROTECT_PUNISH[foe.vol.protectedWith];
    if (punish && hasFlag(move, "contact")) {
      if (punish.chip && takesIndirectDamage(user)) {
        chip(user, side, Math.max(1, Math.floor(user.maxHP / punish.chip)), foe.vol.protectedWith === "spiky-shield" ? "Spiky Shield" : "the shield", events);
      }
      if (punish.stat) {
        applyStatChanges(user, side, [{ stat: punish.stat, change: punish.change }], events, {
          fromFoe: true, ability: seenAbility(foe, user),
        });
      }
      if (punish.status) inflictStatus(user, side, punish.status, events, rng, { weather });
      checkFaint(state, events);
    }
    breakLocks(user, side, events);
    return;
  }
  const foeHiding = foe.vol.charge?.invuln ?? null;
  if (foeHiding && targetsFoe(move) && !REACHES_INVULN[foeHiding].includes(move.slug)) {
    events.push({ type: "miss", side, name, move: move.name, hiding: foeHiding });
    breakLocks(user, side, events);
    return;
  }

  // Accuracy. null accuracy never misses, and neither does anything at all if
  // either side has No Guard.
  const noGuard = user.ability === "no-guard" || foeAbility === "no-guard";
  if (move.accuracy != null && !noGuard) {
    // Keen Eye and friends look straight past a raised evasion; nothing looks
    // past a lowered one, so only the positive half is ignored.
    const foeEva = CLEAR_SIGHTED.has(user.ability) ? Math.min(0, foe.stages.eva) : foe.stages.eva;
    const stageDiff = Math.max(-6, Math.min(6, user.stages.acc - foeEva));
    let hitChance = (move.accuracy / 100) * stageMult(stageDiff, 3);
    if (user.ability === "compound-eyes") hitChance *= 1.3;
    if (user.ability === "victory-star") hitChance *= 1.1;
    if (user.ability === "hustle" && move.category === "physical") hitChance *= 0.8;
    if (foe.item === "bright-powder") hitChance *= 0.9;
    if (EVASION_WEATHER_ABILITY[foeAbility] === weather) hitChance *= 0.8; // 1.25× evasion
    if (!rng.chance(Math.min(1, hitChance))) {
      events.push({ type: "miss", side, name, move: move.name });
      breakLocks(user, side, events);
      return;
    }
  }

  if (move.category === "status") {
    // A status move breaks a Metronome streak just as surely as a miss does.
    user.vol.repeat = { slug: move.slug, uses: 1 };
    applyStatusMove(state, side, move, events, rng);
    startLocks(state, side, move, events, rng);
    return;
  }

  // ---- Damaging move ----
  const isPhysical = move.category === "physical";
  const atkKey = isPhysical ? "atk" : "spa";
  const defKey = isPhysical ? "def" : "spd";

  if (eff === 0) {
    events.push({ type: "immune", side: 1 - side, name: foe.pokemon.name });
    breakLocks(user, side, events);
    return;
  }

  // Wonder Guard turns away everything that isn't super effective.
  if (foeAbility === "wonder-guard" && eff <= 1) {
    events.push({ type: "moveBlocked", side: 1 - side, name: foe.pokemon.name, move: move.name, by: "Wonder Guard" });
    breakLocks(user, side, events);
    return;
  }

  // Abilities and items that swallow the move whole.
  if (ABSORB_ABILITY_TYPE[foeAbility] === move.type) {
    // Dry Skin drinks a quarter like the rest; the others do too.
    const healed = Math.min(foe.maxHP - foe.hp, Math.floor(foe.maxHP / 4));
    if (healed > 0) foe.hp += healed;
    events.push({
      type: "absorb", side: 1 - side, name: foe.pokemon.name,
      ability: ABILITIES[foeAbility].name, amount: healed,
    });
    breakLocks(user, side, events);
    return;
  }
  if (REDIRECT_ABILITY[foeAbility]?.type === move.type) {
    const { stat, change } = REDIRECT_ABILITY[foeAbility];
    events.push({ type: "absorb", side: 1 - side, name: foe.pokemon.name, ability: ABILITIES[foeAbility].name, amount: 0 });
    applyStatChanges(foe, 1 - side, [{ stat, change }], events);
    breakLocks(user, side, events);
    return;
  }
  if (move.type === "fire" && foeAbility === "flash-fire") {
    events.push({ type: "absorb", side: 1 - side, name: foe.pokemon.name, ability: "Flash Fire", amount: 0 });
    breakLocks(user, side, events);
    return;
  }
  if (move.type === "ground" && !isGrounded(foe, foeAbility)) {
    events.push({ type: "immune", side: 1 - side, name: foe.pokemon.name });
    breakLocks(user, side, events);
    return;
  }

  // Multi-hit moves: 2-5 with the real 35/35/15/15 split, or a fixed count.
  // Skill Link skips the roll entirely and takes the top of the range.
  let hits = 1;
  if (move.meta?.minHits != null && move.meta?.maxHits != null) {
    if (move.meta.minHits === move.meta.maxHits) {
      hits = move.meta.minHits;
    } else if (user.ability === "skill-link") {
      hits = move.meta.maxHits;
    } else {
      const r = rng.int(20);
      hits = r < 7 ? 2 : r < 14 ? 3 : r < 17 ? 4 : 5;
    }
  }

  // Sheer Force trades the move's extra effect for raw power. The flag is read
  // once here and again after the hit, where it silences the secondary.
  const sheerForced = user.ability === "sheer-force" && hasSecondaryEffect(move);
  const contact = hasFlag(move, "contact");
  const basePower = movePower(state, side, move, { foeHiding, weather });
  let totalDamage = 0;
  let brokeSub = false;
  // A Rough Skin or Rocky Helmet can knock the attacker out mid-flurry, and a
  // fainted Pokémon doesn't get to finish its multi-hit move.
  for (let h = 0; h < hits && foe.hp > 0 && user.hp > 0; h++) {
    let critStages = move.meta?.critRate ?? 0;
    if (user.ability === "super-luck") critStages += 1;
    if (user.item === "scope-lens" || user.item === "razor-claw") critStages += 1;
    const critChance = [1 / 24, 1 / 8, 1 / 2, 1][Math.min(3, critStages)];
    const crit = rng.chance(critChance) && !CRIT_PROOF.has(foeAbility);

    // Unaware refuses to look at the other side's stat changes — each way round.
    const atk = attackStat(user, atkKey, {
      crit, isPhysical, weather, ignoreStages: foeAbility === "unaware",
    });
    const def = defenseStat(foe, defKey, {
      crit, weather, ability: foeAbility, ignoreStages: user.ability === "unaware",
    });

    // Power modifiers: Technician, then the low-HP pinch abilities, then the
    // flag-reading abilities, then Sheer Force and Sand Force.
    let power = basePower;
    if (user.ability === "technician" && power <= 60) power = Math.floor(power * 1.5);
    if (PINCH_ABILITY_TYPE[user.ability] === move.type && user.hp * 3 <= user.maxHP) {
      power = Math.floor(power * 1.5);
    }
    const flagBoost = FLAG_POWER_ABILITY[user.ability];
    if (flagBoost && hasFlag(move, flagBoost.flag)) power = Math.floor(power * flagBoost.mult);
    if (user.ability === "reckless" && move.meta?.drain < 0) power = Math.floor(power * 1.2);
    if (sheerForced) power = Math.floor(power * 1.3);
    if (user.ability === "sand-force" && weather === "sand" &&
        ["rock", "ground", "steel"].includes(move.type)) {
      power = Math.floor(power * 1.3);
    }

    const stabBase = user.ability === "adaptability" ? 2 : 1.5;
    const stab = user.pokemon.types.includes(move.type) ? stabBase : 1;

    // The `other` multiplier battle.js has always had ready: weather, screens,
    // items and the defensive abilities — multiplied together, floored once.
    let other = 1;
    if (weather === "rain") other *= move.type === "water" ? 1.5 : move.type === "fire" ? 0.5 : 1;
    if (weather === "sun") other *= move.type === "fire" ? 1.5 : move.type === "water" ? 0.5 : 1;
    if (!(user.ability === "infiltrator")) other *= screenMultiplier(state, 1 - side, isPhysical, crit);
    if (user.item === "life-orb") other *= 1.3;
    if (user.item === "expert-belt" && eff > 1) other *= 1.2;
    if (TYPE_BOOST_ITEM[user.item] === move.type) other *= 1.2;
    if (user.item === "muscle-band" && isPhysical) other *= 1.1;
    if (user.item === "wise-glasses" && !isPhysical) other *= 1.1;
    if (user.item === "metronome" && user.vol.repeat?.slug === move.slug) {
      other *= Math.min(2, 1 + 0.2 * user.vol.repeat.uses);
    }
    if (user.ability === "water-bubble" && move.type === "water") other *= 2;
    if (user.ability === "analytic" && movesLast) other *= 1.3;
    if (user.ability === "sniper" && crit) other *= 1.5;
    if (user.ability === "tinted-lens" && eff < 1) other *= 2;

    if (foeAbility === "thick-fat" && (move.type === "fire" || move.type === "ice")) other *= 0.5;
    if (foeAbility === "heatproof" && move.type === "fire") other *= 0.5;
    if (foeAbility === "water-bubble" && move.type === "fire") other *= 0.5;
    if (foeAbility === "fluffy") {
      if (contact) other *= 0.5;
      if (move.type === "fire") other *= 2;
    }
    if (foeAbility === "ice-scales" && !isPhysical) other *= 0.5;
    if (foeAbility === "punk-rock" && hasFlag(move, "sound")) other *= 0.5;
    if (QUARTER_DAMAGE_ON_SE.has(foeAbility) && eff > 1) other *= 0.75;
    if (HALVE_AT_FULL_HP.has(foeAbility) && foe.hp === foe.maxHP) other *= 0.5;

    // A type-resist berry is eaten on the way in, so it only ever helps once.
    const berryType = RESIST_BERRY[foe.item];
    if (berryType === move.type && (eff > 1 || move.type === "normal") && canEatBerry(foe)) {
      other *= 0.5;
      consumeItem(foe, 1 - side, ITEMS[foe.item].name, events);
    }

    const calc = calcDamage({
      level: user.level, power, atk, def,
      stab, effectiveness: eff, crit,
      burn: user.status === "burn" && isPhysical && user.ability !== "guts",
      other,
    });
    const rollIndex = rng.rollIndex();
    const raw = calc.rolls[rollIndex];
    const detail = { atk, def, atkKey, defKey, power, other, rollIndex, rolls: calc.rolls };

    // A Substitute eats the hit and everything that rides on it — unless the
    // attacker has Infiltrator, which walks straight through the doll.
    if (foe.vol.sub > 0 && user.ability !== "infiltrator") {
      const dmg = Math.min(foe.vol.sub, raw);
      foe.vol.sub -= dmg;
      totalDamage += dmg;
      events.push({
        type: "damage", side: 1 - side, name: foe.pokemon.name, move: move.name,
        amount: dmg, crit, effectiveness: eff, stab, hit: h + 1, hits,
        toSub: true, detail, hpLeft: foe.hp, maxHP: foe.maxHP,
      });
      if (foe.vol.sub <= 0) {
        foe.vol.sub = 0;
        brokeSub = true;
        events.push({ type: "subBroke", side: 1 - side, name: foe.pokemon.name });
        break; // the rest of a multi-hit move stops at the broken doll
      }
      continue;
    }

    let dmg = Math.min(foe.hp, raw);

    // Sturdy and Focus Sash: a KO from full HP leaves 1 instead.
    if (dmg >= foe.hp && foe.hp === foe.maxHP && foe.hp > 1) {
      if (foeAbility === "sturdy") {
        dmg = foe.hp - 1;
        events.push({ type: "endure", side: 1 - side, name: foe.pokemon.name, via: "Sturdy" });
      } else if (foe.item === "focus-sash") {
        dmg = foe.hp - 1;
        foe.item = null;
        events.push({ type: "endure", side: 1 - side, name: foe.pokemon.name, via: "Focus Sash" });
      }
    }
    const wasAboveHalf = foe.hp * 2 > foe.maxHP;

    foe.hp -= dmg;
    foe.vol.tookDamage = true;
    totalDamage += dmg;

    events.push({
      type: "damage", side: 1 - side, name: foe.pokemon.name,
      move: move.name, amount: dmg, crit, effectiveness: eff, stab,
      hit: h + 1, hits,
      // The working, for the UI to show.
      detail,
      hpLeft: foe.hp, maxHP: foe.maxHP,
    });

    if (foe.item === "air-balloon" && !foe.balloonPopped && dmg > 0) {
      foe.balloonPopped = true;
      events.push({ type: "balloonPop", side: 1 - side, name: foe.pokemon.name });
    }

    // What the target does about having been hit. All of it needs a target
    // that is still standing, and none of it cares whether the move had a
    // secondary effect of its own.
    if (foe.hp > 0 && dmg > 0) {
      reactToHit(state, side, move, { crit, isPhysical, eff, wasAboveHalf, contact, weather }, events, rng);
    }
  }

  const hitTheTarget = totalDamage > 0 && !brokeSub && foe.vol.sub === 0;

  // Metronome counts consecutive uses of the same move, win or lose. `uses` is
  // the count BEFORE this one, so the first swing is always plain 1×.
  user.vol.repeat = user.vol.repeat?.slug === move.slug
    ? { slug: move.slug, uses: user.vol.repeat.uses + 1 }
    : { slug: move.slug, uses: 1 };

  // Drain / recoil are a percentage of damage dealt; Struggle is special-cased
  // to modern rules (quarter of the user's max HP). Magic Guard blocks recoil
  // and Life Orb — but never Struggle's.
  if (move === STRUGGLE) {
    applyRecoil(user, side, Math.floor(user.maxHP / 4), events);
  } else if (move.meta?.drain) {
    let frac = Math.floor((totalDamage * Math.abs(move.meta.drain)) / 100);
    if (move.meta.drain > 0) {
      if (user.item === "big-root") frac = Math.floor(frac * 1.3);
      const healed = Math.min(user.maxHP - user.hp, Math.max(1, frac));
      user.hp += healed;
      events.push({ type: "drain", side, name: user.pokemon.name, amount: healed });
    } else if (takesIndirectDamage(user) && user.ability !== "rock-head") {
      applyRecoil(user, side, Math.max(1, frac), events);
    }
  }
  // Sheer Force's trade includes the Life Orb's price — that is the real rule,
  // not a rounding error, and it is why Sheer Force + Life Orb is a set.
  if (user.item === "life-orb" && totalDamage > 0 && takesIndirectDamage(user) && user.hp > 0 && !sheerForced) {
    applyRecoil(user, side, Math.max(1, Math.floor(user.maxHP / 10)), events);
  }
  if (user.item === "shell-bell" && totalDamage > 0 && user.hp > 0 && user.hp < user.maxHP) {
    const healed = Math.min(user.maxHP - user.hp, Math.max(1, Math.floor(totalDamage / 8)));
    user.hp += healed;
    events.push({ type: "heal", side, name: user.pokemon.name, amount: healed, via: "Shell Bell" });
  }

  // Rapid Spin sweeps the user's own side clear on the way through.
  if (move.slug === "rapid-spin" && totalDamage > 0) {
    const hz = state.teams[side].hazards;
    if (hz.stealthRock || hz.spikes || hz.toxicSpikes || hz.stickyWeb) {
      state.teams[side].hazards = { stealthRock: false, spikes: 0, toxicSpikes: 0, stickyWeb: false };
      events.push({ type: "hazardClear", side, hazard: "everything", by: user.pokemon.name });
    }
  }

  // The user's own stat changes (Draco Meteor's Sp. Atk crash, Close Combat's
  // defences) happen whether or not the target survived the hit.
  applySelfStatChanges(state, side, move, events, rng);

  // Secondary effects need a target that is still standing and not hiding
  // behind a doll. A flinch set by the slower mover is harmless — the flag
  // resets at turn start, so it only ever robs a target that hasn't moved yet.
  //
  // Sheer Force and Shield Dust both cancel the extra effect outright — one
  // because it sold it for power, the other because it refuses to be bothered.
  const secondariesOff = sheerForced || foeAbility === "shield-dust";
  if (foe.hp > 0 && hitTheTarget && !secondariesOff) {
    applyTargetSecondary(state, side, move, events, rng, { weather, foeAbility });
    // Serene Grace doubles the odds; King's Rock and Stench add a flinch to
    // moves that never had one.
    const grace = user.ability === "serene-grace" ? 2 : 1;
    let flinchPct = (move.meta?.flinchChance ?? 0) * grace;
    if (flinchPct === 0 && (user.item === "kings-rock" || user.ability === "stench")) flinchPct = 10;
    if (flinchPct > 0 && foeAbility !== "inner-focus" && rng.chance(Math.min(1, flinchPct / 100))) {
      foe.flinched = true;
    }
  }

  // Moxie and its cousins take their boost the moment the target goes down,
  // and Aftermath takes its pound of flesh on the way out.
  if (foe.hp <= 0 && totalDamage > 0) {
    if (foe.ability === "aftermath" && contact && takesIndirectDamage(user) && user.hp > 0) {
      chip(user, side, Math.max(1, Math.floor(user.maxHP / 4)), "Aftermath", events);
    }
    if (user.hp > 0) {
      const koStat = KO_BOOST_STAT[user.ability]
        ?? (user.ability === "beast-boost" ? bestStatKey(user) : null);
      if (koStat) applyStatChanges(user, side, [{ stat: koStat, change: 1 }], events);
    }
  }

  // Recharge, rampage locks and momentum counters all key off "did it land".
  startLocks(state, side, move, events, rng, { landed: totalDamage > 0 });

  // U-turn and friends: the user is done here.
  if (SWITCH_OUT_MOVES.has(move.slug) && totalDamage > 0 && user.hp > 0) {
    const bench = state.teams[side].battlers.some((x, i) => x.hp > 0 && i !== state.teams[side].active);
    if (bench) {
      state.pendingReplacement[side] = true;
      events.push({ type: "switchOut", side, name });
    }
  }

  checkFaint(state, events);
}

/**
 * Everything the target does about having just been hit, in this fixed order:
 *
 *   1. Anger Point answers a critical hit
 *   2. the type-reading reactions — Justified, Rattled, Water Compaction
 *   3. Stamina and Weak Armor, which answer any hit at all
 *   4. Berserk, which needs the HP to have crossed halfway on THIS hit
 *   5. a Weakness Policy, which needs the hit to have been super effective
 *   6. contact: the chip abilities and Rocky Helmet
 *   7. contact: the abilities that hand out a status or a stat drop
 *   8. the attacker's own Poison Touch
 *
 * All of it fires per hit, so a five-hit Bullet Seed into Rough Skin really
 * does cost the attacker five eighths of its health.
 */
function reactToHit(state, attackerSide, move, ctx, events, rng) {
  const { crit, isPhysical, eff, wasAboveHalf, contact, weather } = ctx;
  const user = active(state, attackerSide);
  const foe = active(state, 1 - attackerSide);
  const foeSide = 1 - attackerSide;
  const ab = foe.ability;
  // A stat drop the attacker's ability might refuse, e.g. Gooey into Clear Body.
  const onUser = (changes) =>
    applyStatChanges(user, attackerSide, changes, events, { fromFoe: true, ability: seenAbility(foe, user) });

  if (crit && ab === "anger-point") {
    applyStatChanges(foe, foeSide, [{ stat: "atk", change: 12 }], events);
  }
  if (ab === "justified" && move.type === "dark") {
    applyStatChanges(foe, foeSide, [{ stat: "atk", change: 1 }], events);
  }
  if (ab === "rattled" && ["bug", "ghost", "dark"].includes(move.type)) {
    applyStatChanges(foe, foeSide, [{ stat: "spe", change: 1 }], events);
  }
  if (ab === "water-compaction" && move.type === "water") {
    applyStatChanges(foe, foeSide, [{ stat: "def", change: 2 }], events);
  }
  if (ab === "stamina") {
    applyStatChanges(foe, foeSide, [{ stat: "def", change: 1 }], events);
  }
  if (ab === "weak-armor" && isPhysical) {
    applyStatChanges(foe, foeSide, [{ stat: "def", change: -1 }, { stat: "spe", change: 2 }], events);
  }
  if (ab === "berserk" && wasAboveHalf && foe.hp * 2 <= foe.maxHP) {
    applyStatChanges(foe, foeSide, [{ stat: "spa", change: 1 }], events);
  }

  if (foe.item === "weakness-policy" && eff > 1) {
    consumeItem(foe, foeSide, "Weakness Policy", events);
    applyStatChanges(foe, foeSide, [{ stat: "atk", change: 2 }, { stat: "spa", change: 2 }], events);
  }

  if (contact) {
    if (CHIP_ON_CONTACT.has(ab) && takesIndirectDamage(user)) {
      chip(user, attackerSide, Math.max(1, Math.floor(user.maxHP / 8)), ABILITIES[ab].name, events);
    }
    if (foe.item === "rocky-helmet" && takesIndirectDamage(user)) {
      chip(user, attackerSide, Math.max(1, Math.floor(user.maxHP / 6)), "Rocky Helmet", events);
    }
    if (user.hp > 0) {
      const status = CONTACT_STATUS_ABILITY[ab];
      if (status && rng.chance(0.3)) {
        inflictStatus(user, attackerSide, status, events, rng, { weather });
      } else if (ab === "effect-spore" && rng.chance(0.3)) {
        // The published split is 9% poison, 10% paralysis, 11% sleep; inside
        // the 30% that fired, that's an even-ish three-way pick.
        const roll = rng.int(30);
        const spore = roll < 9 ? "poison" : roll < 19 ? "paralysis" : "sleep";
        inflictStatus(user, attackerSide, spore, events, rng, { weather });
      } else if (SPEED_STAT_LOWER_ON_CONTACT.has(ab)) {
        onUser([{ stat: "spe", change: -1 }]);
      } else if (ab === "cursed-body" && user.vol.lastMoveIndex != null && !user.vol.disable && rng.chance(0.3)) {
        user.vol.disable = { moveIndex: user.vol.lastMoveIndex, turns: 4 };
        events.push({ type: "disabled", side: attackerSide, name: user.pokemon.name, move: move.name });
      }
    }
    if (user.ability === "poison-touch" && foe.hp > 0 && rng.chance(0.3)) {
      inflictStatus(foe, foeSide, "poison", events, rng, { weather, ability: seenAbility(user, foe) });
    }
  }
}

/** Whichever of the five non-HP stats is highest — what Beast Boost picks. */
function bestStatKey(b) {
  const keys = ["atk", "def", "spa", "spd", "spe"];
  return keys.reduce((best, k) => (b.stats[k] > b.stats[best] ? k : best), "atk");
}

/**
 * Does this move carry an extra effect at all? Sheer Force trades exactly this
 * away for 1.3× power, so the question has to be asked the same way every time:
 * a chance-based status, a flinch, or a stat change aimed at the target.
 */
function hasSecondaryEffect(move) {
  if (move.category === "status") return false;
  if ((move.meta?.ailmentChance ?? 0) > 0) return true;
  if ((move.meta?.flinchChance ?? 0) > 0) return true;
  if (move.statChanges?.length && !statChangesHitUser(move)) return true;
  return false;
}

/**
 * The power a move swings with before Technician and the pinch abilities:
 * momentum doubling (Rollout, Fury Cutter), Solar Beam's bad-weather penalty,
 * and the bonus for catching something underground or in the air.
 */
function movePower(state, side, move, { foeHiding, weather = state.weather.kind }) {
  const user = active(state, side);
  let power = move.power;

  const momentum = user.vol.momentum;
  if (momentum?.slug === move.slug) {
    const cap = FURY_CUTTER_MOVES.has(move.slug) ? 2 : 4; // 40→160, 30→480
    power = power * 2 ** Math.min(cap, momentum.hits);
  }

  const chargeInfo = CHARGE_MOVES[move.slug];
  if (chargeInfo?.weakIn?.includes(weather)) power = Math.floor(power / 2);

  if (foeHiding && DOUBLES_ON_INVULN[foeHiding].includes(move.slug)) power *= 2;

  return power;
}

/** Reflect / Light Screen / Aurora Veil on the defending side. Crits ignore them. */
function screenMultiplier(state, defSide, isPhysical, crit) {
  if (crit) return 1;
  const sc = state.teams[defSide].screens;
  if (sc.auroraVeil > 0) return 0.5;
  if (isPhysical && sc.reflect > 0) return 0.5;
  if (!isPhysical && sc.lightScreen > 0) return 0.5;
  return 1;
}

/**
 * Start (or continue) whatever multi-turn commitment this move carries. Called
 * once the move has resolved, because every one of them cares whether it hit.
 */
function startLocks(state, side, move, events, rng, { landed = true } = {}) {
  const user = active(state, side);

  // Momentum: consecutive uses of the same move double its power, and any
  // other move — or a miss — resets it.
  if (landed && (ROLLOUT_MOVES.has(move.slug) || FURY_CUTTER_MOVES.has(move.slug))) {
    user.vol.momentum = user.vol.momentum?.slug === move.slug
      ? { slug: move.slug, hits: user.vol.momentum.hits + 1 }
      : { slug: move.slug, hits: 1 };
  } else if (user.vol.momentum?.slug !== move.slug || !landed) {
    user.vol.momentum = null;
  }

  if (!landed) return;

  if (RECHARGE_MOVES.has(move.slug)) {
    user.vol.recharge = true;
    events.push({ type: "mustRecharge", side, name: user.pokemon.name });
    return;
  }

  if (user.vol.locked) {
    user.vol.locked.turns -= 1;
    if (user.vol.locked.turns <= 0) {
      const kind = user.vol.locked.kind;
      user.vol.locked = null;
      if (kind === "rampage") {
        events.push({ type: "rampageEnd", side, name: user.pokemon.name });
        confuse(user, side, events, rng);
      }
    }
    return;
  }
  // Struggle has no slot to lock onto, so there is nothing to commit to.
  if (user.vol.lastMoveIndex == null) return;
  if (RAMPAGE_MOVES.has(move.slug)) {
    // Two or three more turns of swinging after this one.
    user.vol.locked = { moveIndex: user.vol.lastMoveIndex, turns: 1 + rng.int(2), kind: "rampage" };
  } else if (ROLLOUT_MOVES.has(move.slug)) {
    user.vol.locked = { moveIndex: user.vol.lastMoveIndex, turns: 4, kind: "rollout" };
  }
}

/** A miss, a Protect or a flinch drops the user out of a rampage, unconfused. */
function breakLocks(user, side, events) {
  if (user.vol.locked) {
    user.vol.locked = null;
    events.push({ type: "rampageEnd", side, name: user.pokemon.name, early: true });
  }
  user.vol.momentum = null;
  user.vol.charge = null;
}

function targetsFoe(move) {
  return move.target !== "user" && move.target !== "users-field" && move.target !== "entire-field";
}

function applyRecoil(user, side, amount, events) {
  const dmg = Math.min(user.hp, amount);
  user.hp -= dmg;
  user.vol.tookDamage = true;
  events.push({ type: "recoil", side, name: user.pokemon.name, amount: dmg, hpLeft: user.hp });
}

/** Confusion's own attack: 40 power, typeless, physical, its own stats both sides. */
function hitSelfInConfusion(user, side, events, rng) {
  const atk = battleStat(user, "atk", { attacking: true });
  const def = battleStat(user, "def", {});
  const calc = calcDamage({ level: user.level, power: 40, atk, def });
  const rollIndex = rng.rollIndex();
  const dmg = Math.min(user.hp, calc.rolls[rollIndex]);
  user.hp -= dmg;
  user.vol.tookDamage = true;
  events.push({
    type: "confusionHit", side, name: user.pokemon.name, amount: dmg,
    hpLeft: user.hp, maxHP: user.maxHP,
  });
}

function confuse(target, targetSide, events, rng, { ability = target.ability } = {}) {
  if (ability === "own-tempo" || ability === "oblivious") {
    events.push({ type: "immune", side: targetSide, name: target.pokemon.name });
    return;
  }
  if (target.vol.confusion > 0) {
    events.push({ type: "noEffect", side: targetSide, name: target.pokemon.name });
    return;
  }
  // 2-5 turns. The counter is decremented before each move attempt, so the
  // stored number is "attempts left including this one".
  target.vol.confusion = 2 + (rng ? rng.int(4) : 2);
  events.push({ type: "confused", side: targetSide, name: target.pokemon.name });
  if (target.item === "lum-berry" && canEatBerry(target)) {
    target.vol.confusion = 0;
    consumeItem(target, targetSide, "Lum Berry", events);
  }
}

/* ---------------------------------------------------------- status moves --- */

function applyStatusMove(state, side, move, events, rng) {
  const user = active(state, side);
  const foe = active(state, 1 - side);
  const onSelf = !targetsFoe(move);

  // Weather setters. The rock that stretches it to eight turns is the
  // setter's, so setWeather is handed the user.
  if (WEATHER_MOVES[move.slug]) {
    setWeather(state, WEATHER_MOVES[move.slug], events, user);
    return;
  }

  // Screens, Tailwind and Trick Room: the timed field effects.
  const screen = SCREEN_MOVES[move.slug];
  if (screen) {
    if (screen === "auroraVeil" && weatherOf(state) !== "snow") {
      events.push({ type: "moveFailed", side, name: user.pokemon.name, move: move.name, why: "it needs snow" });
      return;
    }
    const screens = state.teams[side].screens;
    if (screens[screen] > 0) return events.push({ type: "noEffect" });
    screens[screen] = user.item === "light-clay" ? 8 : 5;
    events.push({ type: "screenSet", side, screen: move.name, turns: screens[screen] });
    return;
  }
  if (move.slug === "tailwind") {
    if (state.teams[side].tailwind > 0) return events.push({ type: "noEffect" });
    state.teams[side].tailwind = 4;
    events.push({ type: "tailwind", side });
    return;
  }
  if (move.slug === "trick-room") {
    // Using it again while it is up tears it down early, exactly as in game.
    if (state.trickRoom > 0) {
      state.trickRoom = 0;
      events.push({ type: "trickRoomEnd" });
    } else {
      state.trickRoom = 5;
      events.push({ type: "trickRoom" });
    }
    return;
  }

  // Protect and its cousins. Each consecutive use is three times likelier to
  // fail than the last, which is the only thing stopping it being unbeatable.
  if (PROTECT_MOVES.has(move.slug)) {
    const odds = 1 / 3 ** user.vol.protectStreak;
    if (user.vol.protectStreak > 0 && !rng.chance(odds)) {
      user.vol.protectStreak = 0;
      events.push({ type: "moveFailed", side, name: user.pokemon.name, move: move.name, why: "it was used too often" });
      return;
    }
    user.vol.protect = true;
    user.vol.protectedWith = move.slug;
    user.vol.protectStreak += 1;
    events.push({ type: "protecting", side, name: user.pokemon.name, move: move.name });
    return;
  }

  if (move.slug === "substitute") {
    const cost = Math.floor(user.maxHP / 4);
    if (user.vol.sub > 0) return events.push({ type: "noEffect", side, name: user.pokemon.name });
    if (user.hp <= cost) {
      events.push({ type: "moveFailed", side, name: user.pokemon.name, move: move.name, why: "it doesn't have the HP" });
      return;
    }
    user.hp -= cost;
    user.vol.sub = cost;
    events.push({ type: "subMade", side, name: user.pokemon.name, hp: cost, hpLeft: user.hp, maxHP: user.maxHP });
    return;
  }

  // Wish and the delayed attacks: set a timer, walk away.
  if (move.slug === "wish") {
    if (state.teams[side].wish) return events.push({ type: "noEffect" });
    state.teams[side].wish = { turns: 2, amount: Math.floor(user.maxHP / 2) };
    events.push({ type: "wishMade", side, name: user.pokemon.name });
    return;
  }

  // Hazard layers land on the FOE's side of the field.
  if (HAZARD_MOVES.includes(move.slug)) {
    const hz = state.teams[1 - side].hazards;
    if (move.slug === "stealth-rock") {
      if (hz.stealthRock) return events.push({ type: "noEffect" });
      hz.stealthRock = true;
    } else if (move.slug === "spikes") {
      if (hz.spikes >= 3) return events.push({ type: "noEffect" });
      hz.spikes += 1;
    } else if (move.slug === "toxic-spikes") {
      if (hz.toxicSpikes >= 2) return events.push({ type: "noEffect" });
      hz.toxicSpikes += 1;
    } else {
      if (hz.stickyWeb) return events.push({ type: "noEffect" });
      hz.stickyWeb = true;
    }
    events.push({ type: "hazardSet", side: 1 - side, hazard: move.name });
    return;
  }

  // Defog clears every hazard on both sides and takes the screens with it.
  if (move.slug === "defog") {
    for (const s of [0, 1]) {
      state.teams[s].hazards = { stealthRock: false, spikes: 0, toxicSpikes: 0, stickyWeb: false };
      state.teams[s].screens = { reflect: 0, lightScreen: 0, auroraVeil: 0 };
    }
    events.push({ type: "hazardClear", side, hazard: "everything", by: user.pokemon.name });
    if (move.statChanges?.length) applyStatChanges(foe, 1 - side, move.statChanges, events, { fromFoe: true });
    return;
  }

  // Taunt, Encore and Disable: three different ways to take a move away.
  if (move.slug === "taunt") {
    if (foe.vol.taunt > 0) return events.push({ type: "noEffect", side: 1 - side, name: foe.pokemon.name });
    if (foe.ability === "oblivious") {
      return events.push({ type: "moveBlocked", side: 1 - side, name: foe.pokemon.name, move: move.name, by: "Oblivious" });
    }
    foe.vol.taunt = 3;
    events.push({ type: "taunted", side: 1 - side, name: foe.pokemon.name });
    shakeOffWithMentalHerb(foe, 1 - side, events);
    return;
  }
  if (move.slug === "encore") {
    if (foe.vol.encore || foe.vol.lastMoveIndex == null) {
      return events.push({ type: "noEffect", side: 1 - side, name: foe.pokemon.name });
    }
    foe.vol.encore = { moveIndex: foe.vol.lastMoveIndex, turns: 3 };
    events.push({
      type: "encored", side: 1 - side, name: foe.pokemon.name,
      move: foe.moves[foe.vol.lastMoveIndex]?.move.name ?? "its last move",
    });
    shakeOffWithMentalHerb(foe, 1 - side, events);
    return;
  }
  if (move.slug === "disable") {
    if (foe.vol.disable || foe.vol.lastMoveIndex == null) {
      return events.push({ type: "noEffect", side: 1 - side, name: foe.pokemon.name });
    }
    foe.vol.disable = { moveIndex: foe.vol.lastMoveIndex, turns: 4 };
    events.push({
      type: "disabled", side: 1 - side, name: foe.pokemon.name,
      move: foe.moves[foe.vol.lastMoveIndex]?.move.name ?? "its last move",
    });
    shakeOffWithMentalHerb(foe, 1 - side, events);
    return;
  }

  // Perish Song puts the same clock on everyone standing.
  if (move.slug === "perish-song") {
    let took = false;
    for (const s of [0, 1]) {
      const b = active(state, s);
      if (b.hp > 0 && b.vol.perish == null) {
        b.vol.perish = 4;
        took = true;
      }
    }
    events.push(took ? { type: "perishSong" } : { type: "noEffect" });
    return;
  }

  // Moves that trap with no timer at all.
  if (BINDING_MOVES.has(move.slug)) {
    if (foe.vol.trap) return events.push({ type: "noEffect", side: 1 - side, name: foe.pokemon.name });
    foe.vol.trap = { turns: null, by: move.name };
    events.push({ type: "trapSet", side: 1 - side, name: foe.pokemon.name, by: move.name, chips: false });
    return;
  }

  // Healing moves (Recover, Roost...): percentage of max HP.
  if (move.meta?.healing) {
    const healed = Math.min(
      user.maxHP - user.hp,
      Math.floor((user.maxHP * move.meta.healing) / 100)
    );
    if (healed <= 0) {
      events.push({ type: "noEffect", side, name: user.pokemon.name });
      return;
    }
    user.hp += healed;
    events.push({ type: "heal", side, name: user.pokemon.name, amount: healed });
    // Roost costs you your wings until the end of the turn.
    if (move.slug === "roost" && user.pokemon.types.includes("flying")) {
      user.vol.roosted = true;
      events.push({ type: "roosted", side, name: user.pokemon.name });
    }
    return;
  }

  // Stat changes.
  if (move.statChanges?.length) {
    const target = onSelf ? user : foe;
    const targetSide = onSelf ? side : 1 - side;
    if (!onSelf && foe.vol.sub > 0) {
      events.push({ type: "subBlocked", side: 1 - side, name: foe.pokemon.name });
    } else {
      applyStatChanges(target, targetSide, move.statChanges, events, {
        fromFoe: !onSelf,
        ability: onSelf ? user.ability : seenAbility(user, foe),
      });
    }
  }

  // Ailments (Thunder Wave, Toxic, Sleep Powder, Confuse Ray, Leech Seed...).
  const ailment = move.meta?.ailment ?? "none";
  const status = ailmentToStatus(ailment, move.slug);
  if (status) {
    if (foe.vol.sub > 0) events.push({ type: "subBlocked", side: 1 - side, name: foe.pokemon.name });
    else inflictStatus(foe, 1 - side, status, events, rng, { weather: weatherOf(state), ability: seenAbility(user, foe) });
  } else if (VOLATILE_AILMENTS.has(ailment)) {
    if (foe.vol.sub > 0) events.push({ type: "subBlocked", side: 1 - side, name: foe.pokemon.name });
    else applyVolatileAilment(state, side, move, ailment, events, rng, { ability: seenAbility(user, foe) });
  } else if (!move.statChanges?.length && !move.meta?.healing) {
    // A status move we don't model yet. Say so instead of pretending.
    events.push({ type: "notModeled", side, move: move.name });
  }
}

/**
 * The ailments that live on the field rather than on the Pokémon: confusion,
 * trapping, Leech Seed and Yawn. Perish Song and Disable are handled by slug
 * above because they need more than the ailment name gives us.
 */
function applyVolatileAilment(state, side, move, ailment, events, rng, { ability } = {}) {
  const foe = active(state, 1 - side);
  const foeSide = 1 - side;

  if (ailment === "confusion") {
    confuse(foe, foeSide, events, rng, { ability: ability ?? foe.ability });
    return;
  }
  if (ailment === "trap") {
    if (foe.vol.trap) return events.push({ type: "noEffect", side: foeSide, name: foe.pokemon.name });
    foe.vol.trap = { turns: 4 + rng.int(2), by: move.name };
    events.push({ type: "trapSet", side: foeSide, name: foe.pokemon.name, by: move.name, chips: true });
    return;
  }
  if (ailment === "leech-seed") {
    if (defendingTypes(foe).includes("grass")) {
      return events.push({ type: "immune", side: foeSide, name: foe.pokemon.name });
    }
    if (foe.vol.seeded) return events.push({ type: "noEffect", side: foeSide, name: foe.pokemon.name });
    foe.vol.seeded = true;
    events.push({ type: "seeded", side: foeSide, name: foe.pokemon.name });
    return;
  }
  if (ailment === "yawn") {
    if (foe.status || foe.vol.drowsy > 0) {
      return events.push({ type: "noEffect", side: foeSide, name: foe.pokemon.name });
    }
    foe.vol.drowsy = 2;
    events.push({ type: "drowsy", side: foeSide, name: foe.pokemon.name });
    return;
  }
  events.push({ type: "notModeled", side, move: move.name });
}

/**
 * Move every stage the list asks for.
 *
 * Order inside one change: Substitute turns a foe's drop away first, then
 * Contrary flips it or Simple doubles it, and only then do the guard abilities
 * look at what is left. That order is why Contrary + Clear Body isn't a
 * contradiction — a Contrary'd "drop" is a rise, and Clear Body has no quarrel
 * with a rise.
 *
 * `ability` is the target's ability as the mover sees it, so Mold Breaker can
 * lower a Clear Body Pokémon's stats.
 */
function applyStatChanges(target, targetSide, changes, events, { fromFoe = false, ability = target.ability } = {}) {
  let loweredByFoe = false;

  for (const { stat, change } of changes) {
    const key = stat === "accuracy" ? "acc" : stat === "evasion" ? "eva" : stat;
    if (!(key in target.stages)) continue;
    if (fromFoe && change < 0 && target.vol.sub > 0) {
      events.push({ type: "subBlocked", side: targetSide, name: target.pokemon.name });
      continue;
    }

    let delta = change;
    if (ability === "contrary") delta = -delta;
    else if (ability === "simple") delta *= 2;

    if (fromFoe && delta < 0) {
      const guard =
        STAT_LOCKED.has(ability) ? ABILITIES[ability].name
        : key === "atk" && ability === "hyper-cutter" ? "Hyper Cutter"
        : key === "def" && ability === "big-pecks" ? "Big Pecks"
        : key === "acc" && CLEAR_SIGHTED.has(ability) ? ABILITIES[ability].name
        : null;
      if (guard) {
        events.push({ type: "statsBlocked", side: targetSide, name: target.pokemon.name, stat: key, by: guard });
        continue;
      }
    }

    const before = target.stages[key];
    target.stages[key] = Math.max(-6, Math.min(6, before + delta));
    const moved = target.stages[key] - before;
    events.push({
      type: "stages", side: targetSide, name: target.pokemon.name,
      stat: key, change: moved, now: target.stages[key],
    });
    if (fromFoe && moved < 0) loweredByFoe = true;
  }

  // A White Herb wipes every drop off the board, whoever caused it.
  if (target.item === "white-herb" && Object.values(target.stages).some((s) => s < 0)) {
    for (const key of Object.keys(target.stages)) target.stages[key] = Math.max(0, target.stages[key]);
    consumeItem(target, targetSide, "White Herb", events);
  }

  // Defiant and Competitive answer back — and answering back is not the foe
  // lowering anything, so it can't set this off again.
  if (loweredByFoe) {
    if (target.ability === "defiant") {
      applyStatChanges(target, targetSide, [{ stat: "atk", change: 2 }], events);
    } else if (target.ability === "competitive") {
      applyStatChanges(target, targetSide, [{ stat: "spa", change: 2 }], events);
    }
  }
}

/** Spend a held item: the slot empties, which is what Unburden watches for. */
function consumeItem(b, side, label, events) {
  b.item = null;
  b.vol.unburdened = true;
  events.push({ type: "itemUsed", side, name: b.pokemon.name, item: label });
}

/**
 * Hand out a status. Everything that can refuse one gets its say here: the
 * type immunities, the abilities built to shrug it off, Leaf Guard while the
 * sun is out, and a Lum Berry eaten the instant it lands.
 */
function shakeOffWithMentalHerb(b, side, events) {
  if (b.item !== "mental-herb") return;
  b.vol.taunt = 0;
  b.vol.encore = null;
  b.vol.disable = null;
  consumeItem(b, side, "Mental Herb", events);
}

function inflictStatus(target, targetSide, status, events, rng, { weather = null, ability = target.ability } = {}) {
  if (target.status) {
    events.push({ type: "noEffect", side: targetSide, name: target.pokemon.name });
    return;
  }
  const immune = STATUS_IMMUNE[status] ?? [];
  if (target.pokemon.types.some((t) => immune.includes(t))) {
    events.push({ type: "immune", side: targetSide, name: target.pokemon.name });
    return;
  }
  const proof =
    STATUS_PROOF_ABILITY[status]?.has(ability) ? ABILITIES[ability].name
    : status === "sleep" && SLEEP_PROOF.has(ability) ? ABILITIES[ability].name
    : ability === "leaf-guard" && weather === "sun" ? "Leaf Guard"
    : null;
  if (proof) {
    events.push({ type: "statusBlocked", side: targetSide, name: target.pokemon.name, by: proof });
    return;
  }

  target.status = status;
  // Sleeps for 1-3 turns: the counter is checked-then-decremented on each
  // move attempt, and the waking turn still gets to move.
  if (status === "sleep") target.sleepTurns = 2 + (rng ? rng.int(3) : 1);
  if (status === "toxic") target.toxicCounter = 0;
  events.push({ type: "status", side: targetSide, name: target.pokemon.name, status });

  if (target.item === "lum-berry" && canEatBerry(target)) {
    target.status = null;
    target.sleepTurns = 0;
    consumeItem(target, targetSide, "Lum Berry", events);
  }
}

/** Unnerve is the only thing that stops a berry going down. */
const canEatBerry = (b) => BERRIES.has(b.item) && !b.vol.unnerved;

/**
 * The user's half of a damaging move's stat changes — Draco Meteor dropping
 * its own Sp. Atk, Close Combat its defences, Meteor Mash raising its Attack.
 *
 * This runs even when the target fainted, because in the real games it does:
 * a Draco Meteor that knocks something out still leaves the user at -2.
 */
function applySelfStatChanges(state, side, move, events, rng) {
  if (!move.statChanges?.length || move.category === "status") return;
  if (!statChangesHitUser(move)) return;
  const chance = move.effectChance ?? 100;
  if (chance < 100 && !rng.chance(chance / 100)) return;
  applyStatChanges(active(state, side), side, move.statChanges, events);
}

/**
 * Chance-based extras a damaging move lands ON THE TARGET. Serene Grace
 * doubles every one of those chances, which is the whole ability.
 */
function applyTargetSecondary(state, side, move, events, rng, { weather = null, foeAbility } = {}) {
  const user = active(state, side);
  const foe = active(state, 1 - side);
  const ability = foeAbility ?? foe.ability;
  const grace = user.ability === "serene-grace" ? 2 : 1;
  const ailment = move.meta?.ailment ?? "none";
  const ailmentChance = (move.meta?.ailmentChance ?? 0) * grace;

  if (ailmentChance > 0 && rng.chance(Math.min(1, ailmentChance / 100))) {
    const status = ailmentToStatus(ailment, move.slug);
    if (status) inflictStatus(foe, 1 - side, status, events, rng, { weather, ability });
    else if (VOLATILE_AILMENTS.has(ailment)) applyVolatileAilment(state, side, move, ailment, events, rng, { ability });
  }

  if (move.statChanges?.length && !statChangesHitUser(move)) {
    const chance = (move.effectChance ?? 100) * grace;
    if (chance >= 100 || rng.chance(Math.min(1, chance / 100))) {
      applyStatChanges(foe, 1 - side, move.statChanges, events, { fromFoe: true, ability });
    }
  }
}

/* ---------------------------------------------------------- End of turn --- */

/**
 * Everything that happens once both sides have acted, in a fixed order:
 *
 *   1. Future Sight / Doom Desire arrive from two turns ago
 *   2. per side, in the same order the sides moved:
 *      weather (chip, then the abilities that read it) → status chip →
 *      Leech Seed → trapping chip → Wish → Leftovers/Black Sludge →
 *      Sitrus/Oran → Speed Boost → Shed Skin/Hydration → Flame/Toxic Orb →
 *      Yawn → Perish Song
 *   3. every counter on the field ticks down
 *
 * The order matters — a Pokémon on 4 HP with a burn and a Wish incoming lives
 * or dies on it — so it is written out here rather than left to luck.
 */
function endOfTurn(state, moveOrder, events, rng) {
  const sandImmune = (b) =>
    ["rock", "ground", "steel"].some((t) => b.pokemon.types.includes(t)) ||
    ["sand-veil", "sand-rush", "sand-force", "overcoat", "magic-guard"].includes(b.ability) ||
    b.item === "safety-goggles";
  const weather = weatherOf(state);
  const heal = (b, side, amount, via) => {
    const healed = Math.min(b.maxHP - b.hp, Math.max(1, amount));
    if (healed <= 0) return;
    b.hp += healed;
    events.push({ type: "heal", side, name: b.pokemon.name, amount: healed, via });
  };

  for (const side of [0, 1]) resolveFutureSight(state, side, events, rng);
  checkFaint(state, events);
  if (state.winner != null) return;

  for (const side of moveOrder) {
    const b = active(state, side);
    if (b.hp <= 0) continue;

    if (weather === "sand" && !sandImmune(b) && takesIndirectDamage(b)) {
      chip(b, side, Math.max(1, Math.floor(b.maxHP / 16)), "sandstorm", events);
    }
    if (b.hp <= 0) continue;

    // The abilities that live off the weather, good and bad.
    if (weather === "rain" && b.ability === "rain-dish" && b.hp < b.maxHP) {
      heal(b, side, Math.floor(b.maxHP / 16), "Rain Dish");
    }
    if (weather === "snow" && b.ability === "ice-body" && b.hp < b.maxHP) {
      heal(b, side, Math.floor(b.maxHP / 16), "Ice Body");
    }
    if (b.ability === "dry-skin") {
      if (weather === "rain" && b.hp < b.maxHP) heal(b, side, Math.floor(b.maxHP / 8), "Dry Skin");
      else if (weather === "sun" && takesIndirectDamage(b)) {
        chip(b, side, Math.max(1, Math.floor(b.maxHP / 8)), "Dry Skin", events);
      }
    }
    if (weather === "sun" && b.ability === "solar-power" && takesIndirectDamage(b)) {
      chip(b, side, Math.max(1, Math.floor(b.maxHP / 8)), "Solar Power", events);
    }
    if (b.hp <= 0) continue;

    // Poison Heal turns the poison right round; everything else chips.
    if (b.ability === "poison-heal" && (b.status === "poison" || b.status === "toxic")) {
      if (b.status === "toxic") b.toxicCounter += 1;
      if (b.hp < b.maxHP) heal(b, side, Math.floor(b.maxHP / 8), "Poison Heal");
    } else if (takesIndirectDamage(b)) {
      if (b.status === "burn") {
        // Heatproof halves what a burn takes out of it, as well as Fire moves.
        const frac = b.ability === "heatproof" ? 32 : 16;
        chip(b, side, Math.max(1, Math.floor(b.maxHP / frac)), "burn", events);
      } else if (b.status === "poison") {
        chip(b, side, Math.max(1, Math.floor(b.maxHP / 8)), "poison", events);
      } else if (b.status === "toxic") {
        b.toxicCounter += 1;
        chip(b, side, Math.max(1, Math.floor((b.maxHP * b.toxicCounter) / 16)), "toxic", events);
      }
    } else if (b.status === "toxic") {
      b.toxicCounter += 1; // the clock still ticks, Magic Guard just ignores it
    }
    if (b.hp <= 0) continue;

    // Leech Seed hands what it takes straight to whoever is out opposite.
    if (b.vol.seeded && takesIndirectDamage(b)) {
      const taken = Math.min(b.hp, Math.max(1, Math.floor(b.maxHP / 8)));
      b.hp -= taken;
      events.push({
        type: "chip", side, name: b.pokemon.name, cause: "Leech Seed",
        amount: taken, hpLeft: b.hp, maxHP: b.maxHP,
      });
      const thief = active(state, 1 - side);
      if (thief.hp > 0 && thief.hp < thief.maxHP) {
        const healed = Math.min(thief.maxHP - thief.hp, taken);
        thief.hp += healed;
        events.push({ type: "heal", side: 1 - side, name: thief.pokemon.name, amount: healed, via: "Leech Seed" });
      }
    }
    if (b.hp <= 0) continue;

    // Trapping moves squeeze for an eighth a turn until the timer runs out.
    if (b.vol.trap) {
      if (b.vol.trap.turns != null) {
        if (takesIndirectDamage(b)) {
          chip(b, side, Math.max(1, Math.floor(b.maxHP / 8)), b.vol.trap.by, events);
        }
        b.vol.trap.turns -= 1;
        if (b.vol.trap.turns <= 0) {
          events.push({ type: "trapEnd", side, name: b.pokemon.name, by: b.vol.trap.by });
          b.vol.trap = null;
        }
      }
    }
    if (b.hp <= 0) continue;

    // A Wish made two turns ago lands on whoever is standing here now.
    const wish = state.teams[side].wish;
    if (wish) {
      wish.turns -= 1;
      if (wish.turns <= 0) {
        state.teams[side].wish = null;
        const healed = Math.min(b.maxHP - b.hp, wish.amount);
        if (healed > 0) {
          b.hp += healed;
          events.push({ type: "heal", side, name: b.pokemon.name, amount: healed, via: "Wish" });
        }
      }
    }

    if (b.item === "leftovers" && b.hp < b.maxHP) {
      heal(b, side, Math.floor(b.maxHP / 16), "Leftovers");
    }
    // Black Sludge is Leftovers for a Poison type and a slow puncture for
    // everyone else, which is the joke and also the mechanic.
    if (b.item === "black-sludge") {
      if (b.pokemon.types.includes("poison")) {
        if (b.hp < b.maxHP) heal(b, side, Math.floor(b.maxHP / 16), "Black Sludge");
      } else if (takesIndirectDamage(b)) {
        chip(b, side, Math.max(1, Math.floor(b.maxHP / 8)), "Black Sludge", events);
      }
    }
    if (b.hp <= 0) continue;

    if (b.item === "sitrus-berry" && canEatBerry(b) && b.hp * 2 <= b.maxHP) {
      b.berryUsed = true;
      heal(b, side, Math.floor(b.maxHP / 4), "Sitrus Berry");
      consumeItem(b, side, "Sitrus Berry", events);
    } else if (b.item === "oran-berry" && canEatBerry(b) && b.hp * 2 <= b.maxHP) {
      heal(b, side, 10, "Oran Berry");
      consumeItem(b, side, "Oran Berry", events);
    }
    if (b.ability === "speed-boost") {
      applyStatChanges(b, side, [{ stat: "spe", change: 1 }], events);
    }

    // Two ways of shrugging a status off, and two orbs that hand one over.
    if (b.status && b.ability === "shed-skin" && rng.chance(1 / 3)) {
      b.status = null;
      b.sleepTurns = 0;
      events.push({ type: "cured", side, name: b.pokemon.name, by: "Shed Skin" });
    }
    if (b.status && b.ability === "hydration" && weather === "rain") {
      b.status = null;
      b.sleepTurns = 0;
      events.push({ type: "cured", side, name: b.pokemon.name, by: "Hydration" });
    }
    if (!b.status && (b.item === "flame-orb" || b.item === "toxic-orb")) {
      inflictStatus(b, side, b.item === "flame-orb" ? "burn" : "toxic", events, rng, { weather });
    }

    // Yawn catches up with it.
    if (b.vol.drowsy > 0) {
      b.vol.drowsy -= 1;
      if (b.vol.drowsy === 0) inflictStatus(b, side, "sleep", events, rng, { weather });
    }

    // Perish Song counts everyone down together.
    if (b.vol.perish != null) {
      b.vol.perish -= 1;
      events.push({ type: "perishCount", side, name: b.pokemon.name, count: b.vol.perish });
      if (b.vol.perish <= 0) {
        b.hp = 0;
        b.vol.perish = null;
      }
    }
  }

  // Counters that belong to the field rather than to any one Pokémon.
  for (const side of [0, 1]) {
    const team = state.teams[side];
    for (const key of ["reflect", "lightScreen", "auroraVeil"]) {
      if (team.screens[key] > 0 && --team.screens[key] === 0) {
        events.push({ type: "screenEnd", side, screen: key });
      }
    }
    if (team.tailwind > 0 && --team.tailwind === 0) {
      events.push({ type: "tailwindEnd", side });
    }
    const b = active(state, side);
    if (b.vol.taunt > 0 && --b.vol.taunt === 0) {
      events.push({ type: "tauntEnd", side, name: b.pokemon.name });
    }
    if (b.vol.encore && --b.vol.encore.turns <= 0) {
      b.vol.encore = null;
      events.push({ type: "encoreEnd", side, name: b.pokemon.name });
    }
    if (b.vol.disable && --b.vol.disable.turns <= 0) {
      b.vol.disable = null;
      events.push({ type: "disableEnd", side, name: b.pokemon.name });
    }
    // A turn in which it didn't protect resets the escalating failure odds.
    if (!b.vol.protect) b.vol.protectStreak = 0;
  }

  if (state.trickRoom > 0 && --state.trickRoom === 0) {
    events.push({ type: "trickRoomEnd" });
  }

  if (state.weather.kind) {
    state.weather.turns -= 1;
    if (state.weather.turns <= 0) {
      events.push({ type: "weatherEnd", kind: state.weather.kind });
      state.weather = { kind: null, turns: 0 };
    }
  }

  checkFaint(state, events);
}

/**
 * Future Sight and Doom Desire land two turns after they were called, on
 * whoever is standing in the way by then. The attacker's stats are the ones it
 * had when it fired; the defender's are current. No crit, no screens, no
 * items — just the raw formula, which is how the sim keeps it honest.
 */
function resolveFutureSight(state, side, events, rng) {
  const pending = state.teams[side].future;
  if (!pending) return;
  pending.turns -= 1;
  if (pending.turns > 0) return;
  state.teams[side].future = null;

  const target = active(state, side);
  if (target.hp <= 0) return;

  const eff = typeEffectiveness(pending.type, defendingTypes(target));
  if (eff === 0) {
    events.push({ type: "immune", side, name: target.pokemon.name });
    return;
  }
  const def = battleStat(target, "spd", {});
  const calc = calcDamage({
    level: pending.level, power: pending.power, atk: pending.spa, def,
    stab: pending.stab, effectiveness: eff,
  });
  const dmg = Math.min(target.hp, calc.rolls[rng.rollIndex()]);
  target.hp -= dmg;
  target.vol.tookDamage = true;
  events.push({
    type: "futureHit", side, name: target.pokemon.name, move: pending.name,
    amount: dmg, hpLeft: target.hp, maxHP: target.maxHP, effectiveness: eff,
  });
}

function chip(b, side, amount, cause, events) {
  const dmg = Math.min(b.hp, amount);
  b.hp -= dmg;
  events.push({
    type: "chip", side, name: b.pokemon.name, cause, amount: dmg,
    hpLeft: b.hp, maxHP: b.maxHP,
  });
}

function checkFaint(state, events) {
  for (const side of [0, 1]) {
    const b = active(state, side);
    if (b.hp > 0) continue;
    b.vol.sub = 0;
    if (!events.some((e) => e.type === "faint" && e.side === side && e.name === b.pokemon.name)) {
      events.push({ type: "faint", side, name: b.pokemon.name });
    }
    const alive = state.teams[side].battlers.some((x) => x.hp > 0);
    if (!alive) {
      // Perish Song can wipe both sides at once. The first side checked takes
      // it, so that state.winner and the "win" event never disagree.
      if (state.winner == null) {
        state.winner = 1 - side;
        events.push({ type: "win", side: 1 - side });
      }
    } else {
      state.pendingReplacement[side] = true;
    }
  }
}

/* ----------------------------------------------------------------- AI ---- */

/**
 * Move picker for auto-battle: highest expected damage (average roll times
 * accuracy), STAB, type chart and stages included — because it reuses the
 * exact same damage path the real turn does. Status moves are picked only
 * when nothing can deal damage. Moves it isn't allowed to use this turn —
 * disabled, taunted, out of PP, or a Fake Out on the wrong turn — are skipped.
 */
export function chooseAiAction(state, side, rng) {
  const user = active(state, side);
  const foe = active(state, 1 - side);

  const usable = (i, move) => {
    if (user.moves[i].pp <= 0) return false;
    if (user.vol.disable?.moveIndex === i) return false;
    if (user.vol.taunt > 0 && move.category === "status") return false;
    if (FIRST_TURN_MOVES.has(move.slug) && user.vol.turnsActive > 1) return false;
    if (move.slug === "focus-punch" && user.vol.tookDamage) return false;
    return true;
  };

  let best = null;
  let bestScore = -1;
  user.moves.forEach((slot, i) => {
    const move = slot.move;
    if (!usable(i, move)) return;
    if (move.category === "status" || move.power == null) return;
    const eff = typeEffectiveness(move.type, defendingTypes(foe));
    if (eff === 0) return;
    const isPhysical = move.category === "physical";
    const atk = battleStat(user, isPhysical ? "atk" : "spa", { attacking: true });
    const def = battleStat(foe, isPhysical ? "def" : "spd");
    const stab = user.pokemon.types.includes(move.type) ? 1.5 : 1;
    const calc = calcDamage({
      level: user.level, power: move.power, atk, def, stab,
      effectiveness: eff, burn: user.status === "burn" && isPhysical,
    });
    const avg = calc.rolls.reduce((a, b) => a + b, 0) / calc.rolls.length;
    // A two-turn move only lands half as often, so value it accordingly.
    const tempo = CHARGE_MOVES[move.slug] && user.item !== "power-herb" ? 0.5 : 1;
    const score = avg * ((move.accuracy ?? 100) / 100) * tempo;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });

  if (best == null) {
    // Nothing damaging it may use: any legal move with PP, else Struggle via
    // whatever index (executeMove falls back once all PP is gone).
    const idx = user.moves.findIndex((s, i) => usable(i, s.move));
    best = idx >= 0 ? idx : 0;
  }
  return { type: "move", moveIndex: best };
}
