// ツールごとにサイボウズへ送る要求の回数を数える（負荷の確認用）。node test/count-requests.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { start, log, store } from "./mock-server.mjs";
const srv = await start(18084);
const env = { ...process.env, CYBOZU_URL: "http://127.0.0.1:18084/cgi-bin/cybozu/ag.cgi", CYBOZU_USERNAME: "me@example.jp", CYBOZU_PASSWORD: "p&ss<word>" };
const cases = [
  ["自分の予定（7日）", "cybozu_get_my_schedule", {}],
  ["他人の予定（名前指定）", "cybozu_get_schedule", { user: "山田" }],
  ["空き時間（2人＋会議室、7日）", "cybozu_find_free_time", { users: ["山田"], facilities: ["会議室A"] }],
  ["空き会議室", "cybozu_find_free_rooms", { start: "2026-10-02 15:00", end: "2026-10-02 16:00" }],
  ["ユーザー検索", "cybozu_search_users", { query: "佐藤" }],
  ["登録プレビュー（参加者1＋会議室1）", "cybozu_create_event", { title: "x", start: "2026-10-05 10:00", attendees: ["山田"], facilities: ["会議室B"] }],
  ["登録実行", "cybozu_create_event", { title: "x", start: "2026-10-05 10:00", attendees: ["山田"], facilities: ["会議室B"], confirm: true }],
];
const connect = async () => { const c = new Client({ name: "t", version: "1" }); await c.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env, stderr: "pipe" })); return c; };
const count = async (c, name, args) => { store.clear(); const n0 = log.length; await c.callTool({ name, arguments: args }); return log.length - n0; };
console.log("ツール: 起動直後 / 2回目");
for (const [label, name, args] of cases) {
  const c = await connect();
  const cold = await count(c, name, args);
  const warm = await count(c, name, args);
  console.log(`  ${label}: ${cold}回 / ${warm}回`);
  await c.close();
}
srv.close();
