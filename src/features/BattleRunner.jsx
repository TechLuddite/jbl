import React, { useState, useEffect, useRef } from "react";
import { POKEDEX, legalMoves } from "../data/index.js";
import {
  createBattler, createBattle, playTurn, replaceFainted, openBattle,
  makeRng, chooseAiAction, switchBlockedBy, ITEMS, ABILITIES,
} from "../lib/sim.js";
import { TypeChip } from "../components.jsx";

/**
 * The turn-by-turn battle screen, shared by the Battle tab and the league.
 * Callers hand over two teams of slots and say which sides the sim plays;
 * this component owns the battle state, the log, and the working-out.
 */

const MAX_TURNS = 500; // auto-play safety stop

/** A sensible default loadout: the four hardest-hitting legal moves, STAB first. */
export function defaultMoveNames(pokemon) {
  const legal = legalMoves(pokemon).filter((m) => m.power != null && m.category !== "status");
  const score = (m) => m.power * (pokemon.types.includes(m.type) ? 1.5 : 1);
  return [...legal].sort((x, y) => score(y) - score(x)).slice(0, 4).map((m) => m.name);
}

export function newSlot(pokemonId) {
  const p = POKEDEX.find((x) => x.id === pokemonId) ?? POKEDEX[0];
  // With the full dex baked, default to the Pokémon's real first ability.
  const ability = p.abilities?.[0]?.slug ?? "";
  return { pokemonId: p.id, level: 50, moveNames: defaultMoveNames(p), item: "", ability };
}

/** Ability choices for a slot: the dex entry's real ones, or the whole
 *  curated list on the sample set (u-pick spirit). */
export function abilityOptions(p) {
  if (p.abilities?.length) {
    return p.abilities.map((a) => ({
      slug: a.slug,
      label: (ABILITIES[a.slug]?.name ?? titleish(a.slug)) +
        (a.hidden ? " (hidden)" : "") +
        (ABILITIES[a.slug] ? "" : " · not in sim yet"),
    }));
  }
  return Object.entries(ABILITIES).map(([slug, a]) => ({ slug, label: a.name }));
}

export const titleish = (slug) => slug.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");

export const dexOf = (slot) => POKEDEX.find((p) => p.id === slot.pokemonId) ?? POKEDEX[0];

export function buildTeam(slots) {
  return slots.map((slot) => {
    const p = dexOf(slot);
    const legal = legalMoves(p);
    const moves = [...new Set(slot.moveNames)]
      .map((n) => legal.find((m) => m.name === n))
      .filter(Boolean)
      .slice(0, 4);
    return createBattler(p, {
      level: slot.level, moves,
      item: slot.item || null,
      ability: slot.ability || null,
    });
  });
}

/**
 * Who comes in next for a side that owes a replacement. It must not be the
 * Pokémon already standing there — a U-turn leaves the user alive and asking
 * to be swapped, so "first one with HP" would pick it right back.
 */
function nextInLine(state, side) {
  const team = state.teams[side];
  return team.battlers.findIndex((b, i) => b.hp > 0 && i !== team.active);
}

/** Play a battle to the end with the sim picking every move for both sides. */
export function playOutAuto(state, rng) {
  let s = state;
  const blocks = [];
  let guard = 0;
  while (s.winner == null && guard++ < MAX_TURNS) {
    const entryEvents = [];
    if (s.pendingReplacement.some(Boolean)) {
      for (const side of [0, 1]) {
        if (s.pendingReplacement[side]) {
          const next = nextInLine(s, side);
          if (next >= 0) {
            const r = replaceFainted(s, side, next);
            s = r.state;
            entryEvents.push({ type: "sendIn", side, name: s.teams[side].battlers[next].pokemon.name }, ...r.events);
          }
        }
      }
    }
    const actions = [0, 1].map((side) => chooseAiAction(s, side, rng));
    const r = playTurn(s, actions, rng);
    blocks.push({ turn: s.turn, events: [...entryEvents, ...r.events] });
    s = r.state;
  }
  return { state: s, blocks };
}

/** Winning side of a battle the sim plays with no UI at all. If the safety
 *  stop trips first (endless stall), whoever kept more of their HP takes it. */
