import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { start, log, store } from "./mock-server.mjs";
const srv = await start(18081);
const t = new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env, CYBOZU_URL: "http://127.0.0.1:18081/cgi-bin/cybozu/ag.cgi", CYBOZU_USERNAME: "me@example.jp", CYBOZU_PASSWORD: "p&ss<word>" }, stderr: "pipe" });
const c = new Client({ name: "t", version: "1" }); await c.connect(t);
let fails = 0;
const call = async (name, args) => (await c.callTool({ name, arguments: args }));
const show = (title, r) => console.log(`\n### ${title}${r.isError ? " [isError]" : ""}\n${r.content[0].text}`);
const expect = (cond, msg) => { if (!cond) { fails++; console.log(`  ✖ FAIL: ${msg}`); } else console.log(`  ✔ ${msg}`); };
const ver = (r) => /version:(\d+)/.exec(r.content[0].text)?.[1];
const idOf = (r) => /登録しました（id:(\d+)/.exec(r.content[0].text)?.[1];

console.log("tools:", (await c.listTools()).tools.map(t => t.name).join(", "));
let r = await call("cybozu_list_plan_menu", {}); show("plan menu", r); expect(r.content[0].text.includes("テレビ会議（社外）"), "予定メニューを改行区切りで取得");
r = await call("cybozu_find_free_rooms", { start: "2026-10-02 12:00", end: "2026-10-02 13:00" }); show("free rooms 12-13", r);
expect(/空き\(1\):\n- 会議室B/.test(r.content[0].text), "会議室Aは予約あり、Bは空き");

// 重なりあり（会議室A 12:30）
const base = { title: "MTG", start: "2026-10-02 12:30", end: "2026-10-02 13:30", attendees: ["山田"], facilities: ["会議室A"], plan: "会議", memo: "議題: X" };
r = await call("cybozu_create_event", base); show("create preview (conflict)", r);
expect(r.content[0].text.includes("まだ登録していません") && r.content[0].text.includes("設備が埋まっています") && store.size === 0, "プレビューでは書き込まず、会議室の重なりを警告");
r = await call("cybozu_create_event", { ...base, confirm: true }); show("create confirm (conflict)", r);
expect(r.isError && store.size === 0, "会議室が埋まっていれば実行しない");

// 正常登録
const ok = { ...base, start: "2026-10-02 16:30", end: "2026-10-02 17:00", facilities: ["会議室B"] };
r = await call("cybozu_create_event", ok); show("create preview", r);
r = await call("cybozu_create_event", { ...ok, confirm: true }); show("create confirm", r);
const id1 = idOf(r); expect(id1 && store.has(id1), "登録された");
const xml1 = log.filter(l => l.method === "ScheduleAddEvents").pop().body.split("<soap:Body>")[1].split("</soap:Body>")[0];
console.log("  request:", xml1);
expect(xml1.includes('plan="会議"') && xml1.includes('description="議題: X"') && xml1.includes('<user id="100">') && xml1.includes('<facility id="35">') && xml1.includes('start="2026-10-02T07:30:00Z"'), "予定メニュー・メモ・参加者・設備・時刻(UTC)が送られる");
r = await call("cybozu_get_my_schedule", { start_date: "2026-10-02", end_date: "2026-10-02" }); show("my schedule 10/2", r);
expect(r.content[0].text.includes("会議:MTG") && r.content[0].text.includes("会議室B"), "取得結果に反映");

// 変更：プレビュー→古い版で失敗→正しい版で成功
r = await call("cybozu_update_event", { event_id: id1, start: "2026-10-02 17:00", remove_attendees: ["山田"], memo: "" }); show("update preview", r);
const v1 = ver(r);
r = await call("cybozu_update_event", { event_id: id1, start: "2026-10-02 17:00", confirm: true, expected_version: "999" }); show("update stale", r);
expect(r.isError && r.content[0].text.includes("プレビューの後に"), "版が違えば変更しない");
r = await call("cybozu_update_event", { event_id: id1, start: "2026-10-02 17:00", remove_attendees: ["山田"], memo: "", confirm: true, expected_version: v1 }); show("update confirm", r);
const m = log.filter(l => l.method === "ScheduleModifyEvents").pop().body;
expect(!r.isError && m.includes('start="2026-10-02T08:00:00Z" end="2026-10-02T08:30:00Z"') && !m.includes('<user id="100">') && m.includes('description=""'), "時間をずらし（長さ維持）、参加者とメモを外して送る");

