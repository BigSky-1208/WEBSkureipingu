// 必要なライブラリをインポートします
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');
const url = require('url');

// Expressアプリケーションを作成します
const app = express();
const PORT = 3000;

// CORSミドルウェアとJSONパーサーを使用します
app.use(cors());
app.use(express.json());

// フロントエンドのHTMLファイルを提供するための設定
app.use(express.static(path.join(__dirname, '')));

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
app.post('/scrape', async (req, res) => {
    const { startUrl, keyword } = req.body;

    if (!startUrl || !keyword || !isValidUrl(startUrl)) {
        return res.status(400).json({ error: '有効なURLとキーワードを入力してください。' });
    }

    try {
        console.log(`スクレイピング開始: URL=${startUrl}, キーワード=${keyword}`);
        
        const foundUrls = [];
        const visitedUrls = new Set(); // 訪問済みURLを記録するSet
        const queue = [{ url: startUrl, depth: 0 }]; // 探索キュー

        while (queue.length > 0) {
            const { url: currentUrl, depth } = queue.shift();

            // 既に訪問済み、または深さ制限を超えた場合はスキップ
            if (visitedUrls.has(currentUrl) || depth > 2) {
                continue;
            }

            visitedUrls.add(currentUrl);
            console.log(`${depth}階層目を検索中: ${currentUrl}`);

            try {
                // ページのHTMLを取得
                const response = await axios.get(currentUrl, { timeout: 5000 });
                const html = response.data;
                const $ = cheerio.load(html);

                // ページ本文にキーワードが含まれているかチェック
                const bodyText = $('body').text();
                if (bodyText.toLowerCase().includes(keyword.toLowerCase())) {
                    // ユニークな結果のみを追加
                    if (!foundUrls.some(item => item.url === currentUrl)) {
                        foundUrls.push({ url: currentUrl, depth });
                    }
                }

                // 次の階層のリンクを収集 (depth < 2 の場合のみ)
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
                // 特定のページの取得エラーは無視して続行
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
    console.log(`サーバーがポート${PORT}で起動しました。 http://localhost:${PORT}`);
});
