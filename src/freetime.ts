// 複数人の空き時間を、各自の予定から計算する
import { EventOccurrence } from "./schedule.js";
import { eachJstDay, jstDateTime, jstWeekday, jstDateStart, toJstHm } from "./time.js";

export interface FreeSlot {
  date: string;
  start: Date;
  end: Date;
}

export interface FreeTimeOptions {
  rangeStart: Date;
  rangeEnd: Date;
  durationMin: number;
  dayStart: string; // "09:00"
  dayEnd: string; // "18:00"
  includeWeekends: boolean;
  allDayIsBusy: boolean;
  now?: Date;
}

type Interval = [number, number];

function merge(iv: Interval[]): Interval[] {
  const s = iv.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: Interval[] = [];
  for (const cur of s) {
    const last = out[out.length - 1];
    if (last && cur[0] <= last[1]) last[1] = Math.max(last[1], cur[1]);
    else out.push([cur[0], cur[1]]);
  }
  return out;
}

export function findFreeSlots(eventsPerPerson: EventOccurrence[][], o: FreeTimeOptions): FreeSlot[] {
  const busy: Interval[] = [];
  for (const evs of eventsPerPerson) {
    for (const e of evs) {
      if (e.allDay && !o.allDayIsBusy) continue;
      // 終了時刻なしの予定は30分とみなす
      const end = e.end ?? new Date(e.start.getTime() + 30 * 60000);
      busy.push([e.start.getTime(), end.getTime()]);
    }
  }
  const merged = merge(busy);
  const need = o.durationMin * 60000;
  const now = (o.now ?? new Date()).getTime();
  const slots: FreeSlot[] = [];
  for (const ymd of eachJstDay(o.rangeStart, o.rangeEnd)) {
    const wd = jstWeekday(jstDateStart(ymd));
    if (!o.includeWeekends && (wd === 0 || wd === 6)) continue;
    let ws = Math.max(jstDateTime(ymd, o.dayStart).getTime(), o.rangeStart.getTime(), now);
    const we = Math.min(jstDateTime(ymd, o.dayEnd).getTime(), o.rangeEnd.getTime());
    // 開始を5分単位に切り上げ
    ws = Math.ceil(ws / 300000) * 300000;
    if (we - ws < need) continue;
    let cursor = ws;
    for (const [bs, be] of merged) {
      if (be <= cursor) continue;
      if (bs >= we) break;
      if (bs - cursor >= need) slots.push({ date: ymd, start: new Date(cursor), end: new Date(bs) });
      cursor = Math.max(cursor, be);
      if (cursor >= we) break;
    }
    if (we - cursor >= need) slots.push({ date: ymd, start: new Date(cursor), end: new Date(we) });
  }
  return slots;
}

const WEEK = ["日", "月", "火", "水", "木", "金", "土"];
export function formatSlots(slots: FreeSlot[]): string {
  if (!slots.length) return "条件に合う空き時間はありませんでした。";
  const byDay = new Map<string, FreeSlot[]>();
  for (const s of slots) byDay.set(s.date, [...(byDay.get(s.date) ?? []), s]);
  return [...byDay.entries()]
    .map(([d, ss]) => {
      const w = WEEK[jstWeekday(jstDateStart(d))];
      return `${d}(${w}): ${ss.map((s) => `${toJstHm(s.start)}〜${toJstHm(s.end)}`).join(", ")}`;
    })
    .join("\n");
}
