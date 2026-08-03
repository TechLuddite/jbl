import React, { useState, useMemo } from "react";
import { POKEDEX } from "../data/index.js";
import { TYPE_COLOR } from "../lib/typeChart.js";
import { TypeChip, Field, StatBar } from "../components.jsx";

const STAT_LABELS = {
  hp: "HP", atk: "Attack", def: "Defense",
  spa: "Sp. Atk", spd: "Sp. Def", spe: "Speed",
};

export default function StatDex() {
  const [sortStat, setSortStat] = useState("bst");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(null);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? POKEDEX.filter(
          (p) => p.name.toLowerCase().includes(q) || p.types.some((t) => t.includes(q))
        )
      : POKEDEX;
    const val = (p) => (sortStat === "bst" ? p.bst : p.stats[sortStat]);
    return [...filtered].sort((a, b) => val(b) - val(a));
  }, [sortStat, query]);

  const max = rows.length ? (sortStat === "bst" ? rows[0].bst : rows[0].stats[sortStat]) : 1;
  const selected = POKEDEX.find((p) => p.id === selectedId);

  return (
    <div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 16 }}>
        <Field label="Rank by">
          <select className="fld" value={sortStat} onChange={(e) => setSortStat(e.target.value)}>
            <option value="bst">Base Stat Total</option>
            {Object.entries(STAT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="Search">
          <input className="fld" placeholder="name or type" value={query}
                 onChange={(e) => setQuery(e.target.value)} />
        </Field>
      </div>

      {selected && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
            <strong style={{ fontSize: 17 }}>{selected.name}</strong>
            {selected.types.map((t) => <TypeChip key={t} type={t} />)}
            <span className="mono" style={{ marginLeft: "auto", fontSize: 12, color: "var(--ink-soft)" }}>
              BST {selected.bst}
            </span>
            <button className="btn ghost tiny" onClick={() => setSelectedId(null)}>Close</button>
          </div>
          {Object.entries(STAT_LABELS).map(([k, label]) => (
            <div key={k} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 5 }}>
              <span className="mono" style={{ fontSize: 11, width: 58, color: "var(--ink-soft)" }}>{label}</span>
              <span className="mono" style={{ fontSize: 12, width: 30, fontWeight: 600 }}>{selected.stats[k]}</span>
              <StatBar value={selected.stats[k]} max={255} color={TYPE_COLOR[selected.types[0]]} />
            </div>
          ))}
        </div>
      )}

      <div className="eyebrow">
        {rows.length} Pokémon · ranked by {sortStat === "bst" ? "base stat total" : STAT_LABELS[sortStat]}
      </div>

      {rows.length === 0 ? (
        <div className="empty">Nothing matches “{query}”. Try a name or a type like “dragon”.</div>
      ) : (
        <div style={{ maxHeight: 360, overflowY: "auto" }}>
          <table className="lb">
            <thead>
              <tr>
                <th>#</th><th>Pokémon</th><th>Types</th>
                <th style={{ width: "45%" }}>{sortStat === "bst" ? "BST" : STAT_LABELS[sortStat]}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p, i) => {
                const v = sortStat === "bst" ? p.bst : p.stats[sortStat];
                return (
                  <tr key={p.id} style={{ cursor: "pointer" }} onClick={() => setSelectedId(p.id)}>
                    <td style={{ color: "var(--ink-soft)" }}>{i + 1}</td>
                    <td style={{ fontWeight: 600 }}>{p.name}</td>
                    <td>{p.types.map((t) => <TypeChip key={t} type={t} />)}</td>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ width: 32, fontWeight: 600 }}>{v}</span>
                        <StatBar value={v} max={max} color={TYPE_COLOR[p.types[0]]} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
