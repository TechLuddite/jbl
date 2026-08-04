import { describe, it, expect } from "vitest";
import {
  createBattler, createBattle, playTurn, replaceFainted, openBattle,
  makeRng, stageMult, effectiveSpeed, chooseAiAction, switchBlockedBy,
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

/* ======================================================================== *
 *  Multi-turn mechanics.
 *
 *  Same rule as everything above: the numbers are worked out by hand from
 *  the formula in battle.js before the code is run, not copied out of the
 *  output afterwards. The reference fixture is unchanged — every stat 120,
 *  175 HP, level 50, and the standard 80-power hit lands for 37 without STAB.
 * ======================================================================== */

/** Build a move with a meta block, since most multi-turn moves need one. */
const withMeta = (over = {}, meta = {}) => move({
  meta: {
    category: "damage", ailment: "none", ailmentChance: 0, critRate: 0,
    drain: 0, healing: 0, flinchChance: 0, minHits: null, maxHits: null,
    ...meta,
  },
  ...over,
});

const statusMove = (over = {}, meta = {}) => withMeta(
  { power: null, accuracy: null, category: "status", pp: 10, ...over },
  { category: "unique", ...meta }
);

describe("charging moves", () => {
  // Solar Beam: 120 power special, spa 120 vs spd 120, no STAB (water user).
  //   floor(floor(22*120*120/120)/50)+2 = floor(2640/50)+2 = 52+2 = 54
  const solarBeam = () => withMeta({
    slug: "solar-beam", name: "Solar Beam", type: "grass",
    power: 120, category: "special", pp: 10,
  });

  it("spends the first turn charging and fires 54 on the second", () => {
    const { state } = duel({
      aMon: { types: ["water"] }, aMoves: [solarBeam()], bMoves: [swordsDance()],
    });
    const t1 = playTurn(state, [attack, attack], scriptRng());
    expect(t1.events.some((e) => e.type === "charge" && e.move === "Solar Beam")).toBe(true);
    expect(t1.events.some((e) => e.type === "damage")).toBe(false);
    // PP is spent when the move starts, not when it lands.
    expect(t1.state.teams[0].battlers[0].moves[0].pp).toBe(9);

    const t2 = playTurn(t1.state, [attack, attack], scriptRng());
    expect(t2.events.find((e) => e.type === "damage").amount).toBe(54);
    expect(t2.state.teams[0].battlers[0].moves[0].pp).toBe(9);
  });

  it("fires the same turn in harsh sunlight", () => {
    const { a, b } = duel({
      aMon: { types: ["water"] }, aMoves: [solarBeam()], bMoves: [swordsDance()],
    });
    const state = createBattle([a], [b]);
    state.weather = { kind: "sun", turns: 5 };
    const { events } = playTurn(state, [attack, attack], scriptRng());
    expect(events.some((e) => e.type === "charge")).toBe(false);
    expect(events.find((e) => e.type === "damage").amount).toBe(54);
  });

  it("still charges in rain, and hits at half power: 60 power = 28", () => {
    // floor(120/2) = 60 power → floor(floor(22*60*120/120)/50)+2 = 26+2 = 28.
    const { a, b } = duel({
      aMon: { types: ["water"] }, aMoves: [solarBeam()], bMoves: [swordsDance()],
    });
    const state = createBattle([a], [b]);
    state.weather = { kind: "rain", turns: 5 };
    const t1 = playTurn(state, [attack, attack], scriptRng());
    expect(t1.events.some((e) => e.type === "charge")).toBe(true);
    const t2 = playTurn(t1.state, [attack, attack], scriptRng());
    expect(t2.events.find((e) => e.type === "damage").amount).toBe(28);
  });

  it("Power Herb skips the charge turn once and is used up", () => {
    const { state } = duel({
      aMon: { types: ["water"] }, aMoves: [solarBeam()], bMoves: [swordsDance()],
      aOpts: { item: "power-herb" },
    });
    const t1 = playTurn(state, [attack, attack], scriptRng());
    expect(t1.events.some((e) => e.type === "itemUsed" && e.item === "Power Herb")).toBe(true);
    expect(t1.events.find((e) => e.type === "damage").amount).toBe(54);
    expect(t1.state.teams[0].battlers[0].item).toBeNull();

    // Second time there is no herb left, so it has to charge.
    const t2 = playTurn(t1.state, [attack, attack], scriptRng());
    expect(t2.events.some((e) => e.type === "charge")).toBe(true);
  });

  it("Skull Bash raises Defense while it winds up", () => {
    const skullBash = withMeta({ slug: "skull-bash", name: "Skull Bash", power: 130 });
    const { state } = duel({ aMoves: [skullBash], bMoves: [swordsDance()] });
    const t1 = playTurn(state, [attack, attack], scriptRng());
    expect(t1.state.teams[0].battlers[0].stages.def).toBe(1);
    expect(t1.events.some((e) => e.type === "damage")).toBe(false);
  });

  it("nothing can touch a Pokémon that is up in the air", () => {
    // Fly: 90 power, no STAB (water user) →
    //   floor(floor(22*90*120/120)/50)+2 = 39+2 = 41 when it comes down.
    const fly = withMeta({ slug: "fly", name: "Fly", type: "flying", power: 90, accuracy: 95 });
    const { state } = duel({ aMon: { types: ["water"] }, aMoves: [fly] });
    const t1 = playTurn(state, [attack, attack], scriptRng());
    const missed = t1.events.find((e) => e.type === "miss");
    expect(missed.hiding).toBe("air");
    expect(t1.state.teams[0].battlers[0].hp).toBe(175); // Beta whiffed entirely

    const t2 = playTurn(t1.state, [attack, attack], scriptRng());
    expect(t2.events.find((e) => e.type === "damage" && e.name === "Beta").amount).toBe(41);
  });

  it("Earthquake reaches a digging Pokémon and hits twice as hard: 90", () => {
    // 100 power doubled to 200, no STAB (water user):
    //   floor(floor(22*200*120/120)/50)+2 = 88+2 = 90.
    const quake = withMeta({ slug: "earthquake", name: "Earthquake", type: "ground", power: 100 });
    const dig = withMeta({ slug: "dig", name: "Dig", type: "ground", power: 80 });
    const { state } = duel({
      aMon: { types: ["water"] }, aMoves: [quake],
      bMon: { types: ["normal"] }, bMoves: [dig],
    });
    const t1 = playTurn(state, [attack, attack], scriptRng());
    expect(t1.state.teams[1].battlers[0].vol.charge.invuln).toBe("underground");
    const t2 = playTurn(t1.state, [attack, attack], scriptRng());
    expect(t2.events.find((e) => e.type === "damage" && e.name === "Beta").amount).toBe(90);
  });

  it("a Pokémon mid-charge cannot be switched out", () => {
    const solar = solarBeam();
    const a = createBattler(mon({ name: "Alpha", types: ["water"], stats: { hp: 100, atk: 100, def: 100, spa: 100, spd: 100, spe: 110 } }), { moves: [solar] });
    const a2 = createBattler(mon({ id: 4, name: "Delta" }), { moves: [move()] });
    const b = createBattler(mon({ id: 2, name: "Beta" }), { moves: [swordsDance()] });
    const state = createBattle([a, a2], [b]);
    const t1 = playTurn(state, [attack, attack], scriptRng());
    expect(switchBlockedBy(t1.state, 0)).toBe("its own move");
    const t2 = playTurn(t1.state, [{ type: "switch", to: 1 }, attack], scriptRng());
    expect(t2.events.some((e) => e.type === "trapped")).toBe(true);
    expect(t2.state.teams[0].active).toBe(0);
  });
});

describe("recharge moves", () => {
  // Hyper Beam: 150 power special, no STAB (water user):
  //   floor(floor(22*150*120/120)/50)+2 = 66+2 = 68.
  const hyperBeam = () => withMeta({
    slug: "hyper-beam", name: "Hyper Beam", power: 150,
    category: "special", accuracy: 90, pp: 5,
  });

  it("hits for 68, then loses the next turn getting its breath back", () => {
    const { state } = duel({
      aMon: { types: ["water"] }, aMoves: [hyperBeam()], bMoves: [swordsDance()],
    });
    const t1 = playTurn(state, [attack, attack], scriptRng());
    expect(t1.events.find((e) => e.type === "damage").amount).toBe(68);
    expect(t1.events.some((e) => e.type === "mustRecharge")).toBe(true);

    const t2 = playTurn(t1.state, [attack, attack], scriptRng());
    expect(t2.events.some((e) => e.type === "recharge")).toBe(true);
    expect(t2.events.some((e) => e.type === "damage")).toBe(false);
    expect(t2.state.teams[0].battlers[0].moves[0].pp).toBe(4); // no second charge

    // And it is swinging again on the turn after that.
    const t3 = playTurn(t2.state, [attack, attack], scriptRng());
    expect(t3.events.find((e) => e.type === "damage").amount).toBe(68);
  });

  it("a miss costs no recharge", () => {
    const { state } = duel({
      aMon: { types: ["water"] }, aMoves: [hyperBeam()], bMoves: [swordsDance()],
    });
    const t1 = playTurn(state, [attack, attack], scriptRng({ chance: [false] }));
    expect(t1.events.some((e) => e.type === "miss")).toBe(true);
    expect(t1.events.some((e) => e.type === "mustRecharge")).toBe(false);
    expect(t1.state.teams[0].battlers[0].vol.recharge).toBe(false);
  });
});

describe("rampage locks and confusion", () => {
  // Outrage: 120 power physical, dragon into normal is neutral, no STAB
  // (water user) → floor(floor(22*120*120/120)/50)+2 = 54.
  const outrage = () => withMeta({
    slug: "outrage", name: "Outrage", type: "dragon", power: 120,
    target: "random-opponent", pp: 10,
  });

  it("swings for three turns on 54 each, then confuses itself", () => {
    // scriptRng's int(2) is 1, so the lock runs the full three turns.
    const { state } = duel({
      aMon: { types: ["water"] }, aMoves: [outrage()], bMoves: [swordsDance()],
    });
    let s = state;
    for (let turn = 1; turn <= 3; turn++) {
      const r = playTurn(s, [attack, attack], scriptRng());
      expect(r.events.find((e) => e.type === "damage").amount).toBe(54);
      // PP is only spent on the turn the move was chosen, so it stays at 9
      // for all three swings.
      expect(r.state.teams[0].battlers[0].moves[0].pp).toBe(9);
      s = r.state;
    }
    expect(s.teams[1].battlers[0].hp).toBe(175 - 54 * 3);
    expect(s.teams[0].battlers[0].vol.locked).toBeNull();
    expect(s.teams[0].battlers[0].vol.confusion).toBe(4); // 2 + int(4) = 4
  });

  it("keeps swinging even when the player asks for something else", () => {
    const { state } = duel({
      aMon: { types: ["water"] }, aMoves: [outrage(), swordsDance()], bMoves: [swordsDance()],
    });
    const t1 = playTurn(state, [attack, attack], scriptRng());
    const t2 = playTurn(t1.state, [{ type: "move", moveIndex: 1 }, attack], scriptRng());
    expect(t2.events.find((e) => e.type === "move" && e.side === 0).move).toBe("Outrage");
    expect(t2.state.teams[0].battlers[0].stages.atk).toBe(0);
  });

  it("a miss ends the rampage early, with no confusion", () => {
    const { state } = duel({
      aMon: { types: ["water"] }, aMoves: [outrage()], bMoves: [swordsDance()],
    });
    const t1 = playTurn(state, [attack, attack], scriptRng());
    const t2 = playTurn(t1.state, [attack, attack], scriptRng({ chance: [false] }));
    expect(t2.events.some((e) => e.type === "rampageEnd" && e.early)).toBe(true);
    expect(t2.state.teams[0].battlers[0].vol.locked).toBeNull();
    expect(t2.state.teams[0].battlers[0].vol.confusion).toBe(0);
  });

  it("confusion hits for 19: 40 power, its own 120 Atk into its own 120 Def", () => {
    // floor(floor(22*40*120/120)/50)+2 = 17+2 = 19, typeless so no STAB.
    const { a, b } = duel({ bMoves: [swordsDance()] });
    a.vol.confusion = 3;
    const state = createBattle([a], [b]);
    const { state: s2, events } = playTurn(state, [attack, attack], scriptRng({ chance: [true] }));
    const hit = events.find((e) => e.type === "confusionHit");
    expect(hit.amount).toBe(19);
    expect(s2.teams[0].battlers[0].hp).toBe(175 - 19);
    expect(events.some((e) => e.type === "damage")).toBe(false); // it never swung
  });

  it("snaps out when the counter runs down, and moves that turn", () => {
    const { a, b } = duel({ bMoves: [swordsDance()] });
    a.vol.confusion = 1;
    const state = createBattle([a], [b]);
    const { events } = playTurn(state, [attack, attack], scriptRng());
    expect(events.some((e) => e.type === "confusionEnd")).toBe(true);
    expect(events.find((e) => e.type === "damage").amount).toBe(55);
  });

  it("Own Tempo refuses to be confused", () => {
    const confuseRay = statusMove(
      { slug: "confuse-ray", name: "Confuse Ray", type: "ghost", accuracy: 100 },
      { category: "ailment", ailment: "confusion" }
    );
    const { state } = duel({
      aMoves: [confuseRay], bMoves: [swordsDance()], bOpts: { ability: "own-tempo" },
    });
    const { state: s2, events } = playTurn(state, [attack, attack], scriptRng());
    expect(events.some((e) => e.type === "immune")).toBe(true);
    expect(s2.teams[1].battlers[0].vol.confusion).toBe(0);
  });
});

describe("momentum moves", () => {
  // Fury Cutter, 40 power bug, no STAB (water user):
  //   40  → floor(floor(22*40*120/120)/50)+2 = 19
  //   80  → floor(floor(22*80*120/120)/50)+2 = 37
  //   160 → floor(floor(22*160*120/120)/50)+2 = 72   (and it caps there)
  it("Fury Cutter doubles on each consecutive use: 19, 37, 72, 72", () => {
    const furyCutter = withMeta({
      slug: "fury-cutter", name: "Fury Cutter", type: "bug", power: 40, accuracy: 95, pp: 20,
    });
    const { a, b } = duel({ aMon: { types: ["water"] }, aMoves: [furyCutter], bMoves: [swordsDance()] });
    b.stats.hp = 400; b.maxHP = 400; b.hp = 400;
    let s = createBattle([a], [b]);
    const dealt = [];
    for (let i = 0; i < 4; i++) {
      const r = playTurn(s, [attack, attack], scriptRng());
      dealt.push(r.events.find((e) => e.type === "damage").amount);
      s = r.state;
    }
    expect(dealt).toEqual([19, 37, 72, 72]);
  });

  it("a different move resets the counter", () => {
    const furyCutter = withMeta({
      slug: "fury-cutter", name: "Fury Cutter", type: "bug", power: 40, accuracy: 95, pp: 20,
    });
    // The filler is a plain weak hit on purpose: anything that moved a stat
    // would change the third turn's number for the wrong reason.
    const filler = withMeta({ slug: "filler", name: "Filler", power: 10 });
    const { state } = duel({
      aMon: { types: ["water"] }, aMoves: [furyCutter, filler], bMoves: [swordsDance()],
    });
    const t1 = playTurn(state, [attack, attack], scriptRng());
    expect(t1.state.teams[0].battlers[0].vol.momentum.hits).toBe(1);
    const t2 = playTurn(t1.state, [{ type: "move", moveIndex: 1 }, attack], scriptRng());
    expect(t2.state.teams[0].battlers[0].vol.momentum).toBeNull();
    const t3 = playTurn(t2.state, [attack, attack], scriptRng());
    expect(t3.events.find((e) => e.type === "damage").amount).toBe(19);
  });

  it("Rollout locks in for five turns and doubles as it goes: 15 then 28", () => {
    // 30 power → floor(floor(22*30*120/120)/50)+2 = 13+2 = 15; 60 → 26+2 = 28.
    const rollout = withMeta({
      slug: "rollout", name: "Rollout", type: "rock", power: 30, accuracy: 90, pp: 20,
    });
    const { a, b } = duel({ aMon: { types: ["water"] }, aMoves: [rollout, swordsDance()], bMoves: [swordsDance()] });
    const state = createBattle([a], [b]);
    const t1 = playTurn(state, [attack, attack], scriptRng());
    expect(t1.events.find((e) => e.type === "damage").amount).toBe(15);
    expect(t1.state.teams[0].battlers[0].vol.locked.kind).toBe("rollout");
    // Asking for Swords Dance changes nothing — it is still rolling.
    const t2 = playTurn(t1.state, [{ type: "move", moveIndex: 1 }, attack], scriptRng());
    expect(t2.events.find((e) => e.type === "damage").amount).toBe(28);
  });
});

describe("trapping", () => {
  const fireSpin = () => withMeta(
    {
      slug: "fire-spin", name: "Fire Spin", type: "fire", power: 35,
      accuracy: 85, category: "special", pp: 15, effectChance: 100,
    },
    { category: "damage-ailment", ailment: "trap", ailmentChance: 100 }
  );

  it("hits for 17, then squeezes 21 a turn and blocks the switch", () => {
    // 35 power special, no STAB (water user):
    //   floor(floor(22*35*120/120)/50)+2 = 15+2 = 17. Chip is floor(175/8) = 21.
    const a = createBattler(mon({ name: "Alpha", types: ["water"], stats: { hp: 100, atk: 100, def: 100, spa: 100, spd: 100, spe: 110 } }), { moves: [fireSpin()] });
    const b = createBattler(mon({ id: 2, name: "Beta" }), { moves: [swordsDance()] });
    const b2 = createBattler(mon({ id: 3, name: "Gamma" }), { moves: [move()] });
    const state = createBattle([a], [b, b2]);

    const t1 = playTurn(state, [attack, attack], scriptRng());
    expect(t1.events.find((e) => e.type === "damage").amount).toBe(17);
    expect(t1.events.find((e) => e.type === "chip").amount).toBe(21);
    expect(t1.state.teams[1].battlers[0].hp).toBe(175 - 17 - 21);
    // 4 + int(2) = 5 turns, one of which has already been served.
    expect(t1.state.teams[1].battlers[0].vol.trap.turns).toBe(4);
    expect(switchBlockedBy(t1.state, 1)).toBe("Fire Spin");

    const t2 = playTurn(t1.state, [attack, { type: "switch", to: 1 }], scriptRng());
    expect(t2.events.some((e) => e.type === "trapped" && e.by === "Fire Spin")).toBe(true);
    expect(t2.state.teams[1].active).toBe(0);
  });

  it("lets go when the timer runs out", () => {
    const { a, b } = duel({ aMon: { types: ["water"] }, aMoves: [fireSpin()], bMoves: [swordsDance()] });
    b.stats.hp = 400; b.maxHP = 400; b.hp = 400;
    let s = createBattle([a], [b]);
    for (let i = 0; i < 5; i++) s = playTurn(s, [attack, attack], scriptRng()).state;
    expect(s.teams[1].battlers[0].vol.trap).toBeNull();
    expect(switchBlockedBy(s, 1)).toBeNull();
  });

  it("Mean Look holds on with no timer and no damage", () => {
    const meanLook = statusMove({ slug: "mean-look", name: "Mean Look" });
    const { state } = duel({ aMoves: [meanLook], bMoves: [swordsDance()] });
    const { state: s2, events } = playTurn(state, [attack, attack], scriptRng());
    expect(s2.teams[1].battlers[0].vol.trap).toEqual({ turns: null, by: "Mean Look" });
    expect(events.some((e) => e.type === "chip")).toBe(false);
  });
});

describe("Leech Seed", () => {
  const leechSeed = () => statusMove(
    { slug: "leech-seed", name: "Leech Seed", type: "grass", accuracy: 90 },
    { category: "ailment", ailment: "leech-seed" }
  );

  it("saps 21 a turn and hands it to whoever planted it", () => {
    // floor(175/8) = 21. Beta's own hit takes Alpha to 175-55 = 120 first.
    const { state } = duel({ aMoves: [leechSeed()] });
    const { state: s2, events } = playTurn(state, [attack, attack], scriptRng());
    expect(events.some((e) => e.type === "seeded")).toBe(true);
    const sap = events.find((e) => e.type === "chip" && e.cause === "Leech Seed");
    expect(sap.amount).toBe(21);
    expect(s2.teams[1].battlers[0].hp).toBe(175 - 21);
    expect(s2.teams[0].battlers[0].hp).toBe(175 - 55 + 21);
  });

  it("cannot seed a Grass type", () => {
    const { state } = duel({ aMoves: [leechSeed()], bMon: { types: ["grass"] }, bMoves: [swordsDance()] });
    const { state: s2, events } = playTurn(state, [attack, attack], scriptRng());
    expect(events.some((e) => e.type === "immune")).toBe(true);
    expect(s2.teams[1].battlers[0].vol.seeded).toBe(false);
  });

  it("switching out shakes the seed off", () => {
    // Alpha's second move matters: seeding again on turn 2 would just plant
    // the replacement and prove nothing.
    const a = createBattler(mon({ name: "Alpha", stats: { hp: 100, atk: 100, def: 100, spa: 100, spd: 100, spe: 110 } }), { moves: [leechSeed(), swordsDance()] });
    const b = createBattler(mon({ id: 2, name: "Beta" }), { moves: [swordsDance()] });
    const b2 = createBattler(mon({ id: 3, name: "Gamma" }), { moves: [swordsDance()] });
    const state = createBattle([a], [b, b2]);
    const t1 = playTurn(state, [attack, attack], scriptRng());
    const t2 = playTurn(t1.state, [{ type: "move", moveIndex: 1 }, { type: "switch", to: 1 }], scriptRng());
    expect(t2.state.teams[1].battlers[1].vol.seeded).toBe(false);
    expect(t2.events.some((e) => e.type === "chip" && e.cause === "Leech Seed")).toBe(false);
  });
});

describe("delayed moves", () => {
  it("Wish heals 87 at the end of the turn after it is made", () => {
    // floor(175/2) = 87.
    const wish = statusMove({ slug: "wish", name: "Wish", target: "user" });
    const { a, b } = duel({ aMoves: [wish], bMoves: [swordsDance()] });
    a.hp = 50;
    const state = createBattle([a], [b]);
    const t1 = playTurn(state, [attack, attack], scriptRng());
    expect(t1.state.teams[0].battlers[0].hp).toBe(50);       // nothing yet
    const t2 = playTurn(t1.state, [attack, attack], scriptRng());
    expect(t2.events.some((e) => e.type === "heal" && e.via === "Wish")).toBe(true);
    expect(t2.state.teams[0].battlers[0].hp).toBe(137);
  });

  it("Future Sight lands 54 two turns later", () => {
    // 120 power special, spa 120 vs spd 120, no STAB (water user) → 54.
    const futureSight = withMeta(
      { slug: "future-sight", name: "Future Sight", type: "psychic", power: 120, category: "special", pp: 10 },
      { category: "unique" }
    );
    const { state } = duel({
      aMon: { types: ["water"] }, aMoves: [futureSight], bMoves: [swordsDance()],
    });
    const t1 = playTurn(state, [attack, attack], scriptRng());
    expect(t1.events.some((e) => e.type === "futureSet")).toBe(true);
    expect(t1.events.some((e) => e.type === "damage")).toBe(false);

    const t2 = playTurn(t1.state, [attack, attack], scriptRng());
    expect(t2.events.some((e) => e.type === "futureHit")).toBe(false);

    const t3 = playTurn(t2.state, [attack, attack], scriptRng());
    const hit = t3.events.find((e) => e.type === "futureHit");
    expect(hit.amount).toBe(54);
    expect(t3.state.teams[1].battlers[0].hp).toBe(175 - 54);
  });

  it("Perish Song counts everyone down and takes them both", () => {
    const perishSong = statusMove(
      { slug: "perish-song", name: "Perish Song", target: "all-pokemon", pp: 5 },
      { category: "ailment", ailment: "perish-song" }
    );
    const { state } = duel({ aMoves: [perishSong], bMoves: [swordsDance()] });
    let s = state;
    const counts = [];
    for (let i = 0; i < 4; i++) {
      const r = playTurn(s, [attack, attack], scriptRng());
      counts.push(r.events.filter((e) => e.type === "perishCount" && e.side === 0).map((e) => e.count)[0]);
      s = r.state;
    }
    expect(counts).toEqual([3, 2, 1, 0]);
    expect(s.teams[0].battlers[0].hp).toBe(0);
    expect(s.teams[1].battlers[0].hp).toBe(0);
    // A double wipe still names one winner, and the event agrees with it.
    expect(s.winner).toBe(1);
  });

  it("Yawn puts the target under at the end of the next turn", () => {
    const yawn = statusMove(
      { slug: "yawn", name: "Yawn" },
      { category: "ailment", ailment: "yawn" }
    );
    const { state } = duel({ aMoves: [yawn], bMoves: [swordsDance()] });
    const t1 = playTurn(state, [attack, attack], scriptRng());
    expect(t1.state.teams[1].battlers[0].vol.drowsy).toBe(1);
    expect(t1.state.teams[1].battlers[0].status).toBeNull();
    const t2 = playTurn(t1.state, [attack, attack], scriptRng());
    expect(t2.state.teams[1].battlers[0].status).toBe("sleep");
  });
});

describe("Taunt, Encore and Disable", () => {
  it("Taunt takes status moves off the table for three turns", () => {
    const taunt = statusMove({ slug: "taunt", name: "Taunt", type: "dark", accuracy: 100 });
    const { state } = duel({ aMoves: [taunt], bMoves: [swordsDance()] });
    const t1 = playTurn(state, [attack, attack], scriptRng());
    expect(t1.events.some((e) => e.type === "taunted")).toBe(true);
    // Beta's Swords Dance was blocked on the very same turn.
    expect(t1.events.some((e) => e.type === "blockedMove" && e.by === "Taunt")).toBe(true);
    expect(t1.state.teams[1].battlers[0].stages.atk).toBe(0);
  });

  it("Encore forces the last move again", () => {
    const encore = statusMove({ slug: "encore", name: "Encore", accuracy: 100 });
    const { state } = duel({
      aMoves: [swordsDance(), encore], bMoves: [swordsDance(), move()],
    });
    const t1 = playTurn(state, [attack, attack], scriptRng());
    expect(t1.state.teams[1].battlers[0].stages.atk).toBe(2);

    // Alpha encores; Beta asks to attack but dances again instead.
    const t2 = playTurn(t1.state, [{ type: "move", moveIndex: 1 }, { type: "move", moveIndex: 1 }], scriptRng());
    expect(t2.events.some((e) => e.type === "encored")).toBe(true);
    expect(t2.state.teams[1].battlers[0].stages.atk).toBe(4);
    expect(t2.events.some((e) => e.type === "damage")).toBe(false);
  });

  it("Disable takes one move away and leaves the rest", () => {
    const disable = statusMove(
      { slug: "disable", name: "Disable", accuracy: 100 },
      { category: "unique", ailment: "disable" }
    );
    const { state } = duel({
      aMoves: [swordsDance(), disable], bMoves: [move(), swordsDance()],
    });
    const t1 = playTurn(state, [attack, attack], scriptRng());
    const t2 = playTurn(t1.state, [{ type: "move", moveIndex: 1 }, attack], scriptRng());
    expect(t2.events.some((e) => e.type === "disabled")).toBe(true);
    expect(t2.events.some((e) => e.type === "blockedMove" && e.by === "Disable")).toBe(true);

    // The other move still works.
    const t3 = playTurn(t2.state, [{ type: "move", moveIndex: 0 }, { type: "move", moveIndex: 1 }], scriptRng());
    expect(t3.state.teams[1].battlers[0].stages.atk).toBe(2);
  });
});

describe("screens, Tailwind and Trick Room", () => {
  const reflect = () => statusMove(
    { slug: "reflect", name: "Reflect", type: "psychic", target: "users-field", pp: 20 },
    { category: "field-effect" }
  );

  it("Reflect halves a physical hit: 37 becomes 18", () => {
    // floor(37 * 0.5) = 18, applied last in the modifier chain.
    const { state } = duel({ aMon: { types: ["water"] }, bMoves: [reflect()] });
    const t1 = playTurn(state, [attack, attack], scriptRng());
    expect(t1.events.find((e) => e.type === "damage").amount).toBe(37); // set up after Alpha hit
    const t2 = playTurn(t1.state, [attack, attack], scriptRng());
    expect(t2.events.find((e) => e.type === "damage").amount).toBe(18);
  });

  it("Light Screen leaves physical hits alone", () => {
    const lightScreen = statusMove(
      { slug: "light-screen", name: "Light Screen", type: "psychic", target: "users-field", pp: 30 },
      { category: "field-effect" }
    );
    const { state } = duel({ aMon: { types: ["water"] }, bMoves: [lightScreen] });
    const t1 = playTurn(state, [attack, attack], scriptRng());
    const t2 = playTurn(t1.state, [attack, attack], scriptRng());
    expect(t2.events.find((e) => e.type === "damage").amount).toBe(37);
  });

  it("a critical hit goes straight through Reflect: 55", () => {
    // Crit before the roll: floor(37*1.5) = 55, and the screen is ignored.
    const { state } = duel({ aMon: { types: ["water"] }, bMoves: [reflect()] });
    const t1 = playTurn(state, [attack, attack], scriptRng());
    const t2 = playTurn(t1.state, [attack, attack], scriptRng({ chance: [true, true] }));
    const hit = t2.events.find((e) => e.type === "damage" && e.name === "Beta");
    expect(hit.crit).toBe(true);
    expect(hit.amount).toBe(55);
  });

  it("Reflect wears off after five turns", () => {
    const { state } = duel({ aMon: { types: ["water"] }, aMoves: [swordsDance()], bMoves: [reflect()] });
    let s = state;
    for (let i = 0; i < 5; i++) s = playTurn(s, [attack, attack], scriptRng()).state;
    expect(s.teams[1].screens.reflect).toBe(0);
  });

  it("Aurora Veil refuses to go up without snow", () => {
    const auroraVeil = statusMove(
      { slug: "aurora-veil", name: "Aurora Veil", type: "ice", target: "users-field", pp: 20 },
      { category: "field-effect" }
    );
    const { state } = duel({ aMoves: [auroraVeil], bMoves: [swordsDance()] });
    const { state: s2, events } = playTurn(state, [attack, attack], scriptRng());
    expect(events.some((e) => e.type === "moveFailed")).toBe(true);
    expect(s2.teams[0].screens.auroraVeil).toBe(0);
  });

  it("Tailwind doubles Speed and flips who goes first", () => {
    const tailwind = statusMove(
      { slug: "tailwind", name: "Tailwind", type: "flying", target: "users-field", pp: 15 },
      { category: "field-effect" }
    );
    const { state } = duel({ aMoves: [swordsDance()], bMoves: [tailwind, move()] });
    const t1 = playTurn(state, [attack, attack], scriptRng());
    // Beta: 120 → 240, comfortably past Alpha's 130.
    expect(effectiveSpeed(t1.state.teams[1].battlers[0], t1.state.teams[1])).toBe(240);
    const t2 = playTurn(t1.state, [attack, { type: "move", moveIndex: 1 }], scriptRng());
    const movers = t2.events.filter((e) => e.type === "move").map((e) => e.side);
    expect(movers[0]).toBe(1);
  });

  it("Trick Room lets the slower Pokémon move first", () => {
    const { a, b } = duel({ aMoves: [swordsDance()], bMoves: [swordsDance()] });
    const state = createBattle([a], [b]);
    state.trickRoom = 5;
    const { events } = playTurn(state, [attack, attack], scriptRng());
    const movers = events.filter((e) => e.type === "move").map((e) => e.side);
    expect(movers).toEqual([1, 0]);
  });

  it("using Trick Room again tears it down", () => {
    const trickRoom = statusMove(
      { slug: "trick-room", name: "Trick Room", type: "psychic", target: "entire-field", priority: -7, pp: 5 },
      { category: "whole-field-effect" }
    );
    const { state } = duel({ aMoves: [trickRoom], bMoves: [swordsDance()] });
    const t1 = playTurn(state, [attack, attack], scriptRng());
    expect(t1.state.trickRoom).toBe(4); // set to 5, ticked once
    const t2 = playTurn(t1.state, [attack, attack], scriptRng());
    expect(t2.state.trickRoom).toBe(0);
    expect(t2.events.some((e) => e.type === "trickRoomEnd")).toBe(true);
  });
});

describe("Protect and Substitute", () => {
  // Protect targets the user, which is why it still works while the other
  // side is off hiding somewhere.
  const protect = () => statusMove({ slug: "protect", name: "Protect", target: "user", priority: 4, pp: 10 });

  it("Protect blocks the whole attack", () => {
    const { state } = duel({ aMoves: [protect()] });
    const { state: s2, events } = playTurn(state, [attack, attack], scriptRng());
    expect(events.some((e) => e.type === "protected")).toBe(true);
    expect(s2.teams[0].battlers[0].hp).toBe(175);
  });

  it("a second Protect in a row usually fails", () => {
    const { state } = duel({ aMoves: [protect()] });
    const t1 = playTurn(state, [attack, attack], scriptRng());
    // The streak roll is 1/3; the default rng says no.
    const t2 = playTurn(t1.state, [attack, attack], scriptRng());
    expect(t2.events.some((e) => e.type === "moveFailed")).toBe(true);
    expect(t2.state.teams[0].battlers[0].hp).toBe(175 - 55);
  });

  it("Shadow Force goes straight through Protect", () => {
    const shadowForce = withMeta({
      slug: "shadow-force", name: "Shadow Force", type: "ghost", power: 120, pp: 5,
    });
    // Beta is Psychic so Ghost is super effective: 120 power, no STAB,
    //   floor(floor(22*120*120/120)/50)+2 = 54, then floor(54*2) = 108.
    const { state } = duel({
      aMon: { types: ["water"] }, aMoves: [shadowForce],
      bMon: { types: ["psychic"] }, bMoves: [protect()],
    });
    const t1 = playTurn(state, [attack, attack], scriptRng());
    expect(t1.state.teams[0].battlers[0].vol.charge.invuln).toBe("vanished");

    // Beta protects (its streak roll), Alpha hits (accuracy), no crit — in
    // that order, because Protect moves first at priority 4.
    const t2 = playTurn(t1.state, [attack, attack], scriptRng({ chance: [true, true, false] }));
    expect(t2.events.some((e) => e.type === "protecting")).toBe(true);
    expect(t2.events.some((e) => e.type === "protected")).toBe(false);
    expect(t2.events.find((e) => e.type === "damage" && e.name === "Beta").amount).toBe(108);
  });

  it("Substitute costs 43 HP and soaks the next hit", () => {
    // floor(175/4) = 43. A no-STAB 80-power hit is 37, so the doll survives.
    const substitute = statusMove({ slug: "substitute", name: "Substitute", target: "user", pp: 10 });
    const { state } = duel({ aMoves: [substitute], bMon: { types: ["water"] } });
    const { state: s2, events } = playTurn(state, [attack, attack], scriptRng());
    expect(events.find((e) => e.type === "subMade").hp).toBe(43);
    const hit = events.find((e) => e.type === "damage");
    expect(hit.toSub).toBe(true);
    expect(hit.amount).toBe(37);
    expect(s2.teams[0].battlers[0].hp).toBe(175 - 43);   // the doll took it
    expect(s2.teams[0].battlers[0].vol.sub).toBe(6);
  });

  it("the doll breaks and stops absorbing", () => {
    const substitute = statusMove({ slug: "substitute", name: "Substitute", target: "user", pp: 10 });
    const { state } = duel({ aMoves: [substitute, swordsDance()], bMon: { types: ["water"] } });
    const t1 = playTurn(state, [attack, attack], scriptRng());
    const t2 = playTurn(t1.state, [{ type: "move", moveIndex: 1 }, attack], scriptRng());
    expect(t2.events.some((e) => e.type === "subBroke")).toBe(true);
    const t3 = playTurn(t2.state, [{ type: "move", moveIndex: 1 }, attack], scriptRng());
    expect(t3.state.teams[0].battlers[0].hp).toBe(175 - 43 - 37);
  });

  it("a Substitute blocks status from the other side", () => {
    const substitute = statusMove({ slug: "substitute", name: "Substitute", target: "user", pp: 10 });
    const twave = statusMove(
      { slug: "thunder-wave", name: "Thunder Wave", type: "electric", accuracy: 90 },
      { category: "ailment", ailment: "paralysis" }
    );
    const { state } = duel({ aMoves: [substitute], bMoves: [twave] });
    const { state: s2, events } = playTurn(state, [attack, attack], scriptRng());
    expect(events.some((e) => e.type === "subBlocked")).toBe(true);
    expect(s2.teams[0].battlers[0].status).toBeNull();
  });
});

describe("first-turn and focus moves", () => {
  it("Fake Out flinches on the way in and fails ever after", () => {
    const fakeOut = withMeta(
      { slug: "fake-out", name: "Fake Out", power: 40, priority: 3 },
      { flinchChance: 100 }
    );
    const { state } = duel({ aMon: { types: ["water"] }, aMoves: [fakeOut] });
    const t1 = playTurn(state, [attack, attack], scriptRng());
    expect(t1.events.find((e) => e.type === "damage").amount).toBe(19);
    expect(t1.events.some((e) => e.type === "flinch")).toBe(true);

    const t2 = playTurn(t1.state, [attack, attack], scriptRng());
    expect(t2.events.some((e) => e.type === "moveFailed")).toBe(true);
    expect(t2.events.some((e) => e.type === "damage" && e.name === "Beta")).toBe(false);
  });

  it("Focus Punch breaks if the user is hit first", () => {
    // Priority -3 means Beta always lands first.
    const focusPunch = withMeta({ slug: "focus-punch", name: "Focus Punch", power: 150, priority: -3 });
    const { state } = duel({ aMon: { types: ["water"] }, aMoves: [focusPunch] });
    const { events } = playTurn(state, [attack, attack], scriptRng());
    expect(events.some((e) => e.type === "focusBroken")).toBe(true);
    expect(events.some((e) => e.type === "damage" && e.name === "Beta")).toBe(false);
  });

  it("Focus Punch lands for 68 if nothing touches the user", () => {
    // 150 power physical, no STAB: floor(floor(22*150*120/120)/50)+2 = 68.
    const focusPunch = withMeta({ slug: "focus-punch", name: "Focus Punch", power: 150, priority: -3 });
    const { state } = duel({ aMon: { types: ["water"] }, aMoves: [focusPunch], bMoves: [swordsDance()] });
    const { events } = playTurn(state, [attack, attack], scriptRng());
    expect(events.find((e) => e.type === "damage").amount).toBe(68);
  });
});

describe("Roost", () => {
  it("gives up the Flying type for the turn, so Ground lands", () => {
    // 100 power ground, no STAB (Beta is flying/normal here), neutral once the
    // Flying half is gone: floor(floor(22*100*120/120)/50)+2 = 46.
    const roost = withMeta(
      { slug: "roost", name: "Roost", power: null, accuracy: null, category: "status", target: "user", pp: 10 },
      { category: "heal", healing: 50 }
    );
    const quake = withMeta({ slug: "earthquake", name: "Earthquake", type: "ground", power: 100, priority: -1 });
    const { a, b } = duel({
      aMon: { types: ["water"] }, aMoves: [quake],
      bMon: { types: ["flying"] }, bMoves: [roost],
    });
    b.hp = 100;
    const state = createBattle([a], [b]);
    const { events } = playTurn(state, [attack, attack], scriptRng());
    // Beta roosts first (Alpha's Earthquake is priority -1), then gets hit.
    expect(events.some((e) => e.type === "roosted")).toBe(true);
    const hit = events.find((e) => e.type === "damage" && e.name === "Beta");
    expect(hit.amount).toBe(46);
  });
});

describe("stat changes land on the right Pokémon", () => {
  const raiseSelf = (slug, name, changes, over = {}) => withMeta(
    { slug, name, effectChance: 100, statChanges: changes, ...over },
    { category: "damage-raise" }
  );

  it("Draco Meteor drops the USER's Sp. Atk by two", () => {
    const draco = raiseSelf("draco-meteor", "Draco Meteor", [{ stat: "spa", change: -2 }], {
      type: "dragon", power: 130, category: "special", accuracy: 90, pp: 5,
    });
    const { state } = duel({ aMon: { types: ["water"] }, aMoves: [draco], bMoves: [swordsDance()] });
    const { state: s2 } = playTurn(state, [attack, attack], scriptRng());
    expect(s2.teams[0].battlers[0].stages.spa).toBe(-2);
    expect(s2.teams[1].battlers[0].stages.spa).toBe(0);
  });

  it("Draco Meteor still drops the user when it knocks the target out", () => {
    const draco = raiseSelf("draco-meteor", "Draco Meteor", [{ stat: "spa", change: -2 }], {
      type: "dragon", power: 130, category: "special", accuracy: 90, pp: 5,
    });
    const { a, b } = duel({ aMon: { types: ["water"] }, aMoves: [draco], bMoves: [swordsDance()] });
    b.hp = 5;
    const state = createBattle([a], [b]);
    const { state: s2, events } = playTurn(state, [attack, attack], scriptRng());
    expect(events.some((e) => e.type === "faint")).toBe(true);
    expect(s2.teams[0].battlers[0].stages.spa).toBe(-2);
  });

  it("Power-Up Punch raises the USER's Attack, not the target's", () => {
    const pup = raiseSelf("power-up-punch", "Power-Up Punch", [{ stat: "atk", change: 1 }], {
      type: "fighting", power: 40,
    });
    // Beta plainly attacks — a Swords Dance of its own would muddy the check.
    const { state } = duel({ aMon: { types: ["water"] }, aMoves: [pup] });
    const { state: s2 } = playTurn(state, [attack, attack], scriptRng());
    expect(s2.teams[0].battlers[0].stages.atk).toBe(1);
    expect(s2.teams[1].battlers[0].stages.atk).toBe(0);
  });

  it("Snarl drops the TARGET's Sp. Atk", () => {
    const snarl = withMeta(
      {
        slug: "snarl", name: "Snarl", type: "dark", power: 55, category: "special",
        accuracy: 95, effectChance: 100, statChanges: [{ stat: "spa", change: -1 }],
      },
      { category: "damage-lower" }
    );
    const { state } = duel({ aMon: { types: ["water"] }, aMoves: [snarl], bMoves: [swordsDance()] });
    const { state: s2 } = playTurn(state, [attack, attack], scriptRng());
    expect(s2.teams[1].battlers[0].stages.spa).toBe(-1);
    expect(s2.teams[0].battlers[0].stages.spa).toBe(0);
  });

  it("Eerie Impulse drops the target's Sp. Atk sharply", () => {
    const eerie = statusMove(
      { slug: "eerie-impulse", name: "Eerie Impulse", type: "electric", accuracy: 100, statChanges: [{ stat: "spa", change: -2 }] },
      { category: "net-good-stats" }
    );
    const { state } = duel({ aMoves: [eerie], bMoves: [swordsDance()] });
    const { state: s2 } = playTurn(state, [attack, attack], scriptRng());
    expect(s2.teams[1].battlers[0].stages.spa).toBe(-2);
  });

  it("Make It Rain drops its own Sp. Atk even with no meta block at all", () => {
    const makeItRain = move({
      slug: "make-it-rain", name: "Make It Rain", type: "steel", power: 120,
      category: "special", target: "all-opponents", meta: null,
      statChanges: [{ stat: "spa", change: -1 }],
    });
    const { state } = duel({ aMon: { types: ["water"] }, aMoves: [makeItRain], bMoves: [swordsDance()] });
    const { state: s2 } = playTurn(state, [attack, attack], scriptRng());
    expect(s2.teams[0].battlers[0].stages.spa).toBe(-1);
    expect(s2.teams[1].battlers[0].stages.spa).toBe(0);
  });
});

describe("status moves and type immunity", () => {
  it("a Normal-type status move still works on a Ghost", () => {
    // Yawn is Normal-type; the type chart says Normal can't touch Ghost, but
    // that rule is for attacks, not for status moves.
    const yawn = statusMove({ slug: "yawn", name: "Yawn" }, { category: "ailment", ailment: "yawn" });
    const { state } = duel({ aMoves: [yawn], bMon: { types: ["ghost"] }, bMoves: [swordsDance()] });
    const { state: s2, events } = playTurn(state, [attack, attack], scriptRng());
    expect(events.some((e) => e.type === "immune")).toBe(false);
    expect(s2.teams[1].battlers[0].vol.drowsy).toBe(1);
  });

  it("Confuse Ray still works on a Normal type", () => {
    const confuseRay = statusMove(
      { slug: "confuse-ray", name: "Confuse Ray", type: "ghost", accuracy: 100 },
      { category: "ailment", ailment: "confusion" }
    );
    const { state } = duel({ aMoves: [confuseRay], bMoves: [swordsDance()] });
    const { state: s2 } = playTurn(state, [attack, attack], scriptRng());
    // Set to 2 + int(4) = 4, and already spent one on Beta's own move this
    // turn — being confused before you act counts against you straight away.
    expect(s2.teams[1].battlers[0].vol.confusion).toBe(3);
  });
});

describe("switch-out moves", () => {
  it("U-turn hands the turn back so the user can leave", () => {
    const uTurn = withMeta({ slug: "u-turn", name: "U-turn", type: "bug", power: 70 });
    const a = createBattler(mon({ name: "Alpha", types: ["water"], stats: { hp: 100, atk: 100, def: 100, spa: 100, spd: 100, spe: 110 } }), { moves: [uTurn] });
    const a2 = createBattler(mon({ id: 4, name: "Delta" }), { moves: [move()] });
    const b = createBattler(mon({ id: 2, name: "Beta" }), { moves: [swordsDance()] });
    const state = createBattle([a, a2], [b]);
    const { state: s2, events } = playTurn(state, [attack, attack], scriptRng());
    expect(events.some((e) => e.type === "switchOut")).toBe(true);
    expect(s2.pendingReplacement[0]).toBe(true);

    const r = replaceFainted(s2, 0, 1);
    expect(r.ok).toBe(true);
    expect(r.state.teams[0].active).toBe(1);
  });

  it("with an empty bench it just attacks", () => {
    const uTurn = withMeta({ slug: "u-turn", name: "U-turn", type: "bug", power: 70 });
    const { state } = duel({ aMon: { types: ["water"] }, aMoves: [uTurn], bMoves: [swordsDance()] });
    const { state: s2, events } = playTurn(state, [attack, attack], scriptRng());
    expect(events.some((e) => e.type === "switchOut")).toBe(false);
    expect(s2.pendingReplacement[0]).toBe(false);
  });
});

describe("the AI reads the new rules", () => {
  it("won't pick a Fake Out it can no longer use", () => {
    const fakeOut = withMeta(
      { slug: "fake-out", name: "Fake Out", power: 40, priority: 3 },
      { flinchChance: 100 }
    );
    const { a, b } = duel({ aMoves: [fakeOut, move()], bMoves: [swordsDance()] });
    a.vol.turnsActive = 3;
    const state = createBattle([a], [b]);
    expect(chooseAiAction(state, 0, scriptRng()).moveIndex).toBe(1);
  });

  it("won't pick a disabled move", () => {
    const { a, b } = duel({ aMoves: [move({ power: 120 }), move({ power: 40 })], bMoves: [swordsDance()] });
    a.vol.disable = { moveIndex: 0, turns: 4 };
    const state = createBattle([a], [b]);
    expect(chooseAiAction(state, 0, scriptRng()).moveIndex).toBe(1);
  });

  it("won't pick a status move while taunted", () => {
    const { a, b } = duel({ aMoves: [swordsDance(), move()], bMoves: [swordsDance()] });
    a.vol.taunt = 3;
    const state = createBattle([a], [b]);
    expect(chooseAiAction(state, 0, scriptRng()).moveIndex).toBe(1);
  });
});
