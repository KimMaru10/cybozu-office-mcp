// 予定の登録・変更・削除ツール
// どれも confirm=false（既定）では何も書き込まず、内容と重なりを確認するプレビューだけを返す。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Directory } from "./directory.js";
import {
  EventDraft,
  EventOccurrence,
  RepeatCondition,
  RepeatType,
  ScheduleApi,
  ScheduleWriter,
  draftFromRaw,
  expandEvent,
} from "./schedule.js";
import { addDays, jstDateStart, jstDateTime, jstMonthDay, jstLastDayOfMonth, jstWeekday, toJstHm, toJstString, toJstYmd } from "./time.js";

export interface Ctx {
  dir: Directory;
  sched: ScheduleApi;
  writer: ScheduleWriter;
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const fail = (e: unknown) => ({
  content: [{ type: "text" as const, text: `エラー: ${e instanceof Error ? e.message : String(e)}` }],
  isError: true,
});
const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

// ───────── 入力の解釈 ─────────

/** "YYYY-MM-DD HH:MM" / "YYYY-MM-DDTHH:MM" → Date（日本時間） */
export function parseJstDateTime(s: string): Date {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`日時は "YYYY-MM-DD HH:MM" の形式で指定してください: ${s}`);
  const mins = parseInt(m[3], 10);
  if (mins % 5 !== 0) throw new Error(`サイボウズは5分単位でしか登録できません: ${s}`);
  return jstDateTime(m[1], `${m[2]}:${m[3]}:00`);
}
function parseYmd(s: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.trim())) throw new Error(`日付は YYYY-MM-DD 形式で指定してください: ${s}`);
  return s.trim();
}
/** "HH:MM" または "YYYY-MM-DD HH:MM" から時刻 "HH:MM:00" を取り出す */
function timeOf(s: string): { date?: string; time: string } {
  const m = /^(?:(\d{4}-\d{2}-\d{2})[ T])?(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`時刻は "HH:MM" または "YYYY-MM-DD HH:MM" で指定してください: ${s}`);
  if (parseInt(m[3], 10) % 5 !== 0) throw new Error(`サイボウズは5分単位でしか登録できません: ${s}`);
  return { date: m[1], time: `${m[2].padStart(2, "0")}:${m[3]}:00` };
}

const repeatSchema = z
  .object({
    frequency: z
      .enum(["daily", "weekdays", "weekly", "monthly_nth_weekday", "monthly_date", "monthly_last_day"])
      .describe(
        "daily=毎日 / weekdays=毎日(土日除く) / weekly=毎週(開始日の曜日) / monthly_nth_weekday=毎月第N◯曜(開始日から算出) / monthly_date=毎月◯日 / monthly_last_day=毎月末日",
      ),
    until: z.string().describe("繰り返しの最終日 YYYY-MM-DD（必須）"),
    nth: z
      .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal("last")])
      .optional()
      .describe("monthly_nth_weekday のとき第何週か。省略時は開始日から自動判定"),
  })
  .describe("繰り返しにする場合のみ指定");

function buildRepeat(r: z.infer<typeof repeatSchema>, startYmd: string): RepeatCondition {
  const day0 = jstDateStart(startYmd);
  const wd = jstWeekday(day0);
  const md = jstMonthDay(day0);
  let type: RepeatType;
  let week = 0;
  let day = 0;
  switch (r.frequency) {
    case "daily":
      type = "day";
      break;
    case "weekdays":
      type = "weekday";
      break;
    case "weekly":
      type = "week";
      week = wd;
      break;
    case "monthly_nth_weekday": {
      const nth = r.nth ?? (md > jstLastDayOfMonth(day0) - 7 && md > 28 ? "last" : Math.ceil(md / 7));
      type = nth === "last" ? "lastweek" : (["1stweek", "2ndweek", "3rdweek", "4thweek"][(nth as number) - 1] as RepeatType);
      if (!type) throw new Error("第5週の指定はできません。nth に \"last\"（最終週）を指定してください");
      week = wd;
      break;
    }
    case "monthly_date":
      type = "month";
      day = md;
      break;
    case "monthly_last_day":
      type = "month";
      day = 0;
      break;
  }
  const until = parseYmd(r.until);
  if (until < startYmd) throw new Error("繰り返しの最終日は開始日以降にしてください");
  return { type, week, day, startDate: startYmd, endDate: until };
}

