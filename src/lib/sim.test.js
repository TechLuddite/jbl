import { describe, it, expect } from "vitest";
import {
  createBattler, createBattle, playTurn, replaceFainted, openBattle,
  makeRng, stageMult, effectiveSpeed, chooseAiAction,
} from "./sim.js";

/**
 * Every expected number below is derived BY HAND from the formulas in
 * battle.js and the mechanics documented in sim.js. If one of these fails,
 * the code is wrong — do not adjust the number to match the output.
 *
 * The reference fixture: base 100 in every stat, level 50, IV 31, EV 0,
 * neutral nature.
 *   non-HP stat: floor((2*100+31)*50/100) = floor(115.5) = 115; +5 = 120
 *   HP:          115 + 50 + 10 = 175
 *
 * Reference damage, 80-power physical, 120 atk vs 120 def, neutral, no STAB:
 *   levelTerm  = floor(2*50/5 + 2) = 22
 *   baseDamage = floor(floor(22*80*120 / 120) / 50) + 2 = floor(1760/50)+2 = 37
 *   max roll (100%) = 37, min roll (85%) = floor(37*0.85) = 31
 */

const mon = (over = {}) => ({
  id: 1, name: "Alpha", types: ["normal"],
  stats: { hp: 100, atk: 100, def: 100, spa: 100, spd: 100, spe: 100 },
  sprite: "",
  ...over,
});

const move = (over = {}) => ({
  slug: "test-hit", name: "Test Hit", type: "normal", power: 80,
  accuracy: 100, pp: 25, category: "physical", priority: 0,
  target: "selected-pokemon", effectChance: null, meta: null, statChanges: [],
  ...over,
});

const swordsDance = () => move({
  slug: "swords-dance", name: "Swords Dance", type: "normal", power: null,
  category: "status", target: "user", pp: 20,
  statChanges: [{ stat: "atk", change: 2 }],
});

/**
 * Deterministic rng for tests. Unscripted calls fall back to 0.5, which
 * means: 100%-accurate moves hit, low-probability rolls (crit, full para,
 * thaw, secondary chances under 50%) do NOT happen, and damage takes the
 * max (100%) roll. Scripted queues override call-by-call, in call order.
 */
function scriptRng({ chance = [], int = [], rollIndex = [] } = {}) {
  const q = { chance: [...chance], int: [...int], rollIndex: [...rollIndex] };
  return {
    next: () => 0.5,
    chance: (p) => (q.chance.length ? q.chance.shift() : 0.5 < p),
    int: (n) => (q.int.length ? q.int.shift() : Math.floor(0.5 * n)),
    rollIndex: () => (q.rollIndex.length ? q.rollIndex.shift() : 15),
  };
}

/** 1v1 battle where side 0 is strictly faster (base 110 speed). */
function duel({ aMon = {}, bMon = {}, aMoves, bMoves, aOpts = {}, bOpts = {} } = {}) {
  const a = createBattler(
    mon({ name: "Alpha", stats: { hp: 100, atk: 100, def: 100, spa: 100, spd: 100, spe: 110 }, ...aMon }),
    { moves: aMoves ?? [move()], ...aOpts }
  );
  const b = createBattler(mon({ name: "Beta", id: 2, ...bMon }), { moves: bMoves ?? [move()], ...bOpts });
  return { a, b, state: createBattle([a], [b]) };
}

const attack = { type: "move", moveIndex: 0 };

describe("createBattler", () => {
  it("computes real stats and full HP from the fixture", () => {
    const b = createBattler(mon(), { moves: [move()] });
    expect(b.stats).toEqual({ hp: 175, atk: 120, def: 120, spa: 120, spd: 120, spe: 120 });
    expect(b.hp).toBe(175);
    expect(b.maxHP).toBe(175);
    expect(b.moves[0].pp).toBe(25);
    expect(b.status).toBeNull();
  });
});

describe("stage and speed helpers", () => {
  it("stage multipliers: +2 doubles, -1 is 2/3, accuracy uses base 3", () => {
    expect(stageMult(2)).toBe(2);
    expect(stageMult(-1)).toBeCloseTo(2 / 3);
    expect(stageMult(1, 3)).toBeCloseTo(4 / 3);
    expect(stageMult(0)).toBe(1);
  });

  it("paralysis halves effective speed", () => {
    const b = createBattler(mon(), { moves: [move()] });
    expect(effectiveSpeed(b)).toBe(120);
    b.status = "paralysis";
    expect(effectiveSpeed(b)).toBe(60);
  });
});

