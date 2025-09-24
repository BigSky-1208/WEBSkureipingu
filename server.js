// ローカル開発用に .env ファイルを読み込む
require('dotenv').config();

// 必要なライブラリをインポートします
const express = require('express');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const { auth, requiresAuth } = require('express-openid-connect');

// Expressアプリケーションを作成します
const app = express();
const PORT = process.env.PORT || 3000;

// Auth0の設定
const config = {
  authRequired: false,
  auth0Logout: true,
  secret: process.env.SECRET, // ランダムで長い文字列（環境変数で設定）
  baseURL: process.env.BASE_URL, // アプリのURL（環境変数で設定）
  clientID: process.env.CLIENT_ID, // Auth0のClient ID（環境変数で設定）
  issuerBaseURL: process.env.ISSUER_BASE_URL, // Auth0のドメイン（環境変数で設定）
};

// ミドルウェアを設定
app.use(express.json());
app.use(auth(config)); // Auth0ミドルウェアを適用

// フロントエンドのHTMLを提供
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ログイン状態をフロントエンドに伝えるためのAPI
app.get('/profile', (req, res) => {
  if (req.oidc.isAuthenticated()) {
    res.json({
      isAuthenticated: true,
      user: req.oidc.user,
    });
  } else {
    res.json({
      isAuthenticated: false,
    });
  }
});

// スクレイピングAPIを認証で保護する
app.post('/scrape', requiresAuth(), async (req, res) => {
  const { startUrl, keyword } = req.body;
  if (!startUrl || !keyword) {
    return res.status(400).json({ error: 'URLとキーワードを入力してください。' });
  }

  try {
    // ここに元のスクレイピング処理が入ります
    console.log(`スクレイピング開始: URL=${startUrl}, キーワード=${keyword}`);
    const foundUrls = [];
    const visitedUrls = new Set();
    const queue = [{ url: startUrl, depth: 0 }];
    while (queue.length > 0) {
        const { url: currentUrl, depth } = queue.shift();
        if (visitedUrls.has(currentUrl) || depth > 2) continue;
        visitedUrls.add(currentUrl);
        try {
            const response = await axios.get(currentUrl, { timeout: 5000 });
            const html = response.data;
            const $ = cheerio.load(html);
            const bodyText = $('body').text();
            if (bodyText.toLowerCase().includes(keyword.toLowerCase())) {
                if (!foundUrls.some(item => item.url === currentUrl)) {
                    foundUrls.push({ url: currentUrl, depth });
                }
            }
            if (depth < 2) {
                $('a').each((i, element) => {
                    const link = $(element).attr('href');
                    if (link) {
                        const nextUrl = new URL(link, currentUrl).href;
                        if (!visitedUrls.has(nextUrl) && nextUrl.startsWith('http')) {
                            queue.push({ url: nextUrl, depth: depth + 1 });
                        }
                    }
                });
            }
        } catch (error) {
            console.error(`エラーが発生したURL: ${currentUrl}`, error.message);
        }
    }
    res.json({ foundUrls });
  } catch (error) {
    console.error('スクレイピングプロセスでエラー:', error);
    res.status(500).json({ error: 'サーバーエラーが発生しました。' });
  }
});

app.listen(PORT, () => {
  console.log(`サーバーがポート${PORT}で起動しました。`);
});

