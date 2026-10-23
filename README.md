# LIFF x LINE 連携 ホットモック セットアップ手順

構成: **GitHub Pages(LIFF画面 + 管理画面)** → **GAS Webアプリ(API)** ⇔ スプレッドシート / LINE API

```
docs/index.html   LIFF画面 (企業名表示 / ログイン / 所属一覧 / 企業切替 / 友だち追加誘導)
docs/admin.html   簡易管理画面 (企業管理 / 連携URL発行 / 企業別配信 / メニュー作成)
docs/config.js    LIFF_ID, GAS_URL など
gas/Code.gs       API本体
```

## 1. LINE Developers の準備
1. 同一**プロバイダー**を作成 (LINEログインとMessaging APIは必ず同じプロバイダー。違うとuserIdが一致しない)
2. **Messaging APIチャネル**を作成 → 「チャネルアクセストークン(長期)」を発行して控える
   - 応答設定: あいさつ/応答メッセージはOFF、Webhookは後述のGAS URLを設定しON
   - 友だち追加URL(`https://line.me/R/ti/p/@xxxx`)を控える
3. **LINEログインチャネル**を作成 (公開ステータスは開発中でOK。自分のアカウントは管理者/テスターとして使える)
   - 「LINEログイン設定」→ **リンクされたLINE公式アカウント**で上記Messaging APIのアカウントを選択
   - LIFFタブでアプリ追加: エンドポイントURLは手順3後の GitHub Pages URL (`https://<user>.github.io/<repo>/`)、
     Scope: `openid` `profile`、**友だち追加オプション: On (Aggressive)** 、サイズ: Full
   - LIFF ID と チャネルID(Basic settings) を控える

## 2. GAS
1. 新規スプレッドシートを作成 → 拡張機能 → Apps Script → `gas/Code.gs` を貼り付け
2. `setup` 関数を実行 (シート作成+サンプル企業 `acme` / `globex`)
3. プロジェクトの設定 → スクリプトプロパティ:

| キー | 値 |
|---|---|
| LOGIN_CHANNEL_ID | LINEログインのチャネルID |
| MESSAGING_TOKEN | Messaging APIの長期アクセストークン |
| ADMIN_KEY | 管理画面用の任意の合言葉 |
| LIFF_ID | LIFF ID |
| PAGES_BASE_URL | `https://<user>.github.io/<repo>` (末尾スラッシュなし) |

4. デプロイ → ウェブアプリ: 実行ユーザー=自分、アクセス=**全員**。表示されるURL (`.../exec`) を控える
   - コード変更時は「デプロイを管理 → 新バージョン」で更新
5. Messaging APIのWebhook URLに上記 `/exec` URLを設定し、Webhookの利用をON
   (「検証」ボタンは302で失敗しがちだが、友だち追加/ブロックのイベントは届く)

## 3. GitHub Pages
1. `docs/config.js` に LIFF_ID / GAS_URL / ADD_FRIEND_URL を記入
2. このフォルダをGitHubにpush → Settings → Pages → Source: `main` / `/docs`
3. LIFFのエンドポイントURLを Pages のURLに設定

## 4. 動作確認シナリオ
1. `https://<pages>/admin.html` を開き、管理キーを入力 → 読み込み
2. 各企業の「メニュー作成」を押す (色違いのリッチメニューが作られる)
3. 企業URL `https://liff.line.me/<LIFF_ID>?company=acme` をスマホのLINEで開く
   → 「ACME株式会社 向け」表示 → ログイン → 友だち追加 → 登録完了、トークに赤いメニュー
4. 同様に `?company=globex` を開く → 所属が2社に。LIFF画面の「この企業に切替」でメニューの色が切り替わる
5. 管理画面「企業別メッセージ配信」で acme に送る → acme所属者だけに届く
6. 管理画面「利用登録の代役」で連携URLを発行 → LINEで開く → サービスユーザーIDと紐付く
   (管理画面の所属ユーザー表のサービスUID列で確認)

## 5. 紐付け設計メモ (本番への持ち越し)
- 既存の利用登録でサービスユーザーIDが発行された後、**ワンタイム連携URL**(`?link=TOKEN`)をLIFFで開かせ、
  LINEのIDトークン検証で得たuserIdとサービスユーザーIDを紐付ける。
  登録完了画面に「LINEと連携する」ボタン/QRとして表示するのが自然な導線。
- 紐付けは**企業所属(membership)単位**で保持 (複数企業所属 = 企業ごとにサービスユーザーIDが異なりうるため)。
- 本番(AWS)での追加課題: Webhook署名検証、トークンの期限/レート制限、企業コードの推測耐性、
  リッチメニューが1ユーザー1つ制約のため複数企業所属時の切替UX、個人情報の保管場所(LINE側には持たない)。