describe("basic damage", () => {
  it("deals 37 on the max roll: 80 power, 120 atk vs 120 def, neutral, no STAB", () => {
    // Water-type attacker with a normal move: no STAB, neutral into Beta.
    const { state } = duel({ aMon: { types: ["water"] } });
    const { state: s2, events } = playTurn(state, [attack, attack], scriptRng());
    const hit = events.find((e) => e.type === "damage" && e.name === "Beta");
    expect(hit.amount).toBe(37);
    expect(s2.teams[1].battlers[0].hp).toBe(175 - 37);
    expect(state.turn).toBe(1); // input state untouched
  });

  it("applies STAB: same-type 80 power hits for floor(37*1.5) = 55", () => {
    // Alpha is normal-type using a normal move.
    const { state } = duel();
    const { events } = playTurn(state, [attack, attack], scriptRng());
    // Both sides are normal-type with a normal move, so both hits are 55.
    expect(events.filter((e) => e.type === "damage").map((e) => e.amount)).toEqual([55, 55]);
  });

  it("applies type effectiveness: fighting vs normal doubles to floor(37*2) = 74", () => {
    const { state } = duel({ aMoves: [move({ type: "fighting" })] });
    const { events } = playTurn(state, [attack, attack], scriptRng());
    const hit = events.find((e) => e.type === "damage" && e.name === "Beta");
    expect(hit.amount).toBe(74);
    expect(hit.effectiveness).toBe(2);
  });

  it("normal move cannot touch a ghost", () => {
    const { state } = duel({ bMon: { types: ["ghost"] } });
    const { state: s2, events } = playTurn(state, [attack, attack], scriptRng());
    expect(events.some((e) => e.type === "immune" && e.name === "Beta")).toBe(true);
    expect(s2.teams[1].battlers[0].hp).toBe(175);
  });

  it("min roll: floor(37*85/100) = 31, then STAB makes 46", () => {
    const { state } = duel();
    const { events } = playTurn(state, [attack, attack], scriptRng({ rollIndex: [0, 0] }));
    // Roll first, STAB after: floor(floor(37*85/100) * 1.5) = floor(31*1.5) = 46.
    expect(events.find((e) => e.type === "damage").amount).toBe(46);
  });

  it("a crit multiplies the base by 1.5 before the roll: 55 with STAB becomes 82", () => {
    // afterCrit = floor(37*1.5) = 55; 100% roll then STAB: floor(55*1.5) = 82.
    const { state } = duel();
    // chance calls for Alpha's move: accuracy(true), crit(true)
    const { events } = playTurn(state, [attack, attack], scriptRng({ chance: [true, true] }));
    const hit = events.find((e) => e.type === "damage" && e.name === "Beta");
    expect(hit.crit).toBe(true);
    expect(hit.amount).toBe(82);
  });
});

describe("turn order", () => {
  it("faster Pokémon moves first", () => {
    const { state } = duel();
    const { events } = playTurn(state, [attack, attack], scriptRng());
    const moves = events.filter((e) => e.type === "move");
    expect(moves[0].name).toBe("Alpha");
    expect(moves[1].name).toBe("Beta");
  });

  it("priority beats speed", () => {
    const { state } = duel({ bMoves: [move({ priority: 1 })] });
    const { events } = playTurn(state, [attack, attack], scriptRng());
    expect(events.filter((e) => e.type === "move")[0].name).toBe("Beta");
  });

  it("speed ties are a coin flip", () => {
    const a = createBattler(mon(), { moves: [move()] });
    const b = createBattler(mon({ id: 2, name: "Beta" }), { moves: [move()] });
    const state = createBattle([a], [b]);
    // First chance call is the tie coin: false sends side 1 first.
    const { events } = playTurn(state, [attack, attack], scriptRng({ chance: [false] }));
    expect(events.filter((e) => e.type === "move")[0].name).toBe("Beta");
  });
});

describe("accuracy and PP", () => {
  it("a 50%-accurate move misses on the default roll and still spends PP", () => {
    const { state } = duel({ aMoves: [move({ accuracy: 50 })] });
    const { state: s2, events } = playTurn(state, [attack, attack], scriptRng());
    expect(events.some((e) => e.type === "miss" && e.name === "Alpha")).toBe(true);
    expect(s2.teams[0].battlers[0].moves[0].pp).toBe(24);
    expect(s2.teams[1].battlers[0].hp).toBe(175);
  });

  it("falls back to Struggle when all PP is gone: 24 damage, 43 recoil", () => {
    // Struggle: 50 power typeless, no STAB: floor(floor(22*50*120/120)/50)+2
    // = floor(1100/50)+2 = 24. Recoil: floor(175/4) = 43.
    const { state } = duel({
      aMoves: [move({ pp: 1 })],
      bMoves: [swordsDance()],
    });
    const t1 = playTurn(state, [attack, attack], scriptRng());
    expect(t1.state.teams[0].battlers[0].moves[0].pp).toBe(0);
    const t2 = playTurn(t1.state, [attack, attack], scriptRng());
    const hit = t2.events.find((e) => e.type === "damage" && e.name === "Beta");
    expect(hit.move).toBe("Struggle");
    expect(hit.amount).toBe(24);
    const recoil = t2.events.find((e) => e.type === "recoil");
    expect(recoil.amount).toBe(43);
    expect(t2.state.teams[0].battlers[0].hp).toBe(175 - 43);
  });
});

describe("stat stages", () => {
  it("Swords Dance gives +2 and physical damage jumps from 55 to 108", () => {
    // +2 atk: 240 atk → base = floor(floor(22*80*240/120)/50)+2 = 72.
    // 100% roll then STAB: floor(72*1.5) = 108... derive precisely:
    // floor(3520... 22*80*240 = 422400 / 120 = 3520 → /50 = 70.4 → 70 + 2 = 72.
    // roll 100%: 72 → STAB floor(72*1.5) = 108.
    const { state } = duel({ aMoves: [swordsDance(), move()] });
    const t1 = playTurn(state, [{ type: "move", moveIndex: 0 }, attack], scriptRng());
    const stage = t1.events.find((e) => e.type === "stages");
    expect(stage).toMatchObject({ name: "Alpha", stat: "atk", change: 2, now: 2 });
    const t2 = playTurn(t1.state, [{ type: "move", moveIndex: 1 }, attack], scriptRng());
    const hit = t2.events.find((e) => e.type === "damage" && e.name === "Beta");
    expect(hit.amount).toBe(108);
  });

  it("stages clamp at +6", () => {
    const { state } = duel({ aMoves: [swordsDance()] });
    let s = state;
    for (let i = 0; i < 4; i++) {
      s = playTurn(s, [attack, attack], scriptRng()).state;
    }
    expect(s.teams[0].battlers[0].stages.atk).toBe(6);
  });

  it("a foe-targeted drop lowers the target's stage", () => {
    const growl = move({
      slug: "growl", name: "Growl", power: null, category: "status",
      statChanges: [{ stat: "atk", change: -1 }],
    });
    const { state } = duel({ aMoves: [growl] });
    const { state: s2 } = playTurn(state, [attack, attack], scriptRng());
    expect(s2.teams[1].battlers[0].stages.atk).toBe(-1);
  });
});

