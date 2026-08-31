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
db.defaults({ bookings: [], feedback: [], walkins: [] }).write();

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

// Calgary wall-clock "now" as a naive Date, so comparisons against naive
// date/time strings (which are always Calgary-local) stay correct regardless
// of the server's own timezone (Render runs UTC) and DST.
function getCalgaryNow() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Edmonton', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return new Date(`${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`);
}

function locationLabel(location, address) {
  if (location === 'mobile') return `Mobile — ${address}`;
  const loc = LOCATIONS.find((l) => l.id === location);
  return loc ? loc.name : location;
}

// SMS to owner — approve or deny request
async function sendOwnerRequest(booking) {
  if (!twilioClient || !OWNER_PHONE) { console.log(`[SMS SKIPPED] Owner request`); return; }
  const where = locationLabel(booking.location, booking.address);
  await twilioClient.messages.create({
    body: `New booking request!\n${booking.customerName} wants ${booking.serviceName}\nWhere: ${where}\n${booking.date} at ${formatTime(booking.time)}\nPhone: ${booking.phone}\n\nReply YES to confirm or NO to decline.`,
    from: TWILIO_PHONE_NUMBER,
    to: OWNER_PHONE,
  });
}

// SMS to customer — booking confirmed
async function sendCustomerConfirmation(booking) {
  if (!twilioClient) { console.log(`[SMS SKIPPED] Confirmation for ${booking.customerName}`); return; }
  const where = locationLabel(booking.location, booking.address);
  await twilioClient.messages.create({
    body: `Hi ${booking.customerName}! Your booking is confirmed at ${BUSINESS_NAME}. ${booking.serviceName} on ${booking.date} at ${formatTime(booking.time)} — ${where}. See you then!`,
    from: TWILIO_PHONE_NUMBER,
    to: booking.phone,
  });
  if (OWNER_PHONE) {
    await twilioClient.messages.create({
      body: `✓ Confirmed: ${booking.customerName} — ${booking.serviceName} on ${booking.date} at ${formatTime(booking.time)}`,
      from: TWILIO_PHONE_NUMBER,
      to: OWNER_PHONE,
    });
  }
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
    body: `Hi ${booking.customerName}! Unfortunately the time you requested isn't available. Would ${suggestedDate} at ${formatTime(suggestedTime)} work for you instead?\n\nReply YES to confirm or NO to decline.`,
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
  { id: "performance-race-tune", name: "Performance Race Tune", price: 85, category: "package", description: "Full ceramic disc edge sharpening finished to an extra-fine edge, hand-ironed race wax, base and side edges set to the perfect angle." },
  { id: "seasonal-tune", name: "Seasonal Tune", price: 70, category: "package", description: "Ceramic disc edge sharpening, hand-ironed wax, stone base grind, and base repairs included." },
  { id: "maintenance-tune", name: "Maintenance Tune", price: 60, category: "package", description: "Ceramic disc edge sharpening, an infrared hot wax, and minor base repairs." },
  { id: "waxing-sharpening", name: "Waxing & Sharpening", price: 55, category: "single", description: "Infrared hot base wax and ceramic disc edge sharpening to keep your gear in shape." },
  { id: "infrared-hot-wax", name: "Infrared Hot Wax", price: 25, category: "single", description: "A simple maintenance wax to keep your gear smooth and gliding." },
  { id: "hand-iron-wax", name: "Hand Iron Wax", price: 35, category: "single", description: "Full hand waxing, ironed and melted into the base for the best possible finish." },
  { id: "ceramic-disc-edge-sharpening", name: "Ceramic Disc Edge Sharpening", price: 30, category: "single", description: "Done with a spinning ceramic disc to keep your edges clean, sharp, and in the best condition." },
  { id: "ptex-base-repair", name: "P-Tex Base Repair", price: 15, category: "single", fromPrice: true, description: "Repairs base damage and core shots to protect your gear and extend its life." },
  { id: "binding-adjustment", name: "Binding Adjustment", price: 15, category: "single", fromPrice: true, description: "Professional adjustment for proper fit, function, and safe release." },
];

