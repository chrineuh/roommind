/**
 * Weekly schedule editor inside RoomMind.
 *
 * Creates and edits Home Assistant `schedule.*` helpers through HA's own
 * websocket API (schedule/list, schedule/create, schedule/update), so the
 * result is a normal helper that RoomMind's backend already understands.
 * A block can carry a temperature in its data (`temperature`, or
 * `heat_temperature` / `cool_temperature` in auto mode); an empty field
 * means the room's comfort temperature applies.
 */
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant, ClimateMode } from "../types";
import { localize } from "../utils/localize";
import { tempUnit } from "../utils/temperature";
import { inputStyles } from "../styles/input-styles";
import "./shared/rs-edit-dialog";

export const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;
type Weekday = (typeof WEEKDAYS)[number];

interface HaScheduleBlock {
  from: string;
  to: string;
  data?: Record<string, unknown>;
}

type HaScheduleItem = { id: string; name: string; icon?: string } & Partial<
  Record<Weekday, HaScheduleBlock[]>
>;

/** Editable block: times as "HH:MM" ("24:00" = end of day), temps as text so a field can be empty. */
export interface EditorBlock {
  from: string;
  to: string;
  temp: string;
  heat: string;
  cool: string;
}

type Week = Record<Weekday, EditorBlock[]>;

const ICON_DELETE =
  "M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z";
const ICON_COPY =
  "M19,21H8V7H19M19,5H8A2,2 0 0,0 6,7V21A2,2 0 0,0 8,23H19A2,2 0 0,0 21,21V7A2,2 0 0,0 19,5M16,1H4A2,2 0 0,0 2,3V17H4V3H16V1Z";

const emptyWeek = (): Week =>
  Object.fromEntries(WEEKDAYS.map((d) => [d, [] as EditorBlock[]])) as unknown as Week;

/** "06:00:00" -> "06:00"; HA reports midnight at the end of a block as "24:00:00" or "00:00:00". */
export function toHm(t: string, isEnd = false): string {
  const hm = (t ?? "").slice(0, 5);
  if (isEnd && (hm === "00:00" || hm === "24:00")) return "24:00";
  return hm;
}

export function toMinutes(hm: string): number {
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
}

const numOrEmpty = (v: unknown): string =>
  v === undefined || v === null || v === "" ? "" : String(v);

export function blocksFromHa(blocks: HaScheduleBlock[] | undefined): EditorBlock[] {
  return (blocks ?? []).map((b) => ({
    from: toHm(b.from),
    to: toHm(b.to, true),
    temp: numOrEmpty(b.data?.temperature),
    heat: numOrEmpty(b.data?.heat_temperature),
    cool: numOrEmpty(b.data?.cool_temperature),
  }));
}

export function blocksToHa(blocks: EditorBlock[], mode: ClimateMode): HaScheduleBlock[] {
  return [...blocks]
    .sort((a, b) => toMinutes(a.from) - toMinutes(b.from))
    .map((b) => {
      const data: Record<string, number> = {};
      if (mode === "auto") {
        if (b.heat !== "") data.heat_temperature = Number(b.heat);
        if (b.cool !== "") data.cool_temperature = Number(b.cool);
      } else if (b.temp !== "") {
        data.temperature = Number(b.temp);
      }
      const block: HaScheduleBlock = { from: `${b.from}:00`, to: `${b.to}:00` };
      if (Object.keys(data).length) block.data = data;
      return block;
    });
}

/** Returns the translation key of the first problem in a day's blocks, or null. */
export function validateDay(blocks: EditorBlock[]): string | null {
  const sorted = [...blocks].sort((a, b) => toMinutes(a.from) - toMinutes(b.from));
  let prevEnd = -1;
  for (const b of sorted) {
    if (!/^\d\d:\d\d$/.test(b.from) || !/^\d\d:\d\d$/.test(b.to)) return "schedule_editor.err_time";
    const from = toMinutes(b.from);
    const to = toMinutes(b.to);
    if (to <= from) return "schedule_editor.err_order";
    if (from < prevEnd) return "schedule_editor.err_overlap";
    for (const v of [b.temp, b.heat, b.cool]) {
      if (v !== "" && !Number.isFinite(Number(v))) return "schedule_editor.err_temp";
    }
    if (b.heat !== "" && b.cool !== "" && Number(b.cool) < Number(b.heat)) {
      return "schedule_editor.err_band";
    }
    prevEnd = to;
  }
  return null;
}