describe("status conditions", () => {
  const willOWisp = () => move({
    slug: "will-o-wisp", name: "Will-O-Wisp", type: "fire", power: null,
    category: "status", accuracy: 85, pp: 15,
    meta: { ailment: "burn", ailmentChance: 0 },
  });
  const thunderWave = () => move({
    slug: "thunder-wave", name: "Thunder Wave", type: "electric", power: null,
    category: "status", accuracy: 90, pp: 20,
    meta: { ailment: "paralysis", ailmentChance: 0 },
  });

  it("burn chips 1/16 (10 of 175) at end of turn and halves physical damage", () => {
    const { state } = duel({ aMoves: [willOWisp()] });
    const t1 = playTurn(state, [attack, attack], scriptRng());
    expect(t1.events.some((e) => e.type === "status" && e.status === "burn")).toBe(true);
    // Beta attacked before the burn landed (Alpha is faster... no — Alpha
    // moved first with the burn, so Beta's hit this same turn is already
    // halved: floor(55 STAB... order is roll→STAB→burn: 37→55→floor(55/2)=27.
    const hit = t1.events.find((e) => e.type === "damage" && e.name === "Alpha");
    expect(hit.amount).toBe(27);
    const chipEvent = t1.events.find((e) => e.type === "chip");
    expect(chipEvent).toMatchObject({ name: "Beta", cause: "burn", amount: 10 });
  });

  it("fire types cannot be burned", () => {
    const { state } = duel({ aMoves: [willOWisp()], bMon: { types: ["fire"] } });
    const { state: s2, events } = playTurn(state, [attack, attack], scriptRng());
    expect(events.some((e) => e.type === "immune" && e.name === "Beta")).toBe(true);
    expect(s2.teams[1].battlers[0].status).toBeNull();
  });

  it("Thunder Wave cannot touch a ground type", () => {
    const { state } = duel({ aMoves: [thunderWave()], bMon: { types: ["ground"] } });
    const { state: s2, events } = playTurn(state, [attack, attack], scriptRng());
    expect(events.some((e) => e.type === "immune")).toBe(true);
    expect(s2.teams[1].battlers[0].status).toBeNull();
  });

  it("paralysis can wipe out a turn entirely", () => {
    const { state } = duel({ aMoves: [thunderWave()] });
    const t1 = playTurn(state, [attack, attack], scriptRng());
    expect(t1.state.teams[1].battlers[0].status).toBe("paralysis");
    // Beta attacked while paralysed on turn 1 (full-para defaulted to no):
    // Alpha sits at 175 - 55 = 120 going into turn 2.
    expect(t1.state.teams[0].battlers[0].hp).toBe(120);
    // Turn 2: Alpha's accuracy check (true), then Beta's full-para (true).
    const t2 = playTurn(t1.state, [attack, attack], scriptRng({ chance: [true, true] }));
    expect(t2.events.some((e) => e.type === "fullPara" && e.name === "Beta")).toBe(true);
    expect(t2.state.teams[0].battlers[0].hp).toBe(120);
  });

  it("sleep skips turns then wakes", () => {
    const spore = move({
      slug: "spore", name: "Spore", type: "grass", power: null,
      category: "status", accuracy: 100, pp: 15,
      meta: { ailment: "sleep", ailmentChance: 0 },
    });
    const { state } = duel({ aMoves: [spore] });
    // int queue: sleepTurns = 2 + 0 = 2 → asleep one turn, wakes the next.
    const t1 = playTurn(state, [attack, attack], scriptRng({ int: [0] }));
    expect(t1.events.some((e) => e.type === "asleep" && e.name === "Beta")).toBe(true);
    const t2 = playTurn(t1.state, [attack, attack], scriptRng());
    expect(t2.events.some((e) => e.type === "wake" && e.name === "Beta")).toBe(true);
    // Awake again, Beta's STAB hit lands: 55.
    expect(t2.state.teams[0].battlers[0].hp).toBe(175 - 55);
  });

  it("freeze holds until the thaw roll succeeds", () => {
    const { a, b } = duel();
    b.status = "freeze";
    const state = createBattle([a], [b]);
    const t1 = playTurn(state, [attack, attack], scriptRng());
    expect(t1.events.some((e) => e.type === "frozen" && e.name === "Beta")).toBe(true);
    // Alpha: accuracy(true), crit(false). Beta: thaw(true) → moves normally.
    const t2 = playTurn(t1.state, [attack, attack], scriptRng({ chance: [true, false, true] }));
    expect(t2.events.some((e) => e.type === "thaw" && e.name === "Beta")).toBe(true);
    expect(t2.state.teams[1].battlers[0].status).toBeNull();
  });

  it("poison chips 1/8 (21 of 175); toxic ramps 10, 21, 32", () => {
    const { a, b } = duel({ aMoves: [swordsDance()], bMoves: [swordsDance()] });
    a.status = "poison";
    b.status = "toxic";
    let s = createBattle([a], [b]);
    const chips = [];
    for (let i = 0; i < 3; i++) {
      const r = playTurn(s, [attack, attack], scriptRng());
      s = r.state;
      chips.push(r.events.filter((e) => e.type === "chip").map((e) => [e.name, e.amount]));
    }
    // floor(175/8) = 21 each turn for plain poison.
    // Toxic: floor(175*n/16) = 10, 21, 32.
    expect(chips[0]).toEqual(expect.arrayContaining([["Alpha", 21], ["Beta", 10]]));
    expect(chips[1]).toEqual(expect.arrayContaining([["Alpha", 21], ["Beta", 21]]));
    expect(chips[2]).toEqual(expect.arrayContaining([["Alpha", 21], ["Beta", 32]]));
  });

  it("an already-statused target is not re-statused", () => {
    const { a, b } = duel({ aMoves: [willOWisp()] });
    b.status = "poison";
    const state = createBattle([a], [b]);
    const { state: s2, events } = playTurn(state, [attack, attack], scriptRng());
    expect(events.some((e) => e.type === "noEffect")).toBe(true);
    expect(s2.teams[1].battlers[0].status).toBe("poison");
  });
});