const MOBILE_SURCHARGE = 10;

const LOCATIONS = [
  { id: "location-a", name: "Location A", address: "26 Val Gardena View SW, Calgary, AB T3H 5Z5" },
  { id: "location-b", name: "Test Location", address: "Patina Dr SW, Calgary, AB" },
];

app.get("/api/services", (req, res) => res.json({ services: SERVICES, mobileSurcharge: MOBILE_SURCHARGE }));
app.get("/api/locations", (req, res) => res.json(LOCATIONS));

// Shared slot-window rules: weekdays are one window, Sat/Sun another;
// mobile uses 2-hour increments, in-shop locations use 30-minute increments.
function getWindow(dayOfWeek, isMobile) {
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  if (isMobile) {
    return isWeekend
      ? { startMin: 10 * 60, endMin: 22 * 60, stepMin: 120 }  // 10 AM–10 PM
      : { startMin: 17 * 60, endMin: 21 * 60, stepMin: 120 }; // 5, 7, 9 PM
  }
  return isWeekend
    ? { startMin: 10 * 60, endMin: 22 * 60, stepMin: 30 }  // 10 AM–10 PM
    : { startMin: 17 * 60, endMin: 23 * 60, stepMin: 30 }; // 5 PM–11 PM
}

function isValidLocation(location) {
  return location === "mobile" || LOCATIONS.some((l) => l.id === location);
}

// Returns [{time, status}] for a date+location, applying the 1-hour advance cutoff.
function computeSlots(date, location) {
  const [year, month, day] = date.split('-').map(Number);
  const dayOfWeek = new Date(year, month - 1, day).getDay();
  const isMobile = location === "mobile";
  const { startMin, endMin, stepMin } = getWindow(dayOfWeek, isMobile);

  const calNow = getCalgaryNow();
  const oneHourFromNow = new Date(calNow.getTime() + 60 * 60 * 1000);
  const todayStr = `${calNow.getFullYear()}-${String(calNow.getMonth() + 1).padStart(2, '0')}-${String(calNow.getDate()).padStart(2, '0')}`;

  const booked = db.get("bookings")
    .filter((b) => b.date === date && b.location === location && b.status !== "cancelled" && b.status !== "denied")
    .map((b) => b.time)
    .value();

  const slots = [];
  for (let mins = startMin; mins <= endMin; mins += stepMin) {
    const h = Math.floor(mins / 60), m = mins % 60;
    const timeStr = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
    if (date === todayStr) {
      const slotTime = new Date(`${date}T${timeStr}:00`);
      if (slotTime < oneHourFromNow) continue;
    }
    slots.push({ time: timeStr, status: booked.includes(timeStr) ? 'booked' : 'available' });
  }
  return slots;
}

app.get("/api/availability", (req, res) => {
  const { date, location } = req.query;
  if (!date || !location) return res.status(400).json({ error: "date and location required" });
  if (!isValidLocation(location)) return res.status(400).json({ error: "invalid location" });
  res.json({ date, location, slots: computeSlots(date, location) });
});

