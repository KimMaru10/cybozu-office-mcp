// Webサーバーの Basic 認証の前段がある環境のテスト
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { start } from "./mock-server.mjs";
const srv = await start(18082, { basic: "office:b@sic" });
let fails = 0;
const run = async (extraEnv) => {
  const t = new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env, CYBOZU_URL: "http://127.0.0.1:18082/cgi-bin/cybozu/ag.cgi", CYBOZU_USERNAME: "me@example.jp", CYBOZU_PASSWORD: "p&ss<word>", ...extraEnv }, stderr: "pipe" });
  const c = new Client({ name: "t", version: "1" }); await c.connect(t);
  const r = await c.callTool({ name: "cybozu_get_my_schedule", arguments: { start_date: "2026-10-02", end_date: "2026-10-02" } });
  await c.close(); return r;
};
const check = (cond, msg) => { console.log(`  ${cond ? "✔" : "✖ FAIL:"} ${msg}`); if (!cond) fails++; };
let r = await run({});
check(r.isError && r.content[0].text.includes("Basic認証）が必要です"), "Basic認証なし → 分かりやすいエラー");
r = await run({ CYBOZU_BASIC_USER: "office", CYBOZU_BASIC_PASSWORD: "wrong" });
check(r.isError && r.content[0].text.includes("Basic認証）に失敗"), "Basic認証の誤り → 失敗の案内");
r = await run({ CYBOZU_BASIC_USER: "office", CYBOZU_BASIC_PASSWORD: "b@sic" });
check(!r.isError && r.content[0].text.includes("社内Ｍ:定例"), "Basic認証あり → 予定を取得");
r = await run({ CYBOZU_BASIC_USER: "${user_config.basic_user}", CYBOZU_BASIC_PASSWORD: "${user_config.basic_password}" });
check(r.isError && r.content[0].text.includes("必要です"), "拡張機能の未入力値（${...}）は無視");
srv.close(); console.log(fails ? `✖ ${fails} 件失敗` : "✔ すべて成功"); process.exit(fails ? 1 : 0);
