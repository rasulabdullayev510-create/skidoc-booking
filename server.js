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
app.use(express.urlencoded({ extended: false }));
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
function generateShortId() { return crypto.randomBytes(3).toString("hex").toUpperCase(); }
function getSurveyUrl(token) { return `${BASE_URL}/review?token=${token}`; }

function formatTime(t) {
  const [h, m] = t.split(':');
  const hr = parseInt(h);
  return `${hr > 12 ? hr - 12 : hr || 12}:${m} ${hr >= 12 ? 'PM' : 'AM'}`;
}

// SMS to owner — approve or deny request
async function sendOwnerRequest(booking) {
  if (!twilioClient || !OWNER_PHONE) { console.log(`[SMS SKIPPED] Owner request`); return; }
  await twilioClient.messages.create({
    body: `New booking request!\n${booking.customerName} wants ${booking.serviceName}\n${booking.date} at ${formatTime(booking.time)}\nPhone: ${booking.phone}\n\nReply YES to confirm or NO to decline.`,
    from: TWILIO_PHONE_NUMBER,
    to: OWNER_PHONE,
  });
}

// SMS to customer — booking confirmed
async function sendCustomerConfirmation(booking) {
  if (!twilioClient) { console.log(`[SMS SKIPPED] Confirmation for ${booking.customerName}`); return; }
  await twilioClient.messages.create({
    body: `Hi ${booking.customerName}! Your booking is confirmed at ${BUSINESS_NAME}. ${booking.serviceName} on ${booking.date} at ${formatTime(booking.time)}. See you then!`,
    from: TWILIO_PHONE_NUMBER,
    to: booking.phone,
  });
}

// SMS to customer — booking denied, rebook link
async function sendCustomerDenied(booking) {
  if (!twilioClient) { console.log(`[SMS SKIPPED] Denial for ${booking.customerName}`); return; }
  await twilioClient.messages.create({
    body: `Hi ${booking.customerName}, unfortunately that time is no longer available at ${BUSINESS_NAME}. Please choose another time: https://skidocyyc.ca/book`,
    from: TWILIO_PHONE_NUMBER,
    to: booking.phone,
  });
}

