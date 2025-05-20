const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const mongoose = require("mongoose");
const QRCode = require("qrcode");
const path = require("path");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require("@whiskeysockets/baileys");
const fs = require("fs");

dotenv.config();
const app = express();
app.use(express.json());

const allowedOrigins = ["https://rsmage.site", "https://bot.rsmage.site"];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true); // untuk Postman/curl
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Origin tidak diizinkan oleh CORS"));
      }
    },
    credentials: true,
  })
);

// MongoDB Schema
const userSchema = new mongoose.Schema({
  phoneNumber: String,
  name: String,
});
const User = mongoose.model("User", userSchema);

const taskSchema = new mongoose.Schema({
  title: String,
  description: String,
  deadline: Date,
  completedAt: Date,
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  reminderSentAt: Date,
  twoDaysReminderSent: Boolean,
});
const Task = mongoose.model("Task", taskSchema);

// Koneksi MongoDB
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB failed:", err));

let latestQr = null; // simpan QR code base64
let sock = null; // global socket supaya bisa diakses endpoint

// Baileys Authentication & Socket
async function startSocket() {
  const { state, saveCreds } = await useMultiFileAuthState("./baileys_auth");

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on(
    "connection.update",
    async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        latestQr = await QRCode.toDataURL(qr);
        console.log("🔁 QR diperbarui");
      }

      if (connection === "open") {
        console.log("✅ WhatsApp connected");
        latestQr = null;
        setInterval(checkAndSendReminders, 30 * 1000); //reminder tiap 30 detik
      }

      if (connection === "close") {
        const shouldReconnect =
          lastDisconnect?.error?.output?.statusCode !==
          DisconnectReason.loggedOut;
        console.log("❌ Disconnected. Reconnect?", shouldReconnect);
        if (shouldReconnect) {
          startSocket();
        }
      }
    }
  );
}

startSocket();

// Endpoint QR
app.get("/qr", (req, res) => {
  if (latestQr) {
    res.send(`
      <html><body style="text-align:center">
        <h2>Scan QR WhatsApp</h2>
        <img src="${latestQr}" width="300" />
      </body></html>
    `);
  } else {
    res.send(`<h3>✅ WhatsApp sudah terhubung</h3>`);
  }
});

// OTP Store
const otpStore = {};
function normalizePhoneNumber(number) {
  number = number.replace(/\D/g, "");
  if (number.startsWith("08")) return "62" + number.slice(1);
  if (number.startsWith("62")) return number;
  if (number.startsWith("8")) return "62" + number;
  return number;
}

app.post("/send-otp", async (req, res) => {
  const { phoneNumber, otp } = req.body;
  if (!phoneNumber || !otp)
    return res.status(400).json({ error: "phoneNumber dan otp wajib diisi" });

  const number = normalizePhoneNumber(phoneNumber);
  const jid = number + "@s.whatsapp.net";

  try {
    if (!sock) throw new Error("Socket belum siap");
    await sock.sendMessage(jid, {
      text: `Kode verifikasi kamu adalah *${otp}*`,
    });
    otpStore[number] = { otp, expires: Date.now() + 5 * 60 * 1000 };
    res.json({ message: "OTP berhasil dikirim via WA" });
  } catch (err) {
    console.error("❌ Gagal kirim pesan:", err);
    res.status(500).json({ error: "Gagal kirim pesan WhatsApp" });
  }
});

app.post("/verify-otp", (req, res) => {
  const { phoneNumber, otp } = req.body;
  const number = normalizePhoneNumber(phoneNumber);
  const record = otpStore[number];

  if (!record)
    return res.status(400).json({ error: "Nomor belum dikirim OTP" });
  if (Date.now() > record.expires) {
    delete otpStore[number];
    return res.status(400).json({ error: "Kode OTP kadaluarsa" });
  }
  if (record.otp !== otp)
    return res.status(400).json({ error: "Kode OTP salah" });

  delete otpStore[number];
  res.json({ message: "Verifikasi berhasil" });
});

