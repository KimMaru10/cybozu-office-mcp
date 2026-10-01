// サイボウズ Office 10 の SOAP 応答を模したテスト用サーバー（実データの構造を元にした合成データ）
import http from "node:http";
export const log = [];
const env = (ns, method, inner) => `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:${ns}="http://wsdl.cybozu.co.jp/x/2008">
 <soap:Header><vendor>Cybozu</vendor><product>Office</product><version>10.8.4</version><apiversion>1.3.0</apiversion></soap:Header>
 <soap:Body><${ns}:${method}Response><returns>${inner}</returns></${ns}:${method}Response></soap:Body></soap:Envelope>`;
const fault = (code, diag, cause) => `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><soap:Fault><soap:Code><soap:Value>soap:Sender</soap:Value></soap:Code><soap:Reason><soap:Text xml:lang="ja-JP">${diag}</soap:Text></soap:Reason><soap:Detail><code>${code}</code><diagnosis>${diag}</diagnosis><cause>${cause}</cause><counter_measure></counter_measure></soap:Detail></soap:Fault></soap:Body></soap:Envelope>`;
const users = [
  ["100","山田太郎","yamada@example.jp","19"],["101","佐藤花子","sato@example.jp","19"],["102","佐藤一郎","sato1@example.jp","20"],["1000","テスト自分","me@example.jp","19"],
];
const member = (id, name) => `<member xmlns="http://schemas.cybozu.co.jp/schedule/2008"><user id="${id}" name="${name}" order="1"/></member>`;
// 自分(1000): 10/2(金) 12:00-13:00 通常, 毎週金 10:10-10:30 繰り返し(10/9除外), 10/5-10/6 期間予定(バナー), 10/7 非公開 14:00-15:00
// 山田(100): 10/2 15:00-16:30, 毎日(土日除く)9:00-9:30 朝礼
const events = {
  "1000": `
<schedule_event id="1" event_type="normal" public_type="public" plan="社内Ｍ" detail="定例" description="議題A" version="1" timezone="JST" allday="false" start_only="false">
 <members xmlns="http://schemas.cybozu.co.jp/schedule/2008">${member("1000","テスト自分")}${member("100","山田太郎")}<member><facility id="34" name="会議室A" order="1"/></member></members>
 <when xmlns="http://schemas.cybozu.co.jp/schedule/2008"><datetime start="2026-10-02T03:00:00Z" end="2026-10-02T04:00:00Z"/></when></schedule_event>
<schedule_event id="2" event_type="repeat" public_type="public" plan="" detail="週次朝会" description="" version="1" timezone="JST" allday="false" start_only="false">
 <members xmlns="http://schemas.cybozu.co.jp/schedule/2008">${member("1000","テスト自分")}</members>
 <repeat_info xmlns="http://schemas.cybozu.co.jp/schedule/2008"><condition type="week" day="0" week="5" start_date="2025-11-14" start_time="10:10:00" end_time="10:30:00"/>
 <exclusive_datetimes><exclusive_datetime start="2026-10-09T00:00:00+09:00" end="2026-10-10T00:00:00+09:00"/></exclusive_datetimes></repeat_info></schedule_event>
<schedule_event id="3" event_type="banner" public_type="public" plan="出張" detail="大阪" version="1" timezone="JST" allday="true" start_only="false">
 <members xmlns="http://schemas.cybozu.co.jp/schedule/2008">${member("1000","テスト自分")}</members>
 <when xmlns="http://schemas.cybozu.co.jp/schedule/2008"><date start="2026-10-05" end="2026-10-06"/></when></schedule_event>
<schedule_event id="4" event_type="normal" public_type="private" plan="" detail="" version="1" timezone="JST" allday="false" start_only="false">
 <members xmlns="http://schemas.cybozu.co.jp/schedule/2008">${member("1000","テスト自分")}</members>
 <when xmlns="http://schemas.cybozu.co.jp/schedule/2008"><datetime start="2026-10-07T05:00:00Z" end="2026-10-07T06:00:00Z"/></when></schedule_event>`,
  "100": `
<schedule_event id="10" event_type="normal" public_type="public" plan="訪問" detail="A社" version="1" timezone="JST" allday="false" start_only="false">
 <members xmlns="http://schemas.cybozu.co.jp/schedule/2008">${member("100","山田太郎")}</members>
 <when xmlns="http://schemas.cybozu.co.jp/schedule/2008"><datetime start="2026-10-02T06:00:00Z" end="2026-10-02T07:30:00Z"/></when></schedule_event>
<schedule_event id="11" event_type="repeat" public_type="public" plan="" detail="朝礼" version="1" timezone="JST" allday="false" start_only="false">
 <members xmlns="http://schemas.cybozu.co.jp/schedule/2008">${member("100","山田太郎")}</members>
 <repeat_info xmlns="http://schemas.cybozu.co.jp/schedule/2008"><condition type="weekday" day="10" week="3" start_date="2024-01-01" start_time="09:00:00" end_time="09:30:00"/></repeat_info></schedule_event>`,
};
// ── 書き込み用の簡易ストア（実サーバーで確かめた挙動を模す） ──
export const store = new Map(); // id -> { xml, users:[], facilities:[], ver }
let nextId = 9000;
const attr = (x, n) => new RegExp(`\\s${n}="([^"]*)"`).exec(x)?.[1];
function storeEvent(xml, id, ver) {
  const users = [...xml.matchAll(/<user id="(\d+)"/g)].map((m) => m[1]);
  const facilities = [...xml.matchAll(/<facility id="(\d+)"/g)].map((m) => m[1]);
  const named = xml
    .replace(/<user id="(\d+)"><\/user>/g, (_, i) => `<user id="${i}" name="${(users_[i] ?? "?")}" order="1"/>`)
    .replace(/<facility id="(\d+)"><\/facility>/g, (_, i) => `<facility id="${i}" name="${i === "34" ? "会議室A" : "会議室B"}" order="1"/>`)
    .replace(/ id="dummy"/, ` id="${id}"`).replace(/ id="\d+" event_type/, ` id="${id}" event_type`)
    .replace(/ version="[^"]*"/, ` version="${ver}"`).replace('xmlns=""', '');
  store.set(String(id), { xml: named, users, facilities, ver: String(ver) });
  return named;
}
const users_ = { "100": "山田太郎", "101": "佐藤花子", "102": "佐藤一郎", "1000": "テスト自分" };
function overlap(xml) {
  const s = attr(xml.split("<datetime")[1] ?? "", "start"), e = attr(xml.split("<datetime")[1] ?? "", "end");
  return s && e ? [Date.parse(s), Date.parse(e)] : null;
}
export const stats = { inflight: 0, maxInflight: 0, busyReturned: 0 };
export function start(port, opts = {}) {
  return new Promise((res) => {
    const srv = http.createServer((req, resp) => {
      let body = ""; req.on("data", (c) => (body += c)); req.on("end", async () => {
        stats.inflight++; stats.maxInflight = Math.max(stats.maxInflight, stats.inflight);
        resp.on("finish", () => stats.inflight--);
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        if (opts.busy && opts.busy > 0 && !/UtilGetLoginUserId|Versions|ById"/.test("")) {
          opts.busy--; stats.busyReturned++;
          resp.setHeader("Content-Type", "application/soap+xml; charset=utf-8");
          return resp.end(fault("17","データベースにアクセスが集中しています。しばらく経ってから再度アクセスしてください。","（データベース名：x.odbx、診断コード：5）"));
        }
        if (opts.basic && req.headers.authorization !== "Basic " + Buffer.from(opts.basic).toString("base64")) {
          resp.statusCode = 401; resp.setHeader("WWW-Authenticate", 'Basic realm="Input ID and Password."');
          return resp.end("<html><title>401 Unauthorized</title></html>");
        }
        const page = new URL(req.url, "http://x").searchParams.get("page");
        const method = /<Action[^>]*>([^<]+)<\/Action>/.exec(body)?.[1];
        log.push({ page, method, body });
        resp.setHeader("Content-Type", "application/soap+xml; charset=utf-8");
        const user = /<Username>([^<]*)<\/Username>/.exec(body)?.[1];
        const pass = /<Password>([^<]*)<\/Password>/.exec(body)?.[1];
        if (user !== "me@example.jp" || pass !== "p&ss<word>".replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"))
          return resp.end(fault("10101","ログインに失敗しました。","ログイン名またはパスワードが正しくありません。"));
        let out;
        switch (method) {
          case "UtilGetLoginUserId": out = env("util", method, "<user_id>1000</user_id>"); break;
          case "BaseGetUserVersions": out = env("base", method, users.map(u=>`<user_item id="${u[0]}" version="1" operation="add"/>`).join("")); break;
          case "BaseGetUsersById": { const ids=[...body.matchAll(/<user_id>(\d+)<\/user_id>/g)].map(m=>m[1]);
            out = env("base", method, users.filter(u=>ids.includes(u[0])).map(u=>`<user key="${u[0]}" version="1" order="1" login_name="${u[2]}" name="${u[1]}" status="0" email="${u[2]}" primary_organization="${u[3]}"><organization id="${u[3]}" xmlns="http://schemas.cybozu.co.jp/base/2008"/></user>`).join("")); break; }
          case "BaseGetOrganizationVersions": out = env("base", method, `<organization_item id="19" version="1" operation="add"/><organization_item id="20" version="1" operation="add"/>`); break;
          case "BaseGetOrganizationsById": out = env("base", method, `<organization key="19" name="開発部" version="1" order="1"><members xmlns="http://schemas.cybozu.co.jp/base/2008"><user id="100"/><user id="101"/><user id="1000"/></members></organization><organization key="20" name="営業部" version="1" order="2"><members xmlns="http://schemas.cybozu.co.jp/base/2008"><user id="102"/></members></organization>`); break;
          case "ScheduleGetFacilityVersions": out = env("schedule", method, `<facility_item id="34" version="1" operation="add"/><facility_item id="35" version="1" operation="add"/>`); break;
          case "ScheduleGetFacilitiesById": out = env("schedule", method, `<facility key="34" name="会議室A" version="1" order="1" description=""/><facility key="35" name="会議室B" version="1" order="2" description=""/>`); break;
          case "ScheduleGetEvents": out = env("schedule", method, events["1000"] + [...store.values()].filter(v=>v.users.includes("1000")).map(v=>v.xml).join("")); break;
          case "ScheduleGetEventsByTarget": { const uid=/<user id="(\d+)"/.exec(body)?.[1]; const fid=/<facility id="(\d+)"/.exec(body)?.[1];
            const extra=[...store.values()].filter(v=> uid ? v.users.includes(uid) : v.facilities.includes(fid)).map(v=>v.xml).join("");
            const base = uid ? (events[uid] ?? "") : (fid === "34" ? events["1000"].split("</schedule_event>")[0] + "</schedule_event>" : "");
            out = env("schedule", method, base + extra); break; }
          case "ScheduleGetEventsById": { const id=/<event_id>(\d+)<\/event_id>/.exec(body)?.[1]; const v=store.get(id);
            out = v ? env("schedule", method, v.xml) : fault("501","データが見つかりません。",""); break; }
          case "ScheduleGetProfiles": out = env("schedule", method, `<personal_profile plan_menu="" notify_mail="false"></personal_profile><system_profile plan_menu="社内Ｍ&#10;訪問&#10;会議&#10;テレビ会議（社外）&#10;"></system_profile>`); break;
          case "ScheduleAddEvents": {
            const ev = /<schedule_event[\s\S]*<\/schedule_event>/.exec(body)[0];
            const fac = [...ev.matchAll(/<facility id="(\d+)"/g)].map(m=>m[1]); const iv = overlap(ev);
            const clash = iv && fac.some(f => [...store.values()].some(v => v.facilities.includes(f) && (()=>{const o=overlap(v.xml); return o && o[0]<iv[1] && o[1]>iv[0];})()))
              || (iv && fac.includes("34") && iv[0] < Date.parse("2026-10-02T04:00:00Z") && iv[1] > Date.parse("2026-10-02T03:00:00Z"));
            if (clash) { out = fault("14312","他の予約と時間帯が重なっています。",""); break; }
            const id = String(nextId++); out = env("schedule", method, storeEvent(ev, id, 1)); break; }
          case "ScheduleModifyEvents": {
            const ev = /<schedule_event[\s\S]*<\/schedule_event>/.exec(body)[0]; const id = attr(ev, "id");
            if (!store.has(id)) { out = fault("501","データが見つかりません。",""); break; }
            out = env("schedule", method, storeEvent(ev, id, Number(store.get(id).ver) + 1)); break; }
          case "ScheduleModifyRepeatEvents": {
            const op = attr(body.split("<operation")[1], "type"); const ev = /<schedule_event[\s\S]*<\/schedule_event>/.exec(body)[0]; const id = attr(ev, "id");
            if (!store.has(id)) { out = fault("501","データが見つかりません。",""); break; }
            if (op === "all") { const x = storeEvent(ev, id, Number(store.get(id).ver) + 1); out = env("schedule", method, `<result><original ${x.slice(16)}</result>`); }
            else { const nid = String(nextId++); const date = attr(body.split("<operation")[1], "date");
              const st = attr(ev, "start_time"), et = attr(ev, "end_time");
              const single = ev.replace('event_type="repeat"','event_type="normal"').replace(/<repeat_info>[\s\S]*<\/repeat_info>/, `<when><datetime start="${new Date(Date.parse(date+"T"+st+"+09:00")).toISOString().replace(".000","")}" end="${new Date(Date.parse(date+"T"+et+"+09:00")).toISOString().replace(".000","")}"></datetime></when>`);
              storeEvent(single, nid, 1);
              const orig = store.get(id); orig.xml = orig.xml.replace("</repeat_info>", `<exclusive_datetimes><exclusive_datetime start="${date}T00:00:00+09:00" end="${date}T23:59:59+09:00"/></exclusive_datetimes></repeat_info>`); orig.ver = String(Number(orig.ver)+1); orig.xml = orig.xml.replace(/ version="[^"]*"/, ` version="${orig.ver}"`);
              out = env("schedule", method, `<result><original id="${id}"/><modified id="${nid}" event_type="normal"/></result>`); }
            break; }
          case "ScheduleRemoveEvents": { const id=/<event_id>(\d+)<\/event_id>/.exec(body)?.[1]; if(!store.delete(id)) { out = fault("501","データが見つかりません。",""); break; } out = env("schedule", method, ""); break; }
          case "ScheduleRemoveEventsFromRepeatEvent": { const o = body.split("<operation")[1]; const id = attr(o,"event_id"), t = attr(o,"type"), date = attr(o,"date");
            const v = store.get(id); if (!v) { out = fault("501","データが見つかりません。",""); break; }
            if (t === "all") store.delete(id);
            else if (t === "this") { v.xml = v.xml.replace("</repeat_info>", `<exclusive_datetimes><exclusive_datetime start="${date}T00:00:00+09:00" end="${date}T23:59:59+09:00"/></exclusive_datetimes></repeat_info>`); }
            else { const prev = new Date(Date.parse(date+"T00:00:00+09:00") - 86400000 + 9*3600000).toISOString().slice(0,10); v.xml = v.xml.replace(/end_date="[^"]*"/, `end_date="${prev}"`); }
            out = env("schedule", method, ""); break; }
          default: out = fault("19105","未対応", method);
        }
        resp.end(out);
      });
    });
    srv.listen(port, () => res(srv));
  });
}