function describeDraftWhen(d: EventDraft): string {
  if (d.eventType === "repeat" && d.repeat) {
    const c = d.repeat;
    const w = WEEK[c.week ?? 0];
    const rule: Record<string, string> = {
      day: "毎日",
      weekday: "毎日（土日除く）",
      week: `毎週${w}曜`,
      "1stweek": `毎月第1${w}曜`,
      "2ndweek": `毎月第2${w}曜`,
      "3rdweek": `毎月第3${w}曜`,
      "4thweek": `毎月第4${w}曜`,
      lastweek: `毎月最終${w}曜`,
      month: c.day === 0 ? "毎月末日" : `毎月${c.day}日`,
    };
    const time = d.allDay ? "終日" : `${c.startTime?.slice(0, 5)}〜${c.endTime?.slice(0, 5) ?? ""}`;
    return `${rule[c.type] ?? c.type} ${time}（${c.startDate}〜${c.endDate}）`;
  }
  if (d.allDay || d.eventType === "banner") {
    return d.startDate === d.endDate || !d.endDate ? `${d.startDate} 終日` : `${d.startDate}〜${d.endDate}（期間予定）`;
  }
  return `${d.start ? toJstString(d.start) : "?"}〜${d.end ? toJstHm(d.end) : ""}`;
}

async function describeDraft(ctx: Ctx, d: EventDraft): Promise<string> {
  const names = await Promise.all(d.userIds.map((id) => ctx.dir.userName(id)));
  for (const id of d.orgIds ?? []) names.push(`[組織] ${(await ctx.dir.orgName(id)) ?? `id:${id}`}`);
  const facs = await ctx.dir.listFacilities();
  const fnames = d.facilityIds.map((id) => facs.find((f) => f.id === id)?.name ?? `id:${id}`);
  return [
    `  件名: ${d.detail}`,
    `  予定メニュー: ${d.plan || "（なし）"}`,
    `  日時: ${describeDraftWhen(d)}`,
    `  参加者(${names.length}): ${names.join("、") || "（なし）"}`,
    `  設備: ${fnames.join("、") || "（なし）"}`,
    `  公開: ${d.isPrivate ? "非公開" : "公開"}`,
    `  メモ: ${d.description ? d.description.replace(/\s+/g, " ").slice(0, 200) : "（なし）"}`,
  ].join("\n");
}

/** 下書きの「最初の回」の時間帯（重なりチェック用） */
function firstSlot(d: EventDraft, onDate?: string): { start: Date; end: Date } | undefined {
  if (d.eventType === "repeat" && d.repeat) {
    const ymd = onDate ?? d.repeat.startDate;
    if (d.allDay || !d.repeat.startTime) return undefined;
    const s = jstDateTime(ymd, d.repeat.startTime);
    const e = d.repeat.endTime ? jstDateTime(ymd, d.repeat.endTime) : new Date(s.getTime() + 30 * 60000);
    return { start: s, end: e };
  }
  if (d.allDay || d.eventType === "banner" || !d.start) return undefined;
  return { start: d.start, end: d.end ?? new Date(d.start.getTime() + 30 * 60000) };
}

const overlaps = (o: EventOccurrence, s: Date, e: Date) =>
  !o.allDay && o.start.getTime() < e.getTime() && (o.end ?? new Date(o.start.getTime() + 30 * 60000)).getTime() > s.getTime();