describe("drain, recoil, healing, multi-hit, flinch", () => {
  it("drain heals half the damage dealt", () => {
    // Neutral non-STAB 37 damage → heal floor(37*50/100) = 18.
    const drain = move({ type: "fighting", meta: { ailment: "none", drain: 50 } });
    const { a, b } = duel({ aMoves: [drain], bMon: { types: ["bug"] } });
    // fighting vs bug is 0.5x: floor(37*0.5) = 18 damage → heal floor(18/2)=9.
    a.hp = 100;
    const state = createBattle([a], [b]);
    const { state: s2, events } = playTurn(state, [attack, attack], scriptRng());
    const hit = events.find((e) => e.type === "damage" && e.name === "Beta");
    expect(hit.amount).toBe(18);
    const drainEvent = events.find((e) => e.type === "drain");
    expect(drainEvent.amount).toBe(9);
    // Beta (bug) hits back with a normal move for 37, no STAB... Beta's move
    // is the default normal Test Hit and Beta is bug-typed: no STAB, 37.
    expect(s2.teams[0].battlers[0].hp).toBe(100 + 9 - 37);
  });

  it("recoil (negative drain) hurts the user", () => {
    // 33% recoil on a STAB 55 hit: floor(55*33/100) = 18.
    const recoilMove = move({ meta: { ailment: "none", drain: -33 } });
    const { state } = duel({ aMoves: [recoilMove], bMoves: [swordsDance()] });
    const { state: s2, events } = playTurn(state, [attack, attack], scriptRng());
    const r = events.find((e) => e.type === "recoil");
    expect(r.amount).toBe(18);
    expect(s2.teams[0].battlers[0].hp).toBe(175 - 18);
  });

  it("healing moves restore a percentage of max HP, capped at full", () => {
    const recover = move({
      slug: "recover", name: "Recover", power: null, category: "status",
      target: "user", accuracy: null, meta: { ailment: "none", healing: 50 },
    });
    const { a, b } = duel({ aMoves: [recover], bMoves: [swordsDance()] });
    a.hp = 100;
    const state = createBattle([a], [b]);
    const { state: s2, events } = playTurn(state, [attack, attack], scriptRng());
    // floor(175*50/100) = 87 but only 75 HP is missing.
    expect(events.find((e) => e.type === "heal").amount).toBe(75);
    expect(s2.teams[0].battlers[0].hp).toBe(175);
  });

  it("a 2-5 hit move hits twice on the low roll", () => {
    const doubleHit = move({ power: 25, meta: { ailment: "none", minHits: 2, maxHits: 5 } });
    // 25 power STAB: base = floor(floor(22*25*120/120)/50)+2 = floor(550/50)+2 = 13.
    // Per hit at 100%: floor(13*1.5) = 19.
    const { state } = duel({ aMoves: [doubleHit] });
    // int queue: multi-hit count roll 0 → 2 hits.
    const { events } = playTurn(state, [attack, attack], scriptRng({ int: [0] }));
    const hits = events.filter((e) => e.type === "damage" && e.name === "Beta");
    expect(hits).toHaveLength(2);
    expect(hits.map((e) => e.amount)).toEqual([19, 19]);
    expect(hits[1]).toMatchObject({ hit: 2, hits: 2 });
  });

  it("a guaranteed flinch from the faster side robs the slower side's turn", () => {
    const fakeOut = move({ meta: { ailment: "none", flinchChance: 100 } });
    const { state } = duel({ aMoves: [fakeOut] });
    const { state: s2, events } = playTurn(state, [attack, attack], scriptRng());
    expect(events.some((e) => e.type === "flinch" && e.name === "Beta")).toBe(true);
    expect(s2.teams[0].battlers[0].hp).toBe(175);
  });
});

