const express = require('express');
const path = require('path');
const crypto = require('crypto'); // Заменили bcrypt на встроенный легкий crypto
const sqlite3 = require('sqlite3').verbose();
const session = require('express-session');
const multer = require('multer');
const fs = require('fs');

const app = express();
const PORT = 3000;

// Сразу выводим лог, чтобы видеть, что процесс пошел
console.log('Инициализация сервера...');

const uploadDir = './uploads';
if (!fs.existsSync(uploadDir)){ fs.mkdirSync(uploadDir); }

const storage = multer.diskStorage({
    destination: (req, file, cb) => { cb(null, 'uploads/'); },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `avatar-${req.session.userId}-${Date.now()}${ext}`);
    }
});
const upload = multer({ storage: storage });

console.log('Подключение к базе данных...');
const db = new sqlite3.Database('./database.db', (err) => {
    if (err) console.error('Ошибка БД:', err.message);
    else console.log('База данных успешно подключена.');
});

// Инициализация таблиц
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        avatar_path TEXT,
        bio TEXT,
        reg_date TEXT,
        visits INTEGER DEFAULT 0,
        role TEXT DEFAULT 'Пользователь',
        notes TEXT DEFAULT '',
        game_score INTEGER DEFAULT 0,
        streak INTEGER DEFAULT 0,
        last_streak_date TEXT DEFAULT ''
    )`);
    db.run(`ALTER TABLE users ADD COLUMN reg_date TEXT`, () => {});
    db.run(`ALTER TABLE users ADD COLUMN visits INTEGER DEFAULT 0`, () => {});
    db.run(`ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'Пользователь'`, () => {});
    db.run(`ALTER TABLE users ADD COLUMN notes TEXT DEFAULT ''`, () => {});
    db.run(`ALTER TABLE users ADD COLUMN game_score INTEGER DEFAULT 0`, () => {});
    db.run(`ALTER TABLE users ADD COLUMN streak INTEGER DEFAULT 0`, () => {});
    db.run(`ALTER TABLE users ADD COLUMN last_streak_date TEXT DEFAULT ''`, () => {});
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
    secret: 'super-secret-key',
    resave: false,
    saveUninitialized: true
}));

// Функции хэширования без bcrypt
function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

app.get('/', (req, res) => {
    if (req.session.userId) return res.redirect('/dashboard');
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Личный кабинет
app.get('/dashboard', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    
    db.get(`SELECT username, bio, reg_date, visits, role, notes, game_score, streak FROM users WHERE id = ?`, [req.session.userId], (err, user) => {
        if (err || !user) return res.redirect('/');

        fs.readFile(path.join(__dirname, 'dashboard.html'), 'utf8', (err, data) => {
            if (err) return res.status(500).send('Ошибка загрузки страницы');
            
            const userAgent = req.headers['user-agent'] || 'Неизвестный браузер';
            let browser = 'Другой';
            if (userAgent.includes('Chrome')) browser = 'Google Chrome';
            else if (userAgent.includes('Firefox')) browser = 'Mozilla Firefox';
            else if (userAgent.includes('Safari')) browser = 'Apple Safari';

            let html = data;
            html = html.replace("CURRENT_USERNAME", user.username);
            html = html.replace('CURRENT_BIO', user.bio || '');
            html = html.replace('<!-- REG_DATE -->', user.reg_date || 'Не указана');
            html = html.replace('<!-- VISITS -->', user.visits);
            html = html.replace('<!-- ROLE -->', user.role);
            html = html.replace('<!-- BROWSER -->', browser);
            html = html.replace('<!-- NOTES_TEXT -->', user.notes || '');
            html = html.replace('<!-- GAME_SCORE -->', user.game_score || 0);
            html = html.replace('<!-- STREAK -->', user.streak || 0);
                
            res.send(html);
        });
    });
});

// Игровые эндпоинты
app.post('/login', (req, res) => {
    // Принимаем данные из формы (неважно, названо поле email или username)
    const loginInput = req.body.email || req.body.username;
    const password = req.body.password;

    if (!loginInput) {
        return res.status(400).send('Введите email/логин и пароль. <a href="/">Назад</a>');
    }

    // Ищем пользователя И по email, И по username одновременно!
    db.get(`SELECT * FROM users WHERE email = ? OR username = ?`, [loginInput, loginInput], (err, user) => {
        if (err) return res.status(500).send('Ошибка базы данных.');
        
        if (!user) {
            return res.status(400).send('Пользователь не найден. Проверьте логин/email или <a href="/">зарегистрируйтесь заново</a>.');
        }
        
        // Проверяем пароль
        if (hashPassword(password) === user.password) {
            req.session.userId = user.id;
            const todayStr = new Date().toDateString();
            let newStreak = user.streak || 0;
            
            if (user.last_streak_date !== todayStr) {
                const yesterdayStr = new Date(Date.now() - 86400000).toDateString();
                if (user.last_streak_date === yesterdayStr) newStreak += 1;
                else newStreak = 1;
                db.run(`UPDATE users SET visits = visits + 1, streak = ?, last_streak_date = ? WHERE id = ?`, [newStreak, todayStr, user.id]);
            } else {
                db.run(`UPDATE users SET visits = visits + 1 WHERE id = ?`, [user.id]);
            }
            res.redirect('/dashboard');
        } else { 
            res.status(400).send('Неверный пароль. <a href="/">Назад</a>'); 
        }
    });
});


// НАДЕЖНЫЙ ЭНДПОИНТ СОХРАНЕНИЯ ОЧКОВ
app.post('/api/save-score', (req, res) => {
    // Выводим в терминал лог, чтобы видеть, пришел ли запрос вообще
    console.log('--- Получен запрос на сохранение очков ---');
    console.log('Текущая сессия (userId):', req.session.userId);
    console.log('Данные из запроса (body):', req.body);

    if (!req.session.userId) {
        console.log('Ошибка: Пользователь не авторизован в сессии');
        return res.status(401).json({ success: false, message: 'Не авторизован' });
    }

    // Защита: если req.body пустой из-за парсера, берем дефолтное значение
    // (для кликера это 1 очко, для угадайки — 15)
    let points = parseInt(req.body.points);
    if (isNaN(points)) {
        console.log('Предупреждение: points не распознан, ставим по умолчанию 1');
        points = 1; 
    }

    db.run(`UPDATE users SET game_score = game_score + ? WHERE id = ?`, [points, req.session.userId], (err) => {
        if (err) {
            console.error('Ошибка при обновлении очков в БД:', err.message);
            return res.status(500).json({ success: false });
        }
        
        db.get(`SELECT game_score FROM users WHERE id = ?`, [req.session.userId], (err, row) => {
            if (row) {
                console.log(`Успешно! Новые очки в БД для пользователя: ${row.game_score}`);
                res.json({ success: true, newScore: row.game_score });
            } else {
                res.json({ success: false });
            }
        });
    });
});


app.get('/user-avatar-image', (req, res) => {
    if (!req.session.userId) return res.status(401).send('Не авторизован');
    db.get(`SELECT avatar_path FROM users WHERE id = ?`, [req.session.userId], (err, row) => {
        if (row && row.avatar_path) { res.sendFile(path.join(__dirname, row.avatar_path)); } 
        else { res.redirect('https://dummyimage.com'); }
    });
});

app.post('/update-profile-full', upload.single('avatar'), (req, res) => {
    if (!req.session.userId) return res.status(401).send('Сначала войдите в аккаунт.');
    const { new_username, bio } = req.body;
    if (req.file) {
        const avatarPath = `uploads/${req.file.filename}`;
        db.run(`UPDATE users SET username = ?, bio = ?, avatar_path = ? WHERE id = ?`, [new_username, bio, avatarPath, req.session.userId], () => { res.redirect('/dashboard'); });
    } else {
        db.run(`UPDATE users SET username = ?, bio = ? WHERE id = ?`, [new_username, bio, req.session.userId], () => { res.redirect('/dashboard'); });
    }
});

app.post('/save-notes', (req, res) => {
    if (!req.session.userId) return res.status(401).send('Не авторизован');
    const { notes } = req.body;
    db.run(`UPDATE users SET notes = ? WHERE id = ?`, [notes, req.session.userId], (err) => {
        if (err) return res.status(500).send('Ошибка сохранения заметок');
        res.redirect('/dashboard');
    });
});

app.post('/change-password', (req, res) => {
    if (!req.session.userId) return res.status(401).send('Не авторизован');
    const { old_password, new_password } = req.body;

    db.get(`SELECT password FROM users WHERE id = ?`, [req.session.userId], (err, user) => {
        if (err || !user) return res.status(500).send('Пользователь не найден');
        
        if (hashPassword(old_password) !== user.password) {
            return res.status(400).send('Старый пароль введен неверно! <a href="/dashboard">Назад</a>');
        }

        db.run(`UPDATE users SET password = ? WHERE id = ?`, [hashPassword(new_password), req.session.userId], (err) => {
            if (err) return res.status(500).send('Ошибка обновления пароля');
            res.send('Пароль успешно изменен! <a href="/dashboard">Вернуться в кабинет</a>');
        });
    });
});

app.post('/register', (req, res) => {
    const { username, email, password } = req.body;
    const options = { year: 'numeric', month: 'long', day: 'numeric' };
    const today = new Date().toLocaleDateString('ru-RU', options);
    const hashed = hashPassword(password);

    db.run(`INSERT INTO users (username, email, password, reg_date) VALUES (?, ?, ?, ?)`, [username, email, hashed, today], function(err) {
        if (err) return res.status(400).send('Ошибка регистрации. Возможно, email занят.');
        res.send('Успешно! <a href="/">Войдите</a>.');
    });
});

app.post('/login', (req, res) => {
    const { email, password } = req.body;
    db.get(`SELECT * FROM users WHERE email = ?`, [email], (err, user) => {
        if (err || !user) return res.status(400).send('Пользователь не найден.');
        
        if (hashPassword(password) === user.password) {
            req.session.userId = user.id;
            const todayStr = new Date().toDateString();
            let newStreak = user.streak || 0;
            
            if (user.last_streak_date !== todayStr) {
                const yesterdayStr = new Date(Date.now() - 86400000).toDateString();
                if (user.last_streak_date === yesterdayStr) newStreak += 1;
                else newStreak = 1;
                db.run(`UPDATE users SET visits = visits + 1, streak = ?, last_streak_date = ? WHERE id = ?`, [newStreak, todayStr, user.id]);
            } else {
                db.run(`UPDATE users SET visits = visits + 1 WHERE id = ?`, [user.id]);
            }
            res.redirect('/dashboard');
        } else { res.status(400).send('Неверный пароль.'); }
    });
});

app.post('/logout', (req, res) => { req.session.destroy(() => { res.redirect('/'); }); });

// Запуск прослушивания порта
// Запуск прослушивания порта (ИСПРАВЛЕННЫЙ ВАРИАНТ)
app.listen(PORT, () => { 
    console.log('===================================================');
    console.log(`🚀 СЕРВЕР ЗАПУЩЕН! Переходи сюда -> http://localhost:${PORT}`); 
    console.log('===================================================');
});

// API ДЛЯ ПОЛУЧЕНИЯ ТОП-10 ИГРОКОВ
app.get('/api/leaderboard', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ success: false });

    // Выбираем топ-10 пользователей с самым большим счетом (исключая тех, у кого 0 очков)
    db.all(`SELECT username, game_score, role FROM users WHERE game_score > 0 ORDER BY game_score DESC LIMIT 10`, [], (err, rows) => {
        if (err) {
            console.error('Ошибка при получении таблицы лидеров:', err.message);
            return res.status(500).json({ success: false });
        }
        res.json({ success: true, leaders: rows });
    });
});
