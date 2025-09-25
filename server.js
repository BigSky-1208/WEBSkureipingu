// 必要なライブラリをインポートします
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');
const { auth, requiresAuth } = require('express-openid-connect');
require('dotenv').config();

// --- Expressアプリケーションの基本設定 ---
const app = express();
const expressWs = require('express-ws')(app);
const PORT = process.env.PORT || 3000;

// Render.comのようなプロキシ環境でセッションが正しく機能するために追加
app.set('trust proxy', 1);

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

// --- ヘルスチェック用エンドポイント ---
// Render.comがサーバーの生存確認に使うための、認証不要なルート
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// --- HTTPルーティング ---
app.get('/', (req, res) => {
  if (req.oidc.isAuthenticated()) {
    res.sendFile(path.join(__dirname, 'index.html'));
  } else {
    res.oidc.login({ returnTo: '/' });
  }
});

// --- WebSocketルーティング ---
// ユーザーごとのスクレイピング状態を管理
const scrapingStates = new Map();

app.ws('/', (ws, req) => {
  // ★修正点: ここではreq.oidcが正しく利用可能になります
  if (!req.oidc.isAuthenticated()) {
    ws.close(1008, "Unauthorized");
    return;
  }
  const userId = req.oidc.user.sub;

  ws.on('message', async (message) => {
    const data = JSON.parse(message);

    if (data.type === 'start') {
        const { startUrl, keyword } = data.payload;
        
        if (scrapingStates.has(userId) && scrapingStates.get(userId).isScraping) {
            return;
        }

        const state = { isScraping: true, stop: false };
        scrapingStates.set(userId, state);
        
        await runScraping(ws, startUrl, keyword, state);

        scrapingStates.delete(userId);
    }

    if (data.type === 'stop') {
        if (scrapingStates.has(userId)) {
            scrapingStates.get(userId).stop = true;
        }
    }
  });

  ws.on('close', () => {
    if (scrapingStates.has(userId)) {
        scrapingStates.get(userId).stop = true;
    }
  });
});

// --- サーバーの起動 ---
// ★修正点: app.listenでHTTPとWebSocketの両方を起動
app.listen(PORT, () => {
  console.log(`サーバーがポート${PORT}で起動しました。`);
});


// --- スクレイピング実行関数 (変更なし) ---
async function runScraping(ws, startUrl, keyword, state) {
    if (!startUrl || !keyword || !isValidUrl(startUrl)) {
        ws.send(JSON.stringify({ type: 'error', payload: '有効なURLとキーワードを入力してください。' }));
        return;
    }
    
    const normalizedKeyword = keyword.normalize('NFKC').toLowerCase();
    
    try {
        const visitedUrls = new Set();
        const queue = [{ url: startUrl, depth: 0 }];

        while (queue.length > 0) {
            if (state.stop) {
                ws.send(JSON.stringify({ type: 'done', payload: '検索がユーザーによって停止されました。' }));
                return;
            }

            const { url: currentUrl, depth } = queue.shift();

            if (visitedUrls.has(currentUrl) || depth > 2) {
                continue;
            }

            visitedUrls.add(currentUrl);
            ws.send(JSON.stringify({ type: 'progress', payload: { url: currentUrl } }));

            try {
                const response = await axios.get(currentUrl, { timeout: 5000 });
                const $ = cheerio.load(response.data);

                const normalizedBodyText = $('body').text().normalize('NFKC').toLowerCase();
                
                if (normalizedBodyText.includes(normalizedKeyword)) {
                    ws.send(JSON.stringify({ type: 'result', payload: { url: currentUrl, depth } }));
                }

                if (depth < 2) {
                    $('a').each((i, element) => {
                        const link = $(element).attr('href');
                        if (link) {
                            // URLの解決部分をより安全に
                            try {
                                const nextUrlObj = new URL(link, currentUrl);
                                if (['http:', 'https:'].includes(nextUrlObj.protocol)) {
                                    if (!visitedUrls.has(nextUrlObj.href)) {
                                        queue.push({ url: nextUrlObj.href, depth: depth + 1 });
                                    }
                                }
                            } catch (e) {
                                // 不正なURLは無視
                            }
                        }
                    });
                }
            } catch (error) {
                 ws.send(JSON.stringify({ type: 'log', payload: `スキップ: ${currentUrl} (${error.message})` }));
            }
        }
        ws.send(JSON.stringify({ type: 'done', payload: '検索が完了しました。' }));
    } catch (error) {
        ws.send(JSON.stringify({ type: 'error', payload: 'スクレイピング中にエラーが発生しました。' }));
    }
}

// URL検証用のヘルパー関数
const isValidUrl = (s) => { try { new URL(s); return true; } catch (err) { return false; } };

