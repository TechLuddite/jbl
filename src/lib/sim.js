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
    protectStreak: 0,      // consecutive protects, for the failure odds
    roosted: false,        // gave up its Flying type for the turn
    lastMoveIndex: null,   // what Encore and Disable latch onto
    turnsActive: 0,        // 1 on the turn it arrives — Fake Out reads this
    tookDamage: false,     // this turn, for Focus Punch
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
    item,                  // curated slug from ITEMS, or null
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
 * Effective Speed: stage-modified, then Tailwind, then Choice Scarf, then
 * halved by paralysis. Flooring after each step, so the order is load-bearing.
 * `team` is optional — without it Tailwind simply isn't in play.
 */
export function effectiveSpeed(b, team = null) {
  let spe = Math.floor(b.stats.spe * stageMult(b.stages.spe));
  if (team?.tailwind > 0) spe = Math.floor(spe * 2);
  if (b.item === "choice-scarf") spe = Math.floor(spe * 1.5);
  if (b.status === "paralysis") spe = Math.floor(spe / 2);
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

/** Stage-modified attacking/defending stat, with the crit exemptions. */
function battleStat(b, key, { crit = false, attacking = false } = {}) {
  let stage = b.stages[key];
  // A crit ignores the attacker's drops and the defender's boosts.
  if (crit) stage = attacking ? Math.max(0, stage) : Math.min(0, stage);
  return Math.floor(b.stats[key] * stageMult(stage));
}

/**
 * The attacking stat fed to the damage formula. Modifier order is fixed:
 * stages → Choice item ×1.5 → Huge/Pure Power ×2 → Guts ×1.5, flooring after
 * each step. Tests derive their numbers from exactly this order.
 */
function attackStat(user, key, { crit, isPhysical }) {
  let atk = battleStat(user, key, { crit, attacking: true });
  if (isPhysical && user.item === "choice-band") atk = Math.floor(atk * 1.5);
  if (!isPhysical && user.item === "choice-specs") atk = Math.floor(atk * 1.5);
  if (isPhysical && (user.ability === "huge-power" || user.ability === "pure-power")) atk *= 2;
  if (isPhysical && user.ability === "guts" && user.status) atk = Math.floor(atk * 1.5);
  return atk;
}

/** The defending stat: stages → Assault Vest → weather boosts, floored each step. */
function defenseStat(foe, key, { crit, weather }) {
  let def = battleStat(foe, key, { crit, attacking: false });
  if (key === "spd" && foe.item === "assault-vest") def = Math.floor(def * 1.5);
  if (key === "spd" && weather === "sand" && foe.pokemon.types.includes("rock")) def = Math.floor(def * 1.5);
  if (key === "def" && weather === "snow" && foe.pokemon.types.includes("ice")) def = Math.floor(def * 1.5);
  return def;
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
 * The curated held items. Every entry here is fully modeled and tested;
 * anything not on this list simply cannot be picked.
 */
export const ITEMS = {
  "leftovers":    { name: "Leftovers",    desc: "Heals 1/16 max HP every turn." },
  "sitrus-berry": { name: "Sitrus Berry", desc: "Heals 1/4 max HP once, below half." },
  "choice-band":  { name: "Choice Band",  desc: "1.5× Attack, but locked into one move." },
  "choice-specs": { name: "Choice Specs", desc: "1.5× Sp. Atk, but locked into one move." },
  "choice-scarf": { name: "Choice Scarf", desc: "1.5× Speed, but locked into one move." },
  "life-orb":     { name: "Life Orb",     desc: "1.3× damage, costs 1/10 max HP per attack." },
  "focus-sash":   { name: "Focus Sash",   desc: "Survive a KO from full HP with 1 HP. One use." },
  "expert-belt":  { name: "Expert Belt",  desc: "1.2× on super effective hits." },
  "assault-vest": { name: "Assault Vest", desc: "1.5× Sp. Def." },
  "air-balloon":  { name: "Air Balloon",  desc: "Immune to Ground until hit." },
  "power-herb":   { name: "Power Herb",   desc: "Skips the charge turn of a two-turn move. One use." },
};

/**
 * The curated abilities. Same rule: modeled and tested, or not offered.
 * Dex entries may carry abilities outside this set — the UI marks those as
 * not in the sim yet and the engine ignores them.
 */
export const ABILITIES = {
  "intimidate":   { name: "Intimidate",   desc: "Lowers the foe's Attack on entry." },
  "levitate":     { name: "Levitate",     desc: "Immune to Ground moves." },
  "huge-power":   { name: "Huge Power",   desc: "Doubles Attack." },
  "pure-power":   { name: "Pure Power",   desc: "Doubles Attack." },
  "guts":         { name: "Guts",         desc: "1.5× Attack when statused; burn doesn't halve." },
  "speed-boost":  { name: "Speed Boost",  desc: "+1 Speed every turn." },
  "sturdy":       { name: "Sturdy",       desc: "Survive a KO from full HP with 1 HP." },
  "technician":   { name: "Technician",   desc: "1.5× power on moves of 60 power or less." },
  "adaptability": { name: "Adaptability", desc: "STAB is 2× instead of 1.5×." },
  "thick-fat":    { name: "Thick Fat",    desc: "Halves Fire and Ice damage taken." },
  "magic-guard":  { name: "Magic Guard",  desc: "Only direct attacks deal damage." },
  "water-absorb": { name: "Water Absorb", desc: "Heals 1/4 from Water moves instead of damage." },
  "volt-absorb":  { name: "Volt Absorb",  desc: "Heals 1/4 from Electric moves instead of damage." },
  "flash-fire":   { name: "Flash Fire",   desc: "Immune to Fire moves." },
  "regenerator":  { name: "Regenerator",  desc: "Heals 1/3 max HP on switching out." },
  "blaze":        { name: "Blaze",        desc: "1.5× Fire power below 1/3 HP." },
  "torrent":      { name: "Torrent",      desc: "1.5× Water power below 1/3 HP." },
  "overgrow":     { name: "Overgrow",     desc: "1.5× Grass power below 1/3 HP." },
  "swarm":        { name: "Swarm",        desc: "1.5× Bug power below 1/3 HP." },
  "drizzle":      { name: "Drizzle",      desc: "Summons rain on entry." },
  "drought":      { name: "Drought",      desc: "Summons sun on entry." },
  "sand-stream":  { name: "Sand Stream",  desc: "Summons a sandstorm on entry." },
  "snow-warning": { name: "Snow Warning", desc: "Summons snow on entry." },
  "own-tempo":    { name: "Own Tempo",    desc: "Cannot be confused." },
  "inner-focus":  { name: "Inner Focus",  desc: "Cannot be made to flinch." },
};

const PINCH_ABILITY_TYPE = {
  blaze: "fire", torrent: "water", overgrow: "grass", swarm: "bug",
};

const WEATHER_MOVES = {
  "rain-dance": "rain", "sunny-day": "sun",
  "sandstorm": "sand", "snowscape": "snow", "hail": "snow",
};

const WEATHER_ABILITY = {
  drizzle: "rain", drought: "sun", "sand-stream": "sand", "snow-warning": "snow",
};

const HAZARD_MOVES = ["stealth-rock", "spikes", "toxic-spikes", "sticky-web"];

const ABSORB_ABILITY_TYPE = {
  "water-absorb": "water", "volt-absorb": "electric",
};

const isChoiceItem = (item) => item === "choice-band" || item === "choice-specs" || item === "choice-scarf";

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

/** Grounded = takes Spikes, Toxic Spikes, Sticky Web, and Ground moves land. */
function isGrounded(b) {
  if (defendingTypes(b).includes("flying")) return false;
  if (b.ability === "levitate") return false;
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

  for (const b of [active(state, 0), active(state, 1)]) {
    b.flinched = false;
    b.vol.protect = false;
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
  for (const side of moveOrder) {
    if (actions[side]?.type !== "move") continue;
    if (state.winner != null) break;
    const user = active(state, side);
    if (user.hp <= 0) continue; // fainted before it could move
    executeMove(state, side, actions[side].moveIndex, events, rng);
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
  const prio = (side) => {
    if (!actions || actions[side]?.type !== "move") return 0;
    const user = active(state, side);
    // A user mid-charge, locked in or recharging uses that move's priority,
    // not whatever the caller passed in.
    const forced = forcedMoveIndex(user);
    const idx = forced ?? actions[side].moveIndex;
    const slot = user.moves[idx];
    return slot ? (slot.move.priority ?? 0) : 0;
  };
  const p0 = prio(0), p1 = prio(1);
  if (p0 !== p1) return p0 > p1 ? [0, 1] : [1, 0];
  const s0 = effectiveSpeed(active(state, 0), state.teams[0]);
  const s1 = effectiveSpeed(active(state, 1), state.teams[1]);
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

function setWeather(state, kind, events) {
  if (state.weather.kind === kind) {
    events.push({ type: "noEffect" });
    return;
  }
  state.weather = { kind, turns: 5 };
  events.push({ type: "weather", kind });
}

/**
 * Everything that happens when a Pokémon takes the field: hazards bite
 * first (they can faint it), then its ability announces itself.
 */
function applyEntryEffects(state, side, events) {
  const b = active(state, side);
  const hz = state.teams[side].hazards;
  const name = b.pokemon.name;

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

  const weatherKind = WEATHER_ABILITY[b.ability];
  if (weatherKind) setWeather(state, weatherKind, events);
  if (b.ability === "intimidate") {
    const foe = active(state, 1 - side);
    if (foe.hp > 0) {
      events.push({ type: "ability", side, name, ability: "Intimidate" });
      applyStatChanges(foe, 1 - side, [{ stat: "atk", change: -1 }], events);
    }
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
function executeMove(state, side, moveIndex, events, rng) {
  const user = active(state, side);
  const foe = active(state, 1 - side);
  const name = user.pokemon.name;

  // Recharging costs the whole turn.
  if (user.vol.recharge) {
    user.vol.recharge = false;
    events.push({ type: "recharge", side, name });
    return;
  }

  if (user.flinched) {
    events.push({ type: "flinch", side, name });
    breakLocks(user, side, events);
    return;
  }
  if (user.status === "sleep") {
    user.sleepTurns -= 1;
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
    slot.pp -= 1;
    if (isChoiceItem(user.item) && user.choiceLock == null) user.choiceLock = moveIndex;
  }
  user.vol.lastMoveIndex = slot ? moveIndex : null;

  // ---- Two-turn charge moves ----
  const chargeInfo = CHARGE_MOVES[move.slug];
  if (chargeInfo && !user.vol.charge) {
    const weatherSkip = chargeInfo.skipIn && state.weather.kind === chargeInfo.skipIn;
    const herbSkip = !weatherSkip && user.item === "power-herb";
    if (!weatherSkip && !herbSkip) {
      user.vol.charge = { moveIndex, slug: move.slug, invuln: chargeInfo.invuln ?? null };
      events.push({ type: "charge", side, name, move: move.name, invuln: chargeInfo.invuln ?? null });
      if (chargeInfo.boost) applyStatChanges(user, side, chargeInfo.boost, events);
      return;
    }
    // Fired the same turn: the charge-turn boost still happens either way.
    if (chargeInfo.boost) applyStatChanges(user, side, chargeInfo.boost, events);
    if (herbSkip) {
      user.item = null;
      events.push({ type: "itemUsed", side, name, item: "Power Herb" });
    }
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

  // A status move only bounces off a type immunity when it is one of the two
  // that really do (Thunder Wave into a Ground type, Poison Powder into Steel).
  const foeTypes = defendingTypes(foe);
  const eff = typeEffectiveness(move.type, foeTypes);
  if (
    move.category === "status" && targetsFoe(move) && eff === 0 &&
    STATUS_TYPES_THAT_RESPECT_IMMUNITY.includes(move.type)
  ) {
    events.push({ type: "immune", side: 1 - side, name: foe.pokemon.name });
    return;
  }

  // ---- Protect, and the hiding places it can't reach into ----
  const breaksProtect = CHARGE_MOVES[move.slug]?.breaksProtect || move.slug === "feint";
  if (foe.vol.protect && targetsFoe(move) && !breaksProtect) {
    events.push({ type: "protected", side: 1 - side, name: foe.pokemon.name, move: move.name });
    breakLocks(user, side, events);
    return;
  }
  const foeHiding = foe.vol.charge?.invuln ?? null;
  if (foeHiding && targetsFoe(move) && !REACHES_INVULN[foeHiding].includes(move.slug)) {
    events.push({ type: "miss", side, name, move: move.name, hiding: foeHiding });
    breakLocks(user, side, events);
    return;
  }

  // Accuracy. null accuracy never misses.
  if (move.accuracy != null) {
    const stageDiff = Math.max(-6, Math.min(6, user.stages.acc - foe.stages.eva));
    const hitChance = (move.accuracy / 100) * stageMult(stageDiff, 3);
    if (!rng.chance(Math.min(1, hitChance))) {
      events.push({ type: "miss", side, name, move: move.name });
      breakLocks(user, side, events);
      return;
    }
  }

  if (move.category === "status") {
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

  // Abilities and items that swallow the move whole.
  if (ABSORB_ABILITY_TYPE[foe.ability] === move.type) {
    const healed = Math.min(foe.maxHP - foe.hp, Math.floor(foe.maxHP / 4));
    if (healed > 0) foe.hp += healed;
    events.push({
      type: "absorb", side: 1 - side, name: foe.pokemon.name,
      ability: ABILITIES[foe.ability].name, amount: healed,
    });
    breakLocks(user, side, events);
    return;
  }
  if (move.type === "fire" && foe.ability === "flash-fire") {
    events.push({ type: "absorb", side: 1 - side, name: foe.pokemon.name, ability: "Flash Fire", amount: 0 });
    breakLocks(user, side, events);
    return;
  }
  if (move.type === "ground" && !isGrounded(foe)) {
    events.push({ type: "immune", side: 1 - side, name: foe.pokemon.name });
    breakLocks(user, side, events);
    return;
  }

  // Multi-hit moves: 2-5 with the real 35/35/15/15 split, or a fixed count.
  let hits = 1;
  if (move.meta?.minHits != null && move.meta?.maxHits != null) {
    if (move.meta.minHits === move.meta.maxHits) {
      hits = move.meta.minHits;
    } else {
      const r = rng.int(20);
      hits = r < 7 ? 2 : r < 14 ? 3 : r < 17 ? 4 : 5;
    }
  }

  const weather = state.weather.kind;
  const basePower = movePower(state, side, move, { foeHiding });
  let totalDamage = 0;
  let brokeSub = false;
  for (let h = 0; h < hits && foe.hp > 0; h++) {
    const critStages = move.meta?.critRate ?? 0;
    const critChance = [1 / 24, 1 / 8, 1 / 2, 1][Math.min(3, critStages)];
    const crit = rng.chance(critChance);

    const atk = attackStat(user, atkKey, { crit, isPhysical });
    const def = defenseStat(foe, defKey, { crit, weather });

    // Power modifiers: Technician, then the low-HP pinch abilities.
    let power = basePower;
    if (user.ability === "technician" && power <= 60) power = Math.floor(power * 1.5);
    if (PINCH_ABILITY_TYPE[user.ability] === move.type && user.hp * 3 <= user.maxHP) {
      power = Math.floor(power * 1.5);
    }

    const stabBase = user.ability === "adaptability" ? 2 : 1.5;
    const stab = user.pokemon.types.includes(move.type) ? stabBase : 1;

    // The `other` multiplier battle.js has always had ready: weather, screens,
    // Life Orb, Expert Belt, Thick Fat — multiplied together, floored once.
    let other = 1;
    if (weather === "rain") other *= move.type === "water" ? 1.5 : move.type === "fire" ? 0.5 : 1;
    if (weather === "sun") other *= move.type === "fire" ? 1.5 : move.type === "water" ? 0.5 : 1;
    other *= screenMultiplier(state, 1 - side, isPhysical, crit);
    if (user.item === "life-orb") other *= 1.3;
    if (user.item === "expert-belt" && eff > 1) other *= 1.2;
    if (foe.ability === "thick-fat" && (move.type === "fire" || move.type === "ice")) other *= 0.5;

    const calc = calcDamage({
      level: user.level, power, atk, def,
      stab, effectiveness: eff, crit,
      burn: user.status === "burn" && isPhysical && user.ability !== "guts",
      other,
    });
    const rollIndex = rng.rollIndex();
    const raw = calc.rolls[rollIndex];
    const detail = { atk, def, atkKey, defKey, power, other, rollIndex, rolls: calc.rolls };

    // A Substitute eats the hit and everything that rides on it.
    if (foe.vol.sub > 0) {
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
      if (foe.ability === "sturdy") {
        dmg = foe.hp - 1;
        events.push({ type: "endure", side: 1 - side, name: foe.pokemon.name, via: "Sturdy" });
      } else if (foe.item === "focus-sash") {
        dmg = foe.hp - 1;
        foe.item = null;
        events.push({ type: "endure", side: 1 - side, name: foe.pokemon.name, via: "Focus Sash" });
      }
    }

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
  }

  const hitTheTarget = totalDamage > 0 && !brokeSub && foe.vol.sub === 0;

  // Drain / recoil are a percentage of damage dealt; Struggle is special-cased
  // to modern rules (quarter of the user's max HP). Magic Guard blocks recoil
  // and Life Orb — but never Struggle's.
  if (move === STRUGGLE) {
    applyRecoil(user, side, Math.floor(user.maxHP / 4), events);
  } else if (move.meta?.drain) {
    const frac = Math.floor((totalDamage * Math.abs(move.meta.drain)) / 100);
    if (move.meta.drain > 0) {
      const healed = Math.min(user.maxHP - user.hp, Math.max(1, frac));
      user.hp += healed;
      events.push({ type: "drain", side, name: user.pokemon.name, amount: healed });
    } else if (takesIndirectDamage(user)) {
      applyRecoil(user, side, Math.max(1, frac), events);
    }
  }
  if (user.item === "life-orb" && totalDamage > 0 && takesIndirectDamage(user) && user.hp > 0) {
    applyRecoil(user, side, Math.max(1, Math.floor(user.maxHP / 10)), events);
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
  if (foe.hp > 0 && hitTheTarget) {
    applyTargetSecondary(state, side, move, events, rng);
    const flinchPct = move.meta?.flinchChance ?? 0;
    if (flinchPct > 0 && foe.ability !== "inner-focus" && rng.chance(flinchPct / 100)) {
      foe.flinched = true;
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
 * The power a move swings with before Technician and the pinch abilities:
 * momentum doubling (Rollout, Fury Cutter), Solar Beam's bad-weather penalty,
 * and the bonus for catching something underground or in the air.
 */
function movePower(state, side, move, { foeHiding }) {
  const user = active(state, side);
  let power = move.power;

  const momentum = user.vol.momentum;
  if (momentum?.slug === move.slug) {
    const cap = FURY_CUTTER_MOVES.has(move.slug) ? 2 : 4; // 40→160, 30→480
    power = power * 2 ** Math.min(cap, momentum.hits);
  }

  const chargeInfo = CHARGE_MOVES[move.slug];
  if (chargeInfo?.weakIn?.includes(state.weather.kind)) power = Math.floor(power / 2);

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

function confuse(target, targetSide, events, rng) {
  if (target.ability === "own-tempo") {
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
}

/* ---------------------------------------------------------- status moves --- */

function applyStatusMove(state, side, move, events, rng) {
  const user = active(state, side);
  const foe = active(state, 1 - side);
  const onSelf = !targetsFoe(move);

  // Weather setters.
  if (WEATHER_MOVES[move.slug]) {
    setWeather(state, WEATHER_MOVES[move.slug], events);
    return;
  }

  // Screens, Tailwind and Trick Room: the timed field effects.
  const screen = SCREEN_MOVES[move.slug];
  if (screen) {
    if (screen === "auroraVeil" && state.weather.kind !== "snow") {
      events.push({ type: "moveFailed", side, name: user.pokemon.name, move: move.name, why: "it needs snow" });
      return;
    }
    const screens = state.teams[side].screens;
    if (screens[screen] > 0) return events.push({ type: "noEffect" });
    screens[screen] = 5;
    events.push({ type: "screenSet", side, screen: move.name });
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
    foe.vol.taunt = 3;
    events.push({ type: "taunted", side: 1 - side, name: foe.pokemon.name });
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
      applyStatChanges(target, targetSide, move.statChanges, events, { fromFoe: !onSelf });
    }
  }

  // Ailments (Thunder Wave, Toxic, Sleep Powder, Confuse Ray, Leech Seed...).
  const ailment = move.meta?.ailment ?? "none";
  const status = ailmentToStatus(ailment, move.slug);
  if (status) {
    if (foe.vol.sub > 0) events.push({ type: "subBlocked", side: 1 - side, name: foe.pokemon.name });
    else inflictStatus(foe, 1 - side, status, events, rng);
  } else if (VOLATILE_AILMENTS.has(ailment)) {
    if (foe.vol.sub > 0) events.push({ type: "subBlocked", side: 1 - side, name: foe.pokemon.name });
    else applyVolatileAilment(state, side, move, ailment, events, rng);
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
function applyVolatileAilment(state, side, move, ailment, events, rng) {
  const foe = active(state, 1 - side);
  const foeSide = 1 - side;

  if (ailment === "confusion") {
    confuse(foe, foeSide, events, rng);
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

function applyStatChanges(target, targetSide, changes, events, { fromFoe = false } = {}) {
  for (const { stat, change } of changes) {
    const key = stat === "accuracy" ? "acc" : stat === "evasion" ? "eva" : stat;
    if (!(key in target.stages)) continue;
    if (fromFoe && change < 0 && target.vol.sub > 0) {
      events.push({ type: "subBlocked", side: targetSide, name: target.pokemon.name });
      continue;
    }
    const before = target.stages[key];
    target.stages[key] = Math.max(-6, Math.min(6, before + change));
    events.push({
      type: "stages", side: targetSide, name: target.pokemon.name,
      stat: key, change: target.stages[key] - before, now: target.stages[key],
    });
  }
}

function inflictStatus(target, targetSide, status, events, rng) {
  if (target.status) {
    events.push({ type: "noEffect", side: targetSide, name: target.pokemon.name });
    return;
  }
  const immune = STATUS_IMMUNE[status] ?? [];
  if (target.pokemon.types.some((t) => immune.includes(t))) {
    events.push({ type: "immune", side: targetSide, name: target.pokemon.name });
    return;
  }
  target.status = status;
  // Sleeps for 1-3 turns: the counter is checked-then-decremented on each
  // move attempt, and the waking turn still gets to move.
  if (status === "sleep") target.sleepTurns = 2 + (rng ? rng.int(3) : 1);
  if (status === "toxic") target.toxicCounter = 0;
  events.push({ type: "status", side: targetSide, name: target.pokemon.name, status });
}

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

/** Chance-based extras a damaging move lands ON THE TARGET. */
function applyTargetSecondary(state, side, move, events, rng) {
  const foe = active(state, 1 - side);
  const ailment = move.meta?.ailment ?? "none";
  const ailmentChance = move.meta?.ailmentChance ?? 0;

  if (ailmentChance > 0 && rng.chance(ailmentChance / 100)) {
    const status = ailmentToStatus(ailment, move.slug);
    if (status) inflictStatus(foe, 1 - side, status, events, rng);
    else if (VOLATILE_AILMENTS.has(ailment)) applyVolatileAilment(state, side, move, ailment, events, rng);
  }

  if (move.statChanges?.length && !statChangesHitUser(move)) {
    const chance = move.effectChance ?? 100;
    if (chance >= 100 || rng.chance(chance / 100)) {
      applyStatChanges(foe, 1 - side, move.statChanges, events, { fromFoe: true });
    }
  }
}

/* ---------------------------------------------------------- End of turn --- */

/**
 * Everything that happens once both sides have acted, in a fixed order:
 *
 *   1. Future Sight / Doom Desire arrive from two turns ago
 *   2. per side, in the same order the sides moved:
 *      weather → status chip → Leech Seed → trapping chip → Wish →
 *      Leftovers → Sitrus → Speed Boost → Yawn → Perish Song
 *   3. every counter on the field ticks down
 *
 * The order matters — a Pokémon on 4 HP with a burn and a Wish incoming lives
 * or dies on it — so it is written out here rather than left to luck.
 */
function endOfTurn(state, moveOrder, events, rng) {
  const sandImmune = (b) =>
    ["rock", "ground", "steel"].some((t) => b.pokemon.types.includes(t));

  for (const side of [0, 1]) resolveFutureSight(state, side, events, rng);
  checkFaint(state, events);
  if (state.winner != null) return;

  for (const side of moveOrder) {
    const b = active(state, side);
    if (b.hp <= 0) continue;

    if (state.weather.kind === "sand" && !sandImmune(b) && takesIndirectDamage(b)) {
      chip(b, side, Math.max(1, Math.floor(b.maxHP / 16)), "sandstorm", events);
    }
    if (b.hp <= 0) continue;

    if (takesIndirectDamage(b)) {
      if (b.status === "burn") {
        chip(b, side, Math.max(1, Math.floor(b.maxHP / 16)), "burn", events);
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
      const healed = Math.min(b.maxHP - b.hp, Math.max(1, Math.floor(b.maxHP / 16)));
      b.hp += healed;
      events.push({ type: "heal", side, name: b.pokemon.name, amount: healed, via: "Leftovers" });
    }
    if (b.item === "sitrus-berry" && !b.berryUsed && b.hp * 2 <= b.maxHP) {
      const healed = Math.min(b.maxHP - b.hp, Math.floor(b.maxHP / 4));
      b.hp += healed;
      b.berryUsed = true;
      b.item = null;
      events.push({ type: "heal", side, name: b.pokemon.name, amount: healed, via: "Sitrus Berry" });
    }
    if (b.ability === "speed-boost") {
      applyStatChanges(b, side, [{ stat: "spe", change: 1 }], events);
    }

    // Yawn catches up with it.
    if (b.vol.drowsy > 0) {
      b.vol.drowsy -= 1;
      if (b.vol.drowsy === 0) inflictStatus(b, side, "sleep", events, rng);
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