describe("fainting, switching, winning", () => {
  it("a KO ends a 1v1 and names the winner", () => {
    const { a, b } = duel();
    b.hp = 10;
    const state = createBattle([a], [b]);
    const { state: s2, events } = playTurn(state, [attack, attack], scriptRng());
    expect(events.some((e) => e.type === "faint" && e.name === "Beta")).toBe(true);
    expect(events.some((e) => e.type === "win" && e.side === 0)).toBe(true);
    expect(s2.winner).toBe(0);
  });

  it("a KO with a bench asks for a replacement instead", () => {
    const { a } = duel();
    const b1 = createBattler(mon({ id: 2, name: "Beta" }), { moves: [move()] });
    const b2 = createBattler(mon({ id: 3, name: "Gamma" }), { moves: [move()] });
    b1.hp = 10;
    const state = createBattle([a], [b1, b2]);
    const t1 = playTurn(state, [attack, attack], scriptRng());
    expect(t1.state.winner).toBeNull();
    expect(t1.state.pendingReplacement[1]).toBe(true);

    // Sending in the fainted one again is rejected; the healthy one is fine.
    const bad = replaceFainted(t1.state, 1, 0);
    expect(bad.ok).toBe(false);
    const good = replaceFainted(t1.state, 1, 1);
    expect(good.ok).toBe(true);
    expect(good.state.teams[1].active).toBe(1);
    expect(good.state.pendingReplacement[1]).toBe(false);
  });

  it("switching happens before moves, resets stages, and keeps status", () => {
    const { a } = duel();
    const b1 = createBattler(mon({ id: 2, name: "Beta" }), { moves: [move()] });
    const b2 = createBattler(mon({ id: 3, name: "Gamma" }), { moves: [move()] });
    b1.stages.atk = 2;
    b1.status = "burn";
    const state = createBattle([a], [b1, b2]);
    const { state: s2, events } = playTurn(
      state,
      [attack, { type: "switch", to: 1 }],
      scriptRng()
    );
    const order = events.map((e) => e.type);
    expect(order.indexOf("switch")).toBeLessThan(order.indexOf("move"));
    // Alpha's hit lands on the incoming Gamma.
    expect(events.find((e) => e.type === "damage").name).toBe("Gamma");
    const beta = s2.teams[1].battlers[0];
    expect(beta.stages.atk).toBe(0);
    expect(beta.status).toBe("burn");
  });
});

describe("auto-battle AI", () => {
  it("prefers the hardest-hitting legal move", () => {
    const weak = move({ slug: "weak", name: "Weak", power: 40 });
    const ghostHit = move({ slug: "shadow", name: "Shadow", type: "ghost", power: 80 });
    const strong = move({ slug: "strong", name: "Strong", type: "fighting", power: 80 });
    const user = createBattler(mon(), { moves: [weak, ghostHit, strong] });
    // Foe is normal-type: ghost is immune (skip), fighting is 2x (best).
    const foe = createBattler(mon({ id: 2, name: "Beta" }), { moves: [move()] });
    const state = createBattle([user], [foe]);
    expect(chooseAiAction(state, 0, scriptRng())).toEqual({ type: "move", moveIndex: 2 });
  });

  it("falls back to the first move with PP when nothing damages", () => {
    const user = createBattler(mon(), { moves: [swordsDance()] });
    const foe = createBattler(mon({ id: 2, name: "Beta" }), { moves: [move()] });
    const state = createBattle([user], [foe]);
    expect(chooseAiAction(state, 0, scriptRng())).toEqual({ type: "move", moveIndex: 0 });
  });
});

describe("makeRng", () => {
  it("is deterministic for a given seed", () => {
    const a = makeRng(42);
    const b = makeRng(42);
    expect([a.next(), a.int(100), a.rollIndex()])
      .toEqual([b.next(), b.int(100), b.rollIndex()]);
  });
});

/* ---------------------------------------------------------- slice 2 ------ */

const rainDance = () => move({
  slug: "rain-dance", name: "Rain Dance", type: "water", power: null,
  category: "status", accuracy: null, target: "users-field",
});
const sunnyDay = () => move({
  slug: "sunny-day", name: "Sunny Day", type: "fire", power: null,
  category: "status", accuracy: null, target: "users-field",
});

describe("weather", () => {
  it("rain boosts water 1.5× and sun halves it", () => {
    // Non-STAB neutral 37: rain → floor(37*1.5) = 55; sun → floor(37*0.5) = 18.
    const water = move({ slug: "surf", name: "Surf", type: "water" });
    const { state } = duel({ aMon: { types: ["normal"] }, aMoves: [rainDance(), water, sunnyDay()], bMoves: [swordsDance()] });
    const t1 = playTurn(state, [attack, attack], scriptRng());
    expect(t1.events.some((e) => e.type === "weather" && e.kind === "rain")).toBe(true);
    const t2 = playTurn(t1.state, [{ type: "move", moveIndex: 1 }, attack], scriptRng());
    expect(t2.events.find((e) => e.type === "damage").amount).toBe(55);
    const t3 = playTurn(t2.state, [{ type: "move", moveIndex: 2 }, attack], scriptRng());
    const t4 = playTurn(t3.state, [{ type: "move", moveIndex: 1 }, attack], scriptRng());
    expect(t4.events.find((e) => e.type === "damage").amount).toBe(18);
  });

  it("sandstorm chips 1/16 from both, but not rock/ground/steel", () => {
    const sand = move({ slug: "sandstorm", name: "Sandstorm", type: "rock", power: null, category: "status", accuracy: null, target: "users-field" });
    const { state } = duel({ aMoves: [sand], bMon: { types: ["rock"] }, bMoves: [swordsDance()] });
    const { events } = playTurn(state, [attack, attack], scriptRng());
    const chips = events.filter((e) => e.type === "chip");
    // floor(175/16) = 10 for normal-type Alpha; rock-type Beta is untouched.
    expect(chips).toHaveLength(1);
    expect(chips[0]).toMatchObject({ name: "Alpha", cause: "sandstorm", amount: 10 });
  });

  it("sand gives rock types 1.5× Sp. Def", () => {
    // Special 80 into floor(120*1.5)=180 SpD: floor(floor(22*80*120/180)/50)+2
    // = floor(1173/50)+2 = 25. Psychic vs rock is neutral.
    const sand = move({ slug: "sandstorm", name: "Sandstorm", type: "rock", power: null, category: "status", accuracy: null, target: "users-field" });
    const psy = move({ slug: "psyshot", name: "Psyshot", type: "psychic", category: "special" });
    const { state } = duel({ aMoves: [sand, psy], bMon: { types: ["rock"] }, bMoves: [swordsDance()] });
    const t1 = playTurn(state, [attack, attack], scriptRng());
    const t2 = playTurn(t1.state, [{ type: "move", moveIndex: 1 }, attack], scriptRng());
    expect(t2.events.find((e) => e.type === "damage").amount).toBe(25);
  });

  it("weather runs out after five turns", () => {
    const { state } = duel({ aMoves: [rainDance(), swordsDance()], bMoves: [swordsDance()] });
    let s = playTurn(state, [attack, attack], scriptRng()).state;
    for (let i = 0; i < 3; i++) {
      const r = playTurn(s, [{ type: "move", moveIndex: 1 }, attack], scriptRng());
      expect(r.state.weather.kind).toBe("rain");
      s = r.state;
    }
    const last = playTurn(s, [{ type: "move", moveIndex: 1 }, attack], scriptRng());
    expect(last.events.some((e) => e.type === "weatherEnd")).toBe(true);
    expect(last.state.weather.kind).toBeNull();
  });
});

