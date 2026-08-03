import React, { useState } from "react";
import { TYPE_COLOR } from "./lib/typeChart.js";

export function TypeChip({ type }) {
  return (
    <span className="chip" style={{ background: TYPE_COLOR[type] }}>
      {type}
    </span>
  );
}

export function Field({ label, children }) {
  return (
    <label style={{ display: "block" }}>
      <div className="eyebrow" style={{ marginBottom: 4 }}>{label}</div>
      {children}
    </label>
  );
}

/**
 * A Pokémon dropdown with a search box on top. With 1300+ entries the plain
 * select is unscrollable, so typing narrows the list first.
 */
export function PokemonSelect({ list, value, onChange, style }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const matches = q ? list.filter((p) => p.name.toLowerCase().includes(q)) : list;
  // Keep the current pick in the list even when it doesn't match the search,
  // so the dropdown never goes blank while typing.
  const current = list.find((p) => p.id === value);
  const options =
    current && !matches.some((p) => p.id === current.id) ? [current, ...matches] : matches;

  return (
    <div style={{ display: "grid", gap: 4, ...style }}>
      <input
        className="fld"
        type="search"
        placeholder="Start typing a name…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <select className="fld" value={value} onChange={(e) => onChange(+e.target.value)}>
        {options.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
    </div>
  );
}

export function StatBar({ value, max = 255, color }) {
  return (
    <div className="track">
      <div className="bar" style={{ width: `${Math.min(100, (value / max) * 100)}%`, background: color }} />
    </div>
  );
}
