const express = require('express');
const { OAuth2Client } = require('google-auth-library');
const sqlite3 = require('sqlite3').verbose();

const app = express();
app.use(express.json());

// 🌟【URL・ポートの設定】
// サーバーが動くポート番号を指定します。環境変数（Renderなど）がなければ自動的に「3000」になります。
const PORT = process.env.PORT || 3000;

// 🌟【CORSエラー回避とURL許可の設定】
// ローカル環境（localhost）と、あなたの本番環境（Renderなど）の両方からのアクセスを安全に許可します。
const ALLOWED_ORIGINS = [
    'http://localhost:3000',
    'http://localhost:5500',   // VSCodeのLive Server用
    'http://127.0.0.1:5500',   // VSCodeのLive Server用（IPアドレス版）
    'https://ani-kanri.onrender.com' // 本番環境のフロントURL（必要に応じて変更してください）
];

app.use((req, res, next) => {
    const origin = req.headers.origin;
    
    // 接続してきたフロントのURLが許可リストにあれば、そのURLに対して通信を許可する
    if (ALLOWED_ORIGINS.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
        // リストにない場合でも、ローカルテスト中に不具合が出ないよう開発時はすべて許可（*）のバックアップを設定
        res.setHeader('Access-Control-Allow-Origin', '*');
    }

    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
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

    // 2. アニメ視聴記録テーブル（🌟フロントの要求に合わせ、データ欠落を防ぐカラムを完全配備）
    db.run(`
        CREATE TABLE IF NOT EXISTS anime_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            google_id TEXT,
            anime_id TEXT,
            anime_title TEXT,
            anime_image TEXT,
            season_name TEXT,
            episode TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(google_id, anime_id)
        )
    `);

    // 3. アニメ作品評価・感想テーブル
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

// 🛠️ 2. アニメの視聴記録を保存する窓口（🌟フロントデータをすべて受け止める構造に修正）
app.post('/api/records', (req, res) => {
    const { googleId, animeId, animeTitle, animeImage, seasonName, episode } = req.body;

    if (!googleId || !animeId || !animeTitle || !episode) {
        return res.status(400).json({ error: '必要なデータが足りません' });
    }

    const query = `
        INSERT OR REPLACE INTO anime_records 
        (google_id, anime_id, anime_title, anime_image, season_name, episode, created_at) 
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `;
    
    const params = [googleId, String(animeId), animeTitle, animeImage || '', seasonName || '', episode];

    db.run(query, params, function(err) {
        if (err) {
            console.error('視聴記録のDB保存失敗:', err.message);
            return res.status(500).json({ error: '保存に失敗しました' });
        }
        console.log(`[サーバー] 視聴記録を保存しました: ${animeTitle} -> ${episode}`);
        res.json({ status: 'success', message: '記録を保存しました！' });
    });
});

// 🛠️ 3. そのユーザーの過去の視聴記録をすべて取得する窓口（🌟フロントがパースできるようにフォーマット）
app.get('/api/records/:googleId', (req, res) => {
    const { googleId } = req.params;

    const query = `SELECT * FROM anime_records WHERE google_id = ? ORDER BY created_at DESC`;
    db.all(query, [googleId], (err, rows) => {
        if (err) {
            console.error(err.message);
            return res.status(500).json({ error: '取得に失敗しました' });
        }

        const formattedRecords = rows.map(row => ({
            id: row.id,
            googleId: row.google_id,
            animeId: row.anime_id,
            animeTitle: row.anime_title,
            animeImage: row.anime_image,
            seasonName: row.season_name,
            episode: row.episode,
            createdAt: row.created_at
        }));

        res.json({ status: 'success', records: formattedRecords });
    });
});

// 🛠️ 4. 作品への評価・感想を保存する窓口
app.post('/api/ratings', (req, res) => {
    const { 
        googleId, animeId, animeTitle, animeImage, seasonName,
        character, art, tempo, story, comment 
    } = req.body;

    if (!googleId || !animeId) {
        return res.status(400).json({ error: 'ユーザーIDまたはアニメIDが不足しています' });
    }

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

        const formattedRatings = rows.map(row => ({
            id: row.id,
            googleId: row.google_id,
            animeId: row.anime_id,
            animeTitle: row.anime_title,
            animeImage: row.anime_image,
            seasonName: row.season_name,
            character: row.character,
            art: row.art,
            tempo: row.tempo,
            story: row.story,
            comment: row.comment,
            updated_at: row.updated_at
        }));

        res.json({ status: 'success', ratings: formattedRatings });
    });
});

// 🛠️ 6. 全ユーザーの評価を集計して総合ランキングを作る窓口
app.get('/api/rankings', (req, res) => {
    const query = `
        SELECT 
            anime_id as id,
            anime_title as title,
            anime_image as image,
            season_name,
            COUNT(google_id) as review_count,
            AVG((character + art + tempo + story) / 4.0) as average_score
        FROM anime_ratings
        GROUP BY anime_id
        ORDER BY average_score DESC
        LIMIT 10
    `;

    db.all(query, [], (err, rows) => {
        if (err) {
            console.error('ランキング集計失敗:', err.message);
            return res.status(500).json({ error: 'ランキングの集計に失敗しました' });
        }
        res.json({ status: 'success', records: rows, rankings: rows });
    });
});

// 🛠️ 7. マイページから作品を完全に消去する窓口
app.delete('/api/records/:googleId/:animeId', (req, res) => {
    const { googleId, animeId } = req.params;

    db.run(`DELETE FROM anime_records WHERE google_id = ? AND anime_id = ?`, [googleId, animeId], function(err) {
        if (err) return res.status(500).json({ error: '視聴記録の削除に失敗しました' });

        db.run(`DELETE FROM anime_ratings WHERE google_id = ? AND anime_id = ?`, [googleId, animeId], function(err) {
            if (err) return res.status(500).json({ error: '評価データの削除に失敗しました' });
            
            console.log(`[DB削除完了] User: ${googleId} / AnimeID: ${animeId} の全データを消去しました`);
            res.json({ status: 'success', message: 'データを完全に削除しました' });
        });
    });
});

// 🌟【サーバー起動処理の最適化】
app.listen(PORT, () => {
    console.log('====================================');
    console.log('🚀 フル機能データベースサーバー起動！');
    console.log(`👉 稼働ポート番号: ${PORT}`);
    console.log('👉 ローカル接続先: http://localhost:3000');
    console.log('====================================');
});