app.post("/api/bookings", async (req, res) => {
  const { location, address, items, date, time, customerName, email, notes } = req.body;
  let phone = (req.body.phone || "").toString().replace(/[^0-9+]/g, "");
  if (phone.length === 10) phone = "+1" + phone;
  else if (phone.length === 11 && phone[0] === "1") phone = "+" + phone;
  else if (phone.length > 0 && !phone.startsWith("+")) phone = "+" + phone;

  if (!location || !isValidLocation(location))
    return res.status(400).json({ error: "Select a valid location" });
  const isMobile = location === "mobile";
  if (isMobile && !(address || "").trim())
    return res.status(400).json({ error: "Address is required for mobile service" });
  if (!Array.isArray(items) || !items.length)
    return res.status(400).json({ error: "Select at least one service" });
  if (!date || !time || !customerName || !phone)
    return res.status(400).json({ error: "Missing required fields" });

  // Resolve services & prices server-side — never trust client-submitted prices.
  const resolvedItems = [];
  for (const it of items) {
    const svc = SERVICES.find((s) => s.id === it.serviceId);
    if (!svc) return res.status(400).json({ error: `Unknown service: ${it.serviceId}` });
    const qty = Math.max(1, Math.min(10, Number(it.qty) || 1));
    const unitPrice = svc.price + (isMobile ? MOBILE_SURCHARGE : 0);
    resolvedItems.push({ serviceId: svc.id, serviceName: svc.name, unitPrice, qty });
  }
  const totalPrice = resolvedItems.reduce((sum, i) => sum + i.unitPrice * i.qty, 0);

  // The requested slot must actually be one we currently offer (window + not already past cutoff).
  const offeredSlot = computeSlots(date, location).find((s) => s.time === time);
  if (!offeredSlot) return res.status(400).json({ error: "That time is no longer available" });
  if (offeredSlot.status === "booked") return res.status(409).json({ error: "Slot already booked" });

  const booking = {
    id: `SKI-${Date.now()}`,
    shortId: generateShortId(),
    location,
    address: isMobile ? address.trim() : null,
    items: resolvedItems,
    serviceName: resolvedItems.map((i) => `${i.serviceName}${i.qty > 1 ? ` x${i.qty}` : ''}`).join(', '),
    servicePrice: totalPrice,
    date, time, customerName, phone,
    email: email || null, notes: notes || null,
    status: "pending",
    reviewToken: generateToken(),
    reviewSentAt: null,
    createdAt: new Date().toISOString(),
  };
  booking.locationName = locationLabel(booking.location, booking.address);

  db.get("bookings").push(booking).write();
  console.log(`✓ Booking request: ${booking.id} (${booking.shortId}) — ${customerName} for ${booking.serviceName} on ${date} at ${time} @ ${booking.locationName}`);

  try { await sendOwnerRequest(booking); console.log(`✓ Owner request sent → ${OWNER_PHONE}`); }
  catch (err) { console.error(`✗ Owner request failed:`, err.message); }

  res.json({
    success: true,
    bookingId: booking.id,
    booking: {
      id: booking.id, serviceName: booking.serviceName, date, time,
      price: booking.servicePrice, customerName,
      locationName: booking.locationName, address: booking.address,
    },
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
            && b.location === offerBooking.location
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
        try {
          await twilioClient.messages.create({
            body: `No problem ${offerBooking.customerName}! Give us a call at 825-521-2075 and we'll find a time that works for you.`,
            from: TWILIO_PHONE_NUMBER,
            to: offerBooking.phone,
          });
          console.log(`✓ Call prompt sent to ${offerBooking.customerName}`);
        } catch (err) { console.error(err.message); }
      }
    }
  }

  res.set("Content-Type", "text/xml").send("<Response></Response>");
});

// Walk-in customers (manual review follow-up)
app.post("/api/walkins", async (req, res) => {
  const { customerName, serviceName } = req.body;
  let phone = (req.body.phone || "").toString().replace(/[^0-9+]/g, "");
  if (phone.length === 10) phone = "+1" + phone;
  else if (phone.length === 11 && phone[0] === "1") phone = "+" + phone;
  else if (phone.length > 0 && !phone.startsWith("+")) phone = "+" + phone;
  if (!customerName || !phone) return res.status(400).json({ error: "Name and phone required" });
  const walkin = {
    id: `WK-${Date.now()}`, customerName, phone,
    serviceName: serviceName || "Service",
    reviewToken: crypto.randomBytes(16).toString("hex"),
    reviewSentAt: null, createdAt: new Date().toISOString(),
  };
  db.get("walkins").push(walkin).write();
  console.log(`✓ Walk-in added: ${customerName}`);
  res.json({ success: true, id: walkin.id });
});

app.get("/api/walkins", (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
  res.json(db.get("walkins").value().reverse());
});

