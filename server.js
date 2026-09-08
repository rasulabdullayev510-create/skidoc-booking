const express = require("express");
const low = require("lowdb");
const FileSync = require("lowdb/adapters/FileSync");
const twilio = require("twilio");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const cron = require("node-cron");
const cors = require("cors");

require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Health check — set this as Render's Health Check Path so it waits for
// the new instance to actually be ready before cutting traffic over,
// instead of the brief 502 window during a deploy.
app.get("/healthz", (req, res) => res.status(200).send("ok"));

// DATA_DIR points at Render's persistent disk mount (set via env var) so
// db.json survives redeploys instead of resetting to defaults every time.
// Falls back to the project directory for local dev, where there's no disk.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const adapter = new FileSync(path.join(DATA_DIR, "db.json"));
const db = low(adapter);
db.defaults({
  bookings: [], feedback: [], expenses: [], blocked: [], pageViews: [],
  siteConfig: {
    businessName: "Ski Doc Calgary",
    phone: "(825) 521-2075",
    email: "skidocyyc@gmail.com",
    socials: {
      instagram: "https://www.instagram.com/skidocyyc",
      facebook: "https://www.facebook.com/profile.php?id=61582680415253",
      google: "https://share.google/zg5XRvdmsyLY3mBix",
    },
    // 4-5 star review-page taps redirect here. Plain Maps listing link —
    // loads with a clean 200 and no forced sign-in wall, unlike the
    // writereview endpoint which was producing raw browser errors on some
    // phones straight from the SMS link.
    googleReviewUrl: "https://www.google.com/maps/place/?q=place_id:ChIJrc_l_1JtcVMRuDKC4pHaFrY",
    hero: {
      headline: "Trust Your Turn",
      subtitle: "Fast, affordable, and expert ski & snowboard tuning to keep your gear in peak condition.",
    },
    mobilePage: {
      headline: "Your Ski Shop On Wheels",
      description: "Sit back and bring the shop to your location with the click of a button. No waiting in line, no round trip, no wasted time — same precision tuning, wherever you are in Calgary.",
    },
    kidsDiscountText: "🧒 Kids' equipment discounts apply — just ask when you book.",
    mobileEnabled: true,
    mobileSurcharge: 10,
    locations: [
      { id: "location-a", name: "Location A", address: "26 Val Gardena View SW, Calgary, AB T3H 5Z5", enabled: true },
      { id: "location-b", name: "Test Location", address: "Patina Dr SW, Calgary, AB", enabled: true },
    ],
    services: [
      { id: "performance-race-tune", name: "Performance Race Tune", price: 85, category: "package", description: "Full ceramic disc edge sharpening finished to an extra-fine edge, hand-ironed race wax, base and side edges set to the perfect angle." },
      { id: "seasonal-tune", name: "Seasonal Tune", price: 70, category: "package", description: "Ceramic disc edge sharpening, hand-ironed wax, base edge inspection and touch up, and minor base repairs included." },
      { id: "maintenance-tune", name: "Maintenance Tune", price: 60, category: "package", description: "Ceramic disc edge sharpening, an infrared hot wax, and minor base repairs." },
      { id: "waxing-sharpening", name: "Waxing & Sharpening", price: 55, category: "single", description: "Infrared hot base wax and ceramic disc edge sharpening to keep your gear in shape." },
      { id: "infrared-hot-wax", name: "Infrared Hot Wax", price: 25, category: "single", description: "A simple maintenance wax to keep your gear smooth and gliding." },
      { id: "hand-iron-wax", name: "Hand Iron Wax", price: 35, category: "single", description: "Full hand waxing, ironed and melted into the base for the best possible finish." },
      { id: "ceramic-disc-edge-sharpening", name: "Ceramic Disc Edge Sharpening", price: 30, category: "single", description: "Done with a spinning ceramic disc to keep your edges clean, sharp, and in the best condition." },
      { id: "ptex-base-repair", name: "P-Tex Base Repair", price: 15, category: "single", fromPrice: true, description: "Repairs base damage and core shots to protect your gear and extend its life." },
      { id: "binding-adjustment", name: "Binding Adjustment", price: 15, category: "single", fromPrice: true, description: "Professional adjustment for proper fit, function, and safe release." },
    ],
  },
}).write();