// SMS to customer — owner suggests a new time
async function sendCustomerOffer(booking, suggestedDate, suggestedTime) {
  if (!twilioClient) { console.log(`[SMS SKIPPED] Offer for ${booking.customerName}`); return; }
  await twilioClient.messages.create({
    body: `Hi ${booking.customerName}, ${booking.date} at ${formatTime(booking.time)} isn't available at ${BUSINESS_NAME}. We'd like to offer you ${suggestedDate} at ${formatTime(suggestedTime)} for your ${booking.serviceName}.\n\nReply YES to confirm or NO to choose your own time.`,
    from: TWILIO_PHONE_NUMBER,
    to: booking.phone,
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
  const dayOfWeek = d.getDay(); // 0=Sun, 1=Mon, 5=Fri, 6=Sat

  // Determine start hour based on day
  let startH;
  if (dayOfWeek === 5) startH = 15;        // Friday: 3 PM
  else if (dayOfWeek === 0 || dayOfWeek === 6) startH = 11; // Sat/Sun: 11 AM
  else startH = 17;                          // Mon–Thu: 5 PM
  const endH = 23; // all days end at 11 PM

  const now = new Date();
  const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);
  const todayStr = now.toISOString().split('T')[0];

  const booked = db.get("bookings")
    .filter(b => b.date === date && b.status !== "cancelled" && b.status !== "denied")
    .map(b => b.time)
    .value();

  const slots = [];
  for (let h = startH; h <= endH; h++) {
    for (let m of [0, 30]) {
      if (h === endH && m === 30) continue;
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
  const { serviceId, serviceName, servicePrice, date, time, customerName, email, notes } = req.body;
  let phone = (req.body.phone || "").toString().replace(/[^0-9+]/g, "");
  if (phone.length === 10) phone = "+1" + phone;
  else if (phone.length === 11 && phone[0] === "1") phone = "+" + phone;
  else if (phone.length > 0 && !phone.startsWith("+")) phone = "+" + phone;
  if (!serviceId || !date || !time || !customerName || !phone)
    return res.status(400).json({ error: "Missing required fields" });

  const service = { id: serviceId, name: serviceName || serviceId, price: Number(servicePrice) || 0 };

  const taken = db.get("bookings")
    .find(b => b.date === date && b.time === time && b.status !== "cancelled" && b.status !== "denied")
    .value();
  if (taken) return res.status(409).json({ error: "Slot already booked" });

  const booking = {
    id: `SKI-${Date.now()}`,
    shortId: generateShortId(),
    serviceId, serviceName: service.name, servicePrice: service.price,
    date, time, customerName, phone,
    email: email || null, notes: notes || null,
    status: "pending",
    reviewToken: generateToken(),
    reviewSentAt: null,
    createdAt: new Date().toISOString(),
  };

  db.get("bookings").push(booking).write();
  console.log(`✓ Booking request: ${booking.id} (${booking.shortId}) — ${customerName} for ${service.name} on ${date} at ${time}`);

  try { await sendOwnerRequest(booking); console.log(`✓ Owner request sent → ${OWNER_PHONE}`); }
  catch (err) { console.error(`✗ Owner request failed:`, err.message); }

  res.json({
    success: true,
    bookingId: booking.id,
    booking: { id: booking.id, serviceName: booking.serviceName, date, time, price: booking.servicePrice, customerName },
  });
});

// Twilio webhook — handles owner and customer replies
app.post("/api/sms-webhook", async (req, res) => {
  const from = req.body.From;
  const bodyRaw = (req.body.Body || "").trim();
  const body = bodyRaw.toUpperCase();

  const ownerNormalized = (OWNER_PHONE || "").replace(/[^0-9]/g, "");
  const fromNormalized = (from || "").replace(/[^0-9]/g, "");
  const isOwner = ownerNormalized && fromNormalized.endsWith(ownerNormalized.slice(-10));

  if (isOwner) {
    // Check for a pending booking to act on (most recent)
    const pendingBooking = db.get("bookings")
      .filter({ status: "pending" })
      .sortBy("createdAt")
      .last()
      .value();

    // Check for a booking awaiting offer suggestion
    const awaitingOffer = db.get("bookings")
      .filter({ status: "denied_awaiting_offer" })
      .sortBy("createdAt")
      .last()
      .value();

    // Date+time suggestion: MM/DD HH:MM (e.g. "03/29 19:00")
    const dateTimeMatch = bodyRaw.match(/^(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/);

    if (body === "YES") {
      if (pendingBooking) {
        db.get("bookings").find({ id: pendingBooking.id }).assign({ status: "confirmed" }).write();
        try { await sendCustomerConfirmation(pendingBooking); console.log(`✓ Confirmed → ${pendingBooking.customerName}`); }
        catch (err) { console.error(`✗ Confirmation SMS failed:`, err.message); }
      }
    } else if (body === "NO") {
      if (pendingBooking) {
        db.get("bookings").find({ id: pendingBooking.id }).assign({ status: "denied_awaiting_offer" }).write();
        try {
          await twilioClient.messages.create({
            body: `Declined ${pendingBooking.customerName}. Want to suggest a new time?\n\nReply with date and time like:\n03/29 19:00\n\nOr reply SKIP to send them a rebook link.`,
            from: TWILIO_PHONE_NUMBER,
            to: OWNER_PHONE,
          });
          console.log(`✓ Denied, prompted owner for suggestion`);
        } catch (err) { console.error(`✗ Owner suggest prompt failed:`, err.message); }
      }
    } else if (body === "SKIP") {
      if (awaitingOffer) {
        db.get("bookings").find({ id: awaitingOffer.id }).assign({ status: "denied" }).write();
        try { await sendCustomerDenied(awaitingOffer); console.log(`✓ Rebook link sent to ${awaitingOffer.customerName}`); }
        catch (err) { console.error(`✗ Rebook SMS failed:`, err.message); }
      }
    } else if (dateTimeMatch && awaitingOffer) {
      const now = new Date();
      const month = dateTimeMatch[1].padStart(2, "0");
      const day = dateTimeMatch[2].padStart(2, "0");
      const hour = dateTimeMatch[3].padStart(2, "0");
      const min = dateTimeMatch[4];
      const year = now.getFullYear();
      const suggestedDate = `${year}-${month}-${day}`;
      const suggestedTime = `${hour}:${min}`;
      db.get("bookings").find({ id: awaitingOffer.id }).assign({ status: "offer_sent", suggestedDate, suggestedTime }).write();
      try { await sendCustomerOffer(awaitingOffer, suggestedDate, suggestedTime); console.log(`✓ Offer sent to ${awaitingOffer.customerName}`); }
      catch (err) { console.error(`✗ Offer SMS failed:`, err.message); }
    }
  } else {
    // Customer reply to an offer — YES or NO
    const fromNorm = (from || "").replace(/[^0-9]/g, "");
    const allOffers = db.get("bookings").filter(b => b.status === "offer_sent").value();
    const offerBooking = allOffers.find(b => (b.phone || "").replace(/[^0-9]/g, "").endsWith(fromNorm.slice(-10)));

    if (offerBooking) {
      if (body === "YES") {
        const taken = db.get("bookings")
          .find(b => b.date === offerBooking.suggestedDate && b.time === offerBooking.suggestedTime
            && b.status !== "cancelled" && b.status !== "denied" && b.id !== offerBooking.id)
          .value();
        if (taken) {
          db.get("bookings").find({ id: offerBooking.id }).assign({ status: "denied" }).write();
          try {
            await twilioClient.messages.create({
              body: `Sorry ${offerBooking.customerName}, that time just got taken. Please choose a new time: https://skidocyyc.ca/book`,
              from: TWILIO_PHONE_NUMBER,
              to: offerBooking.phone,
            });
          } catch (err) { console.error(err.message); }
        } else {
          db.get("bookings").find({ id: offerBooking.id }).assign({
            status: "confirmed",
            date: offerBooking.suggestedDate,
            time: offerBooking.suggestedTime,
          }).write();
          const updated = db.get("bookings").find({ id: offerBooking.id }).value();
          try { await sendCustomerConfirmation(updated); console.log(`✓ Offer accepted by ${offerBooking.customerName}`); }
          catch (err) { console.error(err.message); }
        }
      } else if (body === "NO") {
        db.get("bookings").find({ id: offerBooking.id }).assign({ status: "denied" }).write();
        try { await sendCustomerDenied(offerBooking); console.log(`✓ Offer declined by ${offerBooking.customerName}`); }
        catch (err) { console.error(err.message); }
      }
    }
  }

  res.set("Content-Type", "text/xml").send("<Response></Response>");
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

// Review SMS fires 2 minutes after appointment time
cron.schedule("* * * * *", async () => {
  const now = new Date();
  const pending = db.get("bookings").filter(b => {
    if (b.status !== "confirmed" || b.reviewSentAt) return false;
    const appointmentTime = new Date(`${b.date}T${b.time}:00`);
    const minutesAfter = (now - appointmentTime) / (1000 * 60);
    return minutesAfter >= 2 && minutesAfter < 3;
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
