import React, { useState, useEffect, useRef } from "react";
import { POKEDEX, legalMoves } from "../data/index.js";
import {
  createBattler, createBattle, playTurn, replaceFainted,
  makeRng, chooseAiAction,
} from "../lib/sim.js";
import { TypeChip, Field } from "../components.jsx";
import * as storage from "../lib/storage.js";

/**
 * The battle sim: u-pick two teams of 1-6, then play it out turn by turn.
 * Either side can be handed to the sim ("auto"), so the same screen covers
 * hotseat play and watch-it-play-out mode.
 *
 * Move legality comes from legalMoves(): real learnsets once the full dex is
 * baked, anything-goes on the sample set.
 */

const SIDE_NAMES = ["Red team", "Blue team"];
const MAX_TURNS = 500; // auto-play safety stop

/** A sensible default loadout: the four hardest-hitting legal moves, STAB first. */
function defaultMoveNames(pokemon) {
  const legal = legalMoves(pokemon).filter((m) => m.power != null && m.category !== "status");
  const score = (m) => m.power * (pokemon.types.includes(m.type) ? 1.5 : 1);
  return [...legal].sort((x, y) => score(y) - score(x)).slice(0, 4).map((m) => m.name);
}

function newSlot(pokemonId) {
  const p = POKEDEX.find((x) => x.id === pokemonId) ?? POKEDEX[0];
  return { pokemonId: p.id, level: 50, moveNames: defaultMoveNames(p) };
}

const dexOf = (slot) => POKEDEX.find((p) => p.id === slot.pokemonId) ?? POKEDEX[0];

