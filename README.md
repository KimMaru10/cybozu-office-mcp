# cybozu-office-mcp

**サイボウズ Office 10（パッケージ版）** の連携API（SOAP）で予定を読み書きする、**非公式**の MCP サーバーです。

> [!IMPORTANT]
> - 非公式ツールです。サイボウズ株式会社とは無関係で、連携APIは同社のサポート対象外です（2018年に資料配布終了）。業務で使う場合は管理者に確認してください。
> - **クラウド版（cybozu.com）では使えません。**

## ツール

| ツール | 内容 |
|---|---|
| `cybozu_get_my_schedule` / `cybozu_get_schedule` | 自分／他メンバー・組織・設備の予定 |
| `cybozu_find_free_time` / `cybozu_find_free_rooms` | 複数人の空き時間／空き会議室 |
| `cybozu_search_users` / `cybozu_list_organizations` / `cybozu_list_facilities` / `cybozu_list_plan_menu` | マスタ参照 |
| `cybozu_create_event` / `cybozu_update_event` / `cybozu_delete_event` | 登録・変更・削除（参加者・会議室・メモ・非公開・繰り返し・終日・期間予定） |

- 書き込みはプレビュー → `confirm=true` の2段階。プレビューで参加者・会議室の重なりを表示し、版（version）が変わっていれば実行しません。
- 予定の本文にプロンプトインジェクションが紛れる可能性があるため、書き込みツールは「常に許可」にしないことを推奨します。
- サーバー負荷対策: 要求は直列化、DBロック時は 1/2/4/8 秒で最大4回再試行、マスタは1時間・予定は60秒キャッシュ。
- `http://` は既定で拒否（`CYBOZU_ALLOW_HTTP=1` で許可）。

## インストール

**Claude デスクトップ**: [Releases](https://github.com/KimMaru10/cybozu-office-mcp/releases) の `cybozu-office.mcpb` を開き、URL・ログイン名・パスワード（必要なら Basic 認証）を入力。

**ソースから**（Node.js 18+）:

```bash
git clone https://github.com/KimMaru10/cybozu-office-mcp.git && cd cybozu-office-mcp
npm ci && npm run build
security add-generic-password -s cybozu-mcp -a '<login>' -w   # macOS: パスワードをキーチェーンへ
CYBOZU_URL='https://example.co.jp/cgi-bin/cbag/ag.cgi' CYBOZU_USERNAME='<login>' node dist/check.js   # 接続確認

claude mcp add cybozu-office \
  -e CYBOZU_URL='https://example.co.jp/cgi-bin/cbag/ag.cgi' \
  -e CYBOZU_USERNAME='<login>' \
  -- node /path/to/cybozu-office-mcp/dist/index.js
```

| 環境変数 | 必須 | 内容 |
|---|---|---|
| `CYBOZU_URL` | ○ | `ag.cgi` までのURL |
| `CYBOZU_USERNAME` | ○ | ログイン名 |
| `CYBOZU_PASSWORD` | △ | 未設定なら macOS キーチェーン（サービス `cybozu-mcp`、アカウント＝ログイン名）。Windows では必須 |
| `CYBOZU_BASIC_USER` | | Basic 認証のID |
| `CYBOZU_BASIC_PASSWORD` | | 未設定なら macOS キーチェーン（サービス `cybozu-mcp-basic`、アカウント＝Basic認証のID） |
| `CYBOZU_ALLOW_HTTP` | | `1` で `http://` を許可 |

## 制限事項

- 時刻は5分単位、日本時間（UTC+9）固定（タイムゾーン設定が日本以外のユーザーは時刻がずれる可能性あり）。
- 繰り返し: 「この回だけ」の変更は同日内の時刻変更のみ／第5週指定不可（「最終週」を使用）／日またぎ不可／「毎日（土日除く）」の祝日の扱いは未確認。
- 参加者への組織の指定は非対応（既存の組織参加者は変更時も維持）。
- フォロー付き予定の変更でフォローが残るかは未確認。ファシリテーター・出欠確認・コメントは非対応。通知メールはサイボウズ側の設定次第。
- `cybozu_find_free_rooms` は会議室ごとに1要求。多い場合は `query` で絞ってください。
- パッケージ版 Office のサポートは2027年に終了します。

## 動作確認

| 項目 | 実サーバー（Office 10.8.4） | 模擬サーバー |
|---|---|---|
| 予定・ユーザー・組織・設備・予定メニューの取得 | ✔ | ✔ |
| 通常・終日・期間予定の登録／変更／削除 | ✔ | ✔ |
| 繰り返し予定の登録、「この回だけ」「この回以降」「すべて」の変更・削除 | ✔ | ✔ |
| 会議室つきの登録、会議室の重複予約が弾かれること | ✔ | ✔ |
| 他のメンバーと会議室を入れた登録 | ✔ | ✔ |
| ログイン名＋パスワードでの認証 | `check.js` で確認してください | ✔ |

実サーバーはブラウザのログイン状態でAPIを呼んで確認（書き込みは自分だけの非公開テスト予定と、同僚の了承を得た実際の打ち合わせ1件）。

## 開発

```bash
npm ci
npm run typecheck
npm test        # ビルド＋模擬サーバー（test/）での結合テスト
npm run pack    # cybozu-office.mcpb を生成
```

リリース: `package.json` と `bundle/manifest.json` の `version` を上げ、`npm test && npm run pack` して Releases に `.mcpb` を添付。

## 謝辞・商標・ライセンス

- API の呼び出し方は [hatashinya/cybozu-connect](https://github.com/hatashinya/cybozu-connect) を参考にしました（コードは含みません）。
- 「サイボウズ」「サイボウズ Office」はサイボウズ株式会社の登録商標です。
- [MIT](./LICENSE)。同梱依存のライセンスは [THIRD_PARTY_LICENSES.txt](./THIRD_PARTY_LICENSES.txt)。