@customElement("rs-schedule-editor")
export class RsScheduleEditor extends LitElement {
  @property({ attribute: false }) public hass!: HomeAssistant;
  @property({ type: Boolean }) public open = false;
  /** Schedule entity to edit; empty creates a new helper. */
  @property({ type: String }) public entityId = "";
  @property({ type: String }) public climateMode: ClimateMode = "auto";
  /** Suggested name for a new schedule (the room name). */
  @property({ type: String }) public defaultName = "";

  @state() private _loading = false;
  @state() private _saving = false;
  @state() private _error = "";
  @state() private _readOnly = false;
  @state() private _name = "";
  @state() private _week: Week = emptyWeek();
  @state() private _scheduleId: string | null = null;
  @state() private _day: Weekday = "monday";

  static styles = [
    inputStyles,
    css`
      :host {
        display: contents;
      }
      .body {
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      .week-preview {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .preview-row {
        display: grid;
        grid-template-columns: 34px 1fr;
        align-items: center;
        gap: 8px;
        cursor: pointer;
        border-radius: 6px;
        padding: 2px 4px;
      }
      .preview-row.selected {
        background: rgba(var(--rgb-primary-color, 3, 169, 244), 0.12);
      }
      .preview-label {
        font-size: 12px;
        font-weight: 500;
        color: var(--secondary-text-color);
      }
      .preview-row.selected .preview-label {
        color: var(--primary-color);
      }
      .bar {
        position: relative;
        height: 14px;
        border-radius: 4px;
        background: var(--divider-color, rgba(127, 127, 127, 0.2));
        overflow: hidden;
      }
      .bar-block {
        position: absolute;
        top: 0;
        bottom: 0;
        background: var(--state-climate-heat-color, #ff8100);
        opacity: 0.85;
      }
      .bar-block.cool {
        background: var(--state-climate-cool-color, #2b9af9);
      }
      .hours {
        display: grid;
        grid-template-columns: 34px 1fr;
        gap: 8px;
        padding: 0 4px;
        font-size: 10px;
        color: var(--secondary-text-color);
      }
      .hours div {
        display: flex;
        justify-content: space-between;
      }
      .day-tabs {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .day-tab {
        border: 1px solid var(--divider-color, #ccc);
        background: none;
        color: var(--primary-text-color);
        border-radius: 16px;
        padding: 4px 12px;
        font: inherit;
        font-size: 13px;
        cursor: pointer;
      }
      .day-tab.selected {
        background: var(--primary-color);
        border-color: var(--primary-color);
        color: var(--text-primary-color, #fff);
      }
      .day-tab.invalid {
        border-color: var(--error-color, #d32f2f);
      }
      .block-row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        padding: 8px 10px;
        border-radius: 8px;
        background: rgba(127, 127, 127, 0.08);
      }
      .block-row label {
        display: flex;
        flex-direction: column;
        gap: 2px;
        font-size: 11px;
        color: var(--secondary-text-color);
      }
      .block-row input {
        font: inherit;
        font-size: 14px;
        padding: 6px 8px;
        border-radius: 6px;
        border: 1px solid var(--divider-color, #ccc);
        background: var(--card-background-color, transparent);
        color: var(--primary-text-color);
        color-scheme: light dark;
      }
      .block-row input.temp {
        width: 70px;
      }
      .block-row .spacer {
        flex: 1;
      }
      .blocks {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .actions-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
      }
      .link-btn {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        background: none;
        border: none;
        padding: 4px 0;
        cursor: pointer;
        color: var(--primary-color);
        font: inherit;
        font-size: 13px;
      }
      .link-btn ha-svg-icon {
        --mdc-icon-size: 16px;
      }
      .hint {
        font-size: 12px;
        color: var(--secondary-text-color);
        line-height: 1.5;
      }
      .error {
        color: var(--error-color, #d32f2f);
        font-size: 13px;
      }
      .footer {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }
      .empty {
        font-size: 13px;
        color: var(--secondary-text-color);
        padding: 8px 0;
      }
    `,
  ];

