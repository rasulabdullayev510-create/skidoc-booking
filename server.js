const express = require("express");
const low = require("lowdb");
const FileSync = require("lowdb/adapters/FileSync");
const twilio = require("twilio");
const crypto = require("crypto");
const path = require("path");
const cron = require("node-cron");
const cors = require("cors");

require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const adapter = new FileSync("db.json");
const db = low(adapter);
db.defaults({ bookings: [], feedback: [] }).write();

const {
  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER,
  BASE_URL = "http://localhost:3004", PORT = 3004,
  BUSINESS_NAME = "Ski Doc Calgary",
  ADMIN_PASSWORD = "skidoc2024",
  OWNER_PHONE,
} = process.env;

const twilioClient = TWILIO_ACCOUNT_SID ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

function generateToken() { return crypto.randomBytes(16).toString("hex"); }
function getSurveyUrl(token) { return `${BASE_URL}/review?token=${token}`; }

function formatTime(t) {
  const [h, m] = t.split(':');
  const hr = parseInt(h);
  return `${hr > 12 ? hr - 12 : hr || 12}:${m} ${hr >= 12 ? 'PM' : 'AM'}`;
}

async function sendBookingConfirmation(booking) {
  if (!twilioClient) { console.log(`[SMS SKIPPED] Confirmation for ${booking.customerName}`); return; }
  await twilioClient.messages.create({
    body: `Hi ${booking.customerName}! Your booking is confirmed at ${BUSINESS_NAME}. Service: ${booking.serviceName} on ${booking.date} at ${formatTime(booking.time)}. See you then!`,
    from: TWILIO_PHONE_NUMBER,
    to: booking.phone,
  });
}

async function sendOwnerNotification(booking) {
  if (!twilioClient || !OWNER_PHONE) { console.log(`[SMS SKIPPED] Owner notification`); return; }
  await twilioClient.messages.create({
    body: `New booking! ${booking.customerName} booked ${booking.serviceName} on ${booking.date} at ${formatTime(booking.time)}. Phone: ${booking.phone}.`,
    from: TWILIO_PHONE_NUMBER,
    to: OWNER_PHONE,
  });
}

async function sendReviewSMS(booking) {
  if (!twilioClient) { console.log(`[SMS SKIPPED] Review for ${booking.customerName}`); return; }
  await twilioClient.messages.create({
    body: `Hi ${booking.customerName}! How was your experience at ${BUSINESS_NAME}? Takes 20 seconds: ${getSurveyUrl(booking.reviewToken)}`,
    from: TWILIO_PHONE_NUMBER,
    to: booking.phone,
  });
}

const SERVICES = [
  { id: "ski-tuneup-wax", name: "Ski Tuneup & Wax", description: "Full base grind, edge work, and hot wax — everything your skis need for a great day on the hill", duration: 90, price: 65, category: "ski" },
  { id: "edge-sharpening", name: "Edge Sharpening", description: "Precision side and base edge bevel sharpening to your spec — crisp, confident edges every run", duration: 45, price: 35, category: "ski" },
  { id: "snowboard-tuneup", name: "Snowboard Tuneup", description: "Base repair, edge sharpening, and hot wax for your board — ride smoother, hit harder", duration: 90, price: 60, category: "snowboard" },
];

app.get("/api/services", (req, res) => res.json(SERVICES));

app.get("/api/availability", (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: "date required" });

  const d = new Date(date);
  if (d.getDay() === 0) return res.json({ date, slots: [] });

  const now = new Date();
  const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);
  const todayStr = now.toISOString().split('T')[0];

  const booked = db.get("bookings")
    .filter(b => b.date === date && b.status !== "cancelled")
    .map(b => b.time)
    .value();

  const slots = [];
  for (let h = 9; h <= 17; h++) {
    for (let m of [0, 30]) {
      if (h === 17 && m === 30) continue;
      const timeStr = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
      if (date === todayStr) {
        const slotTime = new Date(date + 'T' + timeStr + ':00');
        if (slotTime < oneHourFromNow) continue;
      }
      slots.push({
        time: timeStr,
        status: booked.includes(timeStr) ? 'booked' : 'available'
      });
    }
  }

  res.json({ date, slots });
});