export default function BattleSim() {
  const [phase, setPhase] = useState("pick"); // pick | fight
  const [teams, setTeams] = useState([[newSlot(6)], [newSlot(9)]]);
  const [auto, setAuto] = useState([false, false]);

  const [battle, setBattle] = useState(null);
  const [log, setLog] = useState([]);
  const [chosen, setChosen] = useState([{ type: "move", moveIndex: 0 }, { type: "move", moveIndex: 0 }]);
  const rngRef = useRef(makeRng(1));

  // League tie-in: offered after the battle, never automatic.
  const [trainers, setTrainers] = useState([]);
  const [trainerPick, setTrainerPick] = useState([0, 0]);
  const [recorded, setRecorded] = useState(false);

  useEffect(() => {
    (async () => {
      const t = await storage.get("league:trainers", []);
      setTrainers(t);
      if (t.length >= 2) setTrainerPick([t[0].id, t[1].id]);
    })();
  }, [phase]);

  /* ---------------------------------------------------- team building ---- */

  function updateSlot(side, i, patch) {
    setTeams((prev) => prev.map((team, s) => {
      if (s !== side) return team;
      return team.map((slot, j) => {
        if (j !== i) return slot;
        // Re-picking the Pokémon resets its moves to the new default four.
        if (patch.pokemonId != null && patch.pokemonId !== slot.pokemonId) {
          return newSlot(patch.pokemonId);
        }
        return { ...slot, ...patch };
      });
    }));
  }

  function startBattle() {
    const built = teams.map((team) =>
      team.map((slot) => {
        const p = dexOf(slot);
        const legal = legalMoves(p);
        const moves = [...new Set(slot.moveNames)]
          .map((n) => legal.find((m) => m.name === n))
          .filter(Boolean)
          .slice(0, 4);
        return createBattler(p, { level: slot.level, moves });
      })
    );
    rngRef.current = makeRng(Date.now() >>> 0);
    setBattle(createBattle(built[0], built[1]));
    setLog([]);
    setChosen([{ type: "move", moveIndex: 0 }, { type: "move", moveIndex: 0 }]);
    setRecorded(false);
    setPhase("fight");
  }

  /* --------------------------------------------------------- fighting ---- */

  const activeOf = (state, side) => state.teams[side].battlers[state.teams[side].active];

  function firstUsableMove(battler) {
    const i = battler.moves.findIndex((s) => s.pp > 0);
    return { type: "move", moveIndex: Math.max(0, i) };
  }

  /** Auto-fill replacements for sides the sim controls (first healthy pick). */
  function settleAiReplacements(state) {
    let s = state;
    for (const side of [0, 1]) {
      if (s.pendingReplacement[side] && auto[side]) {
        const next = s.teams[side].battlers.findIndex((b) => b.hp > 0);
        if (next >= 0) s = replaceFainted(s, side, next).state;
      }
    }
    return s;
  }

  function stepTurn(state, picks) {
    const actions = [0, 1].map((side) =>
      auto[side] ? chooseAiAction(state, side, rngRef.current) : picks[side]
    );
    const r = playTurn(state, actions, rngRef.current);
    const next = settleAiReplacements(r.state);
    setLog((prev) => [{ turn: state.turn, events: r.events }, ...prev]);
    return next;
  }

  function onPlayTurn() {
    const next = stepTurn(battle, chosen);
    setBattle(next);
    setChosen([firstUsableMove(activeOf(next, 0)), firstUsableMove(activeOf(next, 1))]);
  }

  function onAutoPlayRest() {
    let s = battle;
    const blocks = [];
    let guard = 0;
    while (s.winner == null && guard++ < MAX_TURNS) {
      if (s.pendingReplacement.some(Boolean)) {
        for (const side of [0, 1]) {
          if (s.pendingReplacement[side]) {
            const next = s.teams[side].battlers.findIndex((b) => b.hp > 0);
            if (next >= 0) s = replaceFainted(s, side, next).state;
          }
        }
      }
      const actions = [0, 1].map((side) => chooseAiAction(s, side, rngRef.current));
      const r = playTurn(s, actions, rngRef.current);
      blocks.push({ turn: s.turn, events: r.events });
      s = r.state;
    }
    setLog((prev) => [...blocks.reverse(), ...prev]);
    setBattle(s);
  }

  function onReplace(side, index) {
    const r = replaceFainted(battle, side, index);
    if (r.ok) {
      setBattle(r.state);
      setChosen((prev) => prev.map((c, s) => (s === side ? { type: "move", moveIndex: 0 } : c)));
    }
  }

  async function recordInLeague() {
    const [ta, tb] = trainerPick;
    if (!battle || battle.winner == null || ta === tb) return;
    const battles = await storage.get("league:battles", []);
    battles.push({
      id: Date.now(), a: +ta, b: +tb,
      winner: battle.winner === 0 ? +ta : +tb,
      date: new Date().toISOString().slice(0, 10),
      sim: true,
    });
    await storage.set("league:battles", battles);
    setRecorded(true);
  }

  /* ---------------------------------------------------------- render ----- */

  if (phase === "pick") {
    return (
      <div>
        <div className="eyebrow">Pick two teams · 1 to 6 Pokémon each</div>
        <div className="duel">
          {[0, 1].map((side) => (
            <div key={side} className="card">
              <div className="eyebrow">{SIDE_NAMES[side]}</div>
              {teams[side].map((slot, i) => (
                <TeamSlot
                  key={i}
                  slot={slot}
                  onChange={(patch) => updateSlot(side, i, patch)}
                  onRemove={teams[side].length > 1
                    ? () => setTeams((prev) => prev.map((t, s) => (s === side ? t.filter((_, j) => j !== i) : t)))
                    : null}
                />
              ))}
              {teams[side].length < 6 && (
                <button
                  className="btn ghost"
                  style={{ width: "100%" }}
                  onClick={() => setTeams((prev) => prev.map((t, s) => (s === side ? [...t, newSlot(POKEDEX[(t.length * 7) % POKEDEX.length].id)] : t)))}
                >
                  Add a Pokémon
                </button>
              )}
              <label className="mono" style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center", marginTop: 10 }}>
                <input
                  type="checkbox"
                  checked={auto[side]}
                  onChange={(e) => setAuto((prev) => prev.map((v, s) => (s === side ? e.target.checked : v)))}
                />
                Let the sim play this side
              </label>
            </div>
          ))}
        </div>
        <button className="btn" style={{ marginTop: 14 }} onClick={startBattle}>
          Start the battle
        </button>
      </div>
    );
  }

  const state = battle;
  const over = state.winner != null;

  return (
    <div>
      <div className="duel">
        {[0, 1].map((side) => (
          <SidePanel
            key={side}
            state={state}
            side={side}
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
          <button className="btn ghost" onClick={() => setPhase("pick")}>
            Back to team picks
          </button>
        </div>
      )}

      {over && (
        <div className="card" style={{ marginTop: 14 }}>
          <div className="mono" style={{ fontSize: 18, fontWeight: 600 }}>
            {SIDE_NAMES[state.winner]} wins!
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <button className="btn" onClick={startBattle}>Rematch</button>
            <button className="btn ghost" onClick={() => setPhase("pick")}>New teams</button>
          </div>

          <div style={{ marginTop: 14 }}>
            <div className="eyebrow">Record this in the league?</div>
            {trainers.length < 2 ? (
              <div className="empty">Add at least two trainers on the League tab first.</div>
            ) : recorded ? (
              <div className="mono" style={{ fontSize: 12 }}>Recorded. Check the League tab.</div>
            ) : (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                {[0, 1].map((side) => (
                  <Field key={side} label={`${SIDE_NAMES[side]} was`}>
                    <select
                      className="fld"
                      value={trainerPick[side]}
                      onChange={(e) => setTrainerPick((prev) => prev.map((v, s) => (s === side ? +e.target.value : v)))}
                    >
                      {trainers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                  </Field>
                ))}
                <button
                  className="btn"
                  disabled={trainerPick[0] === trainerPick[1]}
                  onClick={recordInLeague}
                  style={{ alignSelf: "end" }}
                >
                  Record result
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="eyebrow" style={{ marginTop: 18 }}>Battle log · newest first</div>
      {log.length === 0 && <div className="empty">Pick actions and play the first turn.</div>}
      {log.map((block) => (
        <div key={block.turn} className="step">
          <div className="step-label">Turn {block.turn}</div>
          {block.events.map((e, i) => <EventLine key={i} e={e} />)}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------- subcomponents --- */

function TeamSlot({ slot, onChange, onRemove }) {
  const p = dexOf(slot);
  const legal = legalMoves(p);
  const damaging = legal.filter((m) => m.power != null && m.category !== "status");
  const status = legal.filter((m) => m.power == null || m.category === "status");

  return (
    <div style={{ borderTop: "1px solid var(--rule)", paddingTop: 8, marginBottom: 10 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
        <select className="fld" style={{ flex: 1 }} value={slot.pokemonId}
                onChange={(e) => onChange({ pokemonId: +e.target.value })}>
          {POKEDEX.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
        <input className="fld" style={{ width: 64 }} type="number" min="1" max="100"
               title="Level" value={slot.level}
               onChange={(e) => onChange({ level: Math.min(100, Math.max(1, +e.target.value || 1)) })} />
        {onRemove && <button className="btn ghost tiny" onClick={onRemove}>✕</button>}
      </div>
      <div style={{ display: "flex", gap: 4, alignItems: "center", marginBottom: 6 }}>
        {p.types.map((t) => <TypeChip key={t} type={t} />)}
        <span className="mono" style={{ fontSize: 10, color: "var(--ink-soft)" }}>
          {legal.length} moves to pick from
        </span>
      </div>
      <div style={{ display: "grid", gap: 4, gridTemplateColumns: "1fr 1fr" }}>
        {[0, 1, 2, 3].map((i) => (
          <select
            key={i}
            className="fld"
            value={slot.moveNames[i] ?? ""}
            onChange={(e) => {
              const names = [...slot.moveNames];
              names[i] = e.target.value;
              onChange({ moveNames: names.filter(Boolean) });
            }}
          >
            <option value="">— empty —</option>
            {damaging.map((m) => (
              <option key={m.name} value={m.name}>{m.name} · {m.power}</option>
            ))}
            {status.length > 0 && (
              <optgroup label="Status moves">
                {status.map((m) => <option key={m.name} value={m.name}>{m.name}</option>)}
              </optgroup>
            )}
          </select>
        ))}
      </div>
    </div>
  );
}

function SidePanel({ state, side, isAuto, chosen, onChoose, onReplace, over }) {
  const team = state.teams[side];
  const b = team.battlers[team.active];
  const pct = (b.hp / b.maxHP) * 100;
  const barColor = pct > 50 ? "#5FAE55" : pct > 20 ? "var(--amber)" : "#C4553B";
  const needsReplace = state.pendingReplacement[side];

  const stageText = Object.entries(b.stages)
    .filter(([, v]) => v !== 0)
    .map(([k, v]) => `${k.toUpperCase()} ${v > 0 ? "+" : ""}${v}`)
    .join(" · ");

  return (
    <div className="card">
      <div className="eyebrow">{SIDE_NAMES[side]}{isAuto ? " · sim plays" : ""}</div>
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
          {stageText && <div className="mono" style={{ fontSize: 10, color: "var(--ink-soft)", marginTop: 2 }}>{stageText}</div>}
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
          <div style={{ display: "grid", gap: 4, gridTemplateColumns: "1fr 1fr" }}>
            {b.moves.map((slot, i) => (
              <button
                key={i}
                className="btn ghost tiny"
                data-on={chosen.type === "move" && chosen.moveIndex === i}
                disabled={slot.pp <= 0}
                onClick={() => onChoose({ type: "move", moveIndex: i })}
                style={chosen.type === "move" && chosen.moveIndex === i
                  ? { background: "var(--ink)", color: "var(--screen)" } : undefined}
              >
                {slot.move.name} · {slot.pp}pp
              </button>
            ))}
          </div>
          {team.battlers.length > 1 && (
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
function EventLine({ e }) {
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
      return (
        <div className="step-body">
          {e.name} took <strong>{e.amount}</strong> damage{notes ? ` (${notes})` : ""} → {e.hpLeft}/{e.maxHP} HP
          <span style={{ color: "var(--ink-soft)" }}>
            {" "}· roll {e.detail.rollIndex + 1}/16 of {e.detail.rolls[0]}–{e.detail.rolls[15]} · {e.detail.atkKey.toUpperCase()} {e.detail.atk} vs {e.detail.defKey.toUpperCase()} {e.detail.def}
          </span>
        </div>
      );
    }
    case "miss": return <div className="step-body">{e.name}'s {e.move} missed!</div>;
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
    case "switch": return <div className="step-body">{SIDE_NAMES[e.side]} called back {e.out} and sent in <strong>{e.in}</strong>.</div>;
    case "faint": return <div className="step-body"><strong>{e.name} fainted!</strong></div>;
    case "win": return <div className="step-body"><strong>{SIDE_NAMES[e.side]} wins the battle!</strong></div>;
    case "noPP": return <div className="step-body">{e.name} has no PP left for that move.</div>;
    case "noEffect": return <div className="step-body">It didn't do anything.</div>;
    case "notModeled": return <div className="step-body">{e.move} isn't in the sim yet, so nothing happened.</div>;
    default: return null;
  }
}
