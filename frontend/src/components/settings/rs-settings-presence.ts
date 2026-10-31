/**
 * rs-settings-presence – Presence detection settings.
 */
import { html, css, nothing } from "lit";
import { RsSettingsBase } from "./rs-settings-base";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../../types";
import { localize } from "../../utils/localize";
import { getSelectValue } from "../../utils/events";

/** Learned arrivals of one presence entity (roommind/presence/arrivals). */
interface ArrivalSummary {
  arrivals: number;
  typical: Record<string, string>;
  home: boolean | null;
  next: number | null;
  distance_km?: number | null;
  approach_kmh?: number | null;
  eta?: number | null;
}

@customElement("rs-settings-presence")
export class RsSettingsPresence extends RsSettingsBase {
  @property({ attribute: false }) public hass!: HomeAssistant;
  @property({ type: Boolean }) public presenceEnabled = false;
  @property({ type: Array }) public presencePersons: string[] = [];
  @property({ type: String }) public presenceAwayAction: "eco" | "off" = "eco";
  @property({ type: Boolean }) public presenceClearsOverride = false;
  @property({ type: Boolean }) public presencePreheat = false;
  @property({ type: Number }) public presencePreheatMinutes = 60;
  @property({ type: Boolean }) public presenceLocation = false;
  @property({ type: Number }) public presenceNearKm = 1;
  @property({ type: Number }) public presenceTripKm = 100;
  @property({ type: Boolean }) public presenceTripVacation = true;

  @state() private _arrivals: Record<string, ArrivalSummary> = {};

  connectedCallback() {
    super.connectedCallback();
    void this._loadArrivals();
  }

  private async _loadArrivals() {
    try {
      const res = await this.hass.callWS<{ arrivals: Record<string, ArrivalSummary> }>({
        type: "roommind/presence/arrivals",
      });
      this._arrivals = res.arrivals ?? {};
    } catch {
      this._arrivals = {};
    }
  }

  private _renderLocation() {
    const l = this.hass.language;
    const time = (ts: number) =>
      new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const num = (
      key: "presenceNearKm" | "presenceTripKm",
      value: number,
      label: string,
      hint: string,
      min: number,
      max: number,
      step: number,
    ) => html`
      <ha-textfield
        type="number"
        .value=${String(value)}
        .label=${label}
        .suffix=${"km"}
        min=${min}
        max=${max}
        step=${step}
        @change=${(e: Event) => {
          const v = Number((e.target as HTMLInputElement).value);
          if (Number.isFinite(v) && v >= min && v <= max) this._fire(key, v);
        }}
      ></ha-textfield>
      <span class="field-hint">${hint}</span>
    `;
    return html`
      <div class="toggle-row">
        <div class="toggle-text">
          <span class="toggle-label">${localize("presence.location_label", l)}</span>
          <span class="toggle-hint">${localize("presence.location_hint", l)}</span>
        </div>
        <ha-switch
          .checked=${this.presenceLocation}
          @change=${(e: Event) =>
            this._fire("presenceLocation", (e.target as HTMLInputElement).checked)}
        ></ha-switch>
      </div>
      ${
        this.presenceLocation
          ? html`
              ${num(
                "presenceNearKm",
                this.presenceNearKm,
                localize("presence.near_km", l),
                localize("presence.near_km_hint", l),
                0.1,
                20,
                0.1,
              )}
              ${num(
                "presenceTripKm",
                this.presenceTripKm,
                localize("presence.trip_km", l),
                localize("presence.trip_km_hint", l),
                10,
                2000,
                10,
              )}
              <div class="toggle-row">
                <div class="toggle-text">
                  <span class="toggle-label">${localize("presence.trip_vacation_label", l)}</span>
                  <span class="toggle-hint">${localize("presence.trip_vacation_hint", l)}</span>
                </div>
                <ha-switch
                  .checked=${this.presenceTripVacation}
                  @change=${(e: Event) =>
                    this._fire("presenceTripVacation", (e.target as HTMLInputElement).checked)}
                ></ha-switch>
              </div>
              <div class="locations">
                ${this.presencePersons.map((pid) => {
                  const a = this._arrivals[pid];
                  const name =
                    (this.hass.states[pid]?.attributes?.friendly_name as string) ??
                    pid.split(".").slice(1).join(".");
                  let status: string;
                  if (a?.home) status = localize("presence.loc_home", l);
                  else if (a?.distance_km == null) status = localize("presence.loc_unknown", l);
                  else if (a.distance_km > this.presenceTripKm)
                    status = localize("presence.loc_trip", l, { km: a.distance_km });
                  else if (a.eta)
                    status = localize("presence.loc_coming", l, {
                      km: a.distance_km,
                      time: time(a.eta),
                    });
                  else status = localize("presence.loc_away", l, { km: a.distance_km });
                  return html`<div class="person-row">
                    <ha-icon
                      icon="mdi:map-marker-account"
                      style="--mdc-icon-size: 18px; color: var(--secondary-text-color)"
                    ></ha-icon>
                    <span class="person-name">${name}<small>${status}</small></span>
                  </div>`;
                })}
              </div>
            `
          : nothing
      }
    `;
  }

