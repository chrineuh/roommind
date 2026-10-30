/**
 * Read and write Home Assistant schedule helpers from the panel.
 *
 * UI-created helpers live in HA's schedule storage and can be changed through
 * schedule/update. Helpers defined in YAML cannot; their blocks are read via
 * the schedule.get_schedule action so they can be copied into a new helper.
 */
import type { HomeAssistant, ClimateMode } from "../types";

export const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface HaScheduleBlock {
  from: string;
  to: string;
  data?: Record<string, unknown>;
}

export type HaScheduleItem = { id: string; name: string; icon?: string } & Partial<
  Record<Weekday, HaScheduleBlock[]>
>;

export type HaWeek = Record<Weekday, HaScheduleBlock[]>;

/** The storage item behind a schedule entity, or null when it is defined in YAML. */
export async function getStorageSchedule(
  hass: HomeAssistant,
  entityId: string,
): Promise<HaScheduleItem | null> {
  const [entry, items] = await Promise.all([
    hass.callWS<{ unique_id: string }>({ type: "config/entity_registry/get", entity_id: entityId }),
    hass.callWS<HaScheduleItem[]>({ type: "schedule/list" }),
  ]);
  return items.find((i) => i.id === entry.unique_id) ?? null;
}

/** Weekly blocks of any schedule entity (also YAML ones) via schedule.get_schedule. */
export async function readScheduleBlocks(hass: HomeAssistant, entityId: string): Promise<HaWeek> {
  const result = await hass.callWS<{ response: Record<string, Partial<HaWeek>> }>({
    type: "call_service",
    domain: "schedule",
    service: "get_schedule",
    target: { entity_id: entityId },
    return_response: true,
  });
  const days = result.response?.[entityId] ?? {};
  return Object.fromEntries(WEEKDAYS.map((d) => [d, days[d] ?? []])) as HaWeek;
}

/** Target temperatures as the thermostat sends them, in the HA display unit. */
export interface TargetTemps {
  heat?: number;
  cool?: number;
}

export function targetsFromServiceData(
  data: Record<string, unknown>,
  mode: ClimateMode,
): TargetTemps | null {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const low = num(data.target_temp_low);
  const high = num(data.target_temp_high);
  const single = num(data.temperature);
  if (low !== undefined || high !== undefined) return { heat: low, cool: high };
  if (single === undefined) return null;
  return mode === "cool_only" ? { cool: single } : { heat: single };
}

/** Put the day temperature into every block of the week. */
export function applyDayTemperature(
  item: HaScheduleItem,
  mode: ClimateMode,
  temps: TargetTemps,
): HaWeek {
  const week = {} as HaWeek;
  for (const d of WEEKDAYS) {
    week[d] = (item[d] ?? []).map((b) => {
      const data: Record<string, unknown> = { ...(b.data ?? {}) };
      if (mode === "auto") {
        if (temps.heat !== undefined) data.heat_temperature = temps.heat;
        if (temps.cool !== undefined) data.cool_temperature = temps.cool;
        delete data.temperature;
      } else {
        const t = mode === "cool_only" ? temps.cool : temps.heat;
        if (t !== undefined) data.temperature = t;
      }
      return { from: b.from, to: b.to, data };
    });
  }
  return week;
}

/** Write the day temperature into a UI-created schedule. False when the schedule cannot be changed. */
export async function writeDayTemperature(
  hass: HomeAssistant,
  entityId: string,
  mode: ClimateMode,
  temps: TargetTemps,
): Promise<boolean> {
  const item = await getStorageSchedule(hass, entityId);
  if (!item) return false;
  const week = applyDayTemperature(item, mode, temps);
  // schedule/update replaces the whole item, so send name and icon along.
  await hass.callWS({
    type: "schedule/update",
    schedule_id: item.id,
    name: item.name,
    ...(item.icon ? { icon: item.icon } : {}),
    ...week,
  });
  return true;
}