describe("entry hazards", () => {
  const rocks = () => move({ slug: "stealth-rock", name: "Stealth Rock", type: "rock", power: null, category: "status", accuracy: null });
  const spikes = () => move({ slug: "spikes", name: "Spikes", type: "ground", power: null, category: "status", accuracy: null });
  const tSpikes = () => move({ slug: "toxic-spikes", name: "Toxic Spikes", type: "poison", power: null, category: "status", accuracy: null });

  function twoOnBench(bMon2 = {}) {
    const a = createBattler(
      mon({ name: "Alpha", stats: { hp: 100, atk: 100, def: 100, spa: 100, spd: 100, spe: 110 } }),
      { moves: [rocks(), spikes(), tSpikes(), swordsDance()] }
    );
    const b1 = createBattler(mon({ id: 2, name: "Beta" }), { moves: [swordsDance()] });
    const b2 = createBattler(mon({ id: 3, name: "Gamma", ...bMon2 }), { moves: [swordsDance()] });
    return createBattle([a], [b1, b2]);
  }

  it("Stealth Rock takes 1/8, scaled by rock weakness", () => {
    // Neutral Gamma: floor(175/8) = 21.
    const s0 = twoOnBench();
    const t1 = playTurn(s0, [attack, attack], scriptRng());
    expect(t1.events.some((e) => e.type === "hazardSet" && e.hazard === "Stealth Rock")).toBe(true);
    const t2 = playTurn(t1.state, [{ type: "move", moveIndex: 3 }, { type: "switch", to: 1 }], scriptRng());
    const hz = t2.events.find((e) => e.type === "hazard");
    expect(hz).toMatchObject({ name: "Gamma", hazard: "Stealth Rock", amount: 21 });
  });

  it("Stealth Rock hurts a 4×-weak switcher for half its HP", () => {
    // Fire/flying: rock is 2×2 = 4× → floor(175*4/8) = 87.
    const s0 = twoOnBench({ types: ["fire", "flying"] });
    const t1 = playTurn(s0, [attack, attack], scriptRng());
    const t2 = playTurn(t1.state, [{ type: "move", moveIndex: 3 }, { type: "switch", to: 1 }], scriptRng());
    expect(t2.events.find((e) => e.type === "hazard").amount).toBe(87);
  });

  it("Spikes ignore flyers; Toxic Spikes poison grounded switchers", () => {
    const s0 = twoOnBench({ types: ["flying"] });
    // Lay spikes and toxic spikes over two turns.
    const t1 = playTurn(s0, [{ type: "move", moveIndex: 1 }, attack], scriptRng());
    const t2 = playTurn(t1.state, [{ type: "move", moveIndex: 2 }, attack], scriptRng());
    // Flying Gamma comes in: no spikes damage, no poison.
    const t3 = playTurn(t2.state, [{ type: "move", moveIndex: 3 }, { type: "switch", to: 1 }], scriptRng());
    expect(t3.events.some((e) => e.type === "hazard")).toBe(false);
    expect(t3.state.teams[1].battlers[1].status).toBeNull();
    // Grounded Beta comes back in: floor(175/8) = 21 and poisoned.
    const t4 = playTurn(t3.state, [{ type: "move", moveIndex: 3 }, { type: "switch", to: 0 }], scriptRng());
    expect(t4.events.find((e) => e.type === "hazard")).toMatchObject({ name: "Beta", amount: 21 });
    expect(t4.state.teams[1].battlers[0].status).toBe("poison");
  });

  it("a grounded poison type soaks up Toxic Spikes", () => {
    const s0 = twoOnBench({ types: ["poison"] });
    const t1 = playTurn(s0, [{ type: "move", moveIndex: 2 }, attack], scriptRng());
    const t2 = playTurn(t1.state, [{ type: "move", moveIndex: 3 }, { type: "switch", to: 1 }], scriptRng());
    expect(t2.events.some((e) => e.type === "hazardClear")).toBe(true);
    expect(t2.state.teams[1].hazards.toxicSpikes).toBe(0);
    expect(t2.state.teams[1].battlers[1].status).toBeNull();
  });
});