// db.defaults() only fills in siteConfig if the whole key is missing — once
// the persistent disk keeps real data across deploys, a field added here
// later never reaches an already-existing siteConfig. Backfill those explicitly.
(function backfillSiteConfig() {
  const cfg = db.get("siteConfig").value() || {};
  const staleLinks = [
    undefined,
    "https://g.page/r/CbgyguKR2ha2EAE/review",
    "https://search.google.com/local/writereview?placeid=ChIJrc_l_1JtcVMRuDKC4pHaFrY",
  ];
  if (staleLinks.includes(cfg.googleReviewUrl)) {
    db.set("siteConfig.googleReviewUrl", "https://www.google.com/maps/place/?q=place_id:ChIJrc_l_1JtcVMRuDKC4pHaFrY").write();
  }
})();

function getConfig() { return db.get("siteConfig").value(); }
function getServices() { return getConfig().services; }
function getLocations() { return getConfig().locations; }
function getEnabledLocations() { return getLocations().filter((l) => l.enabled !== false); }
function getMobileSurcharge() { return getConfig().mobileSurcharge; }
function isMobileEnabled() { return getConfig().mobileEnabled !== false; }
function bizName() { return getConfig().businessName || BUSINESS_NAME; }
function bizPhone() { return getConfig().phone || ""; }

const {
  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER,
  PORT = 3004,
  BUSINESS_NAME = "Ski Doc Calgary",
  ADMIN_PASSWORD = "skidoc2024",
  OWNER_PHONE,
} = process.env;
// `|| ` (not a destructuring default) so an env var left blank on Render
// still falls back instead of silently producing a link with no domain.
const BASE_URL = process.env.BASE_URL || "http://localhost:3004";

const twilioClient = TWILIO_ACCOUNT_SID ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

function generateToken() { return crypto.randomBytes(16).toString("hex"); }
function generateShortId() { return crypto.randomBytes(3).toString("hex").toUpperCase(); }
function getSurveyUrl(token) { return `${BASE_URL}/review?token=${token}`; }

function formatTime(t) {
  const [h, m] = t.split(':');
  const hr = parseInt(h);
  return `${hr > 12 ? hr - 12 : hr || 12}:${m} ${hr >= 12 ? 'PM' : 'AM'}`;
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function formatDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${d}, ${y}`;
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
  const loc = getLocations().find((l) => l.id === location);
  return loc ? loc.name : location;
}

// Customer-facing: always the actual address, since that's what they need
// to get there — mobile bookings get their own address plus a note that
// it's a door-to-door appointment.
function customerLocationLine(booking) {
  if (booking.location === 'mobile') return `${booking.address} (done at your door)`;
  const loc = getLocations().find((l) => l.id === booking.location);
  return loc ? loc.address : booking.location;
}
// Owner-facing: just the location name — they already know the addresses.
function ownerLocationLine(booking) {
  // Mobile jobs need the actual address so the owner knows where to drive —
  // in-shop bookings just need the name since the owner already knows those.
  if (booking.location === 'mobile') return `Mobile — ${booking.address}`;
  const loc = getLocations().find((l) => l.id === booking.location);
  return loc ? loc.name : booking.location;
}

// SMS to customer — booking confirmed. Also notifies the owner, since
// bookings auto-confirm the moment a customer books (no approval step).
async function sendCustomerConfirmation(booking) {
  if (!twilioClient) { console.log(`[SMS SKIPPED] Confirmation for ${booking.customerName}`); return; }
  await twilioClient.messages.create({
    body: `Hi ${booking.customerName}! Your booking is confirmed at ${bizName()}. ${booking.serviceName} on ${formatDate(booking.date)} at ${formatTime(booking.time)} — ${customerLocationLine(booking)}. See you then!`,
    from: TWILIO_PHONE_NUMBER,
    to: booking.phone,
  });
  if (OWNER_PHONE) {
    const notesLine = booking.notes ? `\nNotes: ${booking.notes}` : "";
    const emailLine = booking.email ? `\nEmail: ${booking.email}` : "";
    await twilioClient.messages.create({
      body: `New booking! ${booking.customerName} — ${booking.serviceName}\nWhere: ${ownerLocationLine(booking)}\n${formatDate(booking.date)} at ${formatTime(booking.time)}\nPhone: ${booking.phone}${emailLine}${notesLine}`,
      from: TWILIO_PHONE_NUMBER,
      to: OWNER_PHONE,
    });
  }
}

// SMS to customer — booking denied, rebook link
async function sendCustomerDenied(booking) {
  if (!twilioClient) { console.log(`[SMS SKIPPED] Denial for ${booking.customerName}`); return; }
  await twilioClient.messages.create({
    body: `Hi ${booking.customerName}, unfortunately that time is no longer available at ${bizName()}. Please choose another time: https://skidocyyc.ca/book`,
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
    body: `Hi ${booking.customerName}! How was your experience at ${bizName()}? Your feedback helps us out tremendously.\n\nTap to rate (20 sec): ${getSurveyUrl(booking.reviewToken)}`,
    from: TWILIO_PHONE_NUMBER,
    to: booking.phone,
  });
}

