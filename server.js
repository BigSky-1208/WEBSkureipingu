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
const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log(`サーバーがポート${PORT}で起動しました。`);
});

const expressWs = require('express-ws')(app, server);

// Render.comのようなプロキシ環境でセッションが正しく機能するために追加
app.set('trust proxy', 1);

// --- Auth0 設定 ---
const config = {
  authRequired: false,
  auth0Logout: true,
  secret: process.env.SECRET,
  baseURL: process.env.BASE_URL,
  clientID: process.env.CLIENT_ID,
  issuerBaseURL: process.env.ISSUER_BASE_URL,
  // ★修正点: ライブラリの仕様に合わないため、不正なroutesオブジェクトを削除しました。
  // auth0Logout: true の設定により、ログアウト後は自動的にbaseURLにリダイレクトされ、
  // ログインしていないユーザー向けの「ようこそ」ページが正しく表示されます。
};

// --- ミドルウェア ---
app.use(auth(config));
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '')));

// --- ヘルスチェック用エンドポイント ---
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// --- HTTPルーティング ---
app.get('/', (req, res) => {
  if (req.oidc.isAuthenticated()) {
    res.sendFile(path.join(__dirname, 'index.html'));
  } else {
    res.send('<h1>ようこそ</h1><p>Webスクレイピングシステムへようこそ。利用するにはログインしてください。</p><a href="/login" style="font-size: 1.2em; padding: 10px 20px; background-color: #007bff; color: white; text-decoration: none; border-radius: 5px;">ログイン</a>');
  }
});

// --- WebSocketルーティング ---
const scrapingStates = new Map();

app.ws('/', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

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

// --- WebSocketの生存確認（ハートビート） ---
const wss = expressWs.getWss();
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping(() => {});
  });
}, 30000);

// --- サーバー終了時のクリーンアップ ---
server.on('close', () => {
    clearInterval(interval);
});

// --- スクレイピング実行関数 ---
async function runScraping(ws, startUrl, keyword, state) {
    if (!startUrl || !keyword || !isValidUrl(startUrl)) {
        ws.send(JSON.stringify({ type: 'error', payload: '有効なURLとキーワードを入力してください。' }));
        return;
    }
    
    const ignoredExtensions = [
        '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', 
        '.zip', '.css', '.js', '.xml', '.ico', '.woff', '.woff2', '.ttf'
    ];
    
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
                            try {
                                const nextUrlObj = new URL(link, currentUrl);
                                const pathname = nextUrlObj.pathname.toLowerCase();

                                const shouldIgnore = ignoredExtensions.some(ext => pathname.endsWith(ext));

                                if (['http:', 'https:'].includes(nextUrlObj.protocol) && !shouldIgnore) {
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

