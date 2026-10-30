/**
 * Boiler history from Home Assistant's recorder, and the figures the heating
 * tab derives from it (burner starts, runtimes, oil used, release reasons).
 */
import type { HomeAssistant } from "../types";

export interface HistoryPoint {
  ts: number; // ms
  state: string;
  attributes?: Record<string, unknown>;
}

type CompressedState = { s: string; a?: Record<string, unknown>; lu?: number; lc?: number };

/** States of the given entities in [start, end], oldest first. */
export async function fetchHistory(
  hass: HomeAssistant,
  entityIds: string[],
  start: number,
  end: number,
  withAttributes = false,
): Promise<Record<string, HistoryPoint[]>> {
  const ids = [...new Set(entityIds.filter(Boolean))];
  if (ids.length === 0) return {};
  const result = await hass.callWS<Record<string, CompressedState[]>>({
    type: "history/history_during_period",
    start_time: new Date(start).toISOString(),
    end_time: new Date(end).toISOString(),
    entity_ids: ids,
    minimal_response: !withAttributes,
    no_attributes: !withAttributes,
    significant_changes_only: false,
  });
  const out: Record<string, HistoryPoint[]> = {};
  for (const [eid, states] of Object.entries(result ?? {})) {
    out[eid] = states.map((st) => ({
      ts: (st.lu ?? st.lc ?? start / 1000) * 1000,
      state: st.s,
      attributes: st.a,
    }));
  }
  return out;
}

/** Same rule as the backend: on/heat/heating/true/running, or a number above 0. */
export function isOnState(state: string | undefined): boolean | null {
  if (state === undefined || state === "unavailable" || state === "unknown" || state === "") {
    return null;
  }
  const v = state.toLowerCase();
  if (["on", "heat", "heating", "true", "running"].includes(v)) return true;
  const n = Number(v);
  return Number.isFinite(n) ? n > 0 : false;
}

export interface OnInterval {
  start: number;
  end: number;
}

/** Periods in which the entity was on, clipped to [start, end]. */
export function onIntervals(points: HistoryPoint[], start: number, end: number): OnInterval[] {
  const out: OnInterval[] = [];
  let since: number | null = null;
  for (const p of points) {
    const ts = Math.max(start, Math.min(end, p.ts));
    const on = isOnState(p.state) === true;
    if (on && since === null) since = ts;
    else if (!on && since !== null) {
      if (ts > since) out.push({ start: since, end: ts });
      since = null;
    }
  }
  if (since !== null && end > since) out.push({ start: since, end });
  return out;
}

export interface OnStats {
  starts: number;
  onHours: number;
  avgRunMinutes: number | null;
}

/** Starts count off→on changes inside the range; a run already going at the start is not a start. */
export function onStats(points: HistoryPoint[], start: number, end: number): OnStats {
  const intervals = onIntervals(points, start, end);
  const starts = intervals.filter((i) => i.start > start).length;
  const onMs = intervals.reduce((sum, i) => sum + (i.end - i.start), 0);
  return {
    starts,
    onHours: onMs / 3_600_000,
    avgRunMinutes: intervals.length ? onMs / intervals.length / 60_000 : null,
  };
}

/** Consumption from a meter reading: sum of increases, so a reset or refill does not count negative. */
export function meterIncrease(points: HistoryPoint[]): number | null {
  let total = 0;
  let prev: number | null = null;
  let seen = false;
  for (const p of points) {
    const v = Number(p.state);
    if (!Number.isFinite(v)) continue;
    if (prev !== null && v > prev) total += v - prev;
    prev = v;
    seen = true;
  }
  return seen ? total : null;
}

/** Time spent per attribute value (e.g. the release reason), in hours. */
export function attributeDurations(
  points: HistoryPoint[],
  attribute: string,
  start: number,
  end: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = 0; i < points.length; i++) {
    const value = points[i].attributes?.[attribute];
    if (typeof value !== "string") continue;
    const from = Math.max(start, points[i].ts);
    const to = Math.min(end, i + 1 < points.length ? points[i + 1].ts : end);
    if (to > from) out[value] = (out[value] ?? 0) + (to - from) / 3_600_000;
  }
  return out;
}

/** Numeric series [ms, value] for a chart. */
export function numericSeries(points: HistoryPoint[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const p of points) {
    const v = Number(p.state);
    if (Number.isFinite(v)) out.push([p.ts, v]);
  }
  return out;
}