// SMS to a past customer — invite them back
async function sendWinbackSMS(phone, name) {
  if (!twilioClient) { console.log(`[SMS SKIPPED] Winback for ${name}`); return; }
  const phoneLine = bizPhone() ? `\nCall/text: ${bizPhone()}` : '';
  await twilioClient.messages.create({
    body: `Hi ${name}, it's been a while since your last tune at Ski Doc, let's get your gear back in peak condition before your next day out.\n\nBook online: https://skidocyyc.ca/book${phoneLine}\n\nSee you soon!`,
    from: TWILIO_PHONE_NUMBER,
    to: phone,
  });
}

app.get("/api/services", (req, res) => res.json({ services: getServices(), mobileSurcharge: getMobileSurcharge(), mobileEnabled: isMobileEnabled() }));
app.get("/api/locations", (req, res) => res.json(req.query.all ? getLocations() : getEnabledLocations()));
app.get("/api/info", (req, res) => res.json({ businessName: bizName() }));
app.get("/api/site-config", (req, res) => res.json(getConfig()));

// Last 10 digits, so "+18255212075", "8255212075", and "18255212075" all match.
function canonicalPhone(phone) {
  const digits = (phone || "").toString().replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

// Returning-customer check for the booking form's "welcome back" greeting.
// Matches on name + phone against past bookings.
app.get("/api/customer-check", (req, res) => {
  const rawName = (req.query.name || "").toString().trim();
  const phone = canonicalPhone(req.query.phone);
  if (!rawName || !phone) return res.json({ recognized: false });

  const nameLower = rawName.toLowerCase();
  const match = db.get("bookings").value()
    .find((c) => canonicalPhone(c.phone) === phone && (c.customerName || "").trim().toLowerCase() === nameLower);
  res.json({ recognized: !!match, name: match ? match.customerName : null });
});

app.put("/api/site-config", (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
  const current = getConfig();
  const updated = { ...current, ...req.body };
  // Nested objects merge field-by-field so a partial update doesn't wipe siblings.
  ["hero", "socials", "mobilePage"].forEach((k) => {
    if (req.body[k]) updated[k] = { ...current[k], ...req.body[k] };
  });
  db.set("siteConfig", updated).write();
  console.log(`✓ Site config updated by admin`);
  res.json({ success: true, siteConfig: updated });
});

// AI assistant — scoped strictly to proposing edits to siteConfig. It never
// applies anything itself; it returns a proposed patch for the admin to
// review and confirm (which then goes through the normal PUT above).
const { ANTHROPIC_API_KEY, ANTHROPIC_MODEL = "claude-sonnet-5" } = process.env;

app.post("/api/ai-assist", async (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
  if (!ANTHROPIC_API_KEY) return res.status(400).json({ error: "AI assistant not configured — add ANTHROPIC_API_KEY in Render's environment variables." });
  const { message } = req.body;
  if (!(message || "").trim()) return res.status(400).json({ error: "message required" });

  const config = getConfig();
  const systemPrompt = `You help edit a ski tuning shop's website and booking content. You may ONLY propose changes to fields that already exist in the JSON config object below — never invent new fields or change its structure/types.

Respond with ONLY a raw JSON object (no markdown, no code fences) with exactly two keys:
- "explanation": a short, friendly, plain-English summary of what you'd change and why (or, if the request isn't about editing this config, an explanation of that).
- "patch": an object containing ONLY the fields that should change, in the same shape as the config below (nested objects like "hero", "socials", "mobilePage" should include only their changed sub-fields; "services" and "locations", if changed, should be the FULL replacement array). If nothing should change, use {}.

Current config:
${JSON.stringify(config, null, 2)}`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: "user", content: message }],
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: data.error?.message || "AI request failed" });
    const text = (data.content || []).map((c) => c.text || "").join("");
    let parsed = null;
    try { parsed = JSON.parse(text); }
    catch (e) {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) { try { parsed = JSON.parse(match[0]); } catch (e2) {} }
    }
    if (!parsed) return res.status(502).json({ error: "Could not understand the AI's response — try rephrasing." });
    res.json({ success: true, explanation: parsed.explanation || "", patch: parsed.patch || {} });
  } catch (err) {
    console.error(`✗ AI assist failed:`, err.message);
    res.status(500).json({ error: "AI request failed" });
  }
});

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
  if (location === "mobile") return isMobileEnabled();
  return getEnabledLocations().some((l) => l.id === location);
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

  // Blocked entries with location:null are "master" blocks that apply to every
  // location and mobile; entries with a location only apply to that one.
  const blockedForDay = db.get("blocked").filter((b) => b.date === date && (b.location == null || b.location === location)).value();
  const wholeDayBlocked = blockedForDay.some((b) => !b.time);
  const blockedTimes = new Set(blockedForDay.filter((b) => b.time).map((b) => b.time));

  const slots = [];
  for (let mins = startMin; mins <= endMin; mins += stepMin) {
    const h = Math.floor(mins / 60), m = mins % 60;
    const timeStr = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
    if (date === todayStr) {
      const slotTime = new Date(`${date}T${timeStr}:00`);
      if (slotTime < oneHourFromNow) continue;
    }
    const status = booked.includes(timeStr) ? 'booked'
      : (wholeDayBlocked || blockedTimes.has(timeStr)) ? 'blocked'
      : 'available';
    slots.push({ time: timeStr, status });
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
  if (!date || !time || !customerName || !phone || !(email || "").trim())
    return res.status(400).json({ error: "Missing required fields" });
  if (!/^\S+@\S+\.\S+$/.test(email.trim()))
    return res.status(400).json({ error: "Enter a valid email address" });

  // Resolve services & prices server-side — never trust client-submitted prices.
  const resolvedItems = [];
  for (const it of items) {
    const svc = getServices().find((s) => s.id === it.serviceId);
    if (!svc) return res.status(400).json({ error: `Unknown service: ${it.serviceId}` });
    const qty = Math.max(1, Math.min(10, Number(it.qty) || 1));
    const unitPrice = svc.price + (isMobile ? getMobileSurcharge() : 0);
    resolvedItems.push({ serviceId: svc.id, serviceName: svc.name, unitPrice, qty });
  }
  const totalPrice = resolvedItems.reduce((sum, i) => sum + i.unitPrice * i.qty, 0);

  // The requested slot must actually be one we currently offer (window + not already past cutoff).
  const offeredSlot = computeSlots(date, location).find((s) => s.time === time);
  if (!offeredSlot) return res.status(400).json({ error: "That time is no longer available" });
  if (offeredSlot.status !== "available") return res.status(409).json({ error: "Slot already booked" });

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
    status: "confirmed",
    reviewToken: generateToken(),
    reviewSentAt: null,
    createdAt: new Date().toISOString(),
  };
  booking.locationName = locationLabel(booking.location, booking.address);

  db.get("bookings").push(booking).write();
  console.log(`✓ Booking confirmed: ${booking.id} (${booking.shortId}) — ${customerName} for ${booking.serviceName} on ${date} at ${time} @ ${booking.locationName}`);

  try { await sendCustomerConfirmation(booking); console.log(`✓ Confirmation sent → ${customerName}`); }
  catch (err) { console.error(`✗ Confirmation SMS failed:`, err.message); }

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