describe("held items", () => {
  it("Leftovers heals 1/16 at end of turn", () => {
    const { a, b } = duel({ aMoves: [swordsDance()], aOpts: { item: "leftovers" } });
    a.hp = 100;
    const state = createBattle([a], [b]);
    const { events } = playTurn(state, [attack, attack], scriptRng());
    // floor(175/16) = 10... after Beta's STAB 55 hit, then +10 at end of turn.
    const heal = events.find((e) => e.type === "heal" && e.via === "Leftovers");
    expect(heal.amount).toBe(10);
  });

  it("Sitrus Berry heals 1/4 once, below half HP", () => {
    const { a, b } = duel({ aMoves: [swordsDance()], aOpts: { item: "sitrus-berry" } });
    a.hp = 80; // under 87.5
    const state = createBattle([a], [b]);
    const { state: s2, events } = playTurn(state, [attack, attack], scriptRng());
    // floor(175/4) = 43. Beta hit for 55 first: 80-55=25, then +43 = 68.
    expect(events.find((e) => e.type === "heal" && e.via === "Sitrus Berry").amount).toBe(43);
    expect(s2.teams[0].battlers[0].item).toBeNull();
  });

  it("Choice Band boosts to floor(120*1.5)=180 Atk and locks the move", () => {
    // Non-STAB neutral: floor(floor(22*80*180/120)/50)+2 = floor(2640/50)+2 = 54.
    const second = move({ slug: "second", name: "Second", power: 40 });
    const { state } = duel({
      aMon: { types: ["water"] },
      aMoves: [move(), second],
      aOpts: { item: "choice-band" },
      bMoves: [swordsDance()],
    });
    const t1 = playTurn(state, [attack, attack], scriptRng());
    expect(t1.events.find((e) => e.type === "damage").amount).toBe(54);
    // Ask for move 1; the Band says no — Test Hit again.
    const t2 = playTurn(t1.state, [{ type: "move", moveIndex: 1 }, attack], scriptRng());
    expect(t2.events.find((e) => e.type === "move" && e.name === "Alpha").move).toBe("Test Hit");
    expect(t2.state.teams[0].battlers[0].moves[0].pp).toBe(23);
  });

  it("Choice Scarf outruns a faster Pokémon", () => {
    // Beta 120 Spe × 1.5 = 180 beats Alpha's 130.
    const { state } = duel({ bOpts: { item: "choice-scarf" } });
    const { events } = playTurn(state, [attack, attack], scriptRng());
    expect(events.filter((e) => e.type === "move")[0].name).toBe("Beta");
  });

  it("Life Orb: 1.3× damage, 1/10 max HP per attack", () => {
    // floor(37*1.3) = 48; recoil floor(175/10) = 17.
    const { state } = duel({ aMon: { types: ["water"] }, aOpts: { item: "life-orb" }, bMoves: [swordsDance()] });
    const { events } = playTurn(state, [attack, attack], scriptRng());
    expect(events.find((e) => e.type === "damage").amount).toBe(48);
    expect(events.find((e) => e.type === "recoil").amount).toBe(17);
  });

  it("Expert Belt: 1.2× only on super effective hits", () => {
    // Fighting vs normal: 37 → eff 74 → belt floor(74*1.2) = 88.
    const { state } = duel({ aMoves: [move({ type: "fighting" })], aOpts: { item: "expert-belt" }, bMoves: [swordsDance()] });
    const { events } = playTurn(state, [attack, attack], scriptRng());
    expect(events.find((e) => e.type === "damage").amount).toBe(88);
  });

  it("Focus Sash keeps a full-HP Pokémon at 1, then is spent", () => {
    // Fighting-type STAB 150 power vs normal: base floor(3300/50)+2 = 68,
    // STAB floor(68*1.5) = 102, eff ×2 = 204 ≥ 175 → sash holds at 1 HP.
    const nuke = move({ slug: "nuke", name: "Nuke", type: "fighting", power: 150 });
    const { state } = duel({ aMon: { types: ["fighting"] }, aMoves: [nuke], bOpts: { item: "focus-sash" }, bMoves: [swordsDance()] });
    const { state: s2, events } = playTurn(state, [attack, attack], scriptRng());
    expect(events.some((e) => e.type === "endure" && e.via === "Focus Sash")).toBe(true);
    expect(s2.teams[1].battlers[0].hp).toBe(1);
    expect(s2.teams[1].battlers[0].item).toBeNull();
  });

  it("Air Balloon floats over Ground moves until popped", () => {
    const quake = move({ slug: "quake", name: "Quake", type: "ground" });
    const pop = move({ slug: "pop", name: "Pop", power: 40 });
    const { state } = duel({ aMoves: [quake, pop], bOpts: { item: "air-balloon" }, bMoves: [swordsDance()] });
    const t1 = playTurn(state, [attack, attack], scriptRng());
    expect(t1.events.some((e) => e.type === "immune")).toBe(true);
    const t2 = playTurn(t1.state, [{ type: "move", moveIndex: 1 }, attack], scriptRng());
    expect(t2.events.some((e) => e.type === "balloonPop")).toBe(true);
    const t3 = playTurn(t2.state, [attack, attack], scriptRng());
    expect(t3.events.some((e) => e.type === "damage" && e.move === "Quake")).toBe(true);
  });
});

