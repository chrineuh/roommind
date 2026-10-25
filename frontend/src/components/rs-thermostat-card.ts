/**
 * Room thermostat: HA's native thermostat dial for the room's RoomMind
 * climate entity (climate.roommind_<area>). Turning the dial or picking a
 * mode/preset goes through that entity, so it behaves exactly like the
 * thermostat on a dashboard: a target change is held until the next schedule change.
 */
import { LitElement, html, css, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../types";
import { localize } from "../utils/localize";

interface LovelaceCard extends HTMLElement {
  hass?: HomeAssistant;
  setConfig(config: Record<string, unknown>): void;
}

/** Find the room climate entity, also when the user renamed its entity_id. */
export function findRoomClimateEntity(hass: HomeAssistant, areaId: string): string | null {
  const preferred = `climate.roommind_${areaId}`;
  if (hass.states[preferred]) return preferred;
  for (const entry of Object.values(hass.entities ?? {})) {
    if (
      entry.platform === "roommind" &&
      entry.entity_id.startsWith("climate.") &&
      entry.area_id === areaId &&
      !entry.entity_id.endsWith("_override")
    ) {
      return entry.entity_id;
    }
  }
  return null;
}

@customElement("rs-thermostat-card")
export class RsThermostatCard extends LitElement {
  @property({ attribute: false }) public hass!: HomeAssistant;
  @property({ type: String }) public areaId = "";

  @state() private _entityId: string | null = null;
  @state() private _failed = false;

  private _card?: LovelaceCard;
  private _cardKey = "";

  static styles = css`
    :host {
      display: block;
    }
    .card-host {
      display: block;
    }
    /* The embedded card brings its own ha-card; drop its frame inside our section. */
    .card-host > * {
      --ha-card-box-shadow: none;
      --ha-card-border-width: 0;
      --ha-card-background: transparent;
    }
    .hint {
      font-size: 13px;
      color: var(--secondary-text-color);
      padding: 0 20px 16px;
    }
  `;

  protected willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("hass") || changed.has("areaId")) {
      this._entityId = this.hass ? findRoomClimateEntity(this.hass, this.areaId) : null;
    }
  }

  protected updated(changed: PropertyValues<this>): void {
    if (!this._entityId) return;
    const st = this.hass.states[this._entityId];
    // The feature list depends on the modes the entity offers; rebuild only when those change.
    const hvacModes = (st?.attributes?.hvac_modes as string[] | undefined) ?? [];
    const presetModes = (st?.attributes?.preset_modes as string[] | undefined) ?? [];
    const key = `${this._entityId}|${hvacModes.join(",")}|${presetModes.join(",")}`;
    if (key !== this._cardKey) {
      this._cardKey = key;
      void this._createCard(hvacModes, presetModes);
    } else if (changed.has("hass") && this._card) {
      this._card.hass = this.hass;
    }
  }

  private async _createCard(hvacModes: string[], presetModes: string[]) {
    const key = this._cardKey;
    const features: Record<string, unknown>[] = [];
    if (hvacModes.length > 1) {
      features.push({ type: "climate-hvac-modes", hvac_modes: hvacModes });
    }
    if (presetModes.length > 0) {
      features.push({ type: "climate-preset-modes", style: "icons", preset_modes: presetModes });
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const helpers = await (window as any).loadCardHelpers();
      const card = (await helpers.createCardElement({
        type: "thermostat",
        entity: this._entityId,
        features,
      })) as LovelaceCard;
      if (key !== this._cardKey) return; // superseded while loading
      card.hass = this.hass;
      this._card = card;
      this._failed = false;
      const host = this.shadowRoot?.querySelector(".card-host");
      host?.replaceChildren(card);
    } catch {
      this._failed = true;
    }
  }

  render() {
    if (!this.hass) return nothing;
    if (!this._entityId) {
      return html`<div class="hint">
        ${localize("thermostat.not_available", this.hass.language)}
      </div>`;
    }
    if (this._failed) {
      return html`<div class="hint">
        ${localize("thermostat.load_failed", this.hass.language)}
      </div>`;
    }
    return html`<div class="card-host"></div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "rs-thermostat-card": RsThermostatCard;
  }
}
