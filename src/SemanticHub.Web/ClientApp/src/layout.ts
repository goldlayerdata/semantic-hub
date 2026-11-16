// Grid layout engine (v3 design §4). Pure functions over grid items; no React, no DOM.
//
// Grid: 24 columns; rows are 16 px with 12 px gaps (a 28 px row pitch), so the design's row counts give the
// intended heights: KPI 5 rows ≈ 128 px, charts 11 ≈ 296 px, tables 12 ≈ 324 px.
// Vertical compaction: tiles float up and never leave holes; dropping onto a tile pushes it down.
import type { Tile, TileKind, TileLayout, TileSize } from "./types";

export const COLS = 24;
export const ROW_H = 16;
export const GAP = 12;
export const ROW_PITCH = ROW_H + GAP;
export const MAX_Y = 1000;
export const MAX_H = 60;
export const MIN_W = 4;

export type Item = { id: string; x: number; y: number; w: number; h: number };
export type Dir = "left" | "right" | "up" | "down" | "wider" | "narrower" | "taller" | "shorter";

const SIZE_W: Record<TileSize, number> = { small: 6, medium: 12, large: 18, full: 24 };

export function defaultHeight(kind: TileKind): number {
  return kind === "kpi" ? 5 : kind === "table" ? 12 : 11;
}
export function minHeight(kind: TileKind | undefined): number {
  return kind === "kpi" ? 4 : 3;
}
/** Server rule: size follows width (≤ 6 small, ≤ 12 medium, ≤ 18 large, else full). */
export function sizeFromWidth(w: number): TileSize {
  return w <= 6 ? "small" : w <= 12 ? "medium" : w <= 18 ? "large" : "full";
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function clampItem(it: Item, kind?: TileKind): Item {
  const w = clamp(Math.round(it.w), Math.min(MIN_W, COLS), COLS);
  const h = clamp(Math.round(it.h), minHeight(kind), MAX_H);
  const x = clamp(Math.round(it.x), 0, COLS - w);
  const y = clamp(Math.round(it.y), 0, MAX_Y);
  return { id: it.id, x, y, w, h };
}

export function collides(a: Item, b: Item): boolean {
  return a.id !== b.id && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
const overlapsX = (a: Item, b: Item) => a.x < b.x + b.w && b.x < a.x + a.w;

export const byPosition = (a: Item, b: Item) => a.y - b.y || a.x - b.x;
export const sortItems = (items: Item[]) => [...items].sort(byPosition);
export const bottom = (items: Item[]) => items.reduce((m, it) => Math.max(m, it.y + it.h), 0);

/**
 * Place items in the given order: each starts at its own y, is pushed below anything it collides with,
 * then floats up until it touches something. Earlier items win their spot.
 */
function settle(ordered: Item[]): Item[] {
  const placed: Item[] = [];
  for (const it of ordered) {
    let cur = { ...it, y: Math.max(0, it.y) };
    for (let guard = 0; guard < 500; guard++) {
      const hit = placed.find((p) => collides(cur, p));
      if (!hit) break;
      cur = { ...cur, y: hit.y + hit.h };
    }
    while (cur.y > 0 && !placed.some((p) => collides({ ...cur, y: cur.y - 1 }, p))) cur = { ...cur, y: cur.y - 1 };
    placed.push(cur);
  }
  return placed;
}

/** Float everything up so there are no holes, keeping the (y, x) order. */
export function compact(items: Item[]): Item[] {
  return settle(sortItems(items));
}

/**
 * Tiles with a stored layout keep it; tiles without one flow left-to-right below them
 * (width from size, height from kind). Then compact.
 */
export function autoPlace(tiles: Pick<Tile, "id" | "kind" | "size" | "layout">[], ignoreStored = false): Item[] {
  const fixed: Item[] = [];
  const loose: typeof tiles = [];
  for (const t of tiles) {
    if (!ignoreStored && t.layout) fixed.push(clampItem({ id: t.id, ...t.layout }, t.kind));
    else loose.push(t);
  }
  const flowed: Item[] = [];
  let x = 0;
  let y = bottom(fixed);
  let rowH = 0;
  for (const t of loose) {
    const w = SIZE_W[t.size] ?? 12;
    const h = defaultHeight(t.kind);
    if (x + w > COLS) {
      x = 0;
      y += rowH;
      rowH = 0;
    }
    flowed.push({ id: t.id, x, y, w, h });
    x += w;
    rowH = Math.max(rowH, h);
  }
  return compact([...fixed, ...flowed]);
}

/** Keep current positions for tiles we already have; place new tiles at the bottom. Drops removed tiles. */
export function mergeLayout(current: Item[], tiles: Pick<Tile, "id" | "kind" | "size" | "layout">[]): Item[] {
  const have = new Map(current.map((i) => [i.id, i]));
  const ids = new Set(tiles.map((t) => t.id));
  const kept = current.filter((i) => ids.has(i.id));
  const fresh = tiles.filter((t) => !have.has(t.id));
  if (!fresh.length) return compact(kept);
  let x = 0;
  let y = bottom(kept);
  let rowH = 0;
  const flowed = fresh.map((t) => {
    const w = SIZE_W[t.size] ?? 12;
    const h = defaultHeight(t.kind);
    if (x + w > COLS) {
      x = 0;
      y += rowH;
      rowH = 0;
    }
    const it = t.layout ? clampItem({ id: t.id, ...t.layout }, t.kind) : { id: t.id, x, y, w, h };
    if (!t.layout) {
      x += w;
      rowH = Math.max(rowH, h);
    }
    return it;
  });
  return compact([...kept, ...flowed]);
}

/**
 * Move one item to (x, y) and reflow. Order decides who gets the spot: the moved item goes after a
 * tile it overlaps (in columns) once its bottom passes that tile's middle when moving down, or stays
 * after it until its top passes that tile's middle when moving up. Then everything settles upward.
 */
export function moveItem(items: Item[], id: string, x: number, y: number, kind?: TileKind): Item[] {
  const orig = items.find((i) => i.id === id);
  if (!orig) return items;
  const moved = clampItem({ ...orig, x, y }, kind);
  let others = sortItems(items.filter((i) => i.id !== id));

  // Sideways drag within the tile's own row (tiles that start on the same row line): reorder the row by
  // centre position and pack it left to right, like a sortable list. Neighbours trade places as soon as the
  // dragged tile's centre passes theirs, instead of being pushed down a row.
  const row = others.filter((o) => o.y === orig.y);
  const rowWidth = row.reduce((s, o) => s + o.w, orig.w);
  if (row.length > 0 && Math.abs(moved.y - orig.y) < orig.h / 2 && rowWidth <= COLS) {
    const centre = (o: Item) => o.x + o.w / 2;
    const members = [...row, { ...moved, y: orig.y }].sort((a, b) => centre(a) - centre(b) || (a.id === id ? -1 : 1));
    let cx = Math.min(...members.map((o) => (o.id === id ? orig.x : o.x)));
    if (cx + rowWidth > COLS) cx = COLS - rowWidth;
    const packed = members.map((o) => {
      const p = { ...o, x: cx, y: orig.y };
      cx += o.w;
      return p;
    });
    const rowIds = new Set(packed.map((p) => p.id));
    return settle(sortItems([...packed, ...others.filter((o) => !rowIds.has(o.id))]));
  }
  // Within the same row band, the tile it lands on takes the vacated slot when it fits there (a swap),
  // so reordering a row of KPIs keeps the row; otherwise it gets pushed down as usual.
  const band = (o: Item) => o.y < orig.y + orig.h && orig.y < o.y + o.h;
  const area = (o: Item) =>
    Math.max(0, Math.min(o.x + o.w, moved.x + moved.w) - Math.max(o.x, moved.x)) * Math.max(0, Math.min(o.y + o.h, moved.y + moved.h) - Math.max(o.y, moved.y));
  const hit = others.filter((o) => band(o) && collides(o, moved)).sort((a, b) => area(b) - area(a))[0];
  if (hit && band(moved)) {
    const sx = Math.min(Math.max(0, moved.x > orig.x ? orig.x : orig.x + orig.w - hit.w), COLS - hit.w);
    const swapped = { ...hit, x: sx };
    if (!collides(swapped, moved) && !others.some((o) => o.id !== hit.id && collides(swapped, o))) others = sortItems(others.map((o) => (o.id === hit.id ? swapped : o)));
  }
  const mustFollow = (o: Item) => {
    if (!overlapsX(moved, o)) return o.y < moved.y || (o.y === moved.y && o.x < moved.x);
    // Same row band as where the tile started: the dropped tile wins the spot and pushes it down.
    const sameBand = o.y < orig.y + orig.h && orig.y < o.y + o.h;
    if (sameBand) return o.y + o.h <= moved.y;
    // Above/below: swap once the moved tile's leading edge passes the other tile's middle.
    const mid = o.y + o.h / 2;
    const wasBefore = byPosition(orig, o) < 0;
    return wasBefore ? moved.y + moved.h > mid : moved.y >= mid;
  };
  // Partition rather than insert at one index: a tile in another column must not decide the order
  // relative to the tiles the moved one actually lands on.
  const ordered = [...others.filter(mustFollow), moved, ...others.filter((o) => !mustFollow(o))];
  return settle(ordered);
}

/** Resize one item (top-left stays); colliding tiles get pushed down, then everything compacts. */
export function resizeItem(items: Item[], id: string, w: number, h: number, kind?: TileKind): Item[] {
  const orig = items.find((i) => i.id === id);
  if (!orig) return items;
  const resized = clampItem({ ...orig, w: Math.min(w, COLS - orig.x), h }, kind);
  const others = sortItems(items.filter((i) => i.id !== id));
  // The resized tile keeps priority over anything in its columns that starts at or below its top.
  const before = others.filter((o) => byPosition(o, orig) < 0 && !(overlapsX(o, resized) && o.y >= orig.y));
  const after = others.filter((o) => !before.includes(o));
  return settle([...before, resized, ...after]);
}

/** One keyboard / Arrange-menu step. Up/down swap with the nearest tile above/below in the same columns. */
export function nudge(items: Item[], id: string, dir: Dir, kind?: TileKind): Item[] {
  const it = items.find((i) => i.id === id);
  if (!it) return items;
  switch (dir) {
    case "left":
      return moveItem(items, id, it.x - 2, it.y, kind);
    case "right":
      return moveItem(items, id, it.x + 2, it.y, kind);
    case "up": {
      const above = items.filter((o) => o.id !== id && overlapsX(o, it) && o.y + o.h <= it.y).sort((a, b) => b.y + b.h - (a.y + a.h))[0];
      return above ? moveItem(items, id, it.x, above.y, kind) : items;
    }
    case "down": {
      const below = items.filter((o) => o.id !== id && overlapsX(o, it) && o.y >= it.y + it.h).sort((a, b) => a.y - b.y)[0];
      return below ? moveItem(items, id, it.x, below.y + below.h - it.h + 1, kind) : items;
    }
    case "wider":
      return resizeItem(items, id, it.w + 2, it.h, kind);
    case "narrower":
      return resizeItem(items, id, it.w - 2, it.h, kind);
    case "taller":
      return resizeItem(items, id, it.w, it.h + 2, kind);
    case "shorter":
      return resizeItem(items, id, it.w, it.h - 2, kind);
  }
}

export function sameLayout(a: Item[], b: Item[]): boolean {
  if (a.length !== b.length) return false;
  const m = new Map(b.map((i) => [i.id, i]));
  return a.every((i) => {
    const o = m.get(i.id);
    return !!o && o.x === i.x && o.y === i.y && o.w === i.w && o.h === i.h;
  });
}

export const toLayout = (i: Item): TileLayout => ({ x: i.x, y: i.y, w: i.w, h: i.h });

/** Pixel geometry for a container width. */
export function geometry(width: number) {
  const colW = Math.max(1, (width - (COLS - 1) * GAP) / COLS);
  const colPitch = colW + GAP;
  return {
    colW,
    colPitch,
    rowPitch: ROW_PITCH,
    rect: (i: Item) => ({ left: i.x * colPitch, top: i.y * ROW_PITCH, width: i.w * colW + (i.w - 1) * GAP, height: i.h * ROW_H + (i.h - 1) * GAP }),
    height: (items: Item[]) => Math.max(0, bottom(items) * ROW_PITCH - GAP),
  };
}
