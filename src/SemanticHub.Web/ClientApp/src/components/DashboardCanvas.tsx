import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useSensor,
  useSensors,
  type Announcements,
  type DragMoveEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
  type PointerSensorOptions,
} from "@dnd-kit/core";
import { Move, X } from "lucide-react";
import { geometry, moveItem, resizeItem, sameLayout, sortItems, type Item } from "../layout";
import type { TileState } from "../stores/dashboard";
import type { Tile } from "../types";
import { cx } from "../util";
import { TileCard, type DragBinding, type TileActions } from "./Tile";

/** Below this canvas width the grid can't fit: one read-only column ordered by (y, x). D7. */
export const NARROW_PX = 900;
const HINT_KEY = "sh-hint-arrange";

// Pixel size of one grid step, shared with the keyboard sensor's coordinate getter.
const pitch = { x: 50, y: 28 };

/** Pointer drag starts only from the tile header, never from its buttons, menus or the resize corner. */
class HeaderPointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: "onPointerDown" as const,
      handler: (event: React.PointerEvent, options: PointerSensorOptions) => {
        const t = event.nativeEvent.target as HTMLElement | null;
        if (t?.closest("button, input, select, textarea, a, .resize-handle, .popover, [role=menuitem]")) return false;
        const e = event.nativeEvent;
        if (!e.isPrimary || e.button !== 0) return false;
        options.onActivation?.({ event: e });
        return true;
      },
    },
  ];
}

/** Keyboard drag only from the grip (Space/Enter), so Enter on the tile menu button still opens the menu. */
class GripKeyboardSensor extends KeyboardSensor {
  static activators = [
    {
      eventName: "onKeyDown" as const,
      handler: (event: React.KeyboardEvent, opts: Parameters<(typeof KeyboardSensor.activators)[0]["handler"]>[1], ctx: Parameters<(typeof KeyboardSensor.activators)[0]["handler"]>[2]) => {
        if (!(event.target as HTMLElement).closest?.(".tile-grip")) return false;
        return KeyboardSensor.activators[0].handler(event, opts, ctx);
      },
    },
  ];
}

/** Arrow keys move by two columns / three rows, so a few presses cross a neighbour's middle and swap. */
const gridCoordinates: KeyboardCoordinateGetter = (event, { currentCoordinates }) => {
  switch (event.code) {
    case "ArrowRight":
      return { ...currentCoordinates, x: currentCoordinates.x + pitch.x * 2 };
    case "ArrowLeft":
      return { ...currentCoordinates, x: currentCoordinates.x - pitch.x * 2 };
    case "ArrowDown":
      return { ...currentCoordinates, y: currentCoordinates.y + pitch.y * 3 };
    case "ArrowUp":
      return { ...currentCoordinates, y: currentCoordinates.y - pitch.y * 3 };
  }
  return undefined;
};

type Props = {
  modelId: string;
  tiles: Tile[];
  layout: Item[];
  results: Record<string, TileState>;
  filtersActive: boolean;
  offline: boolean;
  locked: boolean;
  actions: TileActions;
  onCommit: (next: Item[]) => void;
};

type Gesture = { kind: "drag" | "resize"; id: string; start: Item[]; preview: Item[] };