/** 参加者・設備の予定との重なりを調べる */
async function conflicts(ctx: Ctx, d: EventDraft, slot: { start: Date; end: Date } | undefined, excludeId?: string) {
  const people: string[] = [];
  const rooms: string[] = [];
  if (!slot) return { people, rooms };
  const dayStart = jstDateStart(toJstYmd(slot.start));
  const dayEnd = jstDateStart(addDays(toJstYmd(slot.end), 1));
  await Promise.all([
    ...d.userIds.map(async (id) => {
      const evs = await ctx.sched.getEvents({ kind: "user", id }, dayStart, dayEnd);
      for (const o of evs.filter((o) => o.id !== excludeId && overlaps(o, slot.start, slot.end)))
        people.push(`${await ctx.dir.userName(id)}: ${toJstHm(o.start)}〜${o.end ? toJstHm(o.end) : ""} ${o.title}`);
    }),
    ...d.facilityIds.map(async (id) => {
      const evs = await ctx.sched.getEvents({ kind: "facility", id }, dayStart, dayEnd);
      const name = (await ctx.dir.listFacilities()).find((f) => f.id === id)?.name ?? id;
      for (const o of evs.filter((o) => o.id !== excludeId && overlaps(o, slot.start, slot.end)))
        rooms.push(`${name}: ${toJstHm(o.start)}〜${o.end ? toJstHm(o.end) : ""} ${o.isPrivate ? "（予約あり）" : o.title}`);
    }),
  ]);
  return { people, rooms };
}

function conflictText(c: { people: string[]; rooms: string[] }, repeatNote = false): string {
  const lines: string[] = [];
  if (c.rooms.length) lines.push(`⚠ 設備が埋まっています（このままでは登録できません）:\n${c.rooms.map((x) => "  - " + x).join("\n")}`);
  if (c.people.length) lines.push(`⚠ 参加者の予定と重なっています:\n${c.people.map((x) => "  - " + x).join("\n")}`);
  if (!lines.length) lines.push("重なり: なし");
  if (repeatNote) lines.push("※ 繰り返し予定は初回の日だけ重なりを確認しています。");
  return lines.join("\n");
}

async function resolveUsers(ctx: Ctx, list: string[] | undefined): Promise<string[]> {
  const ids: string[] = [];
  for (const q of list ?? []) {
    const u = await ctx.dir.resolveUser(q);
    if (!ids.includes(u.id)) ids.push(u.id);
  }
  return ids;
}
async function resolveFacilities(ctx: Ctx, list: string[] | undefined): Promise<string[]> {
  const ids: string[] = [];
  for (const q of list ?? []) {
    const f = await ctx.dir.resolveFacility(q);
    if (!ids.includes(f.id)) ids.push(f.id);
  }
  return ids;
}
async function planNote(ctx: Ctx, plan?: string): Promise<string> {
  if (!plan) return "";
  const menu = await ctx.dir.planMenu();
  return menu.length && !menu.includes(plan) ? `\n※ 予定メニュー「${plan}」はメニューにありません（そのまま文字として登録されます）。候補: ${menu.join("、")}` : "";
}

const CONFIRM_DESC =
  "false（既定）なら書き込まずにプレビューと重なりチェックだけを返す。ユーザーにプレビューを見せて了承を得てから、同じ内容で true にして実行する。";

// ───────── ツール登録 ─────────

