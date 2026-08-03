import React, { useState, useMemo } from "react";
import { resolveMatchup } from "../lib/battle.js";
import { NATURES } from "../lib/natures.js";
import { POKEDEX, MOVES } from "../data/index.js";
import { TypeChip, Field } from "../components.jsx";

/**
 * The heart of the app: a damage calculator that shows every step.
 *
 * Design rule — do NOT collapse this into "here's the number". The whole point
 * is that a kid can follow the arithmetic and learn that damage is a RANGE.
 */

const pick = (id, fallback) => POKEDEX.find((p) => p.id === id) ?? POKEDEX[fallback] ?? POKEDEX[0];

export default function DamageCalc() {
  const [attackerId, setAttackerId] = useState(POKEDEX.find((p) => p.name === "Charizard")?.id ?? POKEDEX[0].id);
  const [defenderId, setDefenderId] = useState(POKEDEX.find((p) => p.name === "Swampert")?.id ?? POKEDEX[1].id);
  const [moveName, setMoveName] = useState(MOVES.find((m) => m.name === "Flamethrower")?.name ?? MOVES[0].name);
  const [level, setLevel] = useState(50);
  const [attackerNature, setAttackerNature] = useState("modest");
  const [attackerEV, setAttackerEV] = useState(252);
  const [defenderEV, setDefenderEV] = useState(0);
  const [crit, setCrit] = useState(false);
  const [burn, setBurn] = useState(false);

  const attacker = pick(attackerId, 0);
  const defender = pick(defenderId, 1);
  const move = MOVES.find((m) => m.name === moveName) ?? MOVES[0];

  const r = useMemo(
    () => resolveMatchup({
      attacker, defender, move, level, attackerNature, attackerEV, defenderEV, crit, burn,
    }),
    [attacker, defender, move, level, attackerNature, attackerEV, defenderEV, crit, burn]
  );

  const pct = (n) => ((n / r.defenderHP) * 100).toFixed(1);

  return (
    <div>
      <div className="eyebrow">Set up the matchup</div>
      <div className="grid" style={{ marginBottom: 18 }}>
        <Field label="Attacker">
          <select className="fld" value={attackerId} onChange={(e) => setAttackerId(+e.target.value)}>
            {POKEDEX.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="Move">
          <select className="fld" value={moveName} onChange={(e) => setMoveName(e.target.value)}>
            {MOVES.map((m) => <option key={m.name} value={m.name}>{m.name} · {m.power}</option>)}
          </select>
        </Field>
        <Field label="Defender">
          <select className="fld" value={defenderId} onChange={(e) => setDefenderId(+e.target.value)}>
            {POKEDEX.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="Level">
          <input className="fld" type="number" min="1" max="100" value={level}
                 onChange={(e) => setLevel(Math.min(100, Math.max(1, +e.target.value || 1)))} />
        </Field>
        <Field label="Attacker nature">
          <select className="fld" value={attackerNature} onChange={(e) => setAttackerNature(e.target.value)}>
            {Object.keys(NATURES).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </Field>
        <Field label={`Attacker ${r.atkKey.toUpperCase()} EVs`}>
          <input className="fld" type="number" min="0" max="252" step="4" value={attackerEV}
                 onChange={(e) => setAttackerEV(Math.min(252, Math.max(0, +e.target.value || 0)))} />
        </Field>
        <Field label={`Defender ${r.defKey.toUpperCase()} EVs`}>
          <input className="fld" type="number" min="0" max="252" step="4" value={defenderEV}
                 onChange={(e) => setDefenderEV(Math.min(252, Math.max(0, +e.target.value || 0)))} />
        </Field>
        <Field label="Conditions">
          <div style={{ display: "flex", gap: 14, alignItems: "center", paddingTop: 7 }}>
            <label className="mono" style={{ fontSize: 12, display: "flex", gap: 5, alignItems: "center" }}>
              <input type="checkbox" checked={crit} onChange={(e) => setCrit(e.target.checked)} /> crit
            </label>
            <label className="mono" style={{ fontSize: 12, display: "flex", gap: 5, alignItems: "center" }}>
              <input type="checkbox" checked={burn} onChange={(e) => setBurn(e.target.checked)} /> burn
            </label>
          </div>
        </Field>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 16 }}>{attacker.name}</strong>
        {attacker.types.map((t) => <TypeChip key={t} type={t} />)}
        <span className="mono" style={{ color: "var(--ink-soft)" }}>—{move.name}→</span>
        <strong style={{ fontSize: 16 }}>{defender.name}</strong>
        {defender.types.map((t) => <TypeChip key={t} type={t} />)}
      </div>

      <div className="eyebrow">Showing the work</div>

      <div className="step">
        <div className="step-label">1 · Real stats from base stats</div>
        <div className="step-body">
          {attacker.name} {r.atkKey.toUpperCase()} = ((2×{attacker.stats[r.atkKey]} + 31 + {Math.floor(attackerEV / 4)}) × {level} ÷ 100 + 5) × {attackerNatureMod(attackerNature, r.atkKey)} = <strong>{r.atkStat}</strong>
        </div>
        <div className="step-body">
          {defender.name} {r.defKey.toUpperCase()} = <strong>{r.defStat}</strong> · HP = <strong>{r.defenderHP}</strong>
        </div>
      </div>

      <div className="step">
        <div className="step-label">2 · Base damage</div>
        <div className="step-body">
          ⌊(⌊2×{level}÷5+2⌋ × {move.power} × {r.atkStat}) ÷ {r.defStat} ÷ 50⌋ + 2 = <strong>{r.baseDamage}</strong>
        </div>
      </div>

      <div className="step">
        <div className="step-label">3 · Multipliers</div>
        <div className="step-body">
          STAB ×{r.stab} · type ×{r.effectiveness}
          {crit && " · crit ×1.5"}
          {burn && " · burn ×0.5"}
          {" — "}{effectivenessNote(r.effectiveness)}
        </div>
      </div>

      <div className="step" data-accent="true">
        <div className="step-label">4 · The random roll — damage is 16 numbers, not one</div>
        <div className="rolls" style={{ marginTop: 6 }}>
          {r.rolls.map((v, i) => (
            <div
              key={i}
              className="roll"
              data-ko={v >= r.defenderHP}
              style={{ height: `${Math.max(4, (v / Math.max(r.max, 1)) * 100)}%` }}
              title={`${85 + i}% roll → ${v} damage (${pct(v)}% of HP)`}
            />
          ))}
        </div>
        <div className="step-label" style={{ marginTop: 5 }}>
          85% roll ← each bar is one possible outcome → 100% roll
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="mono" style={{ fontSize: 20, fontWeight: 600 }}>
          {r.min}–{r.max} damage{" "}
          <span style={{ fontSize: 13, color: "var(--ink-soft)" }}>
            ({pct(r.min)}%–{pct(r.max)}% of {r.defenderHP} HP)
          </span>
        </div>
        <div className="mono" style={{ fontSize: 13, marginTop: 6 }}>
          {koSummary(r)}
        </div>
      </div>
    </div>
  );
}

function attackerNatureMod(nature, stat) {
  const [up, down] = NATURES[nature] ?? [null, null];
  if (up === stat) return 1.1;
  if (down === stat) return 0.9;
  return 1;
}

function effectivenessNote(eff) {
  if (eff === 0) return "it has no effect.";
  if (eff > 2) return "it's REALLY super effective.";
  if (eff > 1) return "it's super effective.";
  if (eff < 1) return "it's not very effective.";
  return "normal damage.";
}

function koSummary(r) {
  if (r.effectiveness === 0) return "No damage at all.";
  if (r.ohkoRolls === 16) return "Guaranteed OHKO.";
  if (r.ohkoRolls > 0) {
    return `${r.ohkoRolls}/16 chance to OHKO (${Math.round(r.ohkoChance * 100)}%) · otherwise a ${r.guaranteedHits}HKO`;
  }
  return `${r.bestCaseHits}HKO at best · ${r.guaranteedHits}HKO guaranteed`;
}