export function simBattleWinner(slotsA, slotsB, seed) {
  const rng = makeRng(seed >>> 0);
  const opened = openBattle(createBattle(buildTeam(slotsA), buildTeam(slotsB)));
  const { state } = playOutAuto(opened.state, rng);
  if (state.winner != null) return state.winner;
  const hpShare = (side) => state.teams[side].battlers.reduce((sum, b) => sum + b.hp / b.maxHP, 0);
  return hpShare(0) >= hpShare(1) ? 0 : 1;
}

export default function BattleRunner({
  slots, auto, sideNames,
  instant = false,          // sim the whole battle immediately on mount
  onWinner,                 // called once when the battle is decided
  onExit, exitLabel = "Back",
  overContent,              // render prop for extra post-battle UI
}) {
  const rngRef = useRef(null);
  const reportedRef = useRef(false);
  const [battle, setBattle] = useState(null);
  const [log, setLog] = useState([]);
  const [chosen, setChosen] = useState([{ type: "move", moveIndex: 0 }, { type: "move", moveIndex: 0 }]);

  function start() {
    const rng = makeRng(Date.now() >>> 0);
    rngRef.current = rng;
    reportedRef.current = false;
    const opened = openBattle(createBattle(buildTeam(slots[0]), buildTeam(slots[1])));
    let s = opened.state;
    let blocks = opened.events.length ? [{ turn: 0, events: opened.events }] : [];
    if (instant) {
      const r = playOutAuto(s, rng);
      s = r.state;
      blocks = [...r.blocks.reverse(), ...blocks];
    }
    setBattle(s);
    setLog(blocks);
    setChosen([{ type: "move", moveIndex: 0 }, { type: "move", moveIndex: 0 }]);
  }

  useEffect(() => { start(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (battle?.winner != null && !reportedRef.current) {
      reportedRef.current = true;
      onWinner?.(battle.winner);
    }
  }, [battle]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeOf = (state, side) => state.teams[side].battlers[state.teams[side].active];

  function firstUsableMove(battler) {
    const i = battler.moves.findIndex((s, idx) =>
      s.pp > 0 &&
      battler.vol.disable?.moveIndex !== idx &&
      !(battler.vol.taunt > 0 && s.move.category === "status")
    );
    return { type: "move", moveIndex: Math.max(0, i) };
  }

  /** Auto-fill replacements for sides the sim controls (first healthy pick). */
  function settleAiReplacements(state, events) {
    let s = state;
    for (const side of [0, 1]) {
      if (s.pendingReplacement[side] && auto[side]) {
        const next = nextInLine(s, side);
        if (next >= 0) {
          const r = replaceFainted(s, side, next);
          s = r.state;
          events.push({ type: "sendIn", side, name: s.teams[side].battlers[next].pokemon.name }, ...r.events);
        }
      }
    }
    return s;
  }

  function onPlayTurn() {
    const actions = [0, 1].map((side) =>
      auto[side] ? chooseAiAction(battle, side, rngRef.current) : chosen[side]
    );
    const r = playTurn(battle, actions, rngRef.current);
    const events = [...r.events];
    const next = settleAiReplacements(r.state, events);
    setLog((prev) => [{ turn: battle.turn, events }, ...prev]);
    setBattle(next);
    setChosen([firstUsableMove(activeOf(next, 0)), firstUsableMove(activeOf(next, 1))]);
  }

  function onAutoPlayRest() {
    const r = playOutAuto(battle, rngRef.current);
    setLog((prev) => [...r.blocks.reverse(), ...prev]);
    setBattle(r.state);
  }

  function onReplace(side, index) {
    const r = replaceFainted(battle, side, index);
    if (r.ok) {
      setBattle(r.state);
      const name = r.state.teams[side].battlers[index].pokemon.name;
      setLog((prev) => [{ turn: `${battle.turn}·in`, events: [{ type: "sendIn", side, name }, ...r.events] }, ...prev]);
      setChosen((prev) => prev.map((c, s) => (s === side ? { type: "move", moveIndex: 0 } : c)));
    }
  }

  if (!battle) return null;

  const state = battle;
  const over = state.winner != null;
  const weatherLabel = { rain: "Rain", sun: "Harsh sunlight", sand: "Sandstorm", snow: "Snow" }[state.weather.kind];

  return (
    <div>
      {weatherLabel && (
        <div className="mono" style={{ fontSize: 11, marginBottom: 8, color: "var(--ink-soft)" }}>
          ☁ {weatherLabel} · {state.weather.turns} more turn{state.weather.turns === 1 ? "" : "s"}
        </div>
      )}
      {state.trickRoom > 0 && (
        <div className="mono" style={{ fontSize: 11, marginBottom: 8, color: "var(--amber)" }}>
          ⏳ Trick Room · slower Pokémon go first · {state.trickRoom} more turn{state.trickRoom === 1 ? "" : "s"}
        </div>
      )}
      <div className="duel">
        {[0, 1].map((side) => (
          <SidePanel
            key={side}
            state={state}
            side={side}
            sideNames={sideNames}
            isAuto={auto[side]}
            chosen={chosen[side]}
            onChoose={(action) => setChosen((prev) => prev.map((c, s) => (s === side ? action : c)))}
            onReplace={(i) => onReplace(side, i)}
            over={over}
          />
        ))}
      </div>

      {!over && (
        <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
          <button
            className="btn"
            disabled={state.pendingReplacement.some((p, s) => p && !auto[s])}
            onClick={onPlayTurn}
          >
            Play turn {state.turn}
          </button>
          {auto[0] && auto[1] && (
            <button className="btn ghost" onClick={onAutoPlayRest}>
              Play the whole battle
            </button>
          )}
          {onExit && (
            <button className="btn ghost" onClick={onExit}>{exitLabel}</button>
          )}
        </div>
      )}

      {over && (
        <div className="card" style={{ marginTop: 14 }}>
          <div className="mono" style={{ fontSize: 18, fontWeight: 600 }}>
            {sideNames[state.winner]} wins!
          </div>
          {overContent?.({ winner: state.winner, restart: start })}
        </div>
      )}

      <div className="eyebrow" style={{ marginTop: 18 }}>Battle log · newest first</div>
      {log.length === 0 && <div className="empty">Pick actions and play the first turn.</div>}
      {log.map((block, i) => (
        <div key={`${i}-${block.turn}`} className="step">
          <div className="step-label">{block.turn === 0 ? "Battle start" : `Turn ${block.turn}`}</div>
          {block.events.map((e, j) => <EventLine key={j} e={e} sideNames={sideNames} />)}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------- subcomponents --- */

function SidePanel({ state, side, sideNames, isAuto, chosen, onChoose, onReplace, over }) {
  const team = state.teams[side];
  const b = team.battlers[team.active];
  const pct = (b.hp / b.maxHP) * 100;
  const barColor = pct > 50 ? "#5FAE55" : pct > 20 ? "var(--amber)" : "#C4553B";
  const needsReplace = state.pendingReplacement[side];
  const moveName = (i) => b.moves[i]?.move.name ?? "that move";

  const stageText = Object.entries(b.stages)
    .filter(([, v]) => v !== 0)
    .map(([k, v]) => `${k.toUpperCase()} ${v > 0 ? "+" : ""}${v}`)
    .join(" · ");

  const hz = team.hazards;
  const hazardText = [
    hz.stealthRock && "rocks",
    hz.spikes > 0 && `spikes ×${hz.spikes}`,
    hz.toxicSpikes > 0 && `toxic spikes ×${hz.toxicSpikes}`,
    hz.stickyWeb && "sticky web",
  ].filter(Boolean).join(" · ");

  // Everything with a clock on it, so the player can see what is coming.
  const volText = [
    b.vol.confusion > 0 && "confused",
    b.vol.sub > 0 && `substitute ${b.vol.sub} HP`,
    b.vol.seeded && "seeded",
    b.vol.trap && `held by ${b.vol.trap.by}`,
    b.vol.perish != null && `perish count ${b.vol.perish}`,
    b.vol.drowsy > 0 && "drowsy",
    b.vol.taunt > 0 && `taunted (${b.vol.taunt})`,
    b.vol.encore && `encored into ${moveName(b.vol.encore.moveIndex)}`,
    b.vol.disable && `${moveName(b.vol.disable.moveIndex)} disabled (${b.vol.disable.turns})`,
    b.vol.charge && `charging ${moveName(b.vol.charge.moveIndex)}`,
    b.vol.recharge && "must recharge",
    b.vol.locked && `locked into ${moveName(b.vol.locked.moveIndex)}`,
  ].filter(Boolean).join(" · ");

  const fieldText = [
    team.screens.reflect > 0 && `reflect ${team.screens.reflect}`,
    team.screens.lightScreen > 0 && `light screen ${team.screens.lightScreen}`,
    team.screens.auroraVeil > 0 && `aurora veil ${team.screens.auroraVeil}`,
    team.tailwind > 0 && `tailwind ${team.tailwind}`,
    team.wish && "wish on the way",
    team.future && `${team.future.name} incoming`,
  ].filter(Boolean).join(" · ");

  const kitText = [
    b.item && ITEMS[b.item] ? ITEMS[b.item].name : null,
    b.ability && ABILITIES[b.ability] ? ABILITIES[b.ability].name : null,
  ].filter(Boolean).join(" · ");

  // A move the engine will refuse this turn shouldn't be offered.
  const moveBlocked = (i, slot) =>
    slot.pp <= 0 ||
    b.vol.disable?.moveIndex === i ||
    (b.vol.taunt > 0 && slot.move.category === "status");

  // When it has no say, say so rather than showing buttons that do nothing.
  const forcedNote =
    b.vol.recharge ? "It has to spend this turn recharging." :
    b.vol.charge ? `It is charging ${moveName(b.vol.charge.moveIndex)} and will let go this turn.` :
    b.vol.locked ? `It is locked into ${moveName(b.vol.locked.moveIndex)}.` :
    b.vol.encore ? `Encore is making it use ${moveName(b.vol.encore.moveIndex)}.` :
    null;

  const trappedBy = switchBlockedBy(state, side);

  return (
    <div className="card">
      <div className="eyebrow">{sideNames[side]}{isAuto ? " · sim plays" : ""}</div>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <img src={b.pokemon.sprite} alt="" width="64" height="64"
             style={{ imageRendering: "pixelated", opacity: b.hp > 0 ? 1 : 0.35 }} />
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <strong>{b.pokemon.name}</strong>
            <span className="mono" style={{ fontSize: 11, color: "var(--ink-soft)" }}>Lv{b.level}</span>
            {b.pokemon.types.map((t) => <TypeChip key={t} type={t} />)}
            {b.status && <span className="chip" style={{ background: "var(--ink)" }}>{b.status}</span>}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
            <div className="track"><div className="bar" style={{ width: `${Math.max(0, pct)}%`, background: barColor }} /></div>
            <span className="mono" style={{ fontSize: 12 }}>{b.hp}/{b.maxHP}</span>
          </div>
          {kitText && <div className="mono" style={{ fontSize: 10, color: "var(--ink-soft)", marginTop: 2 }}>{kitText}</div>}
          {stageText && <div className="mono" style={{ fontSize: 10, color: "var(--ink-soft)", marginTop: 2 }}>{stageText}</div>}
          {volText && <div className="mono" style={{ fontSize: 10, color: "var(--amber)", marginTop: 2 }}>{volText}</div>}
          {fieldText && <div className="mono" style={{ fontSize: 10, color: "var(--ink-soft)", marginTop: 2 }}>up: {fieldText}</div>}
          {hazardText && <div className="mono" style={{ fontSize: 10, color: "var(--amber)", marginTop: 2 }}>on this side: {hazardText}</div>}
        </div>
      </div>

      {!over && needsReplace && !isAuto && (
        <div style={{ marginTop: 10 }}>
          <div className="eyebrow">Send in the next Pokémon</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {team.battlers.map((x, i) => (
              x.hp > 0 && i !== team.active
                ? <button key={i} className="btn ghost tiny" onClick={() => onReplace(i)}>{x.pokemon.name} · {x.hp}/{x.maxHP}</button>
                : null
            ))}
          </div>
        </div>
      )}

      {!over && !needsReplace && !isAuto && (
        <div style={{ marginTop: 10 }}>
          <div className="eyebrow">This turn</div>
          {forcedNote && (
            <div className="mono" style={{ fontSize: 11, color: "var(--amber)", marginBottom: 6 }}>
              {forcedNote}
            </div>
          )}
          <div style={{ display: "grid", gap: 4, gridTemplateColumns: "1fr 1fr" }}>
            {b.moves.map((slot, i) => (
              <button
                key={i}
                className="btn ghost tiny"
                data-on={chosen.type === "move" && chosen.moveIndex === i}
                disabled={moveBlocked(i, slot)}
                title={
                  b.vol.disable?.moveIndex === i ? "Disabled" :
                  b.vol.taunt > 0 && slot.move.category === "status" ? "Taunt won't allow it" :
                  slot.pp <= 0 ? "Out of PP" : undefined
                }
                onClick={() => onChoose({ type: "move", moveIndex: i })}
                style={chosen.type === "move" && chosen.moveIndex === i
                  ? { background: "var(--ink)", color: "var(--screen)" } : undefined}
              >
                {slot.move.name} · {slot.pp}pp
              </button>
            ))}
          </div>
          {team.battlers.length > 1 && (
            trappedBy ? (
              <div className="mono" style={{ fontSize: 11, color: "var(--amber)", marginTop: 6 }}>
                Can't switch — {trappedBy} is holding it in place.
              </div>
            ) : (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                {team.battlers.map((x, i) => (
                  x.hp > 0 && i !== team.active
                    ? (
                      <button
                        key={i}
                        className="btn ghost tiny"
                        onClick={() => onChoose({ type: "switch", to: i })}
                        style={chosen.type === "switch" && chosen.to === i
                          ? { background: "var(--ink)", color: "var(--screen)" } : undefined}
                      >
                        switch → {x.pokemon.name}
                      </button>
                    )
                    : null
                ))}
              </div>
            )
          )}
        </div>
      )}

      {team.battlers.length > 1 && (
        <div className="mono" style={{ fontSize: 10, color: "var(--ink-soft)", marginTop: 8 }}>
          Bench: {team.battlers.map((x, i) => i === team.active ? null : `${x.pokemon.name} ${x.hp}/${x.maxHP}`).filter(Boolean).join(" · ") || "—"}
        </div>
      )}
    </div>
  );
}

/** One log line per engine event, written for a 12-year-old, maths included. */
export function EventLine({ e, sideNames }) {
  const effNote = (eff) =>
    eff === 0 ? "no effect" :
    eff > 2 ? "REALLY super effective" :
    eff > 1 ? "super effective" :
    eff < 1 ? "not very effective" : null;

  switch (e.type) {
    case "move":
      return <div className="step-body">{e.name} used <strong>{e.move}</strong>.</div>;
    case "damage": {
      const notes = [
        e.crit && "critical hit!",
        effNote(e.effectiveness),
        e.hits > 1 && `hit ${e.hit} of ${e.hits}`,
      ].filter(Boolean).join(" · ");
      const where = e.toSub
        ? <>{e.name}'s substitute took <strong>{e.amount}</strong> damage{notes ? ` (${notes})` : ""}</>
        : <>{e.name} took <strong>{e.amount}</strong> damage{notes ? ` (${notes})` : ""} → {e.hpLeft}/{e.maxHP} HP</>;
      return (
        <div className="step-body">
          {where}
          <span style={{ color: "var(--ink-soft)" }}>
            {" "}· roll {e.detail.rollIndex + 1}/16 of {e.detail.rolls[0]}–{e.detail.rolls[15]} · {e.detail.atkKey.toUpperCase()} {e.detail.atk} vs {e.detail.defKey.toUpperCase()} {e.detail.def}
          </span>
        </div>
      );
    }
    case "miss": {
      const spot = {
        air: "it was too high up", underground: "it was underground",
        underwater: "it was underwater", vanished: "it had vanished",
      }[e.hiding];
      return <div className="step-body">{e.name}'s {e.move} missed{spot ? ` — ${spot}!` : "!"}</div>;
    }
    case "immune": return <div className="step-body">It doesn't affect {e.name}.</div>;
    case "flinch": return <div className="step-body">{e.name} flinched and couldn't move!</div>;
    case "asleep": return <div className="step-body">{e.name} is fast asleep.</div>;
    case "wake": return <div className="step-body">{e.name} woke up!</div>;
    case "frozen": return <div className="step-body">{e.name} is frozen solid.</div>;
    case "thaw": return <div className="step-body">{e.name} thawed out!</div>;
    case "fullPara": return <div className="step-body">{e.name} is paralysed and can't move!</div>;
    case "status": return <div className="step-body">{e.name} is now <strong>{e.status === "toxic" ? "badly poisoned" : e.status === "paralysis" ? "paralysed" : e.status === "sleep" ? "asleep" : e.status === "freeze" ? "frozen" : e.status + "ed"}</strong>.</div>;
    case "chip": return <div className="step-body">{e.name} lost {e.amount} HP to {e.cause === "toxic" ? "bad poison" : e.cause} → {e.hpLeft}/{e.maxHP} HP</div>;
    case "stages": {
      if (e.change === 0) return <div className="step-body">{e.name}'s {e.stat.toUpperCase()} can't go further.</div>;
      const dir = e.change > 0 ? "rose" : "fell";
      const amount = Math.abs(e.change) === 1 ? "" : Math.abs(e.change) === 2 ? " sharply" : " drastically";
      return <div className="step-body">{e.name}'s {e.stat.toUpperCase()} {dir}{amount} (now {e.now > 0 ? "+" : ""}{e.now}).</div>;
    }
    case "heal": return <div className="step-body">{e.name} healed {e.amount} HP.</div>;
    case "drain": return <div className="step-body">{e.name} drained {e.amount} HP back.</div>;
    case "recoil": return <div className="step-body">{e.name} took {e.amount} recoil damage → {e.hpLeft} HP</div>;
    case "switch": return <div className="step-body">{sideNames[e.side]} called back {e.out} and sent in <strong>{e.in}</strong>.</div>;
    case "faint": return <div className="step-body"><strong>{e.name} fainted!</strong></div>;
    case "win": return <div className="step-body"><strong>{sideNames[e.side]} wins the battle!</strong></div>;
    case "noPP": return <div className="step-body">{e.name} has no PP left for that move.</div>;
    case "noEffect": return <div className="step-body">It didn't do anything.</div>;
    case "notModeled": return <div className="step-body">{e.move} isn't in the sim yet, so nothing happened.</div>;
    case "sendIn": return <div className="step-body">{sideNames[e.side]} sent in <strong>{e.name}</strong>.</div>;
    case "weather": {
      const text = { rain: "It started to rain!", sun: "The sunlight turned harsh!", sand: "A sandstorm kicked up!", snow: "It started to snow!" }[e.kind];
      return <div className="step-body">{text}</div>;
    }
    case "weatherEnd": return <div className="step-body">The weather cleared up.</div>;
    case "hazard": return <div className="step-body">{e.name} was hurt by {e.hazard} for {e.amount} → {e.hpLeft}/{e.maxHP} HP</div>;
    case "hazardSet": return <div className="step-body">{e.hazard} scattered around {sideNames[e.side]}'s side!</div>;
    case "hazardClear": return <div className="step-body">{e.by} cleared {e.hazard === "everything" ? "the hazards" : e.hazard} away.</div>;
    case "ability": return <div className="step-body">{e.name}'s {e.ability}!</div>;
    case "absorb": return <div className="step-body">{e.name}'s {e.ability} soaked up the move{e.amount ? ` and healed ${e.amount} HP` : ""}.</div>;
    case "endure": return <div className="step-body">{e.name} hung on at 1 HP thanks to its {e.via}!</div>;
    case "balloonPop": return <div className="step-body">{e.name}'s Air Balloon popped!</div>;

    /* ---- charging, recharging and being locked in ---- */
    case "charge": {
      const where = {
        air: "flew up high", underground: "burrowed underground",
        underwater: "dived under water", vanished: "vanished",
      }[e.invuln];
      return <div className="step-body">{e.name} {where ?? `started charging ${e.move}`}{where ? "!" : "."} {where ? `Nothing can reach it until ${e.move} lands.` : ""}</div>;
    }
    case "itemUsed": return <div className="step-body">{e.name}'s {e.item} let it attack straight away!</div>;
    case "mustRecharge": return <div className="step-body">{e.name} has to rest next turn.</div>;
    case "recharge": return <div className="step-body">{e.name} is getting its breath back and can't move.</div>;
    case "rampageEnd":
      return <div className="step-body">{e.name} {e.early ? "stopped early." : "calmed down."}</div>;
    case "confused": return <div className="step-body">{e.name} became <strong>confused</strong>!</div>;
    case "confusionEnd": return <div className="step-body">{e.name} snapped out of its confusion.</div>;
    case "confusionHit":
      return <div className="step-body">{e.name} is confused — it hit itself for {e.amount} → {e.hpLeft}/{e.maxHP} HP</div>;

    /* ---- things with a timer on them ---- */
    case "trapSet":
      return <div className="step-body">{e.name} was caught by {e.by}{e.chips ? " and can't escape!" : " and can no longer run!"}</div>;
    case "trapEnd": return <div className="step-body">{e.name} broke free of {e.by}.</div>;
    case "trapped": return <div className="step-body">{e.name} can't switch out — {e.by} is holding it.</div>;
    case "seeded": return <div className="step-body">{e.name} was seeded!</div>;
    case "wishMade": return <div className="step-body">{e.name} made a wish for next turn.</div>;
    case "futureSet": return <div className="step-body">{e.name} foresaw an attack — {e.move} will land in two turns.</div>;
    case "futureHit":
      return <div className="step-body">{e.move} struck {e.name} for <strong>{e.amount}</strong>{effNote(e.effectiveness) ? ` (${effNote(e.effectiveness)})` : ""} → {e.hpLeft}/{e.maxHP} HP</div>;
    case "perishSong": return <div className="step-body">All Pokémon that heard the song will faint in three turns!</div>;
    case "perishCount":
      return <div className="step-body">{e.name}'s perish count fell to {e.count}.</div>;
    case "drowsy": return <div className="step-body">{e.name} grew drowsy — it'll fall asleep at the end of next turn.</div>;
    case "taunted": return <div className="step-body">{e.name} fell for the taunt — no status moves for three turns.</div>;
    case "tauntEnd": return <div className="step-body">{e.name} shook off the taunt.</div>;
    case "encored": return <div className="step-body">{e.name} has to keep using <strong>{e.move}</strong>.</div>;
    case "encoreEnd": return <div className="step-body">{e.name}'s encore ended.</div>;
    case "disabled": return <div className="step-body">{e.name}'s <strong>{e.move}</strong> was disabled.</div>;
    case "disableEnd": return <div className="step-body">{e.name} can use its move again.</div>;
    case "blockedMove": return <div className="step-body">{e.name} can't use {e.move} — {e.by}.</div>;

    /* ---- field effects ---- */
    case "screenSet": return <div className="step-body">{e.screen} went up on {sideNames[e.side]}'s side!</div>;
    case "screenEnd": {
      const label = { reflect: "Reflect", lightScreen: "Light Screen", auroraVeil: "Aurora Veil" }[e.screen];
      return <div className="step-body">{sideNames[e.side]}'s {label} faded.</div>;
    }
    case "tailwind": return <div className="step-body">A tailwind picked up behind {sideNames[e.side]}!</div>;
    case "tailwindEnd": return <div className="step-body">{sideNames[e.side]}'s tailwind died down.</div>;
    case "trickRoom": return <div className="step-body">It twisted the dimensions — slower Pokémon move first!</div>;
    case "trickRoomEnd": return <div className="step-body">The dimensions returned to normal.</div>;

    /* ---- protecting and substitutes ---- */
    case "protecting": return <div className="step-body">{e.name} braced itself with {e.move}.</div>;
    case "protected": return <div className="step-body">{e.name} protected itself from {e.move}!</div>;
    case "subMade": return <div className="step-body">{e.name} put up a substitute with {e.hp} HP → {e.hpLeft}/{e.maxHP} HP</div>;
    case "subBroke": return <div className="step-body">{e.name}'s substitute broke!</div>;
    case "subBlocked": return <div className="step-body">{e.name}'s substitute took it instead — nothing got through.</div>;

    /* ---- one-off refusals ---- */
    case "moveFailed": return <div className="step-body">{e.name}'s {e.move} failed — {e.why}.</div>;
    case "focusBroken": return <div className="step-body">{e.name} lost its focus and couldn't punch!</div>;
    case "roosted": return <div className="step-body">{e.name} landed to rest — it isn't a Flying type this turn.</div>;
    case "switchOut": return <div className="step-body">{e.name} is coming back — pick who goes in.</div>;
    default: return null;
  }
}