export function registerWriteTools(server: McpServer, getCtx: () => Promise<Ctx>) {
  const W = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

  server.registerTool(
    "cybozu_create_event",
    {
      title: "予定を登録",
      description:
        "サイボウズに予定を登録する。参加者・会議室・予定メニュー・メモ・非公開・繰り返しに対応。必ず confirm=false でプレビューを出し、ユーザーの了承を得てから confirm=true で実行すること。",
      inputSchema: {
        title: z.string().min(1).describe("件名"),
        start: z.string().describe('開始。時刻あり "YYYY-MM-DD HH:MM"、終日なら "YYYY-MM-DD"'),
        end: z.string().optional().describe('終了。時刻あり "YYYY-MM-DD HH:MM"（省略時は開始+60分）、終日なら最終日 "YYYY-MM-DD"'),
        all_day: z.boolean().optional().describe("終日予定にする（既定 false）。終了日が開始日より後なら期間予定になる"),
        plan: z.string().optional().describe("予定メニュー（例: 社内Ｍ、訪問、会議）。cybozu_list_plan_menu で候補を確認"),
        memo: z.string().optional().describe("メモ（備考）"),
        attendees: z.array(z.string()).optional().describe("参加者（名前の一部・ログイン名・ID）"),
        include_me: z.boolean().optional().describe("自分を参加者に含める（既定 true）"),
        facilities: z.array(z.string()).optional().describe("会議室などの設備（名前の一部またはID）"),
        private: z.boolean().optional().describe("非公開にする（既定 false）"),
        repeat: repeatSchema.optional(),
        confirm: z.boolean().optional().describe(CONFIRM_DESC),
      },
      annotations: W,
    },
    async (a) => {
      try {
        const ctx = await getCtx();
        const userIds = await resolveUsers(ctx, a.attendees);
        if (a.include_me ?? true) {
          const me = await ctx.dir.loginUserId();
          if (!userIds.includes(me)) userIds.unshift(me);
        }
        const facilityIds = await resolveFacilities(ctx, a.facilities);
        if (!userIds.length && !facilityIds.length) throw new Error("参加者か設備を1つ以上指定してください");
        const allDay = a.all_day ?? false;
        const d: EventDraft = {
          eventType: "normal",
          isPrivate: a.private ?? false,
          plan: a.plan,
          detail: a.title,
          description: a.memo,
          allDay,
          userIds,
          facilityIds,
        };
        if (allDay) {
          d.startDate = parseYmd(a.start.slice(0, 10));
          d.endDate = a.end ? parseYmd(a.end.slice(0, 10)) : d.startDate;
          if (d.endDate < d.startDate) throw new Error("終了日は開始日以降にしてください");
          if (d.endDate !== d.startDate) {
            if (a.repeat) throw new Error("期間予定（複数日）は繰り返しにできません");
            d.eventType = "banner";
          }
        } else {
          d.start = parseJstDateTime(a.start);
          d.end = a.end ? parseJstDateTime(a.end) : new Date(d.start.getTime() + 60 * 60000);
          if (d.end.getTime() <= d.start.getTime()) throw new Error("終了は開始より後にしてください");
        }
        if (a.repeat) {
          const ymd = allDay ? d.startDate! : toJstYmd(d.start!);
          if (!allDay && toJstYmd(d.end!) !== ymd) throw new Error("日をまたぐ予定は繰り返しにできません");
          d.repeat = buildRepeat(a.repeat, ymd);
          if (!allDay) {
            d.repeat.startTime = `${toJstHm(d.start!)}:00`;
            d.repeat.endTime = `${toJstHm(d.end!)}:00`;
          }
          d.eventType = "repeat";
        }
        // 重なりチェックはプレビュー時だけ行う（実行時は省いてサーバーへの負荷を減らす。会議室の重複はサーバー側でも弾かれる）
        const c = a.confirm ? { people: [] as string[], rooms: [] as string[] } : await conflicts(ctx, d, firstSlot(d));
        const summary = await describeDraft(ctx, d);
        const note = await planNote(ctx, a.plan);
        if (!a.confirm) {
          return text(
            `【プレビュー：まだ登録していません】\n${summary}\n\n${conflictText(c, !!d.repeat)}${note}\n\n` +
              `この内容でよければ、同じ引数に confirm=true を付けて再実行してください。`,
          );
        }
        if (c.rooms.length) throw new Error(`設備が埋まっているため登録しません。\n${c.rooms.join("\n")}`);
        const created = await ctx.writer.add(d);
        ctx.sched.clearCache();
        return text(`✔ 登録しました（id:${created?.id ?? "?"}）\n${summary}${c.people.length ? `\n\n${conflictText(c)}` : ""}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "cybozu_update_event",
    {
      title: "予定を変更",
      description:
        "既存の予定を変更する（件名・時間・予定メニュー・メモ・参加者・設備・公開設定）。繰り返し予定は scope で範囲（this=この回だけ / after=この回以降 / all=すべて）を指定。必ず confirm=false でプレビューを出し、返された version を expected_version に入れて confirm=true で実行すること。",
      inputSchema: {
        event_id: z.string().describe("予定ID（予定取得ツールの [id:...]）"),
        scope: z.enum(["this", "after", "all"]).optional().describe("繰り返し予定のときの変更範囲"),
        occurrence_date: z.string().optional().describe("scope=this/after の基準となる回の日付 YYYY-MM-DD"),
        title: z.string().optional(),
        start: z
          .string()
          .optional()
          .describe('新しい開始。通常予定は "YYYY-MM-DD HH:MM"、繰り返し予定は "HH:MM"、終日予定は "YYYY-MM-DD"'),
        end: z.string().optional().describe("新しい終了（start と同じ形式）。省略時は元の長さを保つ"),
        plan: z.string().optional().describe("予定メニュー。空文字で解除"),
        memo: z.string().optional().describe("メモ。空文字で消す"),
        private: z.boolean().optional(),
        add_attendees: z.array(z.string()).optional(),
        remove_attendees: z.array(z.string()).optional(),
        add_facilities: z.array(z.string()).optional(),
        remove_facilities: z.array(z.string()).optional(),
        expected_version: z.string().optional().describe("プレビューで返された version（confirm=true のとき必須）"),
        confirm: z.boolean().optional().describe(CONFIRM_DESC),
      },
      annotations: W,
    },
    async (a) => {
      try {
        const ctx = await getCtx();
        const raw = await ctx.writer.getRawById(a.event_id);
        const before = draftFromRaw(raw);
        const d: EventDraft = structuredClone(before);
        const isRepeat = before.eventType === "repeat";
        const scope = isRepeat ? a.scope : undefined;
        if (isRepeat && !scope) throw new Error("繰り返し予定です。scope（this / after / all）を指定してください");
        if (isRepeat && scope !== "all" && !a.occurrence_date)
          throw new Error("scope=this / after のときは occurrence_date（どの回か）を指定してください");
        const occ = a.occurrence_date ? parseYmd(a.occurrence_date) : undefined;
        if (isRepeat && occ) {
          const hits = expandEvent(raw, jstDateStart(occ), jstDateStart(addDays(occ, 1)));
          if (!hits.length) throw new Error(`${occ} はこの繰り返し予定の回ではありません`);
        }

        if (a.title !== undefined) d.detail = a.title;
        if (a.plan !== undefined) d.plan = a.plan || undefined;
        if (a.memo !== undefined) d.description = a.memo || undefined;
        if (a.private !== undefined) d.isPrivate = a.private;
        if (a.add_attendees) for (const id of await resolveUsers(ctx, a.add_attendees)) if (!d.userIds.includes(id)) d.userIds.push(id);
        if (a.remove_attendees) {
          const rm = await resolveUsers(ctx, a.remove_attendees);
          d.userIds = d.userIds.filter((id) => !rm.includes(id));
        }
        if (a.add_facilities) for (const id of await resolveFacilities(ctx, a.add_facilities)) if (!d.facilityIds.includes(id)) d.facilityIds.push(id);
        if (a.remove_facilities) {
          const rm = await resolveFacilities(ctx, a.remove_facilities);
          d.facilityIds = d.facilityIds.filter((id) => !rm.includes(id));
        }
        if (!d.userIds.length && !(d.orgIds ?? []).length && !d.facilityIds.length) throw new Error("参加者と設備がすべて外れてしまいます");

        // 日時の変更
        if (a.start || a.end) {
          if (isRepeat) {
            const c = d.repeat!;
            if (d.allDay) throw new Error("終日の繰り返し予定の日付変更には対応していません");
            const s = a.start ? timeOf(a.start) : undefined;
            const e = a.end ? timeOf(a.end) : undefined;
            if ((s?.date && s.date !== occ) || (e?.date && e.date !== occ))
              throw new Error("繰り返し予定の変更では時刻だけ変えられます。別の日に移す場合は、その回を削除して新しく登録してください");
            const oldLen = jstDateTime("2000-01-01", c.endTime ?? c.startTime!).getTime() - jstDateTime("2000-01-01", c.startTime!).getTime();
            if (s) c.startTime = s.time;
            if (e) c.endTime = e.time;
            else if (s && c.endTime) c.endTime = `${toJstHm(new Date(jstDateTime("2000-01-01", s.time).getTime() + oldLen))}:00`;
            if (c.endTime && c.endTime <= c.startTime!) throw new Error("終了は開始より後にしてください");
          } else if (d.allDay || d.eventType === "banner") {
            if (a.start) d.startDate = parseYmd(a.start.slice(0, 10));
            if (a.end) d.endDate = parseYmd(a.end.slice(0, 10));
            else if (a.start && before.startDate && before.endDate) {
              const len = (jstDateStart(before.endDate).getTime() - jstDateStart(before.startDate).getTime()) / 86400000;
              d.endDate = addDays(d.startDate!, len);
            }
            if (d.endDate! < d.startDate!) throw new Error("終了日は開始日以降にしてください");
            d.eventType = d.endDate !== d.startDate ? "banner" : "normal";
            d.allDay = true;
          } else {
            const len = before.end && before.start ? before.end.getTime() - before.start.getTime() : 60 * 60000;
            if (a.start) d.start = parseJstDateTime(a.start);
            if (a.end) d.end = parseJstDateTime(a.end);
            else if (a.start) d.end = new Date(d.start!.getTime() + len);
            if (d.end && d.end.getTime() <= d.start!.getTime()) throw new Error("終了は開始より後にしてください");
          }
        }

        const slot = firstSlot(d, isRepeat ? occ : undefined);
        const c = a.confirm ? { people: [] as string[], rooms: [] as string[] } : await conflicts(ctx, d, slot, before.id);
        const scopeText = isRepeat ? { this: `この回だけ（${occ}）`, after: `${occ} 以降`, all: "すべての回" }[scope!] : "";
        let after = await describeDraft(ctx, d);
        if (isRepeat && scope === "this" && d.repeat) {
          const t = d.allDay ? "終日" : `${d.repeat.startTime?.slice(0, 5)}〜${d.repeat.endTime?.slice(0, 5) ?? ""}`;
          after = after.replace(/  日時: .*/, `  日時: ${occ} ${t}（この回だけ。単独の予定に切り出されます）`);
        } else if (isRepeat && scope === "after" && d.repeat) {
          after = after.replace(/  日時: (.*)（.*）$/m, `  日時: $1（${occ} 以降の回。元の予定は ${occ} の前日までになります）`);
        }
        const preview = `変更前:\n${await describeDraft(ctx, before)}\n\n変更後${scopeText ? `（${scopeText}）` : ""}:\n${after}`;

        if (!a.confirm) {
          return text(
            `【プレビュー：まだ変更していません】 id:${before.id} version:${before.version}\n${preview}\n\n${conflictText(c, isRepeat && scope !== "this")}${await planNote(ctx, a.plan)}\n\n` +
              `この内容でよければ、同じ引数に confirm=true と expected_version="${before.version}" を付けて再実行してください。`,
          );
        }
        if (!a.expected_version) throw new Error("confirm=true のときは expected_version（プレビューの version）を指定してください");
        if (a.expected_version !== before.version)
          throw new Error("プレビューの後にこの予定が変更されています。もう一度プレビューからやり直してください。");
        if (c.rooms.length) throw new Error(`設備が埋まっているため変更しません。\n${c.rooms.join("\n")}`);

        if (isRepeat) await ctx.writer.modifyRepeat(d, scope!, occ);
        else await ctx.writer.modify(d);
        ctx.sched.clearCache();
        return text(`✔ 変更しました（id:${before.id}${scopeText ? `、${scopeText}` : ""}）\n${after}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "cybozu_delete_event",
    {
      title: "予定を削除",
      description:
        "予定を削除する。参加者全員の予定表から消える点に注意。繰り返し予定は scope（this / after / all）と occurrence_date を指定。必ず confirm=false でプレビューを出し、返された version を expected_version に入れて confirm=true で実行すること。",
      inputSchema: {
        event_id: z.string(),
        scope: z.enum(["this", "after", "all"]).optional().describe("繰り返し予定のときの削除範囲"),
        occurrence_date: z.string().optional().describe("scope=this/after の基準日 YYYY-MM-DD"),
        expected_version: z.string().optional(),
        confirm: z.boolean().optional().describe(CONFIRM_DESC),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (a) => {
      try {
        const ctx = await getCtx();
        const raw = await ctx.writer.getRawById(a.event_id);
        const d = draftFromRaw(raw);
        const isRepeat = d.eventType === "repeat";
        if (isRepeat && !a.scope) throw new Error("繰り返し予定です。scope（this / after / all）を指定してください");
        if (isRepeat && a.scope !== "all" && !a.occurrence_date) throw new Error("scope=this / after のときは occurrence_date を指定してください");
        const occ = a.occurrence_date ? parseYmd(a.occurrence_date) : undefined;
        if (isRepeat && occ && !expandEvent(raw, jstDateStart(occ), jstDateStart(addDays(occ, 1))).length)
          throw new Error(`${occ} はこの繰り返し予定の回ではありません`);
        const scopeText = isRepeat ? { this: `この回だけ（${occ}）`, after: `${occ} 以降の回`, all: "すべての回" }[a.scope!] : "";
        const others = d.userIds.length - 1 + (d.orgIds?.length ? 1 : 0);
        if (!a.confirm) {
          return text(
            `【プレビュー：まだ削除していません】 id:${d.id} version:${d.version}\n${await describeDraft(ctx, d)}\n` +
              (scopeText ? `削除範囲: ${scopeText}\n` : "") +
              (others > 0 ? `⚠ 自分以外の参加者 ${others}人の予定表からも消えます。\n` : "") +
              `\nこの内容でよければ、同じ引数に confirm=true と expected_version="${d.version}" を付けて再実行してください。`,
          );
        }
        if (!a.expected_version) throw new Error("confirm=true のときは expected_version を指定してください");
        if (a.expected_version !== d.version) throw new Error("プレビューの後にこの予定が変更されています。もう一度プレビューからやり直してください。");
        if (isRepeat) await ctx.writer.removeFromRepeat(d.id!, a.scope!, occ);
        else await ctx.writer.remove(d.id!);
        ctx.sched.clearCache();
        return text(`✔ 削除しました（id:${d.id}${scopeText ? `、${scopeText}` : ""}）: ${d.detail}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "cybozu_find_free_rooms",
    {
      title: "空いている会議室を探す",
      description: "指定した時間帯に予約が入っていない設備（会議室）を一覧にする。",
      inputSchema: {
        start: z.string().describe('"YYYY-MM-DD HH:MM"'),
        end: z.string().describe('"YYYY-MM-DD HH:MM"'),
        query: z.string().optional().describe("設備名の絞り込み（例: 東京、会議室A）"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (a) => {
      try {
        const ctx = await getCtx();
        const s = parseJstDateTime(a.start);
        const e = parseJstDateTime(a.end);
        if (e.getTime() <= s.getTime()) throw new Error("終了は開始より後にしてください");
        let facs = await ctx.dir.listFacilities();
        if (a.query) facs = facs.filter((f) => f.name.includes(a.query!));
        const dayStart = jstDateStart(toJstYmd(s));
        const dayEnd = jstDateStart(addDays(toJstYmd(e), 1));
        const free: string[] = [];
        const busy: string[] = [];
        for (let i = 0; i < facs.length; i += 5) {
          await Promise.all(
            facs.slice(i, i + 5).map(async (f) => {
              const evs = await ctx.sched.getEvents({ kind: "facility", id: f.id }, dayStart, dayEnd);
              const hit = evs.filter((o) => overlaps(o, s, e));
              if (hit.length) busy.push(`- ${f.name} (id:${f.id}) … ${hit.map((o) => `${toJstHm(o.start)}〜${o.end ? toJstHm(o.end) : ""}`).join(", ")}`);
              else free.push(`- ${f.name} (id:${f.id})`);
            }),
          );
        }
        return text(
          `${toJstString(s)}〜${toJstHm(e)} の設備\n\n空き(${free.length}):\n${free.join("\n") || "なし"}\n\n予約あり(${busy.length}):\n${busy.join("\n") || "なし"}`,
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "cybozu_list_plan_menu",
    {
      title: "予定メニューの一覧",
      description: "予定登録時に選べる予定メニュー（社内Ｍ、訪問 など）を返す。",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const ctx = await getCtx();
        const m = await ctx.dir.planMenu();
        return text(m.length ? m.map((x) => `- ${x}`).join("\n") : "予定メニューは設定されていません");
      } catch (e) {
        return fail(e);
      }
    },
  );
}