  protected updated(changed: Map<string, unknown>): void {
    if ((changed.has("open") || changed.has("entityId")) && this.open) {
      void this._load();
    }
  }

  private async _load() {
    this._error = "";
    this._readOnly = false;
    this._day = "monday";
    this._scheduleId = null;
    if (!this.entityId) {
      this._name = this.defaultName;
      this._week = emptyWeek();
      return;
    }
    this._loading = true;
    try {
      const [entry, items] = await Promise.all([
        this.hass.callWS<{ unique_id: string; platform: string }>({
          type: "config/entity_registry/get",
          entity_id: this.entityId,
        }),
        this.hass.callWS<HaScheduleItem[]>({ type: "schedule/list" }),
      ]);
      const item = items.find((i) => i.id === entry.unique_id);
      if (!item) {
        // Defined in YAML: HA cannot change it through the UI either.
        this._readOnly = true;
        this._name = (this.hass.states[this.entityId]?.attributes?.friendly_name as string) ?? "";
        this._week = emptyWeek();
        return;
      }
      this._scheduleId = item.id;
      this._name = item.name;
      const week = emptyWeek();
      for (const d of WEEKDAYS) week[d] = blocksFromHa(item[d]);
      this._week = week;
    } catch (err) {
      this._readOnly = true;
      this._error = err instanceof Error ? err.message : String(err);
    } finally {
      this._loading = false;
    }
  }

  render() {
    const l = this.hass?.language ?? "en";
    return html`
      <rs-edit-dialog
        .open=${this.open}
        .heading=${localize(
          this.entityId ? "schedule_editor.title_edit" : "schedule_editor.title_new",
          l,
        )}
        icon="mdi:calendar-edit"
        @rs-dialog-closed=${this._onClosed}
      >
        ${this.open ? this._renderBody(l) : nothing}
      </rs-edit-dialog>
    `;
  }

