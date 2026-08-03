import React, { useEffect, useRef, useState } from "react";
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
 * A Pokémon picker that opens into a searchable list. With 1300+ entries a
 * plain select is unscrollable, so the open panel puts a search box right on
 * top of the list. Custom rather than a native select because you can't put
 * an input inside one.
 */
export function PokemonSelect({ list, value, onChange, style }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const current = list.find((p) => p.id === value);
  const q = query.trim().toLowerCase();
  const matches = q ? list.filter((p) => p.name.toLowerCase().includes(q)) : list;

  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Keep the highlighted row visible while arrowing through the list.
  useEffect(() => {
    if (open) listRef.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const openPanel = () => {
    setQuery("");
    setActive(Math.max(0, list.findIndex((p) => p.id === value)));
    setOpen(true);
  };

  const pick = (p) => {
    onChange(p.id);
    setOpen(false);
  };

  const onKey = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (matches[active]) pick(matches[active]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="pokepick" ref={rootRef} style={style}>
      <button
        type="button"
        className="fld pokepick-btn"
        onClick={() => (open ? setOpen(false) : openPanel())}
      >
        {current?.name ?? "Pick a Pokémon"}
        <span className="pokepick-caret">▾</span>
      </button>
      {open && (
        <div className="pokepick-pop">
          <input
            ref={inputRef}
            className="fld"
            type="search"
            placeholder="Start typing a name…"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={onKey}
          />
          <div className="pokepick-list" ref={listRef}>
            {matches.map((p, i) => (
              <div
                key={p.id}
                className="pokepick-opt"
                data-active={i === active || undefined}
                data-current={p.id === value || undefined}
                onPointerDown={(e) => e.preventDefault()}
                onClick={(e) => { e.preventDefault(); pick(p); }}
                onMouseMove={() => setActive(i)}
              >
                {p.name}
              </div>
            ))}
            {matches.length === 0 && (
              <div className="empty" style={{ padding: 8 }}>No names match.</div>
            )}
          </div>
        </div>
      )}
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
