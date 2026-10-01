// 日時ユーティリティ（日本時間 = UTC+9 固定。日本は夏時間なし）
export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** "YYYY-MM-DD" を日本時間のその日 0:00 の Date にする */
export function jstDateStart(ymd: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!m) throw new Error(`日付は YYYY-MM-DD 形式で指定してください: ${ymd}`);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]) - JST_OFFSET_MS);
}

/** "YYYY-MM-DD" + "HH:MM[:SS]"（日本時間）→ Date */
export function jstDateTime(ymd: string, hms: string): Date {
  const [h, mi, s] = hms.split(":").map((x) => parseInt(x, 10));
  return new Date(jstDateStart(ymd).getTime() + ((h || 0) * 3600 + (mi || 0) * 60 + (s || 0)) * 1000);
}

/** Date → 日本時間の "YYYY-MM-DD" */
export function toJstYmd(d: Date): string {
  return new Date(d.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Date → 日本時間の "YYYY-MM-DD HH:MM" */
export function toJstString(d: Date): string {
  return new Date(d.getTime() + JST_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ");
}

/** Date → 日本時間の "HH:MM" */
export function toJstHm(d: Date): string {
  return new Date(d.getTime() + JST_OFFSET_MS).toISOString().slice(11, 16);
}

/** API 送信用の xsd:dateTime（UTC, 秒まで） */
export function toXsdUtc(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** 日本時間の曜日（0=日〜6=土） */
export function jstWeekday(d: Date): number {
  return new Date(d.getTime() + JST_OFFSET_MS).getUTCDay();
}

/** 日本時間の日（1〜31） */
export function jstMonthDay(d: Date): number {
  return new Date(d.getTime() + JST_OFFSET_MS).getUTCDate();
}

/** 日本時間でその月の末日（28〜31） */
export function jstLastDayOfMonth(d: Date): number {
  const j = new Date(d.getTime() + JST_OFFSET_MS);
  return new Date(Date.UTC(j.getUTCFullYear(), j.getUTCMonth() + 1, 0)).getUTCDate();
}

/** from 以上 to 未満の日本時間の日付（YYYY-MM-DD）を並べる */
export function eachJstDay(from: Date, to: Date): string[] {
  const out: string[] = [];
  let cur = jstDateStart(toJstYmd(from));
  while (cur.getTime() < to.getTime()) {
    out.push(toJstYmd(cur));
    cur = new Date(cur.getTime() + DAY_MS);
  }
  return out;
}

export function addDays(ymd: string, n: number): string {
  return toJstYmd(new Date(jstDateStart(ymd).getTime() + n * DAY_MS));
}

export function todayJst(): string {
  return toJstYmd(new Date());
}
