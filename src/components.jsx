import React from "react";
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

export function StatBar({ value, max = 255, color }) {
  return (
    <div className="track">
      <div className="bar" style={{ width: `${Math.min(100, (value / max) * 100)}%`, background: color }} />
    </div>
  );
}
