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
 * A picker that opens into a searchable list. With 1300+ Pokémon (or a few
 * hundred moves) a plain select is unscrollable, so the open panel puts a
 * search box right on top of the list. Custom rather than a native select
 * because you can't put an input inside one.
 *
 * `groups` is [{ label?, items: [{ key, label, search?, short? }] }] — a group
 * label renders as a non-selectable heading, like an optgroup. Matching runs on
 * `search` when given (so "Flamethrower · 90" still matches by name only), and
 * the closed button shows `short` when the row label is too long to sit in it.
 */
function SearchPick({ groups, value, onChange, placeholder, fallback, style }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const q = query.trim().toLowerCase();
  const shown = groups
    .map((g) => ({
      ...g,
      items: q
        ? g.items.filter((it) => (it.search ?? it.label).toLowerCase().includes(q))
        : g.items,
    }))
    .filter((g) => g.items.length > 0);
  const matches = shown.flatMap((g) => g.items);
  const current = groups.flatMap((g) => g.items).find((it) => it.key === value);

  // Flat index of each group's first row, so keyboard nav can run over the
  // whole list while the rows render grouped.
  const offsets = [];
  let acc = 0;
  for (const g of shown) { offsets.push(acc); acc += g.items.length; }

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
    if (open) listRef.current?.querySelector("[data-active]")?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const openPanel = () => {
    setQuery("");
    const all = groups.flatMap((g) => g.items);
    setActive(Math.max(0, all.findIndex((it) => it.key === value)));
    setOpen(true);
  };

  const pick = (it) => {
    onChange(it.key);
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
        <span className="pokepick-label">{current?.short ?? current?.label ?? fallback}</span>
        <span className="pokepick-caret">▾</span>
      </button>
      {open && (
        <div className="pokepick-pop">
          <input
            ref={inputRef}
            className="fld"
            type="search"
            placeholder={placeholder}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={onKey}
          />
          <div className="pokepick-list" ref={listRef}>
            {shown.map((g, gi) => (
              <React.Fragment key={g.label ?? gi}>
                {g.label && <div className="pokepick-group">{g.label}</div>}
                {g.items.map((it, ii) => {
                  const i = offsets[gi] + ii;
                  return (
                    <div
                      key={it.key}
                      className="pokepick-opt"
                      data-active={i === active || undefined}
                      data-current={it.key === value || undefined}
                      onPointerDown={(e) => e.preventDefault()}
                      onClick={(e) => { e.preventDefault(); pick(it); }}
                      onMouseMove={() => setActive(i)}
                    >
                      {it.label}
                    </div>
                  );
                })}
              </React.Fragment>
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

export function PokemonSelect({ list, value, onChange, style }) {
  return (
    <SearchPick
      groups={[{ items: list.map((p) => ({ key: p.id, label: p.name })) }]}
      value={value}
      onChange={onChange}
      placeholder="Start typing a name…"
      fallback="Pick a Pokémon"
      style={style}
    />
  );
}

/**
 * The move picker: damaging moves up top with their power, status moves in
 * their own group underneath, matching the old optgroup layout. `allowEmpty`
 * adds the "— empty —" slot the team builder uses; it hides while searching.
 */
export function MoveSelect({ moves, value, onChange, allowEmpty = false, emptyLabel = "— empty —", style }) {
  const damaging = moves.filter((m) => m.power != null && m.category !== "status");
  const status = moves.filter((m) => m.power == null || m.category === "status");
  const groups = [];
  if (allowEmpty) groups.push({ items: [{ key: "", label: emptyLabel, search: "" }] });
  groups.push({ items: damaging.map((m) => ({ key: m.name, label: `${m.name} · ${m.power}`, search: m.name })) });
  if (status.length) {
    groups.push({ label: "Status moves", items: status.map((m) => ({ key: m.name, label: m.name })) });
  }
  return (
    <SearchPick
      groups={groups}
      value={value}
      onChange={onChange}
      placeholder="Start typing a move…"
      fallback="Pick a move"
      style={style}
    />
  );
}

/**
 * The held-item picker. There are seventy-odd items now, so it gets the same
 * search-on-top treatment as the Pokémon and move lists — a plain select of
 * that length is unusable on a phone. Items are grouped the way `ITEMS` groups
 * them, and the description is searchable too, so typing "burn" finds the
 * Flame Orb without knowing its name.
 */
export function ItemSelect({ items, value, onChange, style }) {
  const groups = [{ items: [{ key: "", label: "— no item —", search: "no item none" }] }];
  const byGroup = new Map();
  for (const [slug, item] of Object.entries(items)) {
    if (!byGroup.has(item.group)) byGroup.set(item.group, []);
    byGroup.get(item.group).push({
      key: slug,
      label: `${item.name} · ${item.desc}`,
      short: item.name,
      search: `${item.name} ${item.desc}`,
    });
  }
  for (const [label, list] of byGroup) groups.push({ label, items: list });

  return (
    <SearchPick
      groups={groups}
      value={value}
      onChange={onChange}
      placeholder="Start typing an item…"
      fallback="Pick an item"
      style={style}
    />
  );
}

/**
 * The ability picker. `options` comes from abilityOptions() — a Pokémon's own
 * abilities normally, the whole modeled list on the sample set — and already
 * carries the "not in sim yet" marker.
 */
export function AbilitySelect({ options, value, onChange, style }) {
  const groups = [{ items: [{ key: "", label: "— no ability —", search: "no ability none" }] }];
  const byGroup = new Map();
  for (const opt of options) {
    const group = opt.group ?? "";
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group).push({
      key: opt.slug, label: opt.label, short: opt.short ?? opt.label.split(" · ")[0],
      search: opt.search ?? opt.label,
    });
  }
  for (const [label, list] of byGroup) groups.push({ label: label || undefined, items: list });

  return (
    <SearchPick
      groups={groups}
      value={value}
      onChange={onChange}
      placeholder="Start typing an ability…"
      fallback="Pick an ability"
      style={style}
    />
  );
}

export function StatBar({ value, max = 255, color }) {
  return (
    <div className="track">
      <div className="bar" style={{ width: `${Math.min(100, (value / max) * 100)}%`, background: color }} />
    </div>
  );
}
