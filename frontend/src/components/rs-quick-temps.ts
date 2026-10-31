/**
 * rs-quick-temps – Day, night and away temperature of a room at a glance.
 *
 * Day is the temperature inside the schedule blocks: shown from the active
 * schedule (the same temperature in every block), else the comfort value.
 * Night is what applies outside the blocks (eco), away what applies while
 * everyone is away (falls back to night). The room view decides how a change
 * is stored; this component only reports it as `quick-temp-changed`.
 */
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant, ClimateMode } from "../types";
import { localize } from "../utils/localize";
import { formatTemp, tempUnit, toCelsius, toDisplay, tempStep } from "../utils/temperature";
import { readScheduleBlocks, getStorageSchedule, WEEKDAYS } from "../utils/schedule-write";

export type QuickTempField = "day" | "night" | "away";

@customElement("rs-quick-temps")
export class RsQuickTemps extends LitElement {
  @property({ attribute: false }) public hass!: HomeAssistant;
  @property({ type: String }) public climateMode: ClimateMode = "auto";
  /** °C values from the room config. */
  @property({ type: Number }) public comfortHeat = 21;
  @property({ type: Number }) public ecoHeat = 17;
  @property({ attribute: false }) public awayHeat: number | null = null;
  /** Active schedule entity ("" without schedule). */
  @property({ type: String }) public scheduleEntity = "";
  @property({ type: Boolean }) public presenceEnabled = false;
  @property({ attribute: false }) public predictedArrival: number | null = null;
  @property({ type: Boolean }) public preheatActive = false;
  @property({ attribute: false }) public arrivalSource: string | null = null;
  @property({ type: Boolean }) public onTrip = false;

  /** Common block temperature of the active schedule in °C, null when blocks differ or carry none. */
  @state() private _scheduleDay: number | null = null;
  @state() private _scheduleEditable = true;
  private _loadedFor = "";

  /** Bump to re-read the schedule after it was changed elsewhere. */
  public refresh() {
    this._loadedFor = "";
    this.requestUpdate();
  }

  protected updated(): void {
    if (this.scheduleEntity !== this._loadedFor && this.hass) {
      this._loadedFor = this.scheduleEntity;
      void this._loadSchedule();
    }
  }

  private async _loadSchedule() {
    const entity = this.scheduleEntity;
    if (!entity) {
      this._scheduleDay = null;
      this._scheduleEditable = true;
      return;
    }
    try {
      const [blocks, item] = await Promise.all([
        readScheduleBlocks(this.hass, entity),
        getStorageSchedule(this.hass, entity).catch(() => null),
      ]);
      if (entity !== this.scheduleEntity) return;
      const key = this.climateMode === "auto" ? "heat_temperature" : "temperature";
      const values = new Set(
        WEEKDAYS.flatMap((d) => blocks[d].map((b) => b.data?.[key] ?? b.data?.temperature)),
      );
      const only = values.size === 1 ? [...values][0] : undefined;
      this._scheduleDay =
        typeof only === "number" ? Math.round(toCelsius(only, this.hass) * 10) / 10 : null;
      this._scheduleEditable = item !== null;
    } catch {
      this._scheduleDay = null;
    }
  }

  private get _dayValue(): number {
    return this._scheduleDay ?? this.comfortHeat;
  }

  private _fire(field: QuickTempField, value: number | null) {
    this.dispatchEvent(
      new CustomEvent("quick-temp-changed", {
        detail: { field, value },
        bubbles: true,
        composed: true,
      }),
    );
    if (field === "day" && value !== null && this._scheduleEditable) this._scheduleDay = value;
  }

  private _step(field: QuickTempField, current: number, dir: -1 | 1) {
    const step = Number(tempStep(this.hass)) || 0.5;
    const display = Math.round((toDisplay(current, this.hass) + dir * step) / step) * step;
    const c = Math.round(toCelsius(display, this.hass) * 10) / 10;
    if (c < 5 || c > 30) return;
    this._fire(field, c);
  }

  private _renderRow(
    field: QuickTempField,
    icon: string,
    label: string,
    value: number,
    hint: string,
    inherited = false,
  ) {
    return html`<div class="row">
      <ha-icon .icon=${icon}></ha-icon>
      <div class="text">
        <div class="label">${label}</div>
        ${hint ? html`<div class="hint">${hint}</div>` : nothing}
      </div>
      <button class="step" @click=${() => this._step(field, value, -1)}>−</button>
      <span class="value ${inherited ? "inherited" : ""}"
        >${formatTemp(value, this.hass)}<small>${tempUnit(this.hass)}</small></span
      >
      <button class="step" @click=${() => this._step(field, value, 1)}>+</button>
    </div>`;
  }

