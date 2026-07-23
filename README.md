# Taveesub Chatbot — ระบบตอบแชทอัตโนมัติ ทวีทรัพย์ยานยนต์

โค้ดจริงที่ใช้งานได้ทันที ครอบคลุม: รับข้อความจาก Facebook Messenger + LINE OA, วิเคราะห์ด้วย Claude AI,
หาสาขาใกล้สุด (คำนวณระยะทางจริง), จัดคิวเซล/ช่างแบบ Round Robin หรือส่งตรงถึงคนประจำ, จองคิวซ่อม,
แจ้งเตือนกลุ่ม LINE สาขา และบันทึกเป็น Lead (local file หรือ Bitrix24 ก็ได้)

ทดสอบแล้วว่า server บูตได้จริงและ logic การ routing ทำงานถูกต้อง (ดูหัวข้อ "ทดสอบระบบ" ด้านล่าง)

---

## 1. โครงสร้างโปรเจกต์

```
taveesub-chatbot/
├── src/
│   ├── server.js              จุดเริ่มต้นของแอป (Express server)
│   ├── config/systemPrompt.js คำสั่ง/กฎที่ส่งให้ Claude ทุกครั้ง
│   ├── data/                  ฐานข้อมูล local (JSON) — แก้ไขตรงนี้ได้เลยไม่ต้องรีสตาร์ทเซิร์ฟเวอร์
│   │   ├── branches.json      รายชื่อสาขา + พิกัด + คิวซ่อมสูงสุด/วัน + LINE Group ID
│   │   ├── staff.json         พนักงานขาย/ช่าง + เบอร์โทร + สาขา
│   │   ├── faq.json           คำถาม-คำตอบที่พบบ่อย
│   │   ├── models.json        รายชื่อรุ่นรถที่ขาย
│   │   ├── leads.json         log ของทุก Lead ที่เกิดขึ้น (auto-generate)
│   │   └── bookings.json      log การจองคิวซ่อม (auto-generate)
│   ├── services/
│   │   ├── claude.js          เรียก Claude API
│   │   ├── facebook.js        เรียก Facebook Graph API
│   │   ├── line.js            เรียก LINE Messaging API
│   │   ├── geocode.js         Google Maps Geocoding + คำนวณระยะทาง
│   │   ├── bitrix24.js        เชื่อม Bitrix24 (ไม่บังคับ)
│   │   └── store.js           อ่าน/เขียนไฟล์ใน data/
│   ├── routing/router.js      หัวใจของ business logic (ตัดสินใจ handoff/routing ทั้งหมด)
│   ├── session/sessionStore.js เก็บสถานะการคุยของลูกค้าแต่ละคน (in-memory)
│   └── webhooks/               รับ event จาก Facebook/LINE
├── test_router.js             สคริปต์ทดสอบ routing logic แบบไม่ต้องมี API จริง
├── .env.example                แม่แบบไฟล์ตั้งค่า (คัดลอกเป็น .env แล้วกรอกค่าจริง)
└── package.json
```

---

## 2. ติดตั้งและรันในเครื่อง (ก่อน deploy จริง)