app.post("/api/bookings", async (req, res) => {
  const { serviceId, serviceName, servicePrice, date, time, customerName, phone, email, notes } = req.body;
  if (!serviceId || !date || !time || !customerName || !phone)
    return res.status(400).json({ error: "Missing required fields" });

  const service = { id: serviceId, name: serviceName || serviceId, price: Number(servicePrice) || 0 };

  const taken = db.get("bookings")
    .find(b => b.date === date && b.time === time && b.status !== "cancelled")
    .value();
  if (taken) return res.status(409).json({ error: "Slot already booked" });

  const booking = {
    id: `SKI-${Date.now()}`,
    serviceId, serviceName: service.name, servicePrice: service.price,
    date, time, customerName, phone,
    email: email || null, notes: notes || null,
    status: "confirmed",
    reviewToken: generateToken(),
    reviewSentAt: null,
    createdAt: new Date().toISOString(),
  };

  db.get("bookings").push(booking).write();
  console.log(`✓ Booking: ${booking.id} — ${customerName} for ${service.name} on ${date} at ${time}`);

  try { await sendBookingConfirmation(booking); console.log(`✓ Confirmation SMS → ${customerName}`); }
  catch (err) { console.error(`✗ Customer confirmation failed:`, err.message); }

  try { await sendOwnerNotification(booking); console.log(`✓ Owner notification → ${OWNER_PHONE}`); }
  catch (err) { console.error(`✗ Owner notification failed:`, err.message); }

  res.json({
    success: true,
    bookingId: booking.id,
    booking: { id: booking.id, serviceName: booking.serviceName, date, time, price: booking.servicePrice, customerName },
  });
});

app.get("/api/bookings", (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
  res.json(db.get("bookings").value().reverse());
});

app.post("/api/review", (req, res) => {
  const { token, rating, comment } = req.body;
  if (!token || !rating) return res.status(400).json({ error: "token and rating required" });
  const booking = db.get("bookings").find({ reviewToken: token }).value();
  if (!booking) return res.status(404).json({ error: "Invalid token" });
  db.get("feedback").push({
    id: Date.now(), bookingId: booking.id,
    customerName: booking.customerName, serviceName: booking.serviceName,
    rating: Number(rating), comment: comment || null,
    submittedAt: new Date().toISOString(),
  }).write();
  res.json({ success: true, redirectToGoogle: Number(rating) >= 4 });
});

app.get("/api/review/:token", (req, res) => {
  const booking = db.get("bookings").find({ reviewToken: req.params.token }).value();
  if (!booking) return res.status(404).json({ error: "Not found" });
  const alreadyReviewed = db.get("feedback").find({ bookingId: booking.id }).value();
  res.json({ customerName: booking.customerName, serviceName: booking.serviceName, date: booking.date, alreadyReviewed: !!alreadyReviewed });
});

app.get("/api/analytics", (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
  const bookings = db.get("bookings").value();
  const feedback = db.get("feedback").value();
  const confirmed = bookings.filter(b => b.status === "confirmed");
  const revenue = confirmed.reduce((sum, b) => sum + b.servicePrice, 0);
  const byService = {};
  confirmed.forEach(b => { byService[b.serviceName] = (byService[b.serviceName] || 0) + 1; });
  const last14 = {};
  for (let i = 13; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    last14[d.toISOString().split('T')[0]] = 0;
  }
  confirmed.forEach(b => { if (last14[b.date] !== undefined) last14[b.date] += b.servicePrice; });
  const byHour = {};
  confirmed.forEach(b => { const h = b.time.split(':')[0]; byHour[h] = (byHour[h] || 0) + 1; });
  const totalFeedback = feedback.length;
  const avgRating = totalFeedback ? (feedback.reduce((s, f) => s + f.rating, 0) / totalFeedback).toFixed(1) : null;
  const reviewRate = confirmed.length ? Math.round((totalFeedback / confirmed.length) * 100) : 0;
  res.json({ totalBookings: confirmed.length, totalRevenue: revenue, avgRating, reviewRate, byService, revenueByDay: last14, byHour });
});

app.get("/dashboard", (req, res) => res.sendFile(path.join(__dirname, "public", "dashboard.html")));
app.get("/review", (req, res) => res.sendFile(path.join(__dirname, "public", "review.html")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// Review SMS fires 24h after appointment time
cron.schedule("*/5 * * * *", async () => {
  const now = new Date();
  const pending = db.get("bookings").filter(b => {
    if (b.status !== "confirmed" || b.reviewSentAt) return false;
    const appointmentTime = new Date(`${b.date}T${b.time}:00`);
    const hoursAfter = (now - appointmentTime) / (1000 * 60 * 60);
    return hoursAfter >= 24 && hoursAfter < 25;
  }).value();
  for (const booking of pending) {
    try {
      await sendReviewSMS(booking);
      db.get("bookings").find({ id: booking.id }).assign({ reviewSentAt: now.toISOString() }).write();
      console.log(`✓ Review SMS → ${booking.customerName}`);
    } catch (err) {
      console.error(`✗ Review SMS failed:`, err.message);
    }
  }
});

app.listen(PORT, () => {
  console.log(`\n🏔  Ski Doc Calgary — Booking System`);
  console.log(`   Booking page: http://localhost:${PORT}`);
  console.log(`   Dashboard:    http://localhost:${PORT}/dashboard`);
  console.log(`   Password:     ${ADMIN_PASSWORD}\n`);
});
