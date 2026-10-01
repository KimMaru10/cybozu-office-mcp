// 接続確認: node dist/check.js
import { loadConfig } from "./config.js";
import { SoapClient } from "./soap.js";
import { Directory } from "./directory.js";
import { ScheduleApi } from "./schedule.js";
import { addDays, jstDateStart, todayJst } from "./time.js";

try {
  const cfg = await loadConfig();
  console.log(`接続先: ${cfg.baseUrl}\nログイン名: ${cfg.username}`);
  const soap = new SoapClient(cfg);
  const dir = new Directory(soap);
  const id = await dir.loginUserId();
  console.log(`✔ 認証OK（ユーザーID ${id}）`);
  const users = await dir.listUsers();
  console.log(`✔ ユーザー一覧 ${users.length}人（自分: ${users.find((u) => u.id === id)?.name ?? "?"}）`);
  const t = todayJst();
  const evs = await new ScheduleApi(soap).getEvents({ kind: "me" }, jstDateStart(t), jstDateStart(addDays(t, 7)));
  console.log(`✔ 今日から7日間の予定 ${evs.length}件`);
  console.log("接続確認は成功です。");
} catch (e: any) {
  console.error(`✖ 失敗: ${e?.message ?? e}${e?.code ? `（コード ${e.code}）` : ""}`);
  process.exit(1);
}
