// サイボウズ Office 10 連携API（SOAP）クライアント
// 送り先: <baseUrl>?page=PApi<Service>  （例: ag.cgi?page=PApiSchedule）
// 認証: WS-Security UsernameToken（ログイン名 + パスワード）
import { XMLParser } from "fast-xml-parser";

export class CybozuApiError extends Error {
  constructor(
    message: string,
    public code?: string,
    public cause_?: string,
  ) {
    super(message);
  }
}

export interface SoapConfig {
  baseUrl: string; // .../ag.cgi
  username: string; // ログイン名
  password: string;
  /** サイボウズの手前にあるWebサーバーのBasic認証（ブラウザで最初にID/パスワードを聞かれる場合） */
  basicUser?: string;
  basicPassword?: string;
  timeoutMs?: number;
}

export function xmlEscape(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function attrs(obj: Record<string, string | number | boolean | undefined>): string {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}="${xmlEscape(String(v))}"`)
    .join(" ");
}

/** 数値文字参照（&#10; &#xA; など）を文字に戻す。パーサーが展開しないため */
export function decodeNumericRefs(s: string): string {
  if (typeof s !== "string" || !s.includes("&#")) return s;
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

const parser = new XMLParser({
  attributeValueProcessor: (_name: string, val: string) => decodeNumericRefs(val),
  tagValueProcessor: (_name: string, val: string) => decodeNumericRefs(val),
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) =>
    [
      "schedule_event",
      "member",
      "user",
      "organization",
      "facility",
      "user_item",
      "organization_item",
      "facility_item",
      "facility_group_item",
      "facility_group",
      "exclusive_datetime",
      "user_id",
    ].includes(name),
});

export function parseXml(xml: string): any {
  return parser.parse(xml);
}

/** サイボウズが「データベースにアクセスが集中しています」と返したときの判定（一時的なロック） */
export function isBusyError(e: unknown): boolean {
  return e instanceof CybozuApiError && /アクセスが集中/.test(e.message);
}

export class SoapClient {
  /** サイボウズ Office はファイル型DBのため、同時に複数の要求を送るとロックで失敗しやすい。1件ずつ順番に送る */
  private queue: Promise<unknown> = Promise.resolve();
  /** ロック時の再試行の待ち時間（ミリ秒） */
  retryDelaysMs = [1000, 2000, 4000, 8000];

  constructor(private cfg: SoapConfig) {}

  /** SOAP を呼び出し、<returns> の中身（パース済み）を返す。順番待ちとロック時の再試行つき */
  call(service: string, method: string, paramAttrs = "", inner = ""): Promise<any> {
    const run = async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await this.callOnce(service, method, paramAttrs, inner);
        } catch (e) {
          // ロックによる失敗はサーバー側で処理されていないので、書き込みも含めて再試行してよい
          if (!isBusyError(e) || attempt >= this.retryDelaysMs.length) throw e;
          await new Promise((r) => setTimeout(r, this.retryDelaysMs[attempt]));
        }
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  buildEnvelope(method: string, paramAttrs: string, inner: string): string {
    const now = new Date();
    const exp = new Date(now.getTime() + 60 * 60 * 1000);
    const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
    return `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
<soap:Header>
<Action soap:mustUnderstand="1" xmlns="http://schemas.xmlsoap.org/ws/2003/03/addressing">${method}</Action>
<Security xmlns:wsu="http://schemas.xmlsoap.org/ws/2002/07/utility" soap:mustUnderstand="1" xmlns="http://schemas.xmlsoap.org/ws/2002/12/secext">
<UsernameToken wsu:Id="id"><Username>${xmlEscape(this.cfg.username)}</Username><Password>${xmlEscape(this.cfg.password)}</Password></UsernameToken>
</Security>
<Timestamp soap:mustUnderstand="1" xmlns="http://schemas.xmlsoap.org/ws/2002/07/utility"><Created>${iso(now)}</Created><Expires>${iso(exp)}</Expires></Timestamp>
<Locale>jp</Locale>
</soap:Header>
<soap:Body><${method}><parameters xmlns=""${paramAttrs ? " " + paramAttrs : ""}>${inner}</parameters></${method}></soap:Body>
</soap:Envelope>`;
  }

  private async callOnce(service: string, method: string, paramAttrs: string, inner: string): Promise<any> {
    const url = `${this.cfg.baseUrl}?page=PApi${service}`;
    const body = this.buildEnvelope(method, paramAttrs, inner);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs ?? 30000);
    let text: string;
    let status: number;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": `application/soap+xml; charset=utf-8; action="${method}"`,
          ...(this.cfg.basicUser
            ? { Authorization: `Basic ${Buffer.from(`${this.cfg.basicUser}:${this.cfg.basicPassword ?? ""}`).toString("base64")}` }
            : {}),
        },
        body,
        signal: ctrl.signal,
      });
      status = res.status;
      text = await res.text();
    } catch (e: any) {
      throw new CybozuApiError(`サイボウズに接続できません（${e?.name === "AbortError" ? "タイムアウト" : e?.message ?? e}）`);
    } finally {
      clearTimeout(timer);
    }
    if (status === 401) {
      throw new CybozuApiError(
        this.cfg.basicUser
          ? "Webサーバーの認証（Basic認証）に失敗しました。Basic認証のIDとパスワードを確認してください。"
          : "Webサーバーの認証（Basic認証）が必要です。ブラウザでサイボウズを開く前に聞かれるIDとパスワードを、設定の「Basic認証のID／パスワード」に入れてください。",
      );
    }
    if (!text.trimStart().startsWith("<?xml") && !text.includes("Envelope")) {
      throw new CybozuApiError(`予期しない応答です（HTTP ${status}）: ${text.slice(0, 200)}`);
    }
    const doc = parseXml(text);
    const env = doc.Envelope ?? {};
    const b = env.Body ?? {};
    if (b.Fault) {
      const d = b.Fault.Detail ?? {};
      const reason = b.Fault.Reason?.Text;
      const reasonText = typeof reason === "object" ? reason["#text"] : reason;
      throw new CybozuApiError(
        `${d.diagnosis ?? reasonText ?? "サイボウズAPIエラー"}${d.cause ? `（${d.cause}）` : ""}`,
        d.code,
        d.cause,
      );
    }
    const respKey = Object.keys(b).find((k) => k.endsWith("Response"));
    const resp = respKey ? b[respKey] : undefined;
    return resp?.returns ?? {};
  }
}