app.get("/api/bookings", (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
  res.json(db.get("bookings").value().slice().reverse());
});

app.post("/api/review", (req, res) => {
  const { token, rating, comment } = req.body;
  if (!token || !rating) return res.status(400).json({ error: "token and rating required" });
  const record = db.get("bookings").find({ reviewToken: token }).value();
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
  const record = db.get("bookings").find({ reviewToken: req.params.token }).value();
  if (!record) return res.status(404).json({ error: "Not found" });
  const alreadyReviewed = db.get("feedback").find({ sourceId: record.id }).value();
  res.json({ customerName: record.customerName, serviceName: record.serviceName, date: record.date || null, alreadyReviewed: !!alreadyReviewed });
});

app.get("/api/feedback", (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
  res.json(db.get("feedback").value().slice().reverse());
});

// Danger zone — wipes all bookings and feedback. Irreversible.
app.post("/api/wipe-data", (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
  db.set("bookings", []).write();
  db.set("feedback", []).write();
  db.set("expenses", []).write();
  db.set("blocked", []).write();
  db.set("pageViews", []).write();
  console.log(`⚠ All data wiped by admin`);
  res.json({ success: true });
});

// ── Manual entry — log a phone/in-person booking directly as confirmed ──
app.post("/api/manual-entry", async (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
  const { customerName, items, date, notes, reviewDelayMinutes, location, address } = req.body;
  if (!customerName || !Array.isArray(items) || !items.length) return res.status(400).json({ error: "Name and at least one service required" });
  const isMobile = location === "mobile";
  if (isMobile && !(address || "").trim()) return res.status(400).json({ error: "Address is required for mobile" });
  if (!isMobile && !getLocations().some((l) => l.id === location)) return res.status(400).json({ error: "Select a valid location" });

  const resolvedItems = items
    .map((it) => ({
      name: (it.name || "").toString().trim(),
      price: Number(it.price) || 0,
      qty: Math.max(1, Math.min(10, Number(it.qty) || 1)),
    }))
    .filter((it) => it.name);
  if (!resolvedItems.length) return res.status(400).json({ error: "Name and at least one service required" });
  const serviceName = resolvedItems.map((i) => `${i.name}${i.qty > 1 ? ` x${i.qty}` : ""}`).join(", ");
  const servicePrice = resolvedItems.reduce((sum, i) => sum + i.price * i.qty, 0);

  let phone = (req.body.phone || "").toString().replace(/[^0-9+]/g, "");
  if (phone.length === 10) phone = "+1" + phone;
  else if (phone.length === 11 && phone[0] === "1") phone = "+" + phone;
  else if (phone.length > 0 && !phone.startsWith("+")) phone = "+" + phone;

  const bookingLocation = isMobile ? "mobile" : location;
  const booking = {
    id: `SKI-${Date.now()}`,
    shortId: generateShortId(),
    location: bookingLocation,
    locationName: locationLabel(bookingLocation, isMobile ? address.trim() : null),
    address: isMobile ? address.trim() : null,
    items: resolvedItems,
    serviceName, servicePrice,
    date: date || new Date().toISOString().split('T')[0], time: "00:00",
    customerName, phone: phone || null, email: null, notes: notes || null,
    status: "confirmed", source: "manual",
    reviewToken: generateToken(), reviewSentAt: null,
    reviewDelayMinutes: phone ? (Number.isFinite(Number(reviewDelayMinutes)) ? Number(reviewDelayMinutes) : 1440) : -1,
    createdAt: new Date().toISOString(),
  };
  db.get("bookings").push(booking).write();
  console.log(`✓ Manual entry logged: ${booking.id} — ${customerName} for ${serviceName}`);

  if (phone && booking.reviewDelayMinutes === 0) {
    try {
      await sendReviewSMS(booking);
      db.get("bookings").find({ id: booking.id }).assign({ reviewSentAt: new Date().toISOString() }).write();
    } catch (err) { console.error(`✗ Immediate review SMS failed:`, err.message); }
  }
  res.json({ success: true, bookingId: booking.id });
});