// 繰り返し
const rep = { title: "週次", start: "2026-10-02 19:00", end: "2026-10-02 19:15", private: true, repeat: { frequency: "weekly", until: "2026-10-23" } };
r = await call("cybozu_create_event", { ...rep, confirm: true }); show("create repeat", r);
const id2 = idOf(r);
expect(log.filter(l => l.method === "ScheduleAddEvents").pop().body.includes('<condition type="week" day="0" week="5" start_date="2026-10-02" end_date="2026-10-23" start_time="19:00:00" end_time="19:15:00">'), "毎週金曜の繰り返し条件を送る");
r = await call("cybozu_get_my_schedule", { start_date: "2026-10-01", end_date: "2026-10-31" });
expect((r.content[0].text.match(/  週次  \[/g) || []).length === 4, "10/2,9,16,23 の4回に展開");
r = await call("cybozu_update_event", { event_id: id2, start: "19:30" }); show("update repeat w/o scope", r);
expect(r.isError, "繰り返しは scope 必須");
r = await call("cybozu_update_event", { event_id: id2, scope: "this", occurrence_date: "2026-10-15", start: "19:30" });
expect(r.isError && r.content[0].text.includes("回ではありません"), "存在しない回は弾く");
r = await call("cybozu_update_event", { event_id: id2, scope: "this", occurrence_date: "2026-10-16", start: "19:30" }); show("update repeat this preview", r);
r = await call("cybozu_update_event", { event_id: id2, scope: "this", occurrence_date: "2026-10-16", start: "19:30", confirm: true, expected_version: ver(r) }); show("update repeat this", r);
expect(log.filter(l => l.method === "ScheduleModifyRepeatEvents").pop().body.includes('<operation type="this" date="2026-10-16">') && log.filter(l => l.method === "ScheduleModifyRepeatEvents").pop().body.includes('start_time="19:30:00" end_time="19:45:00"'), "この回だけ 19:30〜19:45 に（長さ維持）");
r = await call("cybozu_get_my_schedule", { start_date: "2026-10-16", end_date: "2026-10-16" }); show("10/16", r);
expect(r.content[0].text.includes("19:30〜19:45") && !r.content[0].text.includes("19:00〜19:15  週次"), "10/16 は変更後の1件だけ");
r = await call("cybozu_delete_event", { event_id: id2, scope: "after", occurrence_date: "2026-10-23" }); show("delete after preview", r);
r = await call("cybozu_delete_event", { event_id: id2, scope: "after", occurrence_date: "2026-10-23", confirm: true, expected_version: ver(r) }); show("delete after", r);
r = await call("cybozu_get_my_schedule", { start_date: "2026-10-01", end_date: "2026-10-31" });
expect((r.content[0].text.match(/  週次  \[id:9001/g) || []).length === 2, "10/23 以降が消え、10/2・10/9 が残る（10/16 は単独予定に）");
r = await call("cybozu_delete_event", { event_id: id2, scope: "all" });
r = await call("cybozu_delete_event", { event_id: id2, scope: "all", confirm: true, expected_version: ver(r) });
expect(!r.isError && !store.has(id2), "繰り返しをすべて削除");

// 終日・期間
r = await call("cybozu_create_event", { title: "休み", start: "2026-10-05", all_day: true, plan: "休み", confirm: true });
expect(log.filter(l => l.method === "ScheduleAddEvents").pop().body.includes('event_type="normal"') && log.filter(l => l.method === "ScheduleAddEvents").pop().body.includes('allday="true"') && log.filter(l => l.method === "ScheduleAddEvents").pop().body.includes('<date start="2026-10-05" end="2026-10-05">'), "終日予定");
r = await call("cybozu_create_event", { title: "出張", start: "2026-10-06", end: "2026-10-07", all_day: true, confirm: true });
expect(log.filter(l => l.method === "ScheduleAddEvents").pop().body.includes('event_type="banner"'), "複数日は期間予定(banner)");

// 削除（他の参加者がいる予定は警告）
r = await call("cybozu_create_event", { title: "共有", start: "2026-10-08 10:00", attendees: ["佐藤花子"], confirm: true }); const id3 = idOf(r);
r = await call("cybozu_delete_event", { event_id: id3 }); show("delete preview", r);
expect(r.content[0].text.includes("1人の予定表からも消えます") && store.has(id3), "削除プレビューで他の参加者への影響を警告し、まだ消さない");
r = await call("cybozu_delete_event", { event_id: id3, confirm: true }); expect(r.isError, "confirm だけでは消さない（版が必要）");
r = await call("cybozu_delete_event", { event_id: id3, confirm: true, expected_version: "1" }); expect(!r.isError && !store.has(id3), "削除");

// 組織が参加者に入った予定を変更しても、組織が消えない
store.set("8000", { xml: `<schedule_event id="8000" event_type="normal" public_type="public" plan="" detail="部会" description="" version="5" timezone="JST" allday="false" start_only="false"><members><member><user id="1000" name="テスト自分" order="1"/></member><member><organization id="20" name="営業部" order="1"/></member></members><when><datetime start="2026-10-09T01:00:00Z" end="2026-10-09T02:00:00Z"/></when></schedule_event>`, users: ["1000"], facilities: [], ver: "5" });
r = await call("cybozu_update_event", { event_id: "8000", title: "部会（変更）" }); show("update org event preview", r);
expect(r.content[0].text.includes("[組織] 営業部"), "プレビューに組織の参加者を表示");
r = await call("cybozu_update_event", { event_id: "8000", title: "部会（変更）", confirm: true, expected_version: "5" });
expect(!r.isError && log.filter(l => l.method === "ScheduleModifyEvents").pop().body.includes('<organization id="20">'), "変更時に組織の参加者を保持して送る");

// 空き時間（会議室込み）
r = await call("cybozu_find_free_time", { users: ["山田"], facilities: ["会議室A"], start_date: "2026-10-02", end_date: "2026-10-02" }); show("free time with room", r);
// 入力チェック
r = await call("cybozu_create_event", { title: "x", start: "2026-10-02 10:07" }); expect(r.isError && r.content[0].text.includes("5分単位"), "5分単位チェック");
r = await call("cybozu_create_event", { title: "x", start: "2026-10-02 10:00", facilities: ["会議"] }); expect(r.isError && r.content[0].text.includes("2件"), "設備名があいまいなら候補を返す");

await c.close(); srv.close();
console.log(`\n${fails ? `✖ ${fails} 件失敗` : "✔ すべて成功"}`); process.exit(fails ? 1 : 0);