async function sendMessageWithRetry(chatId, message) {
  try {
    await sock.sendMessage(chatId, { text: message });
    return true;
  } catch (error) {
    console.error("Gagal kirim pesan:", error);
    return false;
  }
}

async function checkAndSendReminders() {
  const now = new Date();
  const tasks = await Task.find({
    deadline: { $gte: now },
    completedAt: null,
  }).populate("userId");

  for (const task of tasks) {
    if (!task.userId || !task.userId.phoneNumber) continue;

    const chatId =
      normalizePhoneNumber(task.userId.phoneNumber) + "@s.whatsapp.net";
    const deadline = task.deadline;
    const timeDiffMs = deadline - now;
    const minutesToDeadline = timeDiffMs / (1000 * 60);
    const lastSent = task.reminderSentAt || new Date(0);
    const minutesSinceLastSent = (now - lastSent) / (1000 * 60);

    const deadlineStr = deadline.toLocaleString("id-ID", {
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
      day: "numeric",
      month: "long",
      year: "numeric",
    });

    if (minutesToDeadline > 2880 && !task.twoDaysReminderSent) {
      const descriptionText = task.description
        ? `📝 *Deskripsi:* ${task.description}`
        : `📝 *Deskripsi:* Tidak ada keterangan tambahan.`;

      const watermark = `
*Developed by Garin & Team*
👥 Rio | Rizki | Yasid | Izy

    ⚠ *Tugas-Ku Beta Version* ⚠
`;

      const twoDayMsg = `👋 Haloo! Kami dari *Tugas-Ku* ingin mengingatkan kamu nih...\n

✨ *Judul:* ${task.title} 

${descriptionText}

📅 *Deadline:* ${deadlineStr}

📢 Deadline masih lama, jangan lupa mulai dicicil ya!

${watermark}`;

      const sent = await sendMessageWithRetry(chatId, twoDayMsg);
      if (sent) {
        task.twoDaysReminderSent = true;
        await task.save();
        console.log(
          `📆 Reminder 2 hari dikirim ke ${task.userId.phoneNumber} | Tugas: "${task.title}"`
        );
      }

      continue;
    }

    if (minutesToDeadline > 2880) continue;

    let intervalMinutes = 0;
    if (minutesToDeadline > 360) intervalMinutes = 60;
    else if (minutesToDeadline > 60) intervalMinutes = 30;
    else if (minutesToDeadline > 10) intervalMinutes = 10;
    else if (minutesToDeadline > 5) intervalMinutes = 5;
    else if (minutesToDeadline > 0) intervalMinutes = 2;
    else continue;

    if (minutesSinceLastSent < intervalMinutes) continue;

    let urgency = "";
    if (minutesToDeadline < 5) urgency = "🚨 *Segera dikerjakan!*";
    else if (minutesToDeadline < 60) urgency = "⏱️ *Waktunya semakin dekat!*";
    else urgency = "📌 Jangan lupa diselesaikan ya.";

    const descriptionText = task.description
      ? `📝 *Deskripsi:* ${task.description}`
      : `📝 *Deskripsi:* Tidak ada keterangan tambahan.`;

    const watermark = `
*Developed by Garin & Team*
👥 Rio | Rizki | Yasid | Izy

    ⚠ *Tugas-Ku Beta Version* ⚠
`;

    const message = `👋 Haloo! Kami dari *Tugas-Ku* ingin mengingatkan kamu nih...\n

✨ *Judul:* ${task.title} 

${descriptionText}

📅 *Deadline:* ${deadlineStr}

${urgency}

${watermark}`;

    const sent = await sendMessageWithRetry(chatId, message);
    if (sent) {
      task.reminderSentAt = now;
      await task.save();
      console.log(
        `⏰ Reminder dikirim ke ${task.userId.phoneNumber} | Tugas: "${task.title}"`
      );
    }
  }
}

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