describe("abilities", () => {
  it("Intimidate drops the foe's Attack on entry", () => {
    const { a, b } = duel({ aOpts: { ability: "intimidate" } });
    const opened = openBattle(createBattle([a], [b]));
    expect(opened.events.some((e) => e.type === "ability" && e.ability === "Intimidate")).toBe(true);
    expect(opened.state.teams[1].battlers[0].stages.atk).toBe(-1);
  });

  it("Drizzle sets rain from the doorway", () => {
    const { a, b } = duel({ aOpts: { ability: "drizzle" } });
    const opened = openBattle(createBattle([a], [b]));
    expect(opened.state.weather).toEqual({ kind: "rain", turns: 5 });
  });

  it("Levitate blanks Ground moves", () => {
    const quake = move({ slug: "quake", name: "Quake", type: "ground" });
    const { state } = duel({ aMoves: [quake], bOpts: { ability: "levitate" }, bMoves: [swordsDance()] });
    const { events } = playTurn(state, [attack, attack], scriptRng());
    expect(events.some((e) => e.type === "immune")).toBe(true);
    expect(events.some((e) => e.type === "damage")).toBe(false);
  });

  it("Huge Power doubles Attack: 37 becomes 72", () => {
    // atk 240: floor(floor(22*80*240/120)/50)+2 = 72 (non-STAB, neutral).
    const { state } = duel({ aMon: { types: ["water"] }, aOpts: { ability: "huge-power" }, bMoves: [swordsDance()] });
    const { events } = playTurn(state, [attack, attack], scriptRng());
    expect(events.find((e) => e.type === "damage").amount).toBe(72);
  });

  it("Guts turns burn into a boost: 1.5× Atk and no halving", () => {
    // atk floor(120*1.5)=180 → 54 non-STAB; without Guts burn would halve it.
    const { a, b } = duel({ aMon: { types: ["water"] }, aOpts: { ability: "guts" }, bMoves: [swordsDance()] });
    a.status = "burn";
    const state = createBattle([a], [b]);
    const { events } = playTurn(state, [attack, attack], scriptRng());
    expect(events.find((e) => e.type === "damage").amount).toBe(54);
    // The burn itself still chips 10.
    expect(events.find((e) => e.type === "chip").amount).toBe(10);
  });

  it("Water Absorb drinks the hit and heals a quarter", () => {
    const surf = move({ slug: "surf", name: "Surf", type: "water" });
    const { a, b } = duel({ aMoves: [surf], bOpts: { ability: "water-absorb" }, bMoves: [swordsDance()] });
    b.hp = 100;
    const state = createBattle([a], [b]);
    const { state: s2, events } = playTurn(state, [attack, attack], scriptRng());
    // floor(175/4) = 43 → 143.
    expect(events.find((e) => e.type === "absorb").amount).toBe(43);
    expect(s2.teams[1].battlers[0].hp).toBe(143);
  });

  it("Magic Guard ignores every indirect drip", () => {
    const { a, b } = duel({ aOpts: { ability: "magic-guard" }, aMoves: [swordsDance()], bMoves: [swordsDance()] });
    a.status = "poison";
    const state = createBattle([a], [b]);
    const { events } = playTurn(state, [attack, attack], scriptRng());
    expect(events.some((e) => e.type === "chip")).toBe(false);
  });

  it("Speed Boost climbs one stage per turn", () => {
    const { state } = duel({ aOpts: { ability: "speed-boost" }, aMoves: [swordsDance()], bMoves: [swordsDance()] });
    const t1 = playTurn(state, [attack, attack], scriptRng());
    expect(t1.state.teams[0].battlers[0].stages.spe).toBe(1);
  });

  it("Technician: 60 power reads as 90", () => {
    // floor(floor(22*90*120/120)/50)+2 = 41 (non-STAB, neutral).
    const { state } = duel({ aMon: { types: ["water"] }, aMoves: [move({ power: 60 })], aOpts: { ability: "technician" }, bMoves: [swordsDance()] });
    const { events } = playTurn(state, [attack, attack], scriptRng());
    expect(events.find((e) => e.type === "damage").amount).toBe(41);
  });

  it("Adaptability pushes STAB to 2×: 37 becomes 74", () => {
    const { state } = duel({ aOpts: { ability: "adaptability" }, bMoves: [swordsDance()] });
    const { events } = playTurn(state, [attack, attack], scriptRng());
    expect(events.find((e) => e.type === "damage").amount).toBe(74);
  });

  it("Blaze: 1.5× Fire power below a third of HP", () => {
    // power 120: base floor(2640/50)+2 = 54; fire STAB floor(54*1.5) = 81.
    const flame = move({ slug: "flame", name: "Flame", type: "fire" });
    const { a, b } = duel({ aMon: { types: ["fire"] }, aMoves: [flame], aOpts: { ability: "blaze" }, bMoves: [swordsDance()] });
    a.hp = 58; // 58*3 = 174 ≤ 175
    const state = createBattle([a], [b]);
    const { events } = playTurn(state, [attack, attack], scriptRng());
    expect(events.find((e) => e.type === "damage").amount).toBe(81);
  });

  it("Regenerator heals a third on the way out", () => {
    const a = createBattler(mon({ name: "Alpha", stats: { hp: 100, atk: 100, def: 100, spa: 100, spd: 100, spe: 110 } }), { moves: [move()], ability: "regenerator" });
    const a2 = createBattler(mon({ id: 4, name: "Delta" }), { moves: [move()] });
    const b = createBattler(mon({ id: 2, name: "Beta" }), { moves: [swordsDance()] });
    a.hp = 60;
    const state = createBattle([a, a2], [b]);
    const { state: s2 } = playTurn(state, [{ type: "switch", to: 1 }, attack], scriptRng());
    // floor(175/3) = 58 → 118.
    expect(s2.teams[0].battlers[0].hp).toBe(118);
  });

  it("Sturdy hangs on at 1 HP and keeps working from full", () => {
    const nuke = move({ slug: "nuke", name: "Nuke", type: "fighting", power: 150 });
    const { state } = duel({ aMon: { types: ["fighting"] }, aMoves: [nuke], bOpts: { ability: "sturdy" }, bMoves: [swordsDance()] });
    const { state: s2, events } = playTurn(state, [attack, attack], scriptRng());
    expect(events.some((e) => e.type === "endure" && e.via === "Sturdy")).toBe(true);
    expect(s2.teams[1].battlers[0].hp).toBe(1);
  });
});
