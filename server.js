// 必要なライブラリをインポートします
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');
const { auth, requiresAuth } = require('express-openid-connect');
require('dotenv').config();

// Expressアプリケーションを作成します
const app = express();
const PORT = process.env.PORT || 3000;

// --- Auth0 設定 ---
const config = {
  authRequired: false,
  auth0Logout: true,
  secret: process.env.SECRET,
  baseURL: process.env.BASE_URL,
  clientID: process.env.CLIENT_ID,
  issuerBaseURL: process.env.ISSUER_BASE_URL
};

// --- ミドルウェア ---
app.use(auth(config));
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '')));

// --- ルーティング ---

// ルートURL: ログイン状態に応じてリダイレクト
app.get('/', (req, res) => {
  if (req.oidc.isAuthenticated()) {
    res.sendFile(path.join(__dirname, 'index.html'));
  } else {
    res.send('ログインしてください <a href="/login">ログイン</a>');
  }
});

// ログイン後のプロフィール情報（デバッグ用）
app.get('/profile', requiresAuth(), (req, res) => {
  res.send(JSON.stringify(req.oidc.user));
});


/**
 * URLが有効な形式かどうかを基本的な正規表現でチェックします。
 * @param {string} s - チェックするURL文字列。
 * @returns {boolean} - URLが有効な形式であればtrue。
 */
const isValidUrl = (s) => {
    try {
        new URL(s);
        return true;
    } catch (err) {
        return false;
    }
};

/**
 * URLを絶対パスに変換します。
 * @param {string} link - 変換するリンク。
 * @param {string} baseUrl - 基準となるURL。
 * @returns {URL|null} - 変換後のURLオブジェクト、または無効な場合はnull。
 */
const resolveUrl = (link, baseUrl) => {
    try {
        return new URL(link, baseUrl);
    } catch (error) {
        return null;
    }
};


// スクレイピングを実行するAPIエンドポイント
app.post('/scrape', requiresAuth(), async (req, res) => {
    const { startUrl, keyword } = req.body;

    if (!startUrl || !keyword || !isValidUrl(startUrl)) {
        return res.status(400).json({ error: '有効なURLとキーワードを入力してください。' });
    }
    
    // ★修正点1: キーワードを半角・小文字に正規化
    const normalizedKeyword = keyword.normalize('NFKC').toLowerCase();

    try {
        console.log(`スクレイピング開始: URL=${startUrl}, 正規化キーワード=${normalizedKeyword}`);
        
        const foundUrls = [];
        const visitedUrls = new Set();
        const queue = [{ url: startUrl, depth: 0 }];

        while (queue.length > 0) {
            const { url: currentUrl, depth } = queue.shift();

            if (visitedUrls.has(currentUrl) || depth > 2) {
                continue;
            }

            visitedUrls.add(currentUrl);
            console.log(`${depth}階層目を検索中: ${currentUrl}`);

            try {
                const response = await axios.get(currentUrl, { timeout: 5000 });
                const html = response.data;
                const $ = cheerio.load(html);

                // ★修正点2: ページの本文も半角・小文字に正規化
                const bodyText = $('body').text();
                const normalizedBodyText = bodyText.normalize('NFKC').toLowerCase();
                
                // ★修正点3: 正規化されたテキスト同士で比較
                if (normalizedBodyText.includes(normalizedKeyword)) {
                    if (!foundUrls.some(item => item.url === currentUrl)) {
                        foundUrls.push({ url: currentUrl, depth });
                    }
                }

                if (depth < 2) {
                    $('a').each((i, element) => {
                        const link = $(element).attr('href');
                        if (link) {
                            const nextUrlObj = resolveUrl(link, currentUrl);
                            if (nextUrlObj && (nextUrlObj.protocol === 'http:' || nextUrlObj.protocol === 'https:')) {
                                const nextUrl = nextUrlObj.href;
                                if (!visitedUrls.has(nextUrl)) {
                                    queue.push({ url: nextUrl, depth: depth + 1 });
                                }
                            }
                        }
                    });
                }
            } catch (error) {
                console.error(`エラーが発生したURL: ${currentUrl}`, error.message);
            }
        }

        console.log(`検索完了。 ${foundUrls.length}件のページが見つかりました。`);
        res.json({ foundUrls });

    } catch (error) {
        console.error('スクレイピングプロセス全体でエラーが発生しました:', error);
        res.status(500).json({ error: 'スクレイピング中にサーバーエラーが発生しました。' });
    }
});

// サーバーを起動
app.listen(PORT, () => {
    console.log(`サーバーがポート${PORT}で起動しました。`);
});

