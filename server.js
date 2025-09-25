// 必要なライブラリをインポートします
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');
const { auth } = require('express-openid-connect');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const pdfParse = require('pdf-parse'); // ★PDF解析ライブラリを追加
require('dotenv').config();

// --- Expressアプリケーションの基本設定 ---
const app = express();
const PORT = process.env.PORT || 3000;
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

// --- HTTPルーティング ---
app.get('/', (req, res) => {
  if (req.oidc.isAuthenticated()) {
    res.sendFile(path.join(__dirname, 'index.html'));
  } else {
    res.oidc.login({ returnTo: '/' });
  }
});

// --- HTTPサーバーとWebSocketサーバーの起動 ---
const server = createServer(app);
const wss = new WebSocketServer({ server });
const scrapingStates = new Map();

wss.on('connection', (ws, req) => {
  if (!req.oidc || !req.oidc.isAuthenticated()) { // oidcオブジェクトの存在も確認
    ws.close(1008, "Unauthorized");
    return;
  }
  const userId = req.oidc.user.sub;

  ws.on('message', async (message) => {
    const data = JSON.parse(message);
    if (data.type === 'start') {
      if (scrapingStates.has(userId) && scrapingStates.get(userId).isScraping) return;
      const state = { isScraping: true, stop: false };
      scrapingStates.set(userId, state);
      await runScraping(ws, data.payload.startUrl, data.payload.keyword, state);
      scrapingStates.delete(userId);
    }
    if (data.type === 'stop') {
      if (scrapingStates.has(userId)) scrapingStates.get(userId).stop = true;
    }
  });

  ws.on('close', () => {
    if (scrapingStates.has(userId)) scrapingStates.get(userId).stop = true;
  });
});

server.listen(PORT, () => console.log(`サーバーがポート${PORT}で起動しました。`));

// --- スクレイピング実行関数 ---
async function runScraping(ws, startUrl, keyword, state) {
    if (!startUrl || !keyword || !isValidUrl(startUrl)) {
        return ws.send(JSON.stringify({ type: 'error', payload: '有効なURLとキーワードを入力してください。' }));
    }
    
    const normalizedKeyword = keyword.normalize('NFKC').toLowerCase();
    const visitedUrls = new Set();
    const queue = [{ url: startUrl, depth: 0 }];
    const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico'];

    while (queue.length > 0) {
        if (state.stop) {
            return ws.send(JSON.stringify({ type: 'done', payload: '検索がユーザーによって停止されました。' }));
        }

        const { url: currentUrl, depth } = queue.shift();
        if (visitedUrls.has(currentUrl) || depth > 2) continue;

        visitedUrls.add(currentUrl);
        ws.send(JSON.stringify({ type: 'progress', payload: { url: currentUrl } }));

        try {
            // ★修正点: HEADリクエストでコンテンツタイプを先に確認
            const headResponse = await axios.head(currentUrl, { timeout: 4000 });
            const contentType = headResponse.headers['content-type'];

            // ★PDFの処理
            if (contentType && contentType.includes('application/pdf')) {
                ws.send(JSON.stringify({ type: 'log', payload: `PDFを解析中: ${currentUrl}` }));
                const pdfResponse = await axios.get(currentUrl, { responseType: 'arraybuffer', timeout: 10000 });
                const data = await pdfParse(pdfResponse.data);
                const normalizedPdfText = data.text.normalize('NFKC').toLowerCase();
                if (normalizedPdfText.includes(normalizedKeyword)) {
                    ws.send(JSON.stringify({ type: 'result', payload: { url: currentUrl, depth } }));
                }
            } 
            // ★HTMLの処理
            else if (contentType && contentType.includes('text/html')) {
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
                                // ★画像リンクを除外
                                if (['http:', 'https:'].includes(nextUrlObj.protocol) && !imageExtensions.some(ext => pathname.endsWith(ext))) {
                                    if (!visitedUrls.has(nextUrlObj.href)) {
                                        queue.push({ url: nextUrlObj.href, depth: depth + 1 });
                                    }
                                }
                            } catch (e) { /* 不正なURLは無視 */ }
                        }
                    });
                }
            }
            // ★その他のコンテンツタイプはスキップ
            else {
                ws.send(JSON.stringify({ type: 'log', payload: `スキップ (非対応コンテンツ): ${currentUrl}` }));
            }
        } catch (error) {
             ws.send(JSON.stringify({ type: 'log', payload: `スキップ: ${currentUrl} (${error.message})` }));
        }
    }
    ws.send(JSON.stringify({ type: 'done', payload: '検索が完了しました。' }));
}

const isValidUrl = (s) => { try { new URL(s); return true; } catch (err) { return false; } };