  private _renderPreheat() {
    const l = this.hass.language;
    const days = [0, 1, 2, 3, 4, 5, 6];
    return html`
      <div class="toggle-row">
        <div class="toggle-text">
          <span class="toggle-label">${localize("presence.preheat_label", l)}</span>
          <span class="toggle-hint">${localize("presence.preheat_hint", l)}</span>
        </div>
        <ha-switch
          .checked=${this.presencePreheat}
          @change=${(e: Event) =>
            this._fire("presencePreheat", (e.target as HTMLInputElement).checked)}
        ></ha-switch>
      </div>
      ${
        this.presencePreheat
          ? html`
              <ha-textfield
                type="number"
                .value=${String(this.presencePreheatMinutes)}
                .label=${localize("presence.preheat_minutes", l)}
                .suffix=${"min"}
                min="10"
                max="240"
                step="5"
                @change=${(e: Event) => {
                  const v = parseInt((e.target as HTMLInputElement).value, 10);
                  if (v >= 10 && v <= 240) this._fire("presencePreheatMinutes", v);
                }}
              ></ha-textfield>
              <span class="field-hint">${localize("presence.preheat_minutes_hint", l)}</span>
              <span class="toggle-label">${localize("presence.learned_title", l)}</span>
              <div class="arrivals">
                <div class="arrival-row head">
                  <span></span>
                  ${days.map(
                    (d) =>
                      html`<span
                        >${localize(
                          `schedule_editor.day_short.${["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"][d]}` as never,
                          l,
                        )}</span
                      >`,
                  )}
                </div>
                ${this.presencePersons.map((pid) => {
                  const a = this._arrivals[pid];
                  const name =
                    (this.hass.states[pid]?.attributes?.friendly_name as string) ??
                    pid.split(".").slice(1).join(".");
                  return html`<div class="arrival-row">
                    <span class="person-name"
                      >${name}
                      <small
                        >${localize("presence.learned_count", l, { count: a?.arrivals ?? 0 })}${
                          a?.next
                            ? html` ·
                              ${localize("presence.learned_next", l, {
                                time: new Date(a.next * 1000).toLocaleTimeString([], {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                }),
                              })}`
                            : nothing
                        }</small
                      ></span
                    >
                    ${days.map((d) => html`<span>${a?.typical?.[d] ?? "–"}</span>`)}
                  </div>`;
                })}
              </div>
              <span class="field-hint">${localize("presence.learned_hint", l)}</span>
            `
          : nothing
      }
    `;
  }

