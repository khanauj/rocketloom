require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const https   = require('https');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Config ────────────────────────────────────────────────
const WHATSAPP_NUMBER = process.env.WHATSAPP_NUMBER;
const ADMIN_PASSWORD  = process.env.ADMIN_PASSWORD;
const DB_FILE         = path.join(__dirname, 'leads.json');
const NVIDIA_API_KEY  = process.env.NVIDIA_API_KEY;
const NVIDIA_MODEL    = process.env.NVIDIA_MODEL;
// ─────────────────────────────────────────────────────────

// ── JSON "DB" helpers ─────────────────────────────────────
function readDB() {
  if (!fs.existsSync(DB_FILE)) return { leads: [], nextId: 1 };
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function writeDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
function saveLead(name, phone, plan, source = 'chatbot') {
  const cleaned = phone.replace(/\D/g, '');
  if (!/^[6-9]\d{9}$/.test(cleaned)) return null;
  const db   = readDB();
  // avoid duplicate phone in last 10 leads
  if (db.leads.slice(0, 10).some(l => l.phone === cleaned)) return null;
  const lead = {
    id: db.nextId++,
    name: name.trim(),
    phone: cleaned,
    plan: plan || 'Via Chatbot',
    message: '',
    source,
    created_at: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
  };
  db.leads.unshift(lead);
  writeDB(db);
  return lead;
}
// ─────────────────────────────────────────────────────────

// ── NVIDIA NIM helper ─────────────────────────────────────
function nvidiaChat(messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: NVIDIA_MODEL,
      messages,
      max_tokens: 350,
      temperature: 0.75,
      stream: false
    });

    const options = {
      hostname: 'integrate.api.nvidia.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${NVIDIA_API_KEY}`,
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON from NVIDIA: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
// ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Rocket 🚀, an enthusiastic and friendly AI sales assistant for Rocketloom — Delhi's #1 professional web development studio. Your goal is to have a natural, helpful conversation to understand what the user needs, recommend the right plan, and collect their contact details.

ROCKETLOOM PLANS:
- Basic Plan ₹4,990 (one-time): 5-page website, images & videos, bandwidth/storage, 100% responsive, live chat, social media & WhatsApp integration, 1 revision — delivery in 48 hours
- Classic Plan ₹5,990 (one-time): 10-page website, AI chatbot (LLM), Razorpay/payment integration, social media + WhatsApp, 2 revisions — delivery in 24 hours
- Premium Plan ₹7,990 (one-time): 15-page website, advanced features, 4 revisions — delivery in 24 hours

ADD-ONS: Extra page ₹200-500 | E-commerce ₹1,500 | Custom dashboard ₹1,300 | SEO ₹2,999/mo | WhatsApp automation ₹400 | AI bot ₹799

CONVERSATION FLOW — follow this order naturally:
1. Warm greeting, ask what type of business they have
2. Ask what features/pages they need
3. Recommend the best plan with reasoning
4. Ask for their name
5. Ask for their phone number (say team will call within 30 mins)
6. Confirm everything and wrap up enthusiastically

STRICT RULES:
- Keep every reply SHORT — max 3 sentences or 60 words
- Be warm, energetic, use occasional Indian expressions (yaar, bilkul, ekdum)
- Never invent prices or services not listed above
- When you have BOTH name AND phone number from the user, append this JSON on a new line at the very end of your message (do NOT show it to user, it will be hidden): {"__lead__":true,"name":"THEIR_NAME","phone":"THEIR_PHONE","plan":"RECOMMENDED_PLAN"}
- Only append the JSON once, when you have both name and phone confirmed`;

app.use(cors({ origin: ['https://glowing-chimera-68bf58.netlify.app', 'http://localhost:3000'] }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// ── POST /api/chat ────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { messages = [] } = req.body;
  if (!messages.length)
    return res.status(400).json({ error: 'messages required' });

  try {
    const result = await nvidiaChat([
      { role: 'system', content: SYSTEM_PROMPT },
      ...messages
    ]);

    const raw     = result.choices?.[0]?.message?.content || '';
    const jsonMatch = raw.match(/\{"__lead__":true[\s\S]*?\}/);
    let   leadSaved = null;

    if (jsonMatch) {
      try {
        const d = JSON.parse(jsonMatch[0]);
        if (d.name && d.phone) leadSaved = saveLead(d.name, d.phone, d.plan);
      } catch {}
    }

    const clean = raw.replace(/\{"__lead__":true[\s\S]*?\}/g, '').trim();

    res.json({
      content: clean,
      leadSaved: !!leadSaved,
      leadId: leadSaved?.id || null
    });
  } catch (err) {
    console.error('NVIDIA API error:', err.message);
    res.status(500).json({ error: 'AI service unavailable. Please try again.' });
  }
});

// ── POST /api/contact ─────────────────────────────────────
app.post('/api/contact', (req, res) => {
  const { name, phone, plan = 'Not specified', message = '', source = 'contact_form' } = req.body;

  if (!name || !phone)
    return res.status(400).json({ success: false, error: 'Name and phone are required.' });

  if (!/^[6-9]\d{9}$/.test(phone.replace(/\D/g, '')))
    return res.status(400).json({ success: false, error: 'Enter a valid 10-digit Indian mobile number.' });

  const db   = readDB();
  const lead = {
    id: db.nextId++,
    name: name.trim(),
    phone: phone.replace(/\D/g, ''),
    plan,
    message,
    source,
    created_at: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
  };
  db.leads.unshift(lead);
  writeDB(db);

  const waText = encodeURIComponent(
    `Hi Rocketloom! I'm ${lead.name} (${lead.phone}). Interested in the ${plan}. Please get in touch!`
  );

  res.json({
    success: true,
    id: lead.id,
    whatsappUrl: `https://wa.me/${WHATSAPP_NUMBER}?text=${waText}`
  });
});

// ── GET /api/leads ────────────────────────────────────────
app.get('/api/leads', (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  res.json(readDB().leads);
});

// ── GET /api/stats ────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { leads } = readDB();
  const today = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
  const byPlan = leads.reduce((acc, l) => {
    acc[l.plan] = (acc[l.plan] || 0) + 1; return acc;
  }, {});
  res.json({
    total: leads.length,
    today: leads.filter(l => l.created_at.startsWith(today)).length,
    byPlan: Object.entries(byPlan).map(([plan, c]) => ({ plan, c })).sort((a, b) => b.c - a.c)
  });
});

// ── DELETE /api/leads/:id ─────────────────────────────────
app.delete('/api/leads/:id', (req, res) => {
  if (req.query.pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const db = readDB();
  db.leads = db.leads.filter(l => l.id !== Number(req.params.id));
  writeDB(db);
  res.json({ success: true });
});

// ── Pages ─────────────────────────────────────────────────
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '../frontend/admin.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../frontend/stitch_pricing.html')));

app.listen(PORT, () => {
  console.log(`\n🚀 Rocketloom: http://localhost:${PORT}`);
  console.log(`🔐 Admin panel: http://localhost:${PORT}/admin`);
  console.log(`   Password:    ${ADMIN_PASSWORD}\n`);
});
