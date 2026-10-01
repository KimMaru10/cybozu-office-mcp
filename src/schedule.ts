// スケジュールの取得・整形・繰り返し予定の展開
import { SoapClient, attrs } from "./soap.js";
import {
  eachJstDay,
  jstDateStart,
  jstDateTime,
  jstLastDayOfMonth,
  jstMonthDay,
  jstWeekday,
  toJstString,
  toXsdUtc,
} from "./time.js";

export interface Participant {
  type: "user" | "organization" | "facility";
  id: string;
  name?: string;
}

export interface EventOccurrence {
  id: string;
  eventType: string; // normal / repeat / banner / temporary
  title: string;
  plan?: string; // 予定メニュー（例: 社内Ｍ、訪問）
  detail?: string; // 件名
  description?: string; // メモ
  isPrivate: boolean;
  allDay: boolean;
  start: Date;
  end?: Date; // 終日予定は「最終日の翌日 0:00」
  members: Participant[];
  facilities: Participant[];
  repeatRule?: string;
}

const asArray = <T>(x: T | T[] | undefined): T[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);

function participants(ev: any): { members: Participant[]; facilities: Participant[] } {
  const members: Participant[] = [];
  const facilities: Participant[] = [];
  for (const m of asArray<any>(ev.members?.member)) {
    for (const u of asArray<any>(m.user)) members.push({ type: "user", id: u.id, name: u.name });
    for (const o of asArray<any>(m.organization)) members.push({ type: "organization", id: o.id, name: o.name });
    for (const f of asArray<any>(m.facility)) facilities.push({ type: "facility", id: f.id, name: f.name });
  }
  return { members, facilities };
}

const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

function describeRepeat(c: any): string {
  const w = WEEK[parseInt(c.week, 10)] ?? "?";
  const t = c.type as string;
  const base =
    t === "day"
      ? "毎日"
      : t === "weekday"
        ? "毎日（土日を除く）"
        : t === "week"
          ? `毎週${w}曜`
          : /^(1st|2nd|2n|3rd|4th)week$/.test(t)
            ? `毎月第${t[0]}${w}曜`
            : t === "lastweek"
              ? `毎月最終${w}曜`
              : t === "month"
                ? c.day === "0"
                  ? "毎月末日"
                  : `毎月${c.day}日`
                : t;
  return `${base}（${c.start_date}〜${c.end_date ?? ""}）`;
}

function repeatHit(type: string, c: any, day: Date): boolean {
  const wday = jstWeekday(day);
  const mday = jstMonthDay(day);
  const week = parseInt(c.week, 10);
  const dnum = parseInt(c.day, 10);
  switch (type) {
    case "day":
      return true;
    case "weekday":
      return wday !== 0 && wday !== 6;
    case "week":
      return wday === week;
    case "1stweek":
      return wday === week && mday <= 7;
    case "2ndweek":
    case "2nweek":
      return wday === week && mday > 7 && mday <= 14;
    case "3rdweek":
      return wday === week && mday > 14 && mday <= 21;
    case "4thweek":
      return wday === week && mday > 21 && mday <= 28;
    case "lastweek": {
      const last = jstLastDayOfMonth(day);
      return wday === week && mday > last - 7;
    }
    case "month":
      return dnum === 0 ? mday === jstLastDayOfMonth(day) : mday === dnum;
    default:
      return false;
  }
}