app.post("/api/bookings/:id/noshow", (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
  const booking = db.get("bookings").find({ id: req.params.id }).value();
  if (!booking) return res.status(404).json({ error: "Not found" });
  db.get("bookings").find({ id: req.params.id }).assign({ status: "noshow" }).write();
  res.json({ success: true });
});

app.post("/api/bookings/:id/tip", (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
  const amount = Number(req.body.amount);
  if (!amount || amount <= 0) return res.status(400).json({ error: "Invalid amount" });
  const booking = db.get("bookings").find({ id: req.params.id }).value();
  if (!booking) return res.status(404).json({ error: "Not found" });
  db.get("bookings").find({ id: req.params.id }).assign({ tipAmount: amount }).write();
  res.json({ success: true });
});

app.post("/api/winback", async (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
  const { phone, customerName } = req.body;
  if (!phone) return res.status(400).json({ error: "Phone required" });
  try { await sendWinbackSMS(phone, customerName || "there"); res.json({ success: true }); }
  catch (err) { console.error(`✗ Winback SMS failed:`, err.message); res.status(500).json({ error: "Failed to send" }); }
});

app.post("/api/send-review", async (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
  const { phone, customerName } = req.body;
  if (!phone) return res.status(400).json({ error: "Phone required" });
  const norm = phone.replace(/[^0-9]/g, "").slice(-10);
  const candidates = db.get("bookings").filter((b) => (b.phone || "").replace(/[^0-9]/g, "").endsWith(norm)).value();
  const latest = candidates.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  if (!latest) return res.status(404).json({ error: "No matching customer record" });
  try {
    await sendReviewSMS(latest);
    db.get("bookings").find({ id: latest.id }).assign({ reviewSentAt: new Date().toISOString() }).write();
    res.json({ success: true });
  } catch (err) { console.error(`✗ Manual review SMS failed:`, err.message); res.status(500).json({ error: "Failed to send" }); }
});