app.get("/api/bookings", (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
  res.json(db.get("bookings").value().reverse());
});

app.post("/api/review", (req, res) => {
  const { token, rating, comment } = req.body;
  if (!token || !rating) return res.status(400).json({ error: "token and rating required" });
  const booking = db.get("bookings").find({ reviewToken: token }).value();
  const walkin  = !booking ? db.get("walkins").find({ reviewToken: token }).value() : null;
  const record  = booking || walkin;
  if (!record) return res.status(404).json({ error: "Invalid token" });
  db.get("feedback").push({
    id: Date.now(), sourceId: record.id,
    customerName: record.customerName, serviceName: record.serviceName,
    rating: Number(rating), comment: comment || null,
    submittedAt: new Date().toISOString(),
  }).write();
  res.json({ success: true, redirectToGoogle: Number(rating) >= 4 });
});

app.get("/api/review/:token", (req, res) => {
  const booking = db.get("bookings").find({ reviewToken: req.params.token }).value();
  const walkin  = !booking ? db.get("walkins").find({ reviewToken: req.params.token }).value() : null;
  const record  = booking || walkin;
  if (!record) return res.status(404).json({ error: "Not found" });
  const alreadyReviewed = db.get("feedback").find({ sourceId: record.id }).value();
  res.json({ customerName: record.customerName, serviceName: record.serviceName, date: record.date || null, alreadyReviewed: !!alreadyReviewed });
});

app.get("/api/feedback", (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
  res.json(db.get("feedback").value().reverse());
});

// Danger zone — wipes all bookings, walk-ins, and feedback. Irreversible.
app.post("/api/wipe-data", (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
  db.set("bookings", []).write();
  db.set("walkins", []).write();
  db.set("feedback", []).write();
  console.log(`⚠ All data wiped by admin`);
  res.json({ success: true });
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

// Review SMS cron — bookings + walk-ins
cron.schedule("* * * * *", async () => {
  if (process.env.REVIEWS_PAUSED === "true") { console.log("[PAUSED] Review SMS skipped"); return; }
  const now = new Date();

  // Confirmed bookings — fires 24h after appointment
  const pendingBookings = db.get("bookings").filter(b => {
    if (b.status !== "confirmed" || b.reviewSentAt) return false;
    const apptTime = new Date(`${b.date}T${b.time}:00-06:00`);
    return (now - apptTime) / (1000 * 60) >= 1440;
  }).value();
  for (const b of pendingBookings) {
    try {
      await sendReviewSMS(b);
      db.get("bookings").find({ id: b.id }).assign({ reviewSentAt: now.toISOString() }).write();
      console.log(`✓ Review SMS → ${b.customerName} (booking)`);
    } catch (err) { console.error(`✗ Review SMS failed:`, err.message); }
  }

  // Walk-ins — fires 24h after added
  const pendingWalkins = db.get("walkins").filter(w => {
    if (w.reviewSentAt) return false;
    return (now - new Date(w.createdAt)) / (1000 * 60) >= 1440;
  }).value();
  for (const w of pendingWalkins) {
    try {
      if (twilioClient) {
        await twilioClient.messages.create({
          body: `Hi ${w.customerName}! How was your experience at ${BUSINESS_NAME}? Takes 20 seconds: ${BASE_URL}/review?token=${w.reviewToken}`,
          from: TWILIO_PHONE_NUMBER, to: w.phone,
        });
      }
      db.get("walkins").find({ id: w.id }).assign({ reviewSentAt: now.toISOString() }).write();
      console.log(`✓ Review SMS → ${w.customerName} (walk-in)`);
    } catch (err) { console.error(`✗ Review SMS failed:`, err.message); }
  }
});

app.listen(PORT, () => {
  console.log(`\n🏔  Ski Doc Calgary — Booking System`);
  console.log(`   Booking page: http://localhost:${PORT}`);
  console.log(`   Dashboard:    http://localhost:${PORT}/dashboard`);
  console.log(`   Password:     ${ADMIN_PASSWORD}\n`);
});
