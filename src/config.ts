// 設定の読み込み。パスワードは環境変数か macOS キーチェーンから取る
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SoapConfig } from "./soap.js";

const run = promisify(execFile);
export const KEYCHAIN_SERVICE = "cybozu-mcp";

export async function loadConfig(): Promise<SoapConfig> {
  const rawUrl = process.env.CYBOZU_URL;
  const username = process.env.CYBOZU_USERNAME;
  if (!rawUrl) throw new Error("環境変数 CYBOZU_URL が未設定です（例: https://example.jp/cgi-bin/cybozu/ag.cgi）");
  if (!username) throw new Error("環境変数 CYBOZU_USERNAME（サイボウズのログイン名）が未設定です");
  const u = new URL(rawUrl);
  u.search = "";
  u.hash = "";
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol === "http:" && !local && process.env.CYBOZU_ALLOW_HTTP !== "1")
    throw new Error(
      "CYBOZU_URL が http:// です。パスワードが暗号化されずに送られるため、https:// のURLを使ってください（どうしても必要な場合は CYBOZU_ALLOW_HTTP=1）",
    );
  if (!/\/ag\.(cgi|exe)$/.test(u.pathname)) throw new Error(`CYBOZU_URL は ag.cgi で終わるURLにしてください: ${rawUrl}`);

  let password = process.env.CYBOZU_PASSWORD && !process.env.CYBOZU_PASSWORD.startsWith("${") ? process.env.CYBOZU_PASSWORD : undefined;
  if (!password) {
    try {
      const { stdout } = await run("/usr/bin/security", [
        "find-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        username,
        "-w",
      ]);
      password = stdout.replace(/\n$/, "");
    } catch {
      throw new Error(
        `パスワードがキーチェーンに見つかりません。ターミナルで次を実行して登録してください:\n` +
          `security add-generic-password -s ${KEYCHAIN_SERVICE} -a '${username}' -w`,
      );
    }
  }
  // 未入力の拡張機能設定は "${user_config.x}" のまま渡ることがあるので無視する
  const clean = (v?: string) => (v && !v.startsWith("${") ? v : undefined);
  const basicUser = clean(process.env.CYBOZU_BASIC_USER);
  let basicPassword = clean(process.env.CYBOZU_BASIC_PASSWORD);
  if (basicUser && basicPassword === undefined) {
    try {
      const { stdout } = await run("/usr/bin/security", ["find-generic-password", "-s", `${KEYCHAIN_SERVICE}-basic`, "-a", basicUser, "-w"]);
      basicPassword = stdout.replace(/\n$/, "");
    } catch {
      basicPassword = "";
    }
  }
  return { baseUrl: u.toString(), username, password, basicUser, basicPassword, timeoutMs: 30000 };
}