// ── Block times — each entry has an optional `location`. A null location
// is a "master" block applying to every location and mobile at once; a
// specific location (location-a / location-b / mobile) blocks just that one.
app.get("/api/blocked", (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
  res.json(db.get("blocked").value());
});

app.post("/api/blocked", (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
  const { date, time, location } = req.body;
  if (!date) return res.status(400).json({ error: "date required" });
  const loc = location || null;
  const exists = db.get("blocked").find((b) => b.date === date && (b.time || null) === (time || null) && (b.location || null) === loc).value();
  if (!exists) db.get("blocked").push({ date, time: time || null, location: loc }).write();
  res.json({ success: true });
});

app.delete("/api/blocked", (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
  const { date, time, location } = req.body;
  const loc = location || null;
  db.set("blocked", db.get("blocked").value().filter((b) => !(b.date === date && (b.time || null) === (time || null) && (b.location || null) === loc))).write();
  res.json({ success: true });
});

app.post("/api/blocked/range", (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
  const { date, startTime, endTime, location } = req.body;
  if (!date || !startTime || !endTime) return res.status(400).json({ error: "date, startTime, endTime required" });
  const loc = location || null;
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  const startMin = sh * 60 + sm, endMin = eh * 60 + em;
  if (startMin >= endMin) return res.status(400).json({ error: "startTime must be before endTime" });
  for (let mins = startMin; mins < endMin; mins += 30) {
    const h = Math.floor(mins / 60), m = mins % 60;
    const t = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
    const exists = db.get("blocked").find((b) => b.date === date && b.time === t && (b.location || null) === loc).value();
    if (!exists) db.get("blocked").push({ date, time: t, location: loc }).write();
  }
  res.json({ success: true });
});

// ── Expenses ─────────────────────────────────────────────────
app.get("/api/expenses", (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
  res.json(db.get("expenses").value().slice().reverse());
});

app.post("/api/expenses", (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
  const { description, category, amount, date } = req.body;
  if (!description || !amount) return res.status(400).json({ error: "description and amount required" });
  const expense = {
    id: `EXP-${Date.now()}`, description, category: category || "Other",
    amount: Number(amount), date: date || new Date().toISOString().split('T')[0],
    createdAt: new Date().toISOString(),
  };
  db.get("expenses").push(expense).write();
  res.json({ success: true, id: expense.id });
});