/** API の schedule_event を、期間内の「1回ごとの予定」に展開する */
export function expandEvent(ev: any, rangeStart: Date, rangeEnd: Date): EventOccurrence[] {
  const plan = ev.plan || undefined;
  const detail = ev.detail || undefined;
  const isPrivate = ev.public_type === "private";
  const title = [plan, detail].filter(Boolean).join(":") || (isPrivate ? "（非公開の予定）" : "（件名なし）");
  const eventType = ev.event_type ?? "normal";
  const allDayFlag = ev.allday === "true" || eventType === "banner";
  const startOnly = ev.start_only === "true";
  const { members, facilities } = participants(ev);
  const common = {
    id: String(ev.id),
    eventType,
    title,
    plan,
    detail,
    description: ev.description || undefined,
    isPrivate,
    members,
    facilities,
  };

  const out: EventOccurrence[] = [];
  const when = ev.when;
  const inRange = (s: Date, e?: Date) => s.getTime() < rangeEnd.getTime() && (e ?? s).getTime() >= rangeStart.getTime();

  if (when && (when.datetime || when.date)) {
    for (const dt of asArray<any>(when.datetime)) {
      const s = new Date(dt.start);
      const e = dt.end && !startOnly ? new Date(dt.end) : undefined;
      if (inRange(s, e ?? s)) out.push({ ...common, allDay: false, start: s, end: e });
    }
    for (const d of asArray<any>(when.date)) {
      const s = jstDateStart(d.start);
      const lastDay = d.end ?? d.start;
      const e = new Date(jstDateStart(lastDay).getTime() + 24 * 3600 * 1000);
      if (s.getTime() < rangeEnd.getTime() && e.getTime() > rangeStart.getTime())
        out.push({ ...common, allDay: true, start: s, end: e });
    }
    return out;
  }

  if (eventType === "repeat" && ev.repeat_info?.condition) {
    const c = ev.repeat_info.condition;
    const rule = describeRepeat(c);
    const excluded = new Set(
      asArray<any>(ev.repeat_info.exclusive_datetimes?.exclusive_datetime).map((x) =>
        toJstString(new Date(x.start)).slice(0, 10),
      ),
    );
    for (const ymd of eachJstDay(rangeStart, rangeEnd)) {
      if (ymd < c.start_date) continue;
      if (c.end_date && ymd > c.end_date) continue;
      if (excluded.has(ymd)) continue;
      const day = jstDateStart(ymd);
      if (!repeatHit(c.type, c, day)) continue;
      if (allDayFlag || !c.start_time) {
        out.push({ ...common, allDay: true, start: day, end: new Date(day.getTime() + 86400000), repeatRule: rule });
      } else {
        const s = jstDateTime(ymd, c.start_time);
        const e = c.end_time && !startOnly ? jstDateTime(ymd, c.end_time) : undefined;
        out.push({ ...common, allDay: false, start: s, end: e, repeatRule: rule });
      }
    }
  }
  return out;
}

export type Target = { kind: "user" | "organization" | "facility"; id: string } | { kind: "me" };

export class ScheduleApi {
  constructor(private soap: SoapClient) {}

  /** 指定対象（省略時はログインユーザー）の予定を、期間内の1回ごとに展開して返す */
  /** 直近の取得結果を短時間だけ覚えておく（空き会議室→プレビュー と続けて呼ばれたときに同じ要求を繰り返さない） */
  private cache = new Map<string, { at: number; events: any[] }>();
  static CACHE_MS = 60 * 1000;
  clearCache() {
    this.cache.clear();
  }