ต้องมี [Node.js](https://nodejs.org) เวอร์ชัน 18 ขึ้นไปในเครื่อง

```bash
cd taveesub-chatbot
npm install
cp .env.example .env
# แก้ .env ใส่ค่าจริงตามหัวข้อ 3
npm start
```

เปิด `http://localhost:3000/health` ควรเห็น `{"status":"ok",...}` แปลว่าเซิร์ฟเวอร์รันสำเร็จ

ทดสอบ logic การ routing โดยไม่ต้องมี API key จริงได้ด้วย:
```bash
node test_router.js
```

---

## 3. ค่าที่ต้องกรอกใน `.env` และวิธีขอแต่ละตัว

| ตัวแปร | ขอจากไหน | บังคับไหม |
|---|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com → Create Key | บังคับ |
| `FB_PAGE_ACCESS_TOKEN` | Facebook App Dashboard → Messenger → Generate Token (ต้องเชื่อม Page ก่อน) | บังคับถ้าใช้ Facebook |
| `FB_VERIFY_TOKEN` | ตั้งเองเป็นข้อความอะไรก็ได้ ใช้ตอนยืนยัน Webhook | บังคับถ้าใช้ Facebook |
| `FB_APP_SECRET` | Facebook App Dashboard → Settings → Basic | แนะนำให้ตั้ง (เผื่อใช้ตรวจสอบ signature ในอนาคต) |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Developers Console → Messaging API → Channel access token | บังคับถ้าใช้ LINE |
| `LINE_CHANNEL_SECRET` | LINE Developers Console → Basic settings | บังคับถ้าใช้ LINE |
| `GOOGLE_MAPS_API_KEY` | console.cloud.google.com → เปิดใช้ Geocoding API | ถ้าไม่ใส่ ระบบจะส่งทุกเคสเข้า "สำนักงานใหญ่" แทนการหาสาขาใกล้สุด |
| `BITRIX24_WEBHOOK_URL` | Bitrix24 → Applications → Developer resources → Inbound webhook | ไม่บังคับ (ถ้าไม่ตั้ง ระบบใช้ `src/data/leads.json` เป็นฐานข้อมูลแทน) |

---

## 4. แก้ข้อมูลร้าน (ทำได้เลยตอนนี้ ไม่ต้องรอ deploy)

เปิดไฟล์ในโฟลเดอร์ `src/data/` แล้วแก้ตรงๆ ได้เลย (เป็นไฟล์ข้อความธรรมดา เปิดด้วย Notepad/VS Code ก็ได้)

- **`branches.json`** — ใส่ชื่อ ที่อยู่ พิกัด (lat/long) จำนวนคิวซ่อมสูงสุด/วัน และ LINE Group ID ของแต่ละสาขาให้ครบ
  (หาพิกัด: เปิด Google Maps คลิกขวาที่ตำแหน่งสาขา จะมีตัวเลข lat, long ให้กดคัดลอก)
- **`staff.json`** — ใส่ชื่อ เบอร์โทร สาขา และตำแหน่ง (เซล/ช่าง) ของพนักงานทุกคน
- **`faq.json`** — เพิ่ม/แก้คำถามที่ลูกค้าถามบ่อยพร้อมคำตอบ
- **`models.json`** — ใส่รุ่นรถที่ขายทั้งหมด

**ไม่ต้อง deploy โค้ดใหม่หลังแก้ไฟล์พวกนี้** ถ้ารันแบบ local ให้ restart เซิร์ฟเวอร์ (`Ctrl+C` แล้ว `npm start` ใหม่)
ถ้า deploy บน hosting ต้อง push ไฟล์ใหม่ขึ้นไป (ดูหัวข้อ 6 เรื่องอัปเกรดเป็น Bitrix24 ถ้าอยากแก้ได้แบบไม่ต้อง deploy)

---

## 5. ตั้งค่า Facebook และ LINE ให้ยิง Webhook มาที่เซิร์ฟเวอร์นี้

หลัง deploy แล้ว (ดูหัวข้อ 7) จะได้ URL สาธารณะ เช่น `https://your-app.onrender.com`

**Facebook**: App Dashboard → Messenger → Webhooks → Add Callback URL
- Callback URL: `https://your-app.onrender.com/webhook/facebook`
- Verify Token: ค่าเดียวกับที่ตั้งใน `FB_VERIFY_TOKEN`
- Subscribe fields: `messages`, `feed`

**LINE**: LINE Developers Console → Messaging API → Webhook URL
- Webhook URL: `https://your-app.onrender.com/webhook/line`
- เปิด "Use webhook"
- เพิ่มบอทเข้ากลุ่ม LINE ของแต่ละสาขา แล้วเอา Group ID มาใส่ใน `branches.json`
  (วิธีหา Group ID ง่ายที่สุด: log `event.source.groupId` ชั่วคราวตอนบอทเข้ากลุ่มครั้งแรก หรือใช้ LINE Official Account Manager)

---

## 6. เมื่อพร้อมย้ายไป Bitrix24 (ไม่บังคับตอนเริ่มต้น)

ตอนนี้ระบบเก็บ Lead/สาขา/พนักงาน/FAQ เป็นไฟล์ local เพื่อให้เริ่มใช้งานได้ทันทีโดยไม่ต้องตั้งค่า Bitrix24 ก่อน
เมื่อพร้อมแล้วให้ทำตาม `Final_Chatbot_System_Design.md` (สร้าง SPA `Leads`, `Staff_Queue`, `Branches`, `FAQ_KnowledgeBase`)
แล้วตั้งค่า `BITRIX24_WEBHOOK_URL` และ `BITRIX24_LEADS_ENTITY_TYPE_ID` ใน `.env` — ระบบจะเริ่มบันทึก Lead
เข้า Bitrix24 อัตโนมัติ (ดูโค้ดใน `src/services/bitrix24.js`) จุดนี้เป็นจุดเดียวที่ทีมเดฟต้องเพิ่มโค้ดอ่าน/เขียน
`branches.json`, `staff.json`, `faq.json` ให้ดึงจาก Bitrix24 แทนไฟล์ local ถ้าต้องการให้ทีมงานที่ไม่ใช่โปรแกรมเมอร์แก้ข้อมูลจากหน้าเว็บ Bitrix24 ได้เลยแทนการแก้ไฟล์

---

## 7. Deploy ขึ้น hosting จริง

แนะนำ Render.com หรือ Railway.app (มีแผนเริ่มต้นราคาถูก ตั้งค่าไม่ยาก รองรับ Node.js โดยตรง)

**ขั้นตอนคร่าวๆ (Render.com)**
1. อัปโหลดโค้ดโฟลเดอร์นี้ขึ้น GitHub repository (ส่วนตัว)
2. เข้า render.com → New → Web Service → เชื่อม repo
3. Build Command: `npm install`
4. Start Command: `npm start`
5. ใส่ Environment Variables ทั้งหมดจากหัวข้อ 3 ในหน้า Settings ของ Render (ห้ามใส่ในโค้ด/ห้าม commit ไฟล์ .env)
6. Deploy แล้วจะได้ URL สาธารณะ เอาไปตั้งใน Facebook/LINE ตามหัวข้อ 5

> ⚠️ ข้อมูลใน `src/data/*.json` จะ**หายเมื่อ redeploy**บน hosting บางเจ้า (filesystem ไม่ persistent)
> ถ้าจะใช้งานจริงระยะยาว แนะนำให้ย้ายไป Bitrix24 (หัวข้อ 6) หรือฐานข้อมูลจริง (Postgres/MongoDB) แทนไฟล์ local โดยเร็ว

---

## 8. ทดสอบระบบที่ทำไปแล้ว

ก่อนส่งมอบไฟล์นี้ ได้ทดสอบแล้วว่า:
- ทุกไฟล์ผ่าน `node --check` (ไม่มี syntax error)
- เซิร์ฟเวอร์บูตสำเร็จ ตอบ `/health` และ `/` ได้ปกติ
- Facebook Webhook verification (`GET /webhook/facebook`) ตอบ challenge ถูกต้อง และปฏิเสธ token ผิดด้วย 403
- รัน `test_router.js` แล้ว routing logic ทำงานถูกต้องครบทุกเคส: ส่งตรงถึงเซลประจำตัว, ส่งเข้าคิว round robin,
  เคสซ่อมไม่ส่งเบอร์พนักงานให้ลูกค้า, และ high-intent keyword ("จอง") ทำให้ handoff ทันทีแม้ข้อมูลไม่ครบ

สิ่งที่ยัง**ทดสอบกับของจริงไม่ได้**เพราะไม่มี API key จริง (ต้องให้คุณทดสอบเองหลังกรอก `.env` ครบ):
Facebook Messenger จริง, LINE OA จริง, Claude API จริง, Google Maps จริง, Bitrix24 จริง

---

## 9. ข้อจำกัดที่ควรรู้ก่อนใช้งานจริง

- **Session เก็บใน memory** — ถ้าเซิร์ฟเวอร์ restart บทสนทนาที่ค้างอยู่จะหายและเริ่มใหม่ (ไม่กระทบ Lead ที่บันทึกไปแล้ว) เหมาะกับเริ่มต้นทดสอบ ถ้าจะใช้จริงระยะยาวควรเปลี่ยนไปใช้ Redis
- **การแปลงวันที่ (`preferred_date`)** ตอนนี้รองรับเฉพาะรูปแบบ `YYYY-MM-DD` เท่านั้น ถ้าลูกค้าพิมพ์ "พรุ่งนี้"/"เสาร์นี้" ระบบจะยังไม่ auto-parse ให้ — ระบบจะทำการนัดคิวโดยไม่เช็คความจุถ้าแปลงวันที่ไม่ได้ (ควรให้ Claude แปลงเป็น ISO date ก่อนส่งมา หรือเพิ่ม library แปลงวันที่ภาษาไทยภายหลัง)
- **การนับระยะทาง** ใช้เส้นตรง (Haversine) ไม่ใช่ระยะทางถนนจริง เพียงพอสำหรับจัดอันดับสาขาใกล้สุด แต่ตัวเลข กม. ที่โชว์อาจคลาดเคลื่อนจากระยะทางขับจริงเล็กน้อย
