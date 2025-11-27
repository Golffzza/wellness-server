// server.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const line = require('@line/bot-sdk');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- LINE CONFIG ----------
const lineConfig = {
  channelSecret: process.env.CHANNEL_SECRET,
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
};
const lineClient = new line.Client(lineConfig);

// ---------- MIDDLEWARE ----------
app.use(cors());
// ❗ สำคัญ: ยังไม่ใช้ express.json() ตรงนี้ เพราะ LINE webhook ต้องอ่าน raw body ก่อน

// ---------- DATABASE ----------
const db = new sqlite3.Database('./queue.db');

// สร้างตารางถ้ายังไม่มี
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lineUserId TEXT,
      name TEXT,
      date TEXT,
      time TEXT,
      note TEXT,
      status TEXT DEFAULT 'CONFIRMED',
      createdAt TEXT
    )
  `);
});

// ---------- CONFIG SLOT ----------
const TIME_SLOTS = [
  '09:00', '09:30',
  '10:00', '10:30',
  '11:00', '11:30',
  '13:00', '13:30',
  '14:00', '14:30',
  '15:00', '15:30',
  '16:00'
];
// สมมติ 1 คนต่อ 1 slot ถ้าอยากเพิ่ม capacity ก็เปลี่ยนค่าได้
const CAPACITY_PER_SLOT = 1;

// ---------- LINE WEBHOOK ----------
app.post('/webhook', line.middleware(lineConfig), (req, res) => {
  Promise.all(req.body.events.map(handleLineEvent))
    .then(result => res.json(result))
    .catch(err => {
      console.error(err);
      res.status(500).end();
    });
});

// ตอนนี้ค่อย parse JSON สำหรับ REST API ส่วนอื่น ๆ
app.use(express.json());

// ---------- REST API ----------

// 1) ดู slot ว่างของวันหนึ่ง
app.get('/api/slots', (req, res) => {
  const date = req.query.date; // YYYY-MM-DD
  if (!date) {
    return res.status(400).json({ error: 'date is required (YYYY-MM-DD)' });
  }

  db.all(
    'SELECT time, COUNT(*) as count FROM bookings WHERE date = ? GROUP BY time',
    [date],
    (err, rows) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'db error' });
      }

      const bookedMap = {};
      rows.forEach(r => {
        bookedMap[r.time] = r.count;
      });

      const slots = TIME_SLOTS.map(t => {
        const used = bookedMap[t] || 0;
        const available = CAPACITY_PER_SLOT - used;
        return {
          time: t,
          capacity: CAPACITY_PER_SLOT,
          booked: used,
          available,
          isFull: available <= 0
        };
      });

      res.json({ date, slots });
    }
  );
});

// 2) จองคิว
app.post('/api/book', (req, res) => {
  const { lineUserId, name, date, time, note } = req.body;

  if (!lineUserId || !name || !date || !time) {
    return res.status(400).json({ error: 'lineUserId, name, date, time are required' });
  }

  // check ว่ามีคนจอง slot นี้เต็มหรือยัง
  db.get(
    'SELECT COUNT(*) as count FROM bookings WHERE date = ? AND time = ?',
    [date, time],
    (err, row) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'db error' });
      }

      if (row.count >= CAPACITY_PER_SLOT) {
        return res.status(409).json({ error: 'slot is full' });
      }

      const createdAt = new Date().toISOString();
      db.run(
        'INSERT INTO bookings (lineUserId, name, date, time, note, createdAt) VALUES (?,?,?,?,?,?)',
        [lineUserId, name, date, time, note || '', createdAt],
        function (err2) {
          if (err2) {
            console.error(err2);
            return res.status(500).json({ error: 'db error' });
          }

          const bookingId = this.lastID;

          // ส่งข้อความยืนยันกลับไปที่ LINE
          lineClient.pushMessage(lineUserId, {
            type: 'text',
            text: `✅ จองคิวสำเร็จแล้ว\n\nชื่อ: ${name}\nวันที่: ${date}\nเวลา: ${time}\nหมายเลขการจอง: #${bookingId}`
          }).catch(e => console.error('LINE push error:', e));

          res.status(201).json({
            id: bookingId,
            lineUserId,
            name,
            date,
            time,
            note: note || '',
            status: 'CONFIRMED',
            createdAt
          });
        }
      );
    }
  );
});

// 3) ดูคิวของ user คนหนึ่ง
app.get('/api/my-bookings', (req, res) => {
  const { lineUserId } = req.query;
  if (!lineUserId) {
    return res.status(400).json({ error: 'lineUserId is required' });
  }

  db.all(
    'SELECT * FROM bookings WHERE lineUserId = ? ORDER BY date, time',
    [lineUserId],
    (err, rows) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'db error' });
      }
      res.json(rows);
    }
  );
});

// ---------- LINE EVENT HANDLER ----------
async function handleLineEvent(event) {
  // รับเฉพาะข้อความ
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const userId = event.source.userId;
  const text = event.message.text.trim();

  // ตัวอย่าง logic ง่าย ๆ:
  // - ถ้าพิมพ์ "คิวของฉัน" → แสดงรายการจอง
  // - อย่างอื่น → ส่งข้อความแนะนำ
  if (text === 'คิวของฉัน') {
    return new Promise((resolve, reject) => {
      db.all(
        'SELECT * FROM bookings WHERE lineUserId = ? ORDER BY date, time',
        [userId],
        (err, rows) => {
          if (err) {
            console.error(err);
            return reject(err);
          }

          if (!rows.length) {
            return lineClient.replyMessage(event.replyToken, {
              type: 'text',
              text: 'ตอนนี้ยังไม่มีคิวในระบบนะคะ'
            }).then(resolve).catch(reject);
          }

          const lines = rows.map(b =>
            `• ${b.date} เวลา ${b.time} (#${b.id})`
          );
          const msg = `🗓 คิวของคุณมีดังนี้\n\n${lines.join('\n')}`;

          lineClient.replyMessage(event.replyToken, {
            type: 'text',
            text: msg
          }).then(resolve).catch(reject);
        }
      );
    });
  }

  // ข้อความอื่น ให้บอกทางไปหน้า LIFF จองคิว
  const helpText =
    'หากต้องการจองคิว ให้กดปุ่ม "จองคิว" ในเมนูด้านล่าง หรือพิมพ์คำว่า "คิวของฉัน" เพื่อดูคิวล่าสุดของคุณ';

  return lineClient.replyMessage(event.replyToken, {
    type: 'text',
    text: helpText
  });
}

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`Queue backend is running on port ${PORT}`);
});
