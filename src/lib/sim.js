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
 * damage.
 *
 * Slice 2 adds weather, entry hazards, and a CURATED set of held items and
 * abilities (see ITEMS and ABILITIES below) — correctness over coverage, the
 * set grows as each addition can be tested. Modifier order inside a hit is
 * fixed and documented at executeMove; tests derive their numbers from it.
 *
 * Not yet implemented (tracked in ROADMAP.md): confusion and other volatile
 * statuses, contact-triggered items/abilities, terrain. Unknown move ailments
 * and unmodeled abilities are ignored rather than guessed at.
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
  };
}

/** Two teams in, a fresh battle state out. Each team is 1-6 battlers. */
export function createBattle(teamA, teamB) {
  return {
    teams: [
      { battlers: teamA, active: 0, hazards: { stealthRock: false, spikes: 0, toxicSpikes: 0, stickyWeb: false } },
      { battlers: teamB, active: 0, hazards: { stealthRock: false, spikes: 0, toxicSpikes: 0, stickyWeb: false } },
    ],
    weather: { kind: null, turns: 0 },
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

/** Effective Speed: stage-modified, Scarf, then halved by paralysis. */
export function effectiveSpeed(b) {
  let spe = Math.floor(b.stats.spe * stageMult(b.stages.spe));
  if (b.item === "choice-scarf") spe = Math.floor(spe * 1.5);
  if (b.status === "paralysis") spe = Math.floor(spe / 2);
  return spe;
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

/**
 * Damaging moves whose stat drops hit the USER, not the target (Close Combat
 * and friends). PokéAPI's data can't express this distinction, so it's
 * curated here.
 */
const SELF_DEBUFF_MOVES = new Set([
  "close-combat", "superpower", "hammer-arm", "ice-hammer", "v-create",
  "dragon-ascent", "leaf-storm", "overheat", "draco-meteor", "psycho-boost",
  "fleur-cannon", "clanging-scales", "armor-cannon", "headlong-rush",
  "make-it-rain",
]);

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

/** Grounded = takes Spikes, Toxic Spikes, Sticky Web, and Ground moves land. */
function isGrounded(b) {
  if (b.pokemon.types.includes("flying")) return false;
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

  for (const b of [active(state, 0), active(state, 1)]) b.flinched = false;

  // Switches resolve before any move, faster side first.
  const switchOrder = orderSides(state, rng);
  for (const side of switchOrder) {
    if (actions[side]?.type === "switch") doSwitch(state, side, actions[side].to, events);
  }

  // Moves: priority first, then Speed, ties by coin flip.
  const moveOrder = orderSides(state, rng, actions);
  for (const side of moveOrder) {
    if (actions[side]?.type !== "move") continue;
    if (state.winner != null) break;
    const user = active(state, side);
    if (user.hp <= 0) continue; // fainted before it could move
    executeMove(state, side, actions[side].moveIndex, events, rng);
  }

  if (state.winner == null) endOfTurn(state, moveOrder, events);

  state.turn += 1;
  return { state, events };
}

/** Which side acts first this turn, considering priority (moves only). */
function orderSides(state, rng, actions = null) {
  const prio = (side) => {
    if (!actions || actions[side]?.type !== "move") return 0;
    const slot = active(state, side).moves[actions[side].moveIndex];
    return slot ? (slot.move.priority ?? 0) : 0;
  };
  const p0 = prio(0), p1 = prio(1);
  if (p0 !== p1) return p0 > p1 ? [0, 1] : [1, 0];
  const s0 = effectiveSpeed(active(state, 0));
  const s1 = effectiveSpeed(active(state, 1));
  if (s0 !== s1) return s0 > s1 ? [0, 1] : [1, 0];
  return rng.chance(0.5) ? [0, 1] : [1, 0];
}

function doSwitch(state, side, to, events) {
  const team = state.teams[side];
  const target = team.battlers[to];
  if (!target || target.hp <= 0 || to === team.active) return;
  const out = active(state, side);
  // Stages, flinch and Choice locks are left at the door; status rides along.
  out.stages = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, acc: 0, eva: 0 };
  out.flinched = false;
  out.choiceLock = null;
  if (out.ability === "regenerator" && out.hp > 0 && out.hp < out.maxHP) {
    const healed = Math.min(out.maxHP - out.hp, Math.floor(out.maxHP / 3));
    out.hp += healed;
    events.push({ type: "heal", side, name: out.pokemon.name, amount: healed });
  }
  team.active = to;
  events.push({ type: "switch", side, out: out.pokemon.name, in: target.pokemon.name });
  applyEntryEffects(state, side, events);
  checkFaint(state, events);
}

/** Fill a fainted slot between turns. Returns true if the switch was legal. */
export function replaceFainted(prevState, side, to) {
  const state = structuredClone(prevState);
  const team = state.teams[side];
  const target = team.battlers[to];
  if (!state.pendingReplacement[side] || !target || target.hp <= 0) {
    return { state: prevState, ok: false, events: [] };
  }
  team.active = to;
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

function executeMove(state, side, moveIndex, events, rng) {
  const user = active(state, side);
  const foe = active(state, 1 - side);
  const name = user.pokemon.name;

  // Can it move at all?
  if (user.flinched) {
    events.push({ type: "flinch", side, name });
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
  if (user.status === "paralysis" && rng.chance(0.25)) {
    events.push({ type: "fullPara", side, name });
    return;
  }

  // A Choice item locks the user into its first pick until it switches.
  if (user.choiceLock != null && isChoiceItem(user.item) && user.moves[user.choiceLock]?.pp > 0) {
    moveIndex = user.choiceLock;
  }

  // Which move? Out of PP everywhere means Struggle.
  let slot = user.moves[moveIndex];
  let move = slot?.move;
  const anyPP = user.moves.some((s) => s.pp > 0);
  if (!anyPP) {
    move = STRUGGLE;
    slot = null;
  } else if (!slot || slot.pp <= 0) {
    events.push({ type: "noPP", side, name });
    return;
  }
  if (slot) {
    slot.pp -= 1;
    if (isChoiceItem(user.item) && user.choiceLock == null) user.choiceLock = moveIndex;
  }

  events.push({ type: "move", side, name, move: move.name });

  // A status move against a type that blanks its type fails outright
  // (Thunder Wave into a Ground type, Poison Powder into Steel).
  const eff = typeEffectiveness(move.type, foe.pokemon.types);
  if (move.category === "status" && targetsFoe(move) && eff === 0) {
    events.push({ type: "immune", side: 1 - side, name: foe.pokemon.name });
    return;
  }

  // Accuracy. null accuracy never misses.
  if (move.accuracy != null) {
    const stageDiff = Math.max(-6, Math.min(6, user.stages.acc - foe.stages.eva));
    const hitChance = (move.accuracy / 100) * stageMult(stageDiff, 3);
    if (!rng.chance(Math.min(1, hitChance))) {
      events.push({ type: "miss", side, name, move: move.name });
      return;
    }
  }

  if (move.category === "status") {
    applyStatusMove(state, side, move, events, rng);
    return;
  }

  // ---- Damaging move ----
  const isPhysical = move.category === "physical";
  const atkKey = isPhysical ? "atk" : "spa";
  const defKey = isPhysical ? "def" : "spd";

  if (eff === 0) {
    events.push({ type: "immune", side: 1 - side, name: foe.pokemon.name });
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
    return;
  }
  if (move.type === "fire" && foe.ability === "flash-fire") {
    events.push({ type: "absorb", side: 1 - side, name: foe.pokemon.name, ability: "Flash Fire", amount: 0 });
    return;
  }
  if (move.type === "ground" && !isGrounded(foe)) {
    events.push({ type: "immune", side: 1 - side, name: foe.pokemon.name });
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
  let totalDamage = 0;
  for (let h = 0; h < hits && foe.hp > 0; h++) {
    const critStages = move.meta?.critRate ?? 0;
    const critChance = [1 / 24, 1 / 8, 1 / 2, 1][Math.min(3, critStages)];
    const crit = rng.chance(critChance);

    const atk = attackStat(user, atkKey, { crit, isPhysical });
    const def = defenseStat(foe, defKey, { crit, weather });

    // Power modifiers: Technician, then the low-HP pinch abilities.
    let power = move.power;
    if (user.ability === "technician" && power <= 60) power = Math.floor(power * 1.5);
    if (PINCH_ABILITY_TYPE[user.ability] === move.type && user.hp * 3 <= user.maxHP) {
      power = Math.floor(power * 1.5);
    }

    const stabBase = user.ability === "adaptability" ? 2 : 1.5;
    const stab = user.pokemon.types.includes(move.type) ? stabBase : 1;

    // The `other` multiplier battle.js has always had ready: weather, Life
    // Orb, Expert Belt, Thick Fat — multiplied together, floored once.
    let other = 1;
    if (weather === "rain") other *= move.type === "water" ? 1.5 : move.type === "fire" ? 0.5 : 1;
    if (weather === "sun") other *= move.type === "fire" ? 1.5 : move.type === "water" ? 0.5 : 1;
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
    let dmg = Math.min(foe.hp, calc.rolls[rollIndex]);

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
    totalDamage += dmg;

    events.push({
      type: "damage", side: 1 - side, name: foe.pokemon.name,
      move: move.name, amount: dmg, crit, effectiveness: eff, stab,
      hit: h + 1, hits,
      // The working, for the UI to show.
      detail: { atk, def, atkKey, defKey, power, other, rollIndex, rolls: calc.rolls },
      hpLeft: foe.hp, maxHP: foe.maxHP,
    });

    if (foe.item === "air-balloon" && !foe.balloonPopped && dmg > 0) {
      foe.balloonPopped = true;
      events.push({ type: "balloonPop", side: 1 - side, name: foe.pokemon.name });
    }
  }

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

  // Secondary effects only trigger if the target is still standing. A flinch
  // set by the slower mover is harmless — the flag resets at turn start, so
  // it only ever robs a target that hasn't moved yet.
  if (foe.hp > 0) {
    applySecondary(state, side, move, events, rng);
    const flinchPct = move.meta?.flinchChance ?? 0;
    if (flinchPct > 0 && rng.chance(flinchPct / 100)) {
      foe.flinched = true;
    }
  }

  checkFaint(state, events);
}

function targetsFoe(move) {
  return move.target !== "user" && move.target !== "users-field";
}

function applyRecoil(user, side, amount, events) {
  const dmg = Math.min(user.hp, amount);
  user.hp -= dmg;
  events.push({ type: "recoil", side, name: user.pokemon.name, amount: dmg, hpLeft: user.hp });
}

function applyStatusMove(state, side, move, events, rng) {
  const user = active(state, side);
  const foe = active(state, 1 - side);
  const onSelf = !targetsFoe(move);

  // Weather setters.
  if (WEATHER_MOVES[move.slug]) {
    setWeather(state, WEATHER_MOVES[move.slug], events);
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

  // Defog clears every hazard on both sides (and drops evasion via its
  // regular stat-change data when the full move data is baked).
  if (move.slug === "defog") {
    for (const s of [0, 1]) {
      state.teams[s].hazards = { stealthRock: false, spikes: 0, toxicSpikes: 0, stickyWeb: false };
    }
    events.push({ type: "hazardClear", side, hazard: "everything", by: user.pokemon.name });
    if (move.statChanges?.length) applyStatChanges(foe, 1 - side, move.statChanges, events);
    return;
  }

  // Healing moves (Recover, Roost...): percentage of max HP.
  if (move.meta?.healing) {
    const healed = Math.min(
      user.maxHP - user.hp,
      Math.floor((user.maxHP * move.meta.healing) / 100)
    );
    if (healed > 0) {
      user.hp += healed;
      events.push({ type: "heal", side, name: user.pokemon.name, amount: healed });
    } else {
      events.push({ type: "noEffect", side, name: user.pokemon.name });
    }
    return;
  }

  // Stat changes.
  if (move.statChanges?.length) {
    const target = onSelf ? user : foe;
    const targetSide = onSelf ? side : 1 - side;
    applyStatChanges(target, targetSide, move.statChanges, events);
  }

  // Ailments (Thunder Wave, Toxic, Sleep Powder...).
  const status = ailmentToStatus(move.meta?.ailment ?? "none", move.slug);
  if (status) {
    inflictStatus(foe, 1 - side, status, events, rng);
  } else if (!move.statChanges?.length && !move.meta?.healing) {
    // A status move we don't model yet. Say so instead of pretending.
    events.push({ type: "notModeled", side, move: move.name });
  }
}

function applyStatChanges(target, targetSide, changes, events) {
  for (const { stat, change } of changes) {
    const key = stat === "accuracy" ? "acc" : stat === "evasion" ? "eva" : stat;
    if (!(key in target.stages)) continue;
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
  if (status === "sleep") target.sleepTurns = 2 + rng.int(3);
  if (status === "toxic") target.toxicCounter = 0;
  events.push({ type: "status", side: targetSide, name: target.pokemon.name, status });
}

/** Chance-based extras on damaging moves: ailments and stat drops. */
function applySecondary(state, side, move, events, rng) {
  const foe = active(state, 1 - side);
  const meta = move.meta;
  if (!meta) return;

  const status = ailmentToStatus(meta.ailment, move.slug);
  if (status && meta.ailmentChance > 0 && rng.chance(meta.ailmentChance / 100)) {
    inflictStatus(foe, 1 - side, status, events, rng);
  }

  if (move.statChanges?.length && move.category !== "status") {
    const self = SELF_DEBUFF_MOVES.has(move.slug) || meta.category === "damage+raise";
    const chance = self ? 100 : (move.effectChance ?? 100);
    if (chance >= 100 || rng.chance(chance / 100)) {
      const target = self ? active(state, side) : foe;
      applyStatChanges(target, self ? side : 1 - side, move.statChanges, events);
    }
  }
}

/* ---------------------------------------------------------- End of turn --- */

function endOfTurn(state, moveOrder, events) {
  // Order per side: weather bites, then status, then items, then abilities.
  const sandImmune = (b) =>
    ["rock", "ground", "steel"].some((t) => b.pokemon.types.includes(t));

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
    if (!events.some((e) => e.type === "faint" && e.side === side && e.name === b.pokemon.name)) {
      events.push({ type: "faint", side, name: b.pokemon.name });
    }
    const alive = state.teams[side].battlers.some((x) => x.hp > 0);
    if (!alive) {
      state.winner = 1 - side;
      if (!events.some((e) => e.type === "win")) {
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
 * when nothing can deal damage.
 */
export function chooseAiAction(state, side, rng) {
  const user = active(state, side);
  const foe = active(state, 1 - side);

  let best = null;
  let bestScore = -1;
  user.moves.forEach((slot, i) => {
    if (slot.pp <= 0) return;
    const move = slot.move;
    if (move.category === "status" || move.power == null) return;
    const eff = typeEffectiveness(move.type, foe.pokemon.types);
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
    const score = avg * ((move.accuracy ?? 100) / 100);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });

  if (best == null) {
    // Nothing damaging with PP: any status move with PP, else Struggle via
    // whatever index (executeMove falls back once all PP is gone).
    const statusIdx = user.moves.findIndex((s) => s.pp > 0);
    best = statusIdx >= 0 ? statusIdx : 0;
  }
  return { type: "move", moveIndex: best };
}