app.delete("/api/expenses/:id", (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
  db.set("expenses", db.get("expenses").value().filter((e) => e.id !== req.params.id)).write();
  res.json({ success: true });
});

// ── Website page-view tracking (anonymous, no cookies/PII) ─────
app.post("/api/track", (req, res) => {
  const page = (req.body && req.body.page) || "unknown";
  const now = getCalgaryNow();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  db.get("pageViews").push({ page, date, ts: new Date().toISOString() }).write();
  res.json({ success: true });
});

app.get("/api/stats", (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
  const bookings = db.get("bookings").value();
  const feedback = db.get("feedback").value();
  const expenses = db.get("expenses").value();
  const pageViews = db.get("pageViews").value();
  const confirmed = bookings.filter((b) => b.status === "confirmed");

  const now = getCalgaryNow();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const earnedRevenue = confirmed.filter((b) => b.date <= todayStr).reduce((s, b) => s + b.servicePrice + (b.tipAmount || 0), 0);
  const upcomingRevenue = confirmed.filter((b) => b.date > todayStr).reduce((s, b) => s + b.servicePrice, 0);
  const totalExpenses = expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const netProfit = earnedRevenue - totalExpenses;

  const totalFeedback = feedback.length;
  const avgRating = totalFeedback ? (feedback.reduce((s, f) => s + f.rating, 0) / totalFeedback).toFixed(1) : null;
  const reviewRate = confirmed.length ? Math.round((totalFeedback / confirmed.length) * 100) : 0;

  const revenueByDay = {};
  const viewsByDay = {};
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    const key = d.toISOString().split('T')[0];
    revenueByDay[key] = 0; viewsByDay[key] = 0;
  }
  confirmed.forEach((b) => { if (revenueByDay[b.date] !== undefined) revenueByDay[b.date] += b.servicePrice; });
  pageViews.forEach((v) => { if (viewsByDay[v.date] !== undefined) viewsByDay[v.date]++; });

  const totalViews = pageViews.length;
  const homeViews = pageViews.filter((v) => v.page === "home").length;
  const convRate = totalViews ? ((bookings.length / totalViews) * 100).toFixed(1) : "0.0";

  res.json({
    totalBookings: confirmed.length,
    earnedRevenue, upcomingRevenue, totalRevenue: earnedRevenue + upcomingRevenue,
    totalExpenses, netProfit,
    avgRating, reviewRate,
    totalViews, homeViews, viewsByDay, convRate,
    revenueByDay,
  });
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

// Review SMS is sent manually from the admin dashboard (Clients page →
// Review button) via /api/send-review — no automatic cron firing on its own.

// Morning system check — 8am Calgary time, daily. Confirms the website is
// reachable, the persistent data disk is writable, and the database is
// readable, then texts the owner a summary either way.
cron.schedule("0 8 * * *", async () => {
  if (!twilioClient || !OWNER_PHONE) return;
  const issues = [];

  try {
    const r = await fetch("https://skidocyyc.ca/", { signal: AbortSignal.timeout(8000) });
    if (!r.ok) issues.push(`Website returned status ${r.status}`);
  } catch (e) { issues.push("Website is unreachable"); }

  try {
    if (DATA_DIR !== __dirname) fs.accessSync(DATA_DIR, fs.constants.W_OK);
  } catch (e) { issues.push("Data disk isn't writable — settings may not be saving"); }

  try { db.get("bookings").value(); }
  catch (e) { issues.push("Database read failed"); }

  const body = issues.length
    ? `⚠️ Ski Doc system check found an issue:\n${issues.join("\n")}`
    : `Good morning! All Ski Doc systems are up and running smoothly. Happy grinding! 🎿`;
  try { await twilioClient.messages.create({ body, from: TWILIO_PHONE_NUMBER, to: OWNER_PHONE }); }
  catch (err) { console.error(`✗ Morning system check SMS failed:`, err.message); }
}, { timezone: "America/Edmonton" });

app.listen(PORT, () => {
  console.log(`\n🏔  Ski Doc Calgary — Booking System`);
  console.log(`   Booking page: http://localhost:${PORT}`);
  console.log(`   Dashboard:    http://localhost:${PORT}/dashboard`);
  console.log(`   Password:     ${ADMIN_PASSWORD}\n`);
});
