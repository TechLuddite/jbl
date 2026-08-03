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
 * Not yet implemented (tracked in ROADMAP.md, arriving in slices): weather,
 * entry hazards, held items, abilities, confusion and other volatile statuses.
 * Unknown move ailments are ignored rather than guessed at.
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
    status: null,          // burn | paralysis | sleep | freeze | poison | toxic
    sleepTurns: 0,         // turns of sleep remaining
    toxicCounter: 0,       // ramps 1, 2, 3... while badly poisoned
    stages: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, acc: 0, eva: 0 },
    flinched: false,
  };
}

/** Two teams in, a fresh battle state out. Each team is 1-6 battlers. */
export function createBattle(teamA, teamB) {
  return {
    teams: [
      { battlers: teamA, active: 0 },
      { battlers: teamB, active: 0 },
    ],
    turn: 1,
    winner: null,           // 0 | 1 once a whole team has fainted
    pendingReplacement: [false, false],
  };
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

/** Effective Speed: stage-modified, then halved by paralysis. */
export function effectiveSpeed(b) {
  let spe = Math.floor(b.stats.spe * stageMult(b.stages.spe));
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
  // Stages and flinch are left at the door; status rides along.
  out.stages = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, acc: 0, eva: 0 };
  out.flinched = false;
  team.active = to;
  events.push({ type: "switch", side, out: out.pokemon.name, in: target.pokemon.name });
}

/** Fill a fainted slot between turns. Returns true if the switch was legal. */
export function replaceFainted(prevState, side, to) {
  const state = structuredClone(prevState);
  const team = state.teams[side];
  const target = team.battlers[to];
  if (!state.pendingReplacement[side] || !target || target.hp <= 0) {
    return { state: prevState, ok: false };
  }
  team.active = to;
  state.pendingReplacement[side] = false;
  return { state, ok: true };
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
  if (slot) slot.pp -= 1;

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

  let totalDamage = 0;
  for (let h = 0; h < hits && foe.hp > 0; h++) {
    const critStages = move.meta?.critRate ?? 0;
    const critChance = [1 / 24, 1 / 8, 1 / 2, 1][Math.min(3, critStages)];
    const crit = rng.chance(critChance);

    const atk = battleStat(user, atkKey, { crit, attacking: true });
    const def = battleStat(foe, defKey, { crit, attacking: false });
    const stab = user.pokemon.types.includes(move.type) ? 1.5 : 1;

    const calc = calcDamage({
      level: user.level, power: move.power, atk, def,
      stab, effectiveness: eff, crit,
      burn: user.status === "burn" && isPhysical,
    });
    const rollIndex = rng.rollIndex();
    const dmg = Math.min(foe.hp, calc.rolls[rollIndex]);
    foe.hp -= dmg;
    totalDamage += dmg;

    events.push({
      type: "damage", side: 1 - side, name: foe.pokemon.name,
      move: move.name, amount: dmg, crit, effectiveness: eff, stab,
      hit: h + 1, hits,
      // The working, for the UI to show.
      detail: { atk, def, atkKey, defKey, rollIndex, rolls: calc.rolls },
      hpLeft: foe.hp, maxHP: foe.maxHP,
    });
  }

  // Drain / recoil are a percentage of damage dealt; Struggle is special-cased
  // to modern rules (quarter of the user's max HP).
  if (move === STRUGGLE) {
    applyRecoil(user, side, Math.floor(user.maxHP / 4), events);
  } else if (move.meta?.drain) {
    const frac = Math.floor((totalDamage * Math.abs(move.meta.drain)) / 100);
    if (move.meta.drain > 0) {
      const healed = Math.min(user.maxHP - user.hp, Math.max(1, frac));
      user.hp += healed;
      events.push({ type: "drain", side, name: user.pokemon.name, amount: healed });
    } else {
      applyRecoil(user, side, Math.max(1, frac), events);
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
  for (const side of moveOrder) {
    const b = active(state, side);
    if (b.hp <= 0) continue;
    if (b.status === "burn") {
      chip(b, side, Math.max(1, Math.floor(b.maxHP / 16)), "burn", events);
    } else if (b.status === "poison") {
      chip(b, side, Math.max(1, Math.floor(b.maxHP / 8)), "poison", events);
    } else if (b.status === "toxic") {
      b.toxicCounter += 1;
      chip(b, side, Math.max(1, Math.floor((b.maxHP * b.toxicCounter) / 16)), "toxic", events);
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