  render() {
    const l = this.hass.language;

    return html`
      <div class="toggle-row">
        <div class="toggle-text">
          <span class="toggle-label">${localize("presence.title", l)}</span>
          <span class="toggle-hint">${localize("presence.hint", l)}</span>
        </div>
        <ha-switch
          .checked=${this.presenceEnabled}
          @change=${(e: Event) =>
            this._fire("presenceEnabled", (e.target as HTMLInputElement).checked)}
        ></ha-switch>
      </div>

      ${
        this.presenceEnabled
          ? html`
              <div class="detail-section">
                <span class="field-hint">${localize("presence.hint_detail", l)}</span>
                ${
                  this.presencePersons.length > 0
                    ? html`
                        <div class="person-list">
                          ${this.presencePersons.map((pid) => {
                            const name =
                              this.hass.states[pid]?.attributes?.friendly_name ??
                              pid.split(".").slice(1).join(".");
                            return html`
                              <div class="person-row">
                                <ha-icon
                                  icon="mdi:account"
                                  style="--mdc-icon-size: 18px; color: var(--secondary-text-color)"
                                ></ha-icon>
                                <span class="person-name">${name}</span>
                                <ha-icon-button
                                  .path=${"M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z"}
                                  @click=${() =>
                                    this._fire(
                                      "presencePersons",
                                      this.presencePersons.filter((p) => p !== pid),
                                    )}
                                ></ha-icon-button>
                              </div>
                            `;
                          })}
                        </div>
                      `
                    : nothing
                }
                <ha-entity-picker
                  .hass=${this.hass}
                  .includeDomains=${["person", "device_tracker", "binary_sensor", "input_boolean"]}
                  .entityFilter=${(entity: { entity_id: string }) =>
                    !this.presencePersons.includes(entity.entity_id)}
                  .label=${localize("presence.add_entity", l)}
                  @value-changed=${(e: CustomEvent) => {
                    const val = e.detail?.value;
                    if (val && !this.presencePersons.includes(val)) {
                      this._fire("presencePersons", [...this.presencePersons, val]);
                    }
                    const picker = e.target as HTMLElement & { value: string };
                    picker.value = "";
                  }}
                ></ha-entity-picker>
                <ha-select
                  .label=${localize("presence.away_action_label", l)}
                  .value=${this.presenceAwayAction}
                  .options=${[
                    { value: "eco", label: localize("presence.away_action_eco", l) },
                    { value: "off", label: localize("presence.away_action_off", l) },
                  ]}
                  fixedMenuPosition
                  @selected=${(e: Event) => {
                    const val = getSelectValue(e) as "eco" | "off";
                    if (val && val !== this.presenceAwayAction)
                      this._fire("presenceAwayAction", val);
                  }}
                  @closed=${(e: Event) => e.stopPropagation()}
                  style="margin-top: 8px"
                >
                  <ha-list-item value="eco"
                    >${localize("presence.away_action_eco", l)}</ha-list-item
                  >
                  <ha-list-item value="off"
                    >${localize("presence.away_action_off", l)}</ha-list-item
                  >
                </ha-select>
                <div class="toggle-row">
                  <div class="toggle-text">
                    <span class="toggle-label"
                      >${localize("presence.clears_override_label", l)}</span
                    >
                    <span class="toggle-hint">${localize("presence.clears_override_hint", l)}</span>
                  </div>
                  <ha-switch
                    .checked=${this.presenceClearsOverride}
                    @change=${(e: Event) =>
                      this._fire("presenceClearsOverride", (e.target as HTMLInputElement).checked)}
                  ></ha-switch>
                </div>
                ${this._renderPreheat()} ${this._renderLocation()}
              </div>
            `
          : nothing
      }
    `;
  }

  static styles = [
    RsSettingsBase.settingsBaseStyles,
    css`
      .detail-section {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin-top: 12px;
      }

      .person-list {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .person-row {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 4px 8px 4px 12px;
        border-radius: 8px;
        background: rgba(0, 0, 0, 0.04);
      }
      .person-name {
        flex: 1;
        font-size: 14px;
        font-weight: 500;
      }
      .person-name small {
        display: block;
        font-weight: 400;
        font-size: 11px;
        color: var(--secondary-text-color);
      }
      .arrivals {
        display: flex;
        flex-direction: column;
        gap: 4px;
        overflow-x: auto;
      }
      .arrival-row {
        display: grid;
        grid-template-columns: minmax(120px, 1.5fr) repeat(7, minmax(44px, 1fr));
        gap: 6px;
        align-items: center;
        font-size: 13px;
        text-align: center;
      }
      .arrival-row .person-name {
        text-align: left;
      }
      .arrival-row.head {
        font-size: 11px;
        color: var(--secondary-text-color);
      }
    `,
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    "rs-settings-presence": RsSettingsPresence;
  }
}