  render() {
    if (!this.hass || this.climateMode === "cool_only") return nothing;
    const l = this.hass.language;
    const away = this.awayHeat;
    const arrival =
      this.predictedArrival != null
        ? new Date(this.predictedArrival * 1000).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })
        : "";
    return html`
      ${this._renderRow(
        "day",
        "mdi:white-balance-sunny",
        localize("quick.day", l),
        this._dayValue,
        this.scheduleEntity
          ? this._scheduleEditable
            ? localize("quick.day_hint_schedule", l)
            : localize("quick.day_hint_yaml", l)
          : localize("quick.day_hint", l),
      )}
      ${
        this.scheduleEntity && !this._scheduleEditable
          ? html`<button class="link" @click=${this._takeOver}>
              ${localize("quick.take_over", l)}
            </button>`
          : nothing
      }
      ${this._renderRow(
        "night",
        "mdi:weather-night",
        localize("quick.night", l),
        this.ecoHeat,
        localize("quick.night_hint", l),
      )}
      ${
        this.presenceEnabled
          ? html`${this._renderRow(
              "away",
              "mdi:home-export-outline",
              localize("quick.away", l),
              away ?? this.ecoHeat,
              away === null ? localize("quick.away_hint_same", l) : localize("quick.away_hint", l),
              away === null,
            )}
            ${
              away !== null
                ? html`<button class="link" @click=${() => this._fire("away", null)}>
                    ${localize("quick.away_reset", l)}
                  </button>`
                : nothing
            }
            ${
              arrival
                ? html`<div class="arrival ${this.preheatActive ? "active" : ""}">
                    <ha-icon
                      .icon=${this.arrivalSource === "location" ? "mdi:map-marker-radius" : "mdi:home-clock-outline"}
                    ></ha-icon>
                    ${localize(this.preheatActive ? "quick.arrival_heating" : "quick.arrival", l, {
                      time: arrival,
                    })}
                    ${
                      this.arrivalSource === "location"
                        ? html`(${localize("quick.arrival_by_location", l)})`
                        : nothing
                    }
                  </div>`
                : nothing
            }
            ${
              this.onTrip
                ? html`<div class="arrival">
                    <ha-icon icon="mdi:airplane"></ha-icon>${localize("quick.trip", l)}
                  </div>`
                : nothing
            }`
          : nothing
      }
    `;
  }

  private _takeOver = () => {
    this.dispatchEvent(
      new CustomEvent("schedule-edit-request", {
        detail: { entityId: this.scheduleEntity },
        bubbles: true,
        composed: true,
      }),
    );
  };

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin: 12px 0;
      padding-top: 12px;
      border-top: 1px solid var(--divider-color, #eee);
    }
    .row {
      display: grid;
      grid-template-columns: 24px 1fr 34px auto 34px;
      align-items: center;
      gap: 8px;
    }
    .row ha-icon {
      --mdc-icon-size: 20px;
      color: var(--secondary-text-color);
    }
    .label {
      font-size: 14px;
      font-weight: 500;
    }
    .hint {
      font-size: 11px;
      color: var(--secondary-text-color);
      line-height: 1.3;
    }
    .step {
      width: 34px;
      height: 34px;
      border-radius: 50%;
      border: 1px solid var(--divider-color, #ccc);
      background: none;
      color: var(--primary-text-color);
      font-size: 18px;
      cursor: pointer;
    }
    .step:hover {
      background: rgba(127, 127, 127, 0.12);
    }
    .value {
      min-width: 62px;
      text-align: center;
      font-size: 20px;
      font-weight: 500;
    }
    .value small {
      font-size: 12px;
      margin-left: 2px;
      color: var(--secondary-text-color);
    }
    .value.inherited {
      color: var(--secondary-text-color);
    }
    .link {
      align-self: flex-start;
      margin-left: 32px;
      background: none;
      border: none;
      padding: 0;
      color: var(--primary-color);
      font: inherit;
      font-size: 12px;
      cursor: pointer;
    }
    .arrival {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--secondary-text-color);
      margin-left: 32px;
    }
    .arrival ha-icon {
      --mdc-icon-size: 16px;
    }
    .arrival.active {
      color: var(--state-climate-heat-color, #ff8100);
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "rs-quick-temps": RsQuickTemps;
  }
}