export function DashboardCanvas({ modelId, tiles, layout, results, filtersActive, offline, locked, actions, onCommit }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  gestureRef.current = gesture;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [width > 0 && width < NARROW_PX]);

  const narrow = width > 0 && width < NARROW_PX;
  const arrangeable = !locked && !narrow;
  const g = useMemo(() => geometry(width || 1200), [width]);
  pitch.x = g.colPitch;
  pitch.y = g.rowPitch;

  const byId = useMemo(() => new Map(tiles.map((t) => [t.id, t])), [tiles]);
  const shown = gesture?.preview ?? layout;

  const sensors = useSensors(
    useSensor(HeaderPointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(GripKeyboardSensor, { coordinateGetter: gridCoordinates }),
  );

  const onDragStart = (e: DragStartEvent) => {
    const id = String(e.active.id);
    setGesture({ kind: "drag", id, start: layout, preview: layout });
  };
  const onDragMove = (e: DragMoveEvent) => {
    const cur = gestureRef.current;
    if (!cur || cur.kind !== "drag") return;
    const orig = cur.start.find((i) => i.id === cur.id);
    if (!orig) return;
    const dx = Math.round(e.delta.x / g.colPitch);
    const dy = Math.round(e.delta.y / g.rowPitch);
    const preview = moveItem(cur.start, cur.id, orig.x + dx, orig.y + dy, byId.get(cur.id)?.kind);
    if (!sameLayout(preview, cur.preview)) setGesture({ ...cur, preview });
  };
  const onDragEnd = () => {
    const cur = gestureRef.current;
    setGesture(null);
    if (cur && !sameLayout(cur.preview, cur.start)) onCommit(cur.preview);
  };
  const onDragCancel = () => setGesture(null);

  // Corner resize: plain pointer events (one axis pair, snapped to the grid); Escape cancels.
  const startResize = useCallback(
    (id: string) => (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const start = layout;
      const orig = start.find((i) => i.id === id);
      if (!orig) return;
      const x0 = e.clientX;
      const y0 = e.clientY;
      const kind = byId.get(id)?.kind;
      let current: Gesture = { kind: "resize", id, start, preview: start };
      setGesture(current);
      const move = (ev: PointerEvent) => {
        const dw = Math.round((ev.clientX - x0) / g.colPitch);
        const dh = Math.round((ev.clientY - y0) / g.rowPitch);
        const preview = resizeItem(start, id, orig.w + dw, orig.h + dh, kind);
        if (!sameLayout(preview, current.preview)) {
          current = { ...current, preview };
          setGesture(current);
        }
      };
      const done = (commit: boolean) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("keydown", key, true);
        document.body.classList.remove("is-resizing");
        setGesture(null);
        if (commit && !sameLayout(current.preview, start)) onCommit(current.preview);
      };
      const up = () => done(true);
      const key = (ev: KeyboardEvent) => {
        if (ev.key === "Escape") {
          ev.stopPropagation();
          done(false);
        }
      };
      document.body.classList.add("is-resizing");
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("keydown", key, true);
    },
    [layout, byId, g, onCommit],
  );

  const titleOf = (id: unknown) => byId.get(String(id))?.title ?? "tile";
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${titleOf(active.id)}. Use the arrow keys to move it, Space to drop, Escape to cancel.`,
    onDragOver: ({ active }) => `${titleOf(active.id)} is moving.`,
    onDragMove: () => undefined,
    onDragEnd: ({ active }) => `Dropped ${titleOf(active.id)}. The layout is saved automatically.`,
    onDragCancel: ({ active }) => `Moving ${titleOf(active.id)} was cancelled; it is back where it was.`,
  };

  if (narrow) {
    return (
      <div ref={ref} className="canvas-wrap canvas-narrow">
        <p className="canvas-note small muted">
          <Move size={13} aria-hidden /> Widen the window to rearrange tiles.
        </p>
        {sortItems(layout).map((it) => {
          const t = byId.get(it.id);
          if (!t) return null;
          return (
            <div key={it.id} className="canvas-cell-narrow" style={{ height: t.kind === "kpi" ? undefined : g.rect(it).height }}>
              <TileCard modelId={modelId} tile={t} state={results[t.id]} filtersActive={filtersActive} offline={offline} arrangeable={false} {...actions} />
            </div>
          );
        })}
      </div>
    );
  }

  const active = gesture ? shown.find((i) => i.id === gesture.id) : undefined;
  const height = Math.max(g.height(shown), gesture ? g.height(gesture.start) : 0);

  return (
    <div ref={ref} className="canvas-wrap">
      {arrangeable && <ArrangeHint />}
      <DndContext sensors={sensors} onDragStart={onDragStart} onDragMove={onDragMove} onDragEnd={onDragEnd} onDragCancel={onDragCancel} accessibility={{ announcements }} autoScroll={{ threshold: { x: 0, y: 0.15 } }}>
        <div className={cx("canvas", gesture && "is-arranging", locked && "is-locked")} style={{ height: width ? height : undefined }}>
          {width > 0 &&
            shown.map((it) => {
              const t = byId.get(it.id);
              if (!t) return null;
              const dragging = gesture?.kind === "drag" && gesture.id === it.id;
              // The dragged tile stays anchored at its start cell and follows the pointer via dnd-kit's transform.
              const anchor = dragging ? gesture!.start.find((s) => s.id === it.id) ?? it : it;
              return (
                <CanvasTile
                  key={it.id}
                  item={anchor}
                  rect={g.rect(anchor)}
                  tile={t}
                  dragging={dragging}
                  resizing={gesture?.kind === "resize" && gesture.id === it.id}
                  arrangeable={arrangeable}
                  onResizeStart={startResize(it.id)}
                  cardProps={{ modelId, state: results[t.id], filtersActive, offline, ...actions }}
                />
              );
            })}
          {active && <div className={cx("canvas-placeholder", gesture?.kind === "resize" && "is-resize")} style={rectStyle(g.rect(active))} aria-hidden />}
        </div>
      </DndContext>
    </div>
  );
}

const rectStyle = (r: { left: number; top: number; width: number; height: number }): CSSProperties => ({
  transform: `translate3d(${r.left}px, ${r.top}px, 0)`,
  width: r.width,
  height: r.height,
});

type CardProps = Omit<React.ComponentProps<typeof TileCard>, "tile" | "arrangeable" | "drag" | "dragging">;

function CanvasTile({
  item,
  rect,
  tile,
  dragging,
  resizing,
  arrangeable,
  onResizeStart,
  cardProps,
}: {
  item: Item;
  rect: { left: number; top: number; width: number; height: number };
  tile: Tile;
  dragging: boolean;
  resizing: boolean;
  arrangeable: boolean;
  onResizeStart: (e: React.PointerEvent) => void;
  cardProps: CardProps;
}) {
  const { setNodeRef, setActivatorNodeRef, listeners, attributes, transform } = useDraggable({ id: item.id, disabled: !arrangeable });
  const style: CSSProperties = {
    transform: `translate3d(${rect.left + (dragging && transform ? transform.x : 0)}px, ${rect.top + (dragging && transform ? transform.y : 0)}px, 0)`,
    width: rect.width,
    height: rect.height,
  };
  // Listeners go on the whole header (pointer drag from the title; keydown bubbles up from the grip),
  // while the grip is the activator node, because dnd-kit's keyboard sensor only starts from that node.
  const { role: _role, tabIndex: _tab, ...aria } = attributes;
  void _role;
  void _tab;
  const drag: DragBinding = {
    gripRef: setActivatorNodeRef,
    headerProps: listeners ?? {},
    gripProps: aria,
    onResizeStart,
  };
  return (
    <div ref={setNodeRef} className={cx("canvas-cell", dragging && "is-dragging", resizing && "is-resizing")} style={style}>
      <TileCard {...cardProps} tile={tile} arrangeable={arrangeable} drag={drag} dragging={dragging} />
    </div>
  );
}

function ArrangeHint() {
  const [show, setShow] = useState(() => {
    try {
      return localStorage.getItem(HINT_KEY) !== "1";
    } catch {
      return true;
    }
  });
  if (!show) return null;
  return (
    <div className="arrange-hint" role="note">
      <Move size={14} aria-hidden />
      <span>
        <strong>Drag tiles by their title</strong> to rearrange; resize from the bottom-right corner. Changes save automatically — Undo is one click away.
      </span>
      <button
        type="button"
        className="icon-btn"
        aria-label="Dismiss tip"
        onClick={() => {
          setShow(false);
          try {
            localStorage.setItem(HINT_KEY, "1");
          } catch {
            /* fine: hint shows again next time */
          }
        }}
      >
        <X size={14} aria-hidden />
      </button>
    </div>
  );
}
