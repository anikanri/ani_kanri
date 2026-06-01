const express = require('express');
const { OAuth2Client } = require('google-auth-library');
const sqlite3 = require('sqlite3').verbose();

const app = express();
app.use(express.json());

// 🌐 CORSエラー回避の設定
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

// 💾 データベースの初期設定
const db = new sqlite3.Database('./database.db', (err) => {
    if (err) console.error('DB接続エラー:', err.message);
    else console.log('💾 SQLite データベースに接続しました。');
});

// 🗂️ テーブル（表）を作成・管理する
db.serialize(() => {
    // 1. ユーザー情報テーブル
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            google_id TEXT PRIMARY KEY,
            name TEXT,
            avatar TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // 2. アニメ視聴記録テーブル
    db.run(`
        CREATE TABLE IF NOT EXISTS anime_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            google_id TEXT,
            anime_title TEXT,
            episode TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // 3. ⭐ 【新設】アニメ作品評価・感想テーブル
    // ユーザーごとに1つのアニメに対して1つの評価レコードを持つよう設計しています
    db.run(`
        CREATE TABLE IF NOT EXISTS anime_ratings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            google_id TEXT,
            anime_id TEXT,
            anime_title TEXT,
            anime_image TEXT,
            season_name TEXT,
            character INTEGER DEFAULT 0,
            art INTEGER DEFAULT 0,
            tempo INTEGER DEFAULT 0,
            story INTEGER DEFAULT 0,
            comment TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(google_id, anime_id)
        )
    `);
});

const CLIENT_ID = '24659980882-a2lftgmt6vn4lriibv65b3bb3be88r8d.apps.googleusercontent.com';
const client = new OAuth2Client(CLIENT_ID);

// 🛠️ 1. Googleログイン用の窓口
app.post('/api/auth/google', async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'トークンがありません' });

    try {
        const ticket = await client.verifyIdToken({ idToken: token, audience: CLIENT_ID });
        const payload = ticket.getPayload();
        const googleUserId = payload['sub'];
        const name = payload['name'];
        const picture = payload['picture'];

        db.get(`SELECT * FROM users WHERE google_id = ?`, [googleUserId], (err, row) => {
            if (err) return res.status(500).json({ error: 'DBエラー' });

            if (row) {
                console.log(`[サーバー] 既存ユーザーログイン: ${row.name}`);
                res.json({ status: 'success', googleId: googleUserId, username: row.name, avatar: row.avatar });
            } else {
                db.run(`INSERT INTO users (google_id, name, avatar) VALUES (?, ?, ?)`, [googleUserId, name, picture], function(err) {
                    if (err) return res.status(500).json({ error: '登録エラー' });
                    console.log(`[サーバー] 新規ユーザー登録: ${name}`);
                    res.json({ status: 'success', googleId: googleUserId, username: name, avatar: picture });
                });
            }
        });
    } catch (error) {
        res.status(401).json({ error: '無効なトークン' });
    }
});

// 🛠️ 2. アニメの視聴記録を保存する窓口
app.post('/api/records', (req, res) => {
    const { googleId, animeTitle, episode } = req.body;

    if (!googleId || !animeTitle || !episode) {
        return res.status(400).json({ error: '必要なデータが足りません' });
    }

    const query = `INSERT INTO anime_records (google_id, anime_title, episode) VALUES (?, ?, ?)`;
    db.run(query, [googleId, animeTitle, episode], function(err) {
        if (err) {
            console.error(err.message);
            return res.status(500).json({ error: '保存に失敗しました' });
        }
        console.log(`[サーバー] 視聴記録を保存しました: ${animeTitle} ${episode}`);
        res.json({ status: 'success', message: '記録を保存しました！' });
    });
});

// 🛠️ 3. そのユーザーの過去の視聴記録をすべて取得する窓口
app.get('/api/records/:googleId', (req, res) => {
    const { googleId } = req.params;

    const query = `SELECT * FROM anime_records WHERE google_id = ? ORDER BY created_at DESC`;
    db.all(query, [googleId], (err, rows) => {
        if (err) {
            console.error(err.message);
            return res.status(500).json({ error: '取得に失敗しました' });
        }
        res.json({ status: 'success', records: rows });
    });
});


// =================================================================
// ⭐ 【新設窓口】作品評価・感想の同期システム
// =================================================================

// 🛠️ 4. 作品への評価・感想を「保存（追加または上書き）」する窓口
app.post('/api/ratings', (req, res) => {
    const { 
        googleId, animeId, animeTitle, animeImage, seasonName,
        character, art, tempo, story, comment 
    } = req.body;

    if (!googleId || !animeId) {
        return res.status(400).json({ error: 'ユーザーIDまたはアニメIDが不足しています' });
    }

    // 💡 すでに評価が存在すれば新しいデータで上書き（REPLACE）、なければ新規挿入
    const query = `
        INSERT OR REPLACE INTO anime_ratings 
        (google_id, anime_id, anime_title, anime_image, season_name, character, art, tempo, story, comment, updated_at) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `;

    const params = [googleId, String(animeId), animeTitle, animeImage, seasonName, character, art, tempo, story, comment];

    db.run(query, params, function(err) {
        if (err) {
            console.error('評価のDB保存失敗:', err.message);
            return res.status(500).json({ error: 'サーバー側での評価保存に失敗しました' });
        }
        console.log(`[サーバー] 評価を更新しました: ${animeTitle} (User: ${googleId})`);
        res.json({ status: 'success', message: '評価を同期・保存しました！' });
    });
});

// 🛠️ 5. そのユーザーが付けたすべての「評価・感想リスト」を取得する窓口
app.get('/api/ratings/:googleId', (req, res) => {
    const { googleId } = req.params;

    const query = `SELECT * FROM anime_ratings WHERE google_id = ? ORDER BY updated_at DESC`;
    db.all(query, [googleId], (err, rows) => {
        if (err) {
            console.error('評価データの取得失敗:', err.message);
            return res.status(500).json({ error: '評価データの取得に失敗しました' });
        }
        res.json({ status: 'success', ratings: rows });
    });
});


// サーバー起動
app.listen(3000, () => {
    console.log('====================================');
    console.log('🚀 フル機能データベースサーバー起動！');
    console.log('👉 http://localhost:3000');
    console.log('====================================');
});