  private _renderBody(l: string) {
    if (this._loading) return html`<div class="hint">${localize("panel.loading", l)}</div>`;
    if (this._readOnly) {
      return html`<div class="body">
        <div class="hint">${localize("schedule_editor.read_only", l)}</div>
        ${this._error ? html`<div class="error">${this._error}</div>` : nothing}
      </div>`;
    }
    const blocks = this._week[this._day];
    return html`
      <div class="body">
        <ha-textfield
          .label=${localize("schedule_editor.name", l)}
          .value=${this._name}
          @input=${(e: Event) => (this._name = (e.target as HTMLInputElement).value)}
        ></ha-textfield>

        ${this._renderPreview(l)}

        <div class="day-tabs">
          ${WEEKDAYS.map(
            (d) =>
              html`<button
                class="day-tab ${d === this._day ? "selected" : ""} ${
                  validateDay(this._week[d]) ? "invalid" : ""
                }"
                @click=${() => (this._day = d)}
              >
                ${localize(`schedule_editor.day_short.${d}` as never, l)}
              </button>`,
          )}
        </div>

        <div class="blocks">
          ${
            blocks.length === 0
              ? html`<div class="empty">${localize("schedule_editor.no_blocks", l)}</div>`
              : blocks.map((b, i) => this._renderBlock(b, i, l))
          }
        </div>
        ${this._renderDayError(l)}

        <div class="actions-row">
          <button class="link-btn" @click=${this._addBlock}>
            + ${localize("schedule_editor.add_block", l)}
          </button>
          <span class="spacer" style="flex:1"></span>
          <button class="link-btn" @click=${() => this._copyDay("weekdays")}>
            <ha-svg-icon .path=${ICON_COPY}></ha-svg-icon>
            ${localize("schedule_editor.copy_weekdays", l)}
          </button>
          <button class="link-btn" @click=${() => this._copyDay("all")}>
            <ha-svg-icon .path=${ICON_COPY}></ha-svg-icon>
            ${localize("schedule_editor.copy_all", l)}
          </button>
        </div>

        <div class="hint">
          ${localize(
            this.climateMode === "auto" ? "schedule_editor.hint_auto" : "schedule_editor.hint",
            l,
          )}
        </div>

        ${this._error ? html`<div class="error">${this._error}</div>` : nothing}

        <div class="footer">
          <ha-button @click=${this._onClosed}>${localize("schedule_editor.cancel", l)}</ha-button>
          <ha-button raised .disabled=${this._saving || !this._name.trim()} @click=${this._save}>
            ${localize(this._saving ? "settings.saving" : "schedule_editor.save", l)}
          </ha-button>
        </div>
      </div>
    `;
  }

  private _renderPreview(l: string) {
    return html`
      <div class="week-preview">
        ${WEEKDAYS.map(
          (d) => html`
            <div
              class="preview-row ${d === this._day ? "selected" : ""}"
              @click=${() => (this._day = d)}
            >
              <span class="preview-label"
                >${localize(`schedule_editor.day_short.${d}` as never, l)}</span
              >
              <div class="bar">
                ${this._week[d].map((b) => {
                  if (!/^\d\d:\d\d$/.test(b.from) || !/^\d\d:\d\d$/.test(b.to)) return nothing;
                  const left = (toMinutes(b.from) / 1440) * 100;
                  const width = Math.max(0, ((toMinutes(b.to) - toMinutes(b.from)) / 1440) * 100);
                  const cool = this.climateMode === "cool_only";
                  return html`<div
                    class="bar-block ${cool ? "cool" : ""}"
                    style="left:${left}%;width:${width}%"
                    title="${b.from}–${b.to}"
                  ></div>`;
                })}
              </div>
            </div>
          `,
        )}
        <div class="hours">
          <span></span>
          <div><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div>
        </div>
      </div>
    `;
  }

  private _renderBlock(b: EditorBlock, i: number, l: string) {
    const unit = tempUnit(this.hass);
    const tempInput = (field: "temp" | "heat" | "cool", label: string) => html`
      <label
        >${label} (${unit})
        <input
          class="temp"
          type="number"
          step="0.5"
          inputmode="decimal"
          placeholder=${localize("schedule_editor.comfort_placeholder", l)}
          .value=${b[field]}
          @change=${(e: Event) => this._setBlock(i, field, (e.target as HTMLInputElement).value)}
        />
      </label>
    `;
    return html`
      <div class="block-row">
        <label
          >${localize("schedule_editor.from", l)}
          <input
            type="time"
            .value=${b.from}
            @change=${(e: Event) => this._setBlock(i, "from", (e.target as HTMLInputElement).value)}
          />
        </label>
        <label
          >${localize("schedule_editor.to", l)}
          <input
            type="time"
            .value=${b.to === "24:00" ? "00:00" : b.to}
            @change=${(e: Event) => {
              const v = (e.target as HTMLInputElement).value;
              this._setBlock(i, "to", v === "00:00" ? "24:00" : v);
            }}
          />
        </label>
        ${
          this.climateMode === "auto"
            ? html`${tempInput("heat", localize("schedule_editor.heat", l))}
              ${tempInput("cool", localize("schedule_editor.cool", l))}`
            : tempInput("temp", localize("schedule_editor.temperature", l))
        }
        <span class="spacer"></span>
        <ha-icon-button
          .path=${ICON_DELETE}
          .label=${localize("schedule_editor.remove_block", l)}
          @click=${() => this._removeBlock(i)}
        ></ha-icon-button>
      </div>
    `;
  }

  private _renderDayError(l: string) {
    const err = validateDay(this._week[this._day]);
    return err ? html`<div class="error">${localize(err as never, l)}</div>` : nothing;
  }

  private _updateDay(day: Weekday, blocks: EditorBlock[]) {
    this._week = { ...this._week, [day]: blocks };
  }

  private _setBlock(i: number, field: keyof EditorBlock, value: string) {
    const blocks = this._week[this._day].map((b, j) => (j === i ? { ...b, [field]: value } : b));
    this._updateDay(this._day, blocks);
  }

  private _addBlock = () => {
    const blocks = [...this._week[this._day]].sort((a, b) => toMinutes(a.from) - toMinutes(b.from));
    // Start after the last block, default 06:00–22:00 on an empty day.
    const last = blocks[blocks.length - 1];
    let from = "06:00";
    let to = "22:00";
    if (last && /^\d\d:\d\d$/.test(last.to)) {
      const start = Math.min(toMinutes(last.to), 23 * 60);
      const end = Math.min(start + 60, 24 * 60);
      const fmt = (m: number) =>
        `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      from = fmt(start);
      to = fmt(end);
    }
    this._updateDay(this._day, [...blocks, { from, to, temp: "", heat: "", cool: "" }]);
  };

  private _removeBlock(i: number) {
    this._updateDay(
      this._day,
      this._week[this._day].filter((_, j) => j !== i),
    );
  }

  private _copyDay(target: "weekdays" | "all") {
    const source = this._week[this._day];
    const days: readonly Weekday[] = target === "all" ? WEEKDAYS : WEEKDAYS.slice(0, 5);
    const week = { ...this._week };
    for (const d of days) week[d] = source.map((b) => ({ ...b }));
    this._week = week;
  }

  private _save = async () => {
    const l = this.hass.language;
    for (const d of WEEKDAYS) {
      const err = validateDay(this._week[d]);
      if (err) {
        this._day = d;
        this._error = localize(err as never, l);
        return;
      }
    }
    this._error = "";
    this._saving = true;
    const days = Object.fromEntries(
      WEEKDAYS.map((d) => [d, blocksToHa(this._week[d], this.climateMode)]),
    );
    try {
      let entityId = this.entityId;
      if (this._scheduleId) {
        await this.hass.callWS({
          type: "schedule/update",
          schedule_id: this._scheduleId,
          name: this._name.trim(),
          ...days,
        });
      } else {
        const item = await this.hass.callWS<HaScheduleItem>({
          type: "schedule/create",
          name: this._name.trim(),
          icon: "mdi:calendar-clock",
          ...days,
        });
        entityId = await this._entityIdFor(item.id);
      }
      this.dispatchEvent(
        new CustomEvent("schedule-saved", {
          detail: { entityId, created: !this._scheduleId },
          bubbles: true,
          composed: true,
        }),
      );
      this._close();
    } catch (err) {
      this._error =
        err instanceof Error ? err.message : String((err as { message?: string })?.message ?? err);
    } finally {
      this._saving = false;
    }
  };

  /** The helper's entity shows up in the registry a moment after schedule/create returns. */
  private async _entityIdFor(scheduleId: string): Promise<string> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const entries = await this.hass.callWS<
        { entity_id: string; platform: string; unique_id: string }[]
      >({ type: "config/entity_registry/list" });
      const hit = entries.find((e) => e.platform === "schedule" && e.unique_id === scheduleId);
      if (hit) return hit.entity_id;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(localize("schedule_editor.err_entity", this.hass.language));
  }

  private _onClosed = (e?: Event) => {
    e?.stopPropagation();
    this._close();
  };

  private _close() {
    this.dispatchEvent(
      new CustomEvent("schedule-editor-closed", { bubbles: true, composed: true }),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "rs-schedule-editor": RsScheduleEditor;
  }
}
