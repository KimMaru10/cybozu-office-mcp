import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { start, log } from "./mock-server.mjs";
const srv = await start(18080);
async function session(password) {
  const t = new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env, CYBOZU_URL: "http://127.0.0.1:18080/cgi-bin/cybozu/ag.cgi?page=AGIndex", CYBOZU_USERNAME: "me@example.jp", CYBOZU_PASSWORD: password }, stderr: "pipe" });
  const c = new Client({ name: "t", version: "1" }); await c.connect(t); return c;
}
const show = (title, r) => console.log(`\n### ${title}${r.isError ? " [isError]" : ""}\n${r.content[0].text}`);
const c = await session("p&ss<word>");
console.log("tools:", (await c.listTools()).tools.map(t => t.name).join(", "));
show("my 10/1-10/9", await c.callTool({ name: "cybozu_get_my_schedule", arguments: { start_date: "2026-10-01", end_date: "2026-10-09", include_members: true, include_description: true } }));
show("yamada 10/2", await c.callTool({ name: "cybozu_get_schedule", arguments: { user: "山田", start_date: "2026-10-02", end_date: "2026-10-02" } }));
show("ambiguous 佐藤", await c.callTool({ name: "cybozu_get_schedule", arguments: { user: "佐藤", start_date: "2026-10-02" } }));
show("free 10/2-10/7 60min", await c.callTool({ name: "cybozu_find_free_time", arguments: { users: ["yamada@example.jp"], start_date: "2026-10-02", end_date: "2026-10-07" } }));
show("search 営業", await c.callTool({ name: "cybozu_search_users", arguments: { query: "営業" } }));
show("orgs", await c.callTool({ name: "cybozu_list_organizations", arguments: {} }));
show("facilities", await c.callTool({ name: "cybozu_list_facilities", arguments: {} }));
show("bad date", await c.callTool({ name: "cybozu_get_my_schedule", arguments: { start_date: "2026-10-09", end_date: "2026-10-01" } }));
await c.close();
const bad = await session("wrong");
show("wrong password", await bad.callTool({ name: "cybozu_get_my_schedule", arguments: {} }));
await bad.close();
const sample = log.find(l => l.method === "ScheduleGetEventsByTarget");
console.log("\n### sample request (page=%s)\n%s", sample.page, sample.body.replace(/<Password>.*<\/Password>/, "<Password>***</Password>").split("<soap:Body>")[1]);
console.log("pages used:", [...new Set(log.map(l => l.page))].join(", "));
srv.close();
