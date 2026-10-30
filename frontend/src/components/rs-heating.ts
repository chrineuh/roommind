/**
 * rs-heating – Heating tab: everything about a boiler (e.g. oil heating) in one place.
 *
 * Per compressor group with a heat release: live status, what RoomMind has
 * learned about the boiler, figures and a timeline from HA's recorder
 * (release, burner, pump, hot water, boiler temperature, oil) and the
 * boiler settings. The rooms/thermostats of a group are still chosen under
 * Settings → compressor protection.
 */
import { LitElement, html, css, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type {
  HomeAssistant,
  CompressorGroup,
  CompressorReleaseStatus,
  GlobalSettings,
} from "../types";
import { localize } from "../utils/localize";
import { fireSaveStatus } from "../utils/events";
import { inputStyles } from "../styles/input-styles";
import {
  fetchHistory,
  onIntervals,
  onStats,
  meterIncrease,
  attributeDurations,
  numericSeries,
  type HistoryPoint,
  type OnStats,
} from "../utils/heating-history";

type RangeKey = "24h" | "7d" | "30d";
const RANGE_MS: Record<RangeKey, number> = {
  "24h": 24 * 3_600_000,
  "7d": 7 * 24 * 3_600_000,
  "30d": 30 * 24 * 3_600_000,
};

/** Same id the backend gives the group's heat demand sensor. */
export function heatingSensorId(groupId: string): string {
  return `sensor.roommind_heating_${groupId.replace(/-/g, "").slice(0, 8).toLowerCase()}`;
}

interface Figures {
  release: OnStats | null;
  burner: OnStats | null;
  pump: OnStats | null;
  dhw: OnStats | null;
  oilMeasured: number | null;
  oilUnit: string;
  oilEstimated: number | null;
  boilerAvg: number | null;
  boilerMax: number | null;
  reasons: Record<string, number>;
}

const LANES: Array<{ key: "release" | "burner" | "pump" | "dhw"; color: string }> = [
  { key: "release", color: "rgba(255, 152, 0, 0.55)" },
  { key: "burner", color: "rgba(244, 67, 54, 0.6)" },
  { key: "pump", color: "rgba(33, 150, 243, 0.55)" },
  { key: "dhw", color: "rgba(156, 39, 176, 0.55)" },
];

@customElement("rs-heating")
export class RsHeating extends LitElement {
  @property({ attribute: false }) public hass!: HomeAssistant;
  @property({ attribute: false }) public releaseStatus: Record<string, CompressorReleaseStatus> =
    {};

  @state() private _groups: CompressorGroup[] = [];
  @state() private _loaded = false;
  @state() private _selected = "";
  @state() private _range: RangeKey = "24h";
  @state() private _history: Record<string, HistoryPoint[]> = {};
  @state() private _historyLoading = false;
  @state() private _historyKey = "";

  private _saveDebounce?: ReturnType<typeof setTimeout>;
  private _saveChain: Promise<void> = Promise.resolve();

  connectedCallback() {
    super.connectedCallback();
    void this._loadSettings();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._saveDebounce) {
      clearTimeout(this._saveDebounce);
      this._saveDebounce = undefined;
      void this._save();
    }
  }

  private async _loadSettings() {
    try {
      const res = await this.hass.callWS<{ settings: GlobalSettings }>({
        type: "roommind/settings/get",
      });
      this._groups = res.settings.compressor_groups ?? [];
      const withRelease = this._groups.find((g) => g.release_entity);
      if (!this._groups.some((g) => g.id === this._selected)) {
        this._selected = (withRelease ?? this._groups[0])?.id ?? "";
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.debug("[RoomMind] heating settings:", err);
    } finally {
      this._loaded = true;
    }
  }

  private get _group(): CompressorGroup | undefined {
    return this._groups.find((g) => g.id === this._selected);
  }

  protected updated(): void {
    const g = this._group;
    if (!g?.release_entity) return;
    const key = [
      g.id,
      this._range,
      g.release_entity,
      g.burner_entity,
      g.pump_entity,
      g.dhw_entity,
      g.boiler_temp_sensor,
      g.oil_sensor,
    ].join("|");
    if (key !== this._historyKey) {
      this._historyKey = key;
      void this._loadHistory(g);
    }
  }

  private async _loadHistory(g: CompressorGroup) {
    const key = this._historyKey;
    const end = Date.now();
    const start = end - RANGE_MS[this._range];
    this._historyLoading = true;
    try {
      const plain = await fetchHistory(
        this.hass,
        [
          g.release_entity ?? "",
          g.burner_entity ?? "",
          g.pump_entity ?? "",
          g.dhw_entity ?? "",
          g.boiler_temp_sensor ?? "",
          g.oil_sensor ?? "",
        ],
        start,
        end,
      );
      let withAttrs: Record<string, HistoryPoint[]> = {};
      try {
        withAttrs = await fetchHistory(this.hass, [heatingSensorId(g.id)], start, end, true);
      } catch {
        // sensor not created yet
      }
      if (key === this._historyKey) this._history = { ...plain, ...withAttrs };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.debug("[RoomMind] heating history:", err);
      if (key === this._historyKey) this._history = {};
    } finally {
      if (key === this._historyKey) this._historyLoading = false;
    }
  }

  // ─── Render ─────────────────────────────────────────────────────

  render() {
    const l = this.hass.language;
    if (!this._loaded) return html`<div class="empty">${localize("panel.loading", l)}</div>`;
    if (this._groups.length === 0) {
      return html`<div class="empty">
        <ha-icon icon="mdi:water-boiler" class="big-icon"></ha-icon>
        <p>${localize("heating.no_groups", l)}</p>
      </div>`;
    }
    const g = this._group;
    return html`
      ${
        this._groups.length > 1
          ? html`<div class="chips">
              ${this._groups.map(
                (grp) =>
                  html`<button
                    class="chip ${grp.id === this._selected ? "selected" : ""}"
                    @click=${() => (this._selected = grp.id)}
                  >
                    ${grp.name || localize("heating.unnamed", l)}
                  </button>`,
              )}
            </div>`
          : nothing
      }
      ${
        g
          ? g.release_entity
            ? html`${this._renderStatus(g)} ${this._renderAnalysis(g)} ${this._renderSettings(g)}`
            : this._renderSettings(g)
          : nothing
      }
    `;
  }

  private _card(icon: string, title: string, body: TemplateResult, extra?: TemplateResult) {
    return html`<ha-card>
      <div class="card-header">
        <ha-icon .icon=${icon}></ha-icon>
        <span class="card-title">${title}</span>
        ${extra ?? nothing}
      </div>
      <div class="card-body">${body}</div>
    </ha-card>`;
  }

  private _renderStatus(g: CompressorGroup) {
    const l = this.hass.language;
    const st = this.releaseStatus[g.id];
    const onOff = (v: boolean | null | undefined) =>
      v === null || v === undefined
        ? localize("heating.unknown", l)
        : localize(v ? "heating.on" : "heating.off", l);
    const tile = (icon: string, label: string, value: string, active = false, hint = "") =>
      html`<div class="tile ${active ? "active" : ""}">
        <ha-icon .icon=${icon}></ha-icon>
        <div>
          <div class="tile-label">${label}</div>
          <div class="tile-value">${value}</div>
          ${hint ? html`<div class="tile-hint">${hint}</div>` : nothing}
        </div>
      </div>`;
    const unknown = localize("compressor.boiler_learning", l);
    const body = st
      ? html`
          <div class="tiles">
            ${tile(
              st.on ? "mdi:fire" : "mdi:fire-off",
              localize("heating.release", l),
              onOff(st.on),
              st.on,
              localize(`compressor.release_reason.${st.reason}` as never, l),
            )}
            ${tile(
              "mdi:home-thermometer",
              localize("heating.demand", l),
              localize("heating.demand_value", l, {
                count: st.demand_count,
                weighted: st.weighted_demand.toFixed(1),
              }),
            )}
            ${
              g.boiler_temp_sensor
                ? tile(
                    "mdi:thermometer-water",
                    localize("heating.boiler_temp", l),
                    st.boiler_temp != null ? `${st.boiler_temp.toFixed(1)} °C` : "–",
                    false,
                    st.lead_minutes
                      ? localize("compressor.boiler_lead", l, { min: st.lead_minutes })
                      : st.warm_minutes
                        ? localize("compressor.boiler_warm", l, { min: st.warm_minutes })
                        : "",
                  )
                : nothing
            }
            ${
              g.burner_entity
                ? tile(
                    "mdi:fire-circle",
                    localize("heating.burner", l),
                    onOff(st.burner_on),
                    !!st.burner_on,
                  )
                : nothing
            }
            ${
              g.pump_entity
                ? tile("mdi:pump", localize("heating.pump", l), onOff(st.pump_on), !!st.pump_on)
                : nothing
            }
            ${
              g.dhw_entity
                ? tile(
                    "mdi:water-thermometer",
                    localize("heating.dhw", l),
                    onOff(st.dhw_on),
                    !!st.dhw_on,
                  )
                : nothing
            }
          </div>
          ${
            g.boiler_temp_sensor
              ? html`<div class="learned">
                  <div class="section-label">${localize("heating.learned", l)}</div>
                  <div class="learned-row">
                    <span
                      >${localize("heating.heat_rate", l)}:
                      <b>${st.heat_rate ? `${st.heat_rate.toFixed(2)} K/min` : unknown}</b></span
                    >
                    <span
                      >${localize("heating.cool_rate", l)}:
                      <b>${st.cool_rate ? `${st.cool_rate.toFixed(2)} K/min` : unknown}</b></span
                    >
                    <ha-button @click=${() => this._resetLearning(g)}>
                      ${localize("heating.reset_learning", l)}
                    </ha-button>
                  </div>
                  <div class="hint">${localize("heating.learned_hint", l)}</div>
                </div>`
              : nothing
          }
        `
      : html`<div class="hint">${localize("heating.waiting_status", l)}</div>`;
    return this._card("mdi:water-boiler", localize("heating.status", l), body);
  }

  private _figures(g: CompressorGroup, start: number, end: number): Figures {
    const h = this._history;
    const stats = (eid?: string) => (eid && h[eid] ? onStats(h[eid], start, end) : null);
    const burner = stats(g.burner_entity);
    const boiler = g.boiler_temp_sensor ? numericSeries(h[g.boiler_temp_sensor] ?? []) : [];
    const oilPoints = g.oil_sensor ? (h[g.oil_sensor] ?? []) : [];
    const nozzle = g.oil_nozzle_lph ?? 0;
    return {
      release: stats(g.release_entity),
      burner,
      pump: stats(g.pump_entity),
      dhw: stats(g.dhw_entity),
      oilMeasured: g.oil_sensor ? meterIncrease(oilPoints) : null,
      oilUnit:
        (this.hass.states[g.oil_sensor ?? ""]?.attributes?.unit_of_measurement as string) || "L",
      oilEstimated: burner && nozzle > 0 ? burner.onHours * nozzle : null,
      boilerAvg: boiler.length ? boiler.reduce((s, [, v]) => s + v, 0) / boiler.length : null,
      boilerMax: boiler.length ? Math.max(...boiler.map(([, v]) => v)) : null,
      reasons: attributeDurations(h[heatingSensorId(g.id)] ?? [], "reason", start, end),
    };
  }

  private _renderAnalysis(g: CompressorGroup) {
    const l = this.hass.language;
    const end = Date.now();
    const start = end - RANGE_MS[this._range];
    const f = this._figures(g, start, end);
    const hours = (v: number) => `${v.toFixed(1)} h`;
    const kpi = (label: string, value: string, hint = "") =>
      html`<div class="kpi">
        <div class="kpi-value">${value}</div>
        <div class="kpi-label">${label}</div>
        ${hint ? html`<div class="kpi-hint">${hint}</div>` : nothing}
      </div>`;
    const burnerLike = f.burner ?? f.release;
    const burnerLabel = f.burner ? "heating.burner" : "heating.release";
    const totalReason = Object.values(f.reasons).reduce((a, b) => a + b, 0);

    const rangeButtons = html`<div class="range">
      ${(Object.keys(RANGE_MS) as RangeKey[]).map(
        (r) =>
          html`<button
            class="chip small ${r === this._range ? "selected" : ""}"
            @click=${() => (this._range = r)}
          >
            ${localize(`heating.range.${r}` as never, l)}
          </button>`,
      )}
    </div>`;

    const body = html`
      ${this._historyLoading ? html`<div class="hint">${localize("panel.loading", l)}</div>` : nothing}
      <div class="kpis">
        ${
          burnerLike
            ? html`${kpi(
                localize("heating.kpi_starts", l, { what: localize(burnerLabel as never, l) }),
                String(burnerLike.starts),
                burnerLike.avgRunMinutes != null
                  ? localize("heating.kpi_avg_run", l, {
                      min: Math.round(burnerLike.avgRunMinutes),
                    })
                  : "",
              )}
              ${kpi(
                localize("heating.kpi_runtime", l, { what: localize(burnerLabel as never, l) }),
                hours(burnerLike.onHours),
              )}`
            : nothing
        }
        ${f.burner && f.release ? kpi(localize("heating.kpi_release_time", l), hours(f.release.onHours)) : nothing}
        ${
          f.oilMeasured != null
            ? kpi(localize("heating.kpi_oil", l), `${f.oilMeasured.toFixed(1)} ${f.oilUnit}`)
            : f.oilEstimated != null
              ? kpi(
                  localize("heating.kpi_oil", l),
                  `≈ ${f.oilEstimated.toFixed(1)} L`,
                  localize("heating.kpi_oil_estimated", l),
                )
              : nothing
        }
        ${f.pump ? kpi(localize("heating.kpi_pump", l), hours(f.pump.onHours)) : nothing}
        ${
          f.dhw
            ? kpi(
                localize("heating.kpi_dhw", l),
                hours(f.dhw.onHours),
                localize("heating.kpi_dhw_count", l, { count: f.dhw.starts }),
              )
            : nothing
        }
        ${
          f.boilerAvg != null
            ? kpi(
                localize("heating.kpi_boiler", l),
                `${f.boilerAvg.toFixed(0)} °C`,
                localize("heating.kpi_boiler_max", l, { max: (f.boilerMax ?? 0).toFixed(0) }),
              )
            : nothing
        }
      </div>
      ${this._renderChart(g, start, end)}
      ${
        totalReason > 0
          ? html`<div class="section-label">${localize("heating.reasons", l)}</div>
              <div class="reasons">
                ${Object.entries(f.reasons)
                  .sort((a, b) => b[1] - a[1])
                  .map(
                    ([reason, h]) =>
                      html`<div class="reason-row">
                        <span>${localize(`compressor.release_reason.${reason}` as never, l)}</span>
                        <div class="reason-bar">
                          <div style="width:${(h / totalReason) * 100}%"></div>
                        </div>
                        <span class="reason-val">${hours(h)}</span>
                      </div>`,
                  )}
              </div>`
          : nothing
      }
      ${!g.oil_sensor && !(g.oil_nozzle_lph && g.burner_entity) ? html`<div class="hint">${localize("heating.oil_hint", l)}</div>` : nothing}
    `;
    return this._card(
      "mdi:chart-timeline-variant",
      localize("heating.analysis", l),
      body,
      rangeButtons,
    );
  }

  private _renderChart(g: CompressorGroup, start: number, end: number) {
    const l = this.hass.language;
    const h = this._history;
    const entities: Record<string, string | undefined> = {
      release: g.release_entity,
      burner: g.burner_entity,
      pump: g.pump_entity,
      dhw: g.dhw_entity,
    };
    const lanes = LANES.filter((lane) => entities[lane.key] && h[entities[lane.key]!]);
    const series: Array<Record<string, unknown>> = [];
    if (g.boiler_temp_sensor && h[g.boiler_temp_sensor]) {
      series.push({
        id: "boiler",
        type: "line",
        name: localize("heating.boiler_temp", l),
        color: "rgb(255, 87, 34)",
        data: numericSeries(h[g.boiler_temp_sensor]),
        showSymbol: false,
        step: "end",
        yAxisIndex: 0,
      });
    }
    lanes.forEach((lane, idx) => {
      const intervals = onIntervals(h[entities[lane.key]!], start, end);
      series.push({
        id: `lane_${lane.key}`,
        type: "line",
        name: localize(`heating.${lane.key}` as never, l),
        color: lane.color,
        data: [],
        yAxisIndex: 1,
        markArea: {
          silent: true,
          itemStyle: { color: lane.color },
          data: intervals.map((i) => [
            { xAxis: i.start, yAxis: idx + 0.1 },
            { xAxis: i.end, yAxis: idx + 0.9 },
          ]),
        },
      });
    });
    if (series.length === 0) return nothing;
    const options = {
      xAxis: { type: "time", min: start, max: end },
      yAxis: [
        { type: "value", name: "°C", scale: true },
        { type: "value", min: 0, max: Math.max(lanes.length, 1), show: false },
      ],
      legend: { show: true },
      dataZoom: [{ type: "inside", xAxisIndex: 0, filterMode: "none" }],
      tooltip: { trigger: "axis" },
      grid: { top: 40, left: 40, right: 16, bottom: 30, containLabel: true },
    };
    return html`<ha-chart-base
        .hass=${this.hass}
        .data=${series}
        .options=${options}
        .height=${"280px"}
        style="height: 280px"
      ></ha-chart-base>
      <div class="lane-legend">
        ${lanes.map(
          (lane, idx) =>
            html`<span
              ><i style="background:${lane.color}"></i>${idx + 1}.
              ${localize(`heating.${lane.key}` as never, l)}</span
            >`,
        )}
      </div>`;
  }

  // ─── Settings ───────────────────────────────────────────────────

  private _renderSettings(g: CompressorGroup) {
    const l = this.hass.language;
    const picker = (
      field: keyof CompressorGroup,
      label: string,
      hint: string,
      domains: string[],
    ) => html`
      <div class="field">
        <ha-entity-picker
          .hass=${this.hass}
          .value=${(g[field] as string) || ""}
          .includeDomains=${domains}
          .label=${label}
          @value-changed=${(e: CustomEvent) =>
            this._update(g.id, { [field]: (e.detail?.value as string) ?? "" })}
        ></ha-entity-picker>
        <div class="hint">${hint}</div>
      </div>
    `;
    const num = (
      field: keyof CompressorGroup,
      value: number,
      label: string,
      hint: string,
      min: number,
      max: number,
      step: number,
      suffix = "",
    ) => html`
      <div class="field">
        <ha-textfield
          type="number"
          .value=${String(value)}
          .label=${label}
          .suffix=${suffix}
          min=${min}
          max=${max}
          step=${step}
          @change=${(e: Event) => {
            const v = Number((e.target as HTMLInputElement).value);
            if (Number.isFinite(v) && v >= min && v <= max) this._update(g.id, { [field]: v });
          }}
        ></ha-textfield>
        <div class="hint">${hint}</div>
      </div>
    `;
    const stateDomains = ["binary_sensor", "switch", "input_boolean", "sensor"];
    const body = html`
      <div class="hint">${localize("heating.settings_intro", l)}</div>
      ${picker(
        "release_entity",
        localize("compressor.release_entity", l),
        localize("compressor.release_entity_hint", l),
        ["input_boolean", "switch"],
      )}
      ${
        g.release_entity
          ? html`
              <div class="section-label">${localize("heating.section_release", l)}</div>
              <div class="grid">
                ${num(
                  "release_min_demand",
                  g.release_min_demand ?? 1,
                  localize("compressor.release_min_demand", l),
                  localize("compressor.release_min_demand_hint", l),
                  1,
                  50,
                  1,
                )}
              </div>
              <div class="field">
                <ha-formfield .label=${localize("compressor.release_smart", l)}>
                  <ha-switch
                    .checked=${g.release_smart ?? false}
                    @change=${(e: Event) =>
                      this._update(g.id, { release_smart: (e.target as HTMLInputElement).checked })}
                  ></ha-switch>
                </ha-formfield>
                <div class="hint">${localize("compressor.release_smart_hint", l)}</div>
              </div>
              ${
                g.release_smart
                  ? html`<div class="grid">
                      ${num(
                        "release_urgent_delta",
                        g.release_urgent_delta ?? 1.5,
                        localize("compressor.release_urgent_delta", l),
                        localize("compressor.release_urgent_delta_hint", l),
                        0.3,
                        5,
                        0.1,
                        "K",
                      )}
                      ${num(
                        "release_max_wait_minutes",
                        g.release_max_wait_minutes ?? 45,
                        localize("compressor.release_max_wait", l),
                        localize("compressor.release_max_wait_hint", l),
                        5,
                        240,
                        5,
                        "min",
                      )}
                    </div>`
                  : nothing
              }

              <div class="section-label">${localize("heating.section_boiler", l)}</div>
              ${picker(
                "boiler_temp_sensor",
                localize("compressor.boiler_temp_sensor", l),
                localize("compressor.boiler_temp_sensor_hint", l),
                ["sensor", "input_number", "number"],
              )}
              ${
                g.boiler_temp_sensor
                  ? html`<div class="grid">
                      ${num(
                        "boiler_usable_temp",
                        g.boiler_usable_temp ?? 45,
                        localize("compressor.boiler_usable_temp", l),
                        localize("compressor.boiler_usable_temp_hint", l),
                        20,
                        90,
                        1,
                        "°C",
                      )}
                    </div>`
                  : nothing
              }
              ${picker(
                "burner_entity",
                localize("heating.burner_entity", l),
                localize("heating.burner_entity_hint", l),
                stateDomains,
              )}
              ${picker(
                "pump_entity",
                localize("heating.pump_entity", l),
                localize("heating.pump_entity_hint", l),
                stateDomains,
              )}
              ${picker(
                "dhw_entity",
                localize("heating.dhw_entity", l),
                localize("heating.dhw_entity_hint", l),
                [...stateDomains, "water_heater"],
              )}

              <div class="section-label">${localize("heating.section_oil", l)}</div>
              ${picker(
                "oil_sensor",
                localize("heating.oil_sensor", l),
                localize("heating.oil_sensor_hint", l),
                ["sensor", "input_number", "counter"],
              )}
              <div class="grid">
                ${num(
                  "oil_nozzle_lph",
                  g.oil_nozzle_lph ?? 0,
                  localize("heating.oil_nozzle", l),
                  localize("heating.oil_nozzle_hint", l),
                  0,
                  50,
                  0.05,
                  "L/h",
                )}
              </div>
            `
          : nothing
      }
      <div class="hint">${localize("heating.members_hint", l)}</div>
    `;
    return this._card("mdi:cog", localize("heating.settings", l), body);
  }

  private _update(groupId: string, changes: Partial<CompressorGroup>) {
    this._groups = this._groups.map((g) => (g.id === groupId ? { ...g, ...changes } : g));
    if (this._saveDebounce) clearTimeout(this._saveDebounce);
    this._saveDebounce = setTimeout(() => {
      this._saveDebounce = undefined;
      void this._save();
    }, 500);
  }

  private _save(): Promise<void> {
    const groups = this._groups;
    this._saveChain = this._saveChain.then(async () => {
      fireSaveStatus(this, "saving");
      try {
        await this.hass.callWS({ type: "roommind/settings/save", compressor_groups: groups });
        fireSaveStatus(this, "saved");
      } catch (err) {
        // eslint-disable-next-line no-console
        console.debug("[RoomMind] heating save:", err);
        fireSaveStatus(this, "error");
      }
    });
    return this._saveChain;
  }

  private async _resetLearning(g: CompressorGroup) {
    if (!confirm(localize("heating.reset_confirm", this.hass.language))) return;
    try {
      await this.hass.callWS({ type: "roommind/heating/reset_learning", group_id: g.id });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.debug("[RoomMind] reset learning:", err);
    }
  }

  static styles = [
    inputStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        gap: 16px;
        padding: 0 16px 24px;
        max-width: 1200px;
        margin: 0 auto;
      }
      ha-card {
        overflow: hidden;
      }
      .card-header {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 16px 20px 8px;
      }
      .card-header ha-icon {
        --mdc-icon-size: 20px;
        opacity: 0.75;
      }
      .card-title {
        flex: 1;
        font-size: 16px;
        font-weight: 500;
      }
      .card-body {
        padding: 8px 20px 20px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .empty {
        padding: 80px 16px;
        text-align: center;
        color: var(--secondary-text-color);
      }
      .empty p {
        max-width: 460px;
        margin: 16px auto 0;
        line-height: 1.5;
      }
      .big-icon {
        --mdc-icon-size: 48px;
        opacity: 0.4;
      }
      .chips,
      .range {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .chip {
        border: 1px solid var(--divider-color, #ccc);
        background: none;
        color: var(--primary-text-color);
        border-radius: 16px;
        padding: 6px 14px;
        font: inherit;
        font-size: 14px;
        cursor: pointer;
      }
      .chip.small {
        padding: 3px 10px;
        font-size: 12px;
      }
      .chip.selected {
        background: var(--primary-color);
        border-color: var(--primary-color);
        color: var(--text-primary-color, #fff);
      }
      .tiles {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
        gap: 10px;
      }
      .tile {
        display: flex;
        gap: 10px;
        align-items: flex-start;
        padding: 12px;
        border-radius: 10px;
        background: rgba(127, 127, 127, 0.08);
      }
      .tile.active {
        background: rgba(255, 129, 0, 0.14);
      }
      .tile.active ha-icon {
        color: var(--state-climate-heat-color, #ff8100);
      }
      .tile-label {
        font-size: 12px;
        color: var(--secondary-text-color);
      }
      .tile-value {
        font-size: 18px;
        font-weight: 500;
      }
      .tile-hint {
        font-size: 12px;
        color: var(--secondary-text-color);
        margin-top: 2px;
      }
      .learned-row {
        display: flex;
        flex-wrap: wrap;
        gap: 16px;
        align-items: center;
        font-size: 14px;
      }
      .kpis {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
        gap: 10px;
      }
      .kpi {
        padding: 12px;
        border-radius: 10px;
        background: rgba(127, 127, 127, 0.08);
      }
      .kpi-value {
        font-size: 22px;
        font-weight: 500;
      }
      .kpi-label {
        font-size: 12px;
        color: var(--secondary-text-color);
      }
      .kpi-hint {
        font-size: 11px;
        color: var(--secondary-text-color);
        margin-top: 2px;
      }
      .lane-legend {
        display: flex;
        flex-wrap: wrap;
        gap: 14px;
        font-size: 12px;
        color: var(--secondary-text-color);
      }
      .lane-legend i {
        display: inline-block;
        width: 12px;
        height: 12px;
        border-radius: 3px;
        margin-right: 4px;
        vertical-align: -2px;
      }
      .reasons {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .reason-row {
        display: grid;
        grid-template-columns: minmax(140px, 220px) 1fr 60px;
        gap: 10px;
        align-items: center;
        font-size: 13px;
      }
      .reason-bar {
        height: 8px;
        border-radius: 4px;
        background: rgba(127, 127, 127, 0.15);
        overflow: hidden;
      }
      .reason-bar div {
        height: 100%;
        background: var(--primary-color);
      }
      .reason-val {
        text-align: right;
        color: var(--secondary-text-color);
      }
      .section-label {
        font-size: 14px;
        font-weight: 500;
        margin-top: 8px;
      }
      .grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
      }
      @media (max-width: 600px) {
        .grid {
          grid-template-columns: 1fr;
        }
      }
      .field ha-entity-picker,
      .field ha-textfield {
        width: 100%;
      }
      .hint {
        font-size: 12px;
        color: var(--secondary-text-color);
        line-height: 1.5;
        margin-top: 4px;
      }
    `,
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    "rs-heating": RsHeating;
  }
}