  async getEvents(target: Target, start: Date, end: Date): Promise<EventOccurrence[]> {
    const key = `${target.kind}:${"id" in target ? target.id : ""}:${start.getTime()}:${end.getTime()}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < ScheduleApi.CACHE_MS) {
      return hit.events.flatMap((ev) => expandEvent(ev, start, end)).sort((x, y) => x.start.getTime() - y.start.getTime() || Number(y.allDay) - Number(x.allDay));
    }
    const a = attrs({ start: toXsdUtc(start), end: toXsdUtc(end) });
    let returns: any;
    if (target.kind === "me") {
      returns = await this.soap.call("Schedule", "ScheduleGetEvents", a, "");
    } else {
      returns = await this.soap.call(
        "Schedule",
        "ScheduleGetEventsByTarget",
        a,
        `<${target.kind} ${attrs({ id: target.id })}></${target.kind}>`,
      );
    }
    const events = asArray<any>(returns.schedule_event);
    this.cache.set(key, { at: Date.now(), events });
    const occ = events.flatMap((ev) => expandEvent(ev, start, end));
    occ.sort((x, y) => x.start.getTime() - y.start.getTime() || Number(y.allDay) - Number(x.allDay));
    return occ;
  }
}

export function formatOccurrence(o: EventOccurrence, opts: { withMembers?: boolean; withDescription?: boolean } = {}): string {
  let when: string;
  if (o.allDay) {
    const lastDay = toJstString(new Date((o.end ?? o.start).getTime() - 1)).slice(0, 10);
    const first = toJstString(o.start).slice(0, 10);
    when = first === lastDay ? `${first} 終日` : `${first}〜${lastDay} 終日`;
  } else {
    when = `${toJstString(o.start)}〜${o.end ? toJstString(o.end).slice(11) : ""}`;
  }
  const lines = [`- ${when}  ${o.title}  [id:${o.id}${o.eventType !== "normal" ? ` ${o.eventType}` : ""}]`];
  if (o.facilities.length) lines.push(`  設備: ${o.facilities.map((f) => f.name ?? f.id).join("、")}`);
  if (opts.withMembers && o.members.length) {
    const names = o.members.map((m) => m.name ?? m.id);
    lines.push(`  参加者(${names.length}): ${names.slice(0, 15).join("、")}${names.length > 15 ? " ほか" : ""}`);
  }
  if (o.repeatRule) lines.push(`  繰り返し: ${o.repeatRule}`);
  if (opts.withDescription && o.description) lines.push(`  メモ: ${o.description.replace(/\s+/g, " ").slice(0, 300)}`);
  return lines.join("\n");
}

// ───────────────────────── 書き込み ─────────────────────────

export type RepeatType =
  | "day"
  | "weekday"
  | "week"
  | "1stweek"
  | "2ndweek"
  | "3rdweek"
  | "4thweek"
  | "lastweek"
  | "month";

export interface RepeatCondition {
  type: RepeatType;
  week?: number; // 曜日 0=日〜6=土（week / Nthweek / lastweek で使用）
  day?: number; // 日（month で使用。0 = 月末）
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  startTime?: string; // HH:MM:SS（終日なら省略）
  endTime?: string;
}

export interface EventDraft {
  id?: string;
  version?: string;
  eventType: "normal" | "banner" | "repeat";
  isPrivate: boolean;
  plan?: string;
  detail: string;
  description?: string;
  allDay: boolean;
  userIds: string[];
  /** 参加者として入っている組織（このツールでは追加しないが、変更時に消さないよう保持する） */
  orgIds?: string[];
  facilityIds: string[];
  /** 通常の時刻予定 */
  start?: Date;
  end?: Date;
  /** 終日・期間予定（YYYY-MM-DD、end は最終日を含む） */
  startDate?: string;
  endDate?: string;
  repeat?: RepeatCondition;
}

export function buildEventXml(d: EventDraft): string {
  const head = attrs({
    id: d.id ?? "dummy",
    event_type: d.eventType,
    version: d.version ?? "dummy",
    public_type: d.isPrivate ? "private" : "public",
    plan: d.plan ?? "",
    detail: d.detail,
    description: d.description ?? "",
    allday: d.eventType === "banner" ? "false" : String(d.allDay),
    start_only: d.eventType === "repeat" ? String(!d.allDay && !d.repeat?.endTime) : String(!d.allDay && !d.end),
  });
  const members =
    d.userIds.map((id) => `<member><user ${attrs({ id })}></user></member>`).join("") +
    (d.orgIds ?? []).map((id) => `<member><organization ${attrs({ id })}></organization></member>`).join("") +
    d.facilityIds.map((id) => `<member><facility ${attrs({ id })}></facility></member>`).join("");
  let body = `<members>${members}</members>`;
  if (d.eventType === "repeat" && d.repeat) {
    const c = d.repeat;
    body += `<repeat_info><condition ${attrs({
      type: c.type,
      day: c.day ?? 0,
      week: c.week ?? 0,
      start_date: c.startDate,
      end_date: c.endDate,
      start_time: d.allDay ? undefined : c.startTime,
      end_time: d.allDay ? undefined : c.endTime,
    })}></condition></repeat_info>`;
  } else if (d.allDay || d.eventType === "banner") {
    body += `<when><date ${attrs({ start: d.startDate, end: d.endDate ?? d.startDate })}></date></when>`;
  } else {
    body += `<when><datetime ${attrs({ start: d.start ? toXsdUtc(d.start) : undefined, end: d.end ? toXsdUtc(d.end) : undefined })}></datetime></when>`;
  }
  return `<schedule_event xmlns="" ${head}>${body}</schedule_event>`;
}

/** API が返した schedule_event（パース済み）を、書き戻し用の EventDraft にする */
export function draftFromRaw(ev: any): EventDraft {
  const { members, facilities } = participants(ev);
  const eventType = (ev.event_type ?? "normal") as EventDraft["eventType"];
  const d: EventDraft = {
    id: String(ev.id),
    version: String(ev.version),
    eventType,
    isPrivate: ev.public_type === "private",
    plan: ev.plan || undefined,
    detail: ev.detail ?? "",
    description: ev.description || undefined,
    allDay: ev.allday === "true",
    userIds: members.filter((m) => m.type === "user").map((m) => m.id),
    orgIds: members.filter((m) => m.type === "organization").map((m) => m.id),
    facilityIds: facilities.map((f) => f.id),
  };
  const when = ev.when;
  if (when?.datetime) {
    const dt = asArray<any>(when.datetime)[0];
    d.start = new Date(dt.start);
    d.end = dt.end && ev.start_only !== "true" ? new Date(dt.end) : undefined;
  }
  if (when?.date) {
    const dd = asArray<any>(when.date)[0];
    d.startDate = dd.start;
    d.endDate = dd.end ?? dd.start;
  }
  const c = ev.repeat_info?.condition;
  if (c) {
    d.repeat = {
      type: c.type,
      week: c.week !== undefined ? parseInt(c.week, 10) : undefined,
      day: c.day !== undefined ? parseInt(c.day, 10) : undefined,
      startDate: c.start_date,
      endDate: c.end_date,
      startTime: c.start_time,
      endTime: c.end_time,
    };
  }
  return d;
}

export class ScheduleWriter {
  constructor(private soap: SoapClient) {}

  async getRawById(id: string): Promise<any> {
    const r = await this.soap.call("Schedule", "ScheduleGetEventsById", "", `<event_id>${xmlEscapeId(id)}</event_id>`);
    const ev = asArray<any>(r.schedule_event)[0];
    if (!ev) throw new Error(`予定 id:${id} が見つかりません`);
    return ev;
  }

  async add(d: EventDraft): Promise<any> {
    const r = await this.soap.call("Schedule", "ScheduleAddEvents", "", buildEventXml({ ...d, id: undefined, version: undefined }));
    return asArray<any>(r.schedule_event)[0];
  }

  async modify(d: EventDraft): Promise<any> {
    const r = await this.soap.call("Schedule", "ScheduleModifyEvents", "", buildEventXml(d));
    return asArray<any>(r.schedule_event)[0];
  }

  /** 繰り返し予定の変更。type=this/after は date（YYYY-MM-DD）が必要 */
  async modifyRepeat(d: EventDraft, type: "this" | "after" | "all", date?: string): Promise<any> {
    const r = await this.soap.call(
      "Schedule",
      "ScheduleModifyRepeatEvents",
      "",
      `<operation ${attrs({ type, date: type === "all" ? undefined : date })}>${buildEventXml(d)}</operation>`,
    );
    return r.result ?? r;
  }

  async remove(id: string): Promise<void> {
    await this.soap.call("Schedule", "ScheduleRemoveEvents", "", `<event_id>${xmlEscapeId(id)}</event_id>`);
  }

  async removeFromRepeat(id: string, type: "this" | "after" | "all", date?: string): Promise<void> {
    await this.soap.call(
      "Schedule",
      "ScheduleRemoveEventsFromRepeatEvent",
      "",
      `<operation ${attrs({ event_id: id, type, date: type === "all" ? undefined : date })}></operation>`,
    );
  }
}

function xmlEscapeId(id: string): string {
  if (!/^\d+$/.test(String(id).trim())) throw new Error(`予定IDは数字で指定してください: ${id}`);
  return String(id).trim();
}
