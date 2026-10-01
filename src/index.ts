#!/usr/bin/env node
// サイボウズ Office 10（パッケージ版）MCP サーバー（非公式）
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { SoapClient } from "./soap.js";
import { Directory } from "./directory.js";
import { ScheduleApi, ScheduleWriter, formatOccurrence, Target, EventOccurrence } from "./schedule.js";
import { registerWriteTools, Ctx } from "./writeTools.js";
import { findFreeSlots, formatSlots } from "./freetime.js";
import { addDays, jstDateStart, todayJst, toJstString } from "./time.js";

const VERSION = "0.2.4";

let ctx: Ctx | undefined;
async function getCtx(): Promise<Ctx> {
  if (!ctx) {
    const cfg = await loadConfig();
    const soap = new SoapClient(cfg);
    ctx = { dir: new Directory(soap), sched: new ScheduleApi(soap), writer: new ScheduleWriter(soap) };
  }
  return ctx;
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const fail = (e: unknown) => ({
  content: [{ type: "text" as const, text: `エラー: ${e instanceof Error ? e.message : String(e)}` }],
  isError: true,
});

const dateArg = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD 形式");

function range(startDate?: string, endDate?: string, defaultDays = 7) {
  const s = startDate ?? todayJst();
  const e = endDate ?? addDays(s, defaultDays - 1);
  if (e < s) throw new Error("end_date は start_date 以降にしてください");
  if (jstDateStart(e).getTime() - jstDateStart(s).getTime() > 92 * 86400000)
    throw new Error("期間は最大93日までです");
  return { s, e, start: jstDateStart(s), end: jstDateStart(addDays(e, 1)) };
}

function render(header: string, evs: EventOccurrence[], withMembers: boolean, withDescription: boolean) {
  if (!evs.length) return `${header}\n予定はありません。`;
  return `${header}（${evs.length}件）\n${evs.map((o) => formatOccurrence(o, { withMembers, withDescription })).join("\n")}`;
}

const server = new McpServer({ name: "cybozu-office", version: VERSION });
const RO = { readOnlyHint: true, openWorldHint: false };

server.registerTool(
  "cybozu_get_my_schedule",
  {
    title: "自分の予定を取得",
    description:
      "サイボウズ Office から、ログインユーザー自身の予定を取得します。期間を省略すると今日から7日分。日時はすべて日本時間。繰り返し予定は1回ずつに展開して返します。",
    inputSchema: {
      start_date: dateArg.optional().describe("開始日 YYYY-MM-DD（省略時は今日）"),
      end_date: dateArg.optional().describe("終了日 YYYY-MM-DD（この日を含む。省略時は開始日+6日）"),
      include_members: z.boolean().optional().describe("参加者名も出す（既定 false）"),
      include_description: z.boolean().optional().describe("メモ欄も出す（既定 false）"),
    },
    annotations: RO,
  },
  async ({ start_date, end_date, include_members, include_description }) => {
    try {
      const { sched } = await getCtx();
      const r = range(start_date, end_date);
      const evs = await sched.getEvents({ kind: "me" }, r.start, r.end);
      return text(render(`自分の予定 ${r.s}〜${r.e}`, evs, !!include_members, !!include_description));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "cybozu_get_schedule",
  {
    title: "他のメンバー・組織・設備の予定を取得",
    description:
      "指定したユーザー（名前の一部・ログイン名・ID）、組織、または設備の予定を取得します。名前で一意に決まらない場合は候補を返すので、IDで指定し直してください。",
    inputSchema: {
      user: z.string().optional().describe("ユーザー名の一部、ログイン名、メール、またはユーザーID"),
      organization_id: z.string().optional().describe("組織ID（cybozu_list_organizations で確認）"),
      facility_id: z.string().optional().describe("設備ID（cybozu_list_facilities で確認）"),
      start_date: dateArg.optional(),
      end_date: dateArg.optional(),
      include_members: z.boolean().optional(),
      include_description: z.boolean().optional(),
    },
    annotations: RO,
  },
  async ({ user, organization_id, facility_id, start_date, end_date, include_members, include_description }) => {
    try {
      const { dir, sched } = await getCtx();
      const n = [user, organization_id, facility_id].filter(Boolean).length;
      if (n !== 1) throw new Error("user / organization_id / facility_id のどれか1つを指定してください");
      const r = range(start_date, end_date);
      let target: Target;
      let label: string;
      if (user) {
        const u = await dir.resolveUser(user);
        target = { kind: "user", id: u.id };
        label = `${u.name}(id:${u.id})`;
      } else if (organization_id) {
        target = { kind: "organization", id: organization_id };
        label = `組織 ${(await dir.orgName(organization_id)) ?? organization_id}`;
      } else {
        const f = (await dir.listFacilities()).find((x) => x.id === facility_id);
        target = { kind: "facility", id: facility_id! };
        label = `設備 ${f?.name ?? facility_id}`;
      }
      const evs = await sched.getEvents(target, r.start, r.end);
      return text(render(`${label} の予定 ${r.s}〜${r.e}`, evs, !!include_members, !!include_description));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "cybozu_find_free_time",
  {
    title: "複数人の空き時間を探す",
    description:
      "指定したメンバー全員（既定で自分を含む）の予定が空いている時間帯を探します。既定は平日 9:00〜18:00、終日予定は空き扱い。非公開の予定も埋まり扱いになります。",
    inputSchema: {
      users: z.array(z.string()).describe("ユーザー名の一部・ログイン名・IDの配列"),
      include_me: z.boolean().optional().describe("自分も含める（既定 true）"),
      duration_minutes: z.number().int().min(5).max(600).optional().describe("必要な長さ（分）。既定 60"),
      start_date: dateArg.optional().describe("探す期間の開始日（既定は今日）"),
      end_date: dateArg.optional().describe("探す期間の終了日（既定は開始日+6日）"),
      day_start: z.string().regex(/^\d{1,2}:\d{2}$/).optional().describe("1日の開始時刻（既定 09:00）"),
      day_end: z.string().regex(/^\d{1,2}:\d{2}$/).optional().describe("1日の終了時刻（既定 18:00）"),
      include_weekends: z.boolean().optional().describe("土日も探す（既定 false）"),
      all_day_is_busy: z.boolean().optional().describe("終日予定を埋まり扱いにする（既定 false）"),
      facilities: z.array(z.string()).optional().describe("同時に空いている必要がある会議室など（名前の一部またはID）"),
    },
    annotations: RO,
  },
  async (a) => {
    try {
      const { dir, sched } = await getCtx();
      const r = range(a.start_date, a.end_date);
      const people: { id: string; name: string }[] = [];
      if (a.include_me ?? true) {
        const myId = await dir.loginUserId();
        const me = (await dir.listUsers()).find((u) => u.id === myId);
        people.push({ id: myId, name: me?.name ?? "自分" });
      }
      for (const q of a.users) {
        const u = await dir.resolveUser(q);
        if (!people.some((p) => p.id === u.id)) people.push({ id: u.id, name: u.name });
      }
      const rooms: { id: string; name: string }[] = [];
      for (const q of a.facilities ?? []) {
        const f = await dir.resolveFacility(q);
        if (!rooms.some((x) => x.id === f.id)) rooms.push({ id: f.id, name: f.name });
      }
      if (!people.length && !rooms.length) throw new Error("対象者がいません");
      const lists = await Promise.all([
        ...people.map((p) => sched.getEvents({ kind: "user", id: p.id }, r.start, r.end)),
        ...rooms.map((f) => sched.getEvents({ kind: "facility", id: f.id }, r.start, r.end)),
      ]);
      const slots = findFreeSlots(lists, {
        rangeStart: r.start,
        rangeEnd: r.end,
        durationMin: a.duration_minutes ?? 60,
        dayStart: a.day_start ?? "09:00",
        dayEnd: a.day_end ?? "18:00",
        includeWeekends: a.include_weekends ?? false,
        allDayIsBusy: a.all_day_is_busy ?? false,
      });
      const allDayNotes = lists
        .slice(0, people.length)
        .flatMap((l, i) =>
          l
            .filter((e) => e.allDay)
            .map((e) => {
              const first = toJstString(e.start).slice(0, 10);
              const last = toJstString(new Date((e.end ?? e.start).getTime() - 1)).slice(0, 10);
              return `${people[i].name}: ${first === last ? first : `${first}〜${last}`} ${e.title}`;
            }),
        )
        .slice(0, 20);
      return text(
        [
          `対象: ${people.map((p) => p.name).join("、")}${rooms.length ? ` ／ 設備: ${rooms.map((f) => f.name).join("、")}` : ""}`,
          `条件: ${r.s}〜${r.e} / ${a.day_start ?? "09:00"}〜${a.day_end ?? "18:00"} / ${a.duration_minutes ?? 60}分以上`,
          "",
          formatSlots(slots),
          allDayNotes.length ? `\n参考：期間中の終日予定（空き扱いにしています）\n${allDayNotes.join("\n")}` : "",
        ].join("\n"),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "cybozu_search_users",
  {
    title: "ユーザーを検索",
    description: "名前の一部・ログイン名・メール・組織名でユーザーを検索し、IDと所属を返します。",
    inputSchema: { query: z.string().describe("検索語（例: 山田、開発部）") },
    annotations: RO,
  },
  async ({ query }) => {
    try {
      const { dir } = await getCtx();
      const hits = await dir.searchUsers(query);
      const orgs = await dir.listOrganizations();
      const on = (id?: string) => orgs.find((o) => o.id === id)?.name;
      if (!hits.length) return text(`「${query}」に当たるユーザーはいません。`);
      const lines = hits
        .slice(0, 50)
        .map((u) => `- ${u.name} (id:${u.id}${u.loginName ? `, ${u.loginName}` : ""})${on(u.primaryOrganization) ? ` / ${on(u.primaryOrganization)}` : ""}`);
      return text(`${hits.length}件${hits.length > 50 ? "（先頭50件）" : ""}\n${lines.join("\n")}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "cybozu_list_organizations",
  {
    title: "組織の一覧",
    description: "組織（部署）の一覧とID、人数を返します。",
    inputSchema: { query: z.string().optional().describe("組織名の絞り込み") },
    annotations: RO,
  },
  async ({ query }) => {
    try {
      const { dir } = await getCtx();
      let orgs = await dir.listOrganizations();
      if (query) orgs = orgs.filter((o) => o.name.includes(query));
      return text(orgs.map((o) => `- ${o.name} (id:${o.id}, ${o.memberIds.length}人)`).join("\n") || "該当なし");
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "cybozu_list_facilities",
  {
    title: "設備の一覧",
    description: "会議室などの設備の一覧とIDを返します。",
    inputSchema: { query: z.string().optional().describe("設備名の絞り込み") },
    annotations: RO,
  },
  async ({ query }) => {
    try {
      const { dir } = await getCtx();
      let fs = await dir.listFacilities();
      if (query) fs = fs.filter((f) => f.name.includes(query));
      return text(fs.map((f) => `- ${f.name} (id:${f.id})`).join("\n") || "該当なし");
    } catch (e) {
      return fail(e);
    }
  },
);

registerWriteTools(server, getCtx);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`cybozu-office MCP v${VERSION} started`);
