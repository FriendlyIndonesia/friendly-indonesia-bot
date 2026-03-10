// ============================================================
// FRIENDLY INDONESIA — TELEGRAM BOT AI v2.0
// Upgrade: CoinGecko realtime, Digiflazz PPOB, Supabase DB, Midtrans
// ============================================================

const TelegramBot = require("node-telegram-bot-api");
const Anthropic   = require("@anthropic-ai/sdk");
const https       = require("https");
const crypto      = require("crypto");

// ── CONFIG ──────────────────────────────────────────────────
const BOT_TOKEN           = process.env.BOT_TOKEN;
const CLAUDE_KEY          = process.env.CLAUDE_API_KEY;
const ADMIN_ID            = process.env.ADMIN_ID;
const DIGI_USER           = process.env.DIGIFLAZZ_USER     || "";
const DIGI_KEY_DEV        = process.env.DIGIFLAZZ_KEY_DEV  || "";
const DIGI_KEY_PROD       = process.env.DIGIFLAZZ_KEY_PROD || "";
const MIDTRANS_SERVER_KEY = process.env.MIDTRANS_SERVER_KEY || "";
const MIDTRANS_MODE       = process.env.MIDTRANS_MODE       || "sandbox";
const SUPABASE_URL        = process.env.SUPABASE_URL        || "";
const SUPABASE_KEY        = process.env.SUPABASE_ANON_KEY   || "";

const bot    = new TelegramBot(BOT_TOKEN, { polling: true });
const claude = new Anthropic({ apiKey: CLAUDE_KEY });

// ── IN-MEMORY FALLBACK ───────────────────────────────────────
const users    = {};
const sessions = {};

// ── HELPER FETCH ────────────────────────────────────────────
function fetchJSON(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ── SUPABASE ─────────────────────────────────────────────────
const SB_HEADERS = {
  "apikey": SUPABASE_KEY,
  "Authorization": `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
  "Prefer": "return=representation"
};

async function dbGetUser(userId) {
  if (!SUPABASE_URL) return users[userId] || null;
  try {
    const res = await fetchJSON(`${SUPABASE_URL}/rest/v1/users?telegram_id=eq.${userId}`, { method:"GET", headers:SB_HEADERS });
    return res[0] || null;
  } catch(e) { return users[userId] || null; }
}

async function dbUpsertUser(userId, data) {
  if (!SUPABASE_URL) { users[userId] = data; return; }
  try {
    await fetchJSON(`${SUPABASE_URL}/rest/v1/users`, {
      method: "POST",
      headers: { ...SB_HEADERS, "Prefer": "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({ telegram_id: userId, ...data, updated_at: new Date().toISOString() })
    });
  } catch(e) { users[userId] = data; }
}

async function dbAddTransaction(userId, tx) {
  if (!SUPABASE_URL) {
    if (!users[userId]) users[userId] = { history: [] };
    users[userId].history = [tx, ...(users[userId].history||[])].slice(0, 50);
    return;
  }
  try {
    await fetchJSON(`${SUPABASE_URL}/rest/v1/transactions`, {
      method: "POST",
      headers: SB_HEADERS,
      body: JSON.stringify({ telegram_id: userId, ...tx, created_at: new Date().toISOString() })
    });
  } catch(e) {
    if (!users[userId]) users[userId] = { history: [] };
    users[userId].history = [tx, ...(users[userId].history||[])].slice(0, 50);
  }
}

async function dbGetHistory(userId, limit = 5) {
  if (!SUPABASE_URL) return (users[userId]?.history || []).slice(0, limit);
  try {
    return await fetchJSON(`${SUPABASE_URL}/rest/v1/transactions?telegram_id=eq.${userId}&order=created_at.desc&limit=${limit}`, { method:"GET", headers:SB_HEADERS });
  } catch(e) { return (users[userId]?.history || []).slice(0, limit); }
}

// ── CRYPTO REALTIME (CoinGecko) ──────────────────────────────
const COIN_IDS = {
  BTC:"bitcoin", ETH:"ethereum", BNB:"binancecoin", SOL:"solana",
  XRP:"ripple", USDT:"tether", DOGE:"dogecoin", ADA:"cardano",
  MATIC:"matic-network", AVAX:"avalanche-2"
};
const ID_TO_TICKER = Object.fromEntries(Object.entries(COIN_IDS).map(([k,v])=>[v,k]));
let cryptoCache = {}, cryptoCacheAt = 0;

async function getCryptoPrices() {
  if (Date.now() - cryptoCacheAt < 60000 && Object.keys(cryptoCache).length) return cryptoCache;
  try {
    const ids  = Object.values(COIN_IDS).join(",");
    const data = await fetchJSON(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=idr&include_24hr_change=true`);
    const result = {};
    for (const [id, val] of Object.entries(data)) {
      const ticker = ID_TO_TICKER[id];
      if (ticker) result[ticker] = { price: val.idr||0, change: parseFloat((val.idr_24h_change||0).toFixed(2)) };
    }
    cryptoCache = result; cryptoCacheAt = Date.now();
    return result;
  } catch(e) { console.error("CoinGecko error:", e.message); return cryptoCache; }
}

// ── DIGIFLAZZ ────────────────────────────────────────────────
function digiSign(user, key, refId="") {
  return crypto.createHash("md5").update(user + key + refId).digest("hex");
}
async function digiCekSaldo() {
  if (!DIGI_USER) return null;
  try {
    const sign    = digiSign(DIGI_USER, DIGI_KEY_DEV, "info");
    const payload = JSON.stringify({ cmd:"deposit", username:DIGI_USER, sign });
    return fetchJSON("https://api.digiflazz.com/v1/cek-saldo", {
      method:"POST", headers:{"Content-Type":"application/json"}, body:payload
    });
  } catch(e) { return null; }
}

// ── MIDTRANS ─────────────────────────────────────────────────
const MT_BASE = MIDTRANS_MODE === "production"
  ? "https://app.midtrans.com/snap/v1"
  : "https://app.sandbox.midtrans.com/snap/v1";

async function createPayment({ orderId, amount, customerName, itemName }) {
  if (!MIDTRANS_SERVER_KEY) return null;
  const auth    = Buffer.from(MIDTRANS_SERVER_KEY + ":").toString("base64");
  const payload = JSON.stringify({
    transaction_details: { order_id:orderId, gross_amount:amount },
    customer_details: { first_name:customerName },
    item_details: [{ id:orderId, price:amount, quantity:1, name:itemName }]
  });
  try {
    return await fetchJSON(`${MT_BASE}/transactions`, {
      method:"POST",
      headers:{ "Authorization":`Basic ${auth}`, "Content-Type":"application/json" },
      body: payload
    });
  } catch(e) { console.error("Midtrans error:", e.message); return null; }
}

// ── HELPERS ──────────────────────────────────────────────────
const fmt        = (n) => "Rp " + Math.round(n).toLocaleString("id-ID");
const ppn        = (fee) => Math.round(fee * 0.12);
const getPoints  = (n) => Math.round(n * 0.001);
const getTier    = (pts) => pts>=50001?"💎 Diamond":pts>=10001?"🥇 Gold":pts>=2001?"🥈 Silver":"🥉 Bronze";
const genOrderId = (uid) => `FRI-${uid}-${Date.now()}`;

async function getOrCreateUser(id, name) {
  let user = await dbGetUser(id);
  if (!user) {
    user = { telegram_id:id, name, points:500, tier:"🥉 Bronze", joined:new Date().toLocaleDateString("id-ID") };
    await dbUpsertUser(id, user);
    await dbAddTransaction(id, { type:"Bonus Daftar", points:500, date:new Date().toLocaleDateString("id-ID") });
  }
  users[id] = user;
  return user;
}

async function addPoints(userId, pts) {
  const u = users[userId] || await dbGetUser(userId);
  if (!u) return;
  u.points = (u.points||0) + pts;
  u.tier   = getTier(u.points);
  await dbUpsertUser(userId, u);
  users[userId] = u;
}

// ── SYSTEM PROMPT ─────────────────────────────────────────────
const SYSTEM = `Kamu adalah asisten AI Friendly Indonesia — platform PPOB dan Crypto terpercaya Indonesia.
KEPRIBADIAN: Ramah, sopan, profesional tapi santai. Selalu Bahasa Indonesia. Pakai emoji secukupnya.
LAYANAN: PPOB (Pulsa, Data, PLN, BPJS, Game, E-Wallet, TV, Internet) & CRYPTO realtime (BTC,ETH,BNB,SOL,XRP,USDT,DOGE,ADA,MATIC,AVAX).
FEE: Pulsa Rp500+PPN12%, PLN/BPJS Rp2000-2500+PPN12%, Crypto fee1%+PPh0.1%+PPN0.11%.
PEMBAYARAN: Midtrans (QRIS, Transfer Bank, GoPay, OVO, Dana, ShopeePay).
PENTING: Jangan janjikan keuntungan crypto. Selalu ingatkan risiko. Masalah teknis → admin.`;

// ── KEYBOARDS ────────────────────────────────────────────────
const mainKeyboard = { reply_markup: { keyboard:[["⚡ PPOB","🪙 Crypto"],["⭐ Poin & Reward","📋 Riwayat"],["💬 Bantuan","ℹ️ Tentang Kami"]], resize_keyboard:true } };
const ppobKeyboard = { reply_markup: { inline_keyboard:[
  [{text:"📱 Pulsa",callback_data:"ppob_pulsa"},{text:"📶 Paket Data",callback_data:"ppob_data"}],
  [{text:"⚡ PLN",callback_data:"ppob_pln"},{text:"🏥 BPJS",callback_data:"ppob_bpjs"}],
  [{text:"🎮 Top-up Game",callback_data:"ppob_game"},{text:"💚 E-Wallet",callback_data:"ppob_ewallet"}],
  [{text:"📺 TV Kabel",callback_data:"ppob_tv"},{text:"🌐 Internet",callback_data:"ppob_internet"}],
  [{text:"🏠 Menu Utama",callback_data:"back_main"}]
]}};
const cryptoKeyboard = { reply_markup: { inline_keyboard:[
  [{text:"₿ BTC",callback_data:"crypto_BTC"},{text:"Ξ ETH",callback_data:"crypto_ETH"},{text:"◎ SOL",callback_data:"crypto_SOL"}],
  [{text:"🟡 BNB",callback_data:"crypto_BNB"},{text:"✕ XRP",callback_data:"crypto_XRP"},{text:"💵 USDT",callback_data:"crypto_USDT"}],
  [{text:"Ð DOGE",callback_data:"crypto_DOGE"},{text:"🔵 ADA",callback_data:"crypto_ADA"},{text:"🟣 MATIC",callback_data:"crypto_MATIC"}],
  [{text:"🔺 AVAX",callback_data:"crypto_AVAX"},{text:"📊 Semua",callback_data:"crypto_all"}],
  [{text:"🏠 Menu Utama",callback_data:"back_main"}]
]}};

// ── /START ───────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const id = msg.from.id, name = msg.from.first_name || "Pengguna";
  const user = await getOrCreateUser(id, name);
  await bot.sendMessage(id,
    `👋 Halo *${name}!* Selamat datang di *Friendly Indonesia* 🤝\n\n` +
    `Platform PPOB & Crypto #1 yang transparan & terpercaya.\n\n` +
    `⭐ Poin kamu: *${(user.points||500).toLocaleString("id-ID")} poin*\n` +
    `🏆 Tier: *${user.tier||"🥉 Bronze"}*\n\n` +
    `Pilih layanan atau ketik pertanyaan:`,
    { parse_mode:"Markdown", ...mainKeyboard }
  );
});

// ── MESSAGES ─────────────────────────────────────────────────
bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;
  const id = msg.from.id, name = msg.from.first_name || "Pengguna";
  const text = msg.text.trim();
  const user = await getOrCreateUser(id, name);

  if (text === "⚡ PPOB") return bot.sendMessage(id, "⚡ *Layanan PPOB*\nPilih layanan:", { parse_mode:"Markdown", ...ppobKeyboard });

  if (text === "🪙 Crypto") {
    await bot.sendChatAction(id, "typing");
    const prices = await getCryptoPrices();
    if (!Object.keys(prices).length) return bot.sendMessage(id, "⚠️ Gagal ambil harga. Coba lagi!", mainKeyboard);
    const lines = Object.entries(prices).map(([k,v]) => `${k}: *${fmt(v.price)}* ${v.change>=0?"▲":"▼"} ${Math.abs(v.change)}%`).join("\n");
    return bot.sendMessage(id, `🪙 *Harga Crypto Realtime*\n_CoinGecko · update 60 detik_\n\n${lines}\n\n_Pilih koin:_`, { parse_mode:"Markdown", ...cryptoKeyboard });
  }

  if (text === "⭐ Poin & Reward") {
    const pts = user.points||0;
    const next = user.tier==="🥉 Bronze"?"🥈 Silver (2.001 poin)":user.tier==="🥈 Silver"?"🥇 Gold (10.001 poin)":user.tier==="🥇 Gold"?"💎 Diamond (50.001 poin)":"Sudah tertinggi! 🎉";
    return bot.sendMessage(id,
      `⭐ *Friendly Points*\n\n💰 Saldo: *${pts.toLocaleString("id-ID")} poin*\n🏆 Tier: *${user.tier}*\n🎯 Berikutnya: ${next}\n\n` +
      `*Kumpul Poin:*\n• Tiap transaksi = 0.1% nominal\n• Referral = +1.000 poin\n\n` +
      `*Redeem:*\n• 500 poin = Pulsa Rp 5.000\n• 300 poin = Diskon fee 50%\n• 1.000 poin = Gratis 1x PLN`,
      { parse_mode:"Markdown", ...mainKeyboard }
    );
  }

  if (text === "📋 Riwayat") {
    const history = await dbGetHistory(id, 5);
    if (!history.length) return bot.sendMessage(id, "📋 Belum ada riwayat. Yuk mulai transaksi pertama!", mainKeyboard);
    const hist = history.map((h,i) => `${i+1}. ${h.type} — ${h.date||h.created_at?.split("T")[0]}\n   ${h.amount?fmt(h.amount):""} ${h.points?`+${h.points} poin`:""}`).join("\n\n");
    return bot.sendMessage(id, `📋 *Riwayat (5 terakhir)*\n\n${hist}`, { parse_mode:"Markdown", ...mainKeyboard });
  }

  if (text === "ℹ️ Tentang Kami") return bot.sendMessage(id,
    `🤝 *Friendly Indonesia*\n\nPlatform PPOB & Crypto transparan & terpercaya.\n\n✅ Harga + pajak transparan\n✅ Bayar via QRIS/GoPay/OVO/Transfer (Midtrans)\n✅ Invoice PDF otomatis\n✅ Friendly Points tiap transaksi\n✅ AI Support 24/7\n\n🌐 friendlyindonesia.netlify.app\n📧 hello@friendlyindonesia.id`,
    { parse_mode:"Markdown", ...mainKeyboard }
  );

  if (text === "💬 Bantuan") return bot.sendMessage(id,
    `💬 *Bantuan*\n\nKetik pertanyaan langsung, atau:\n\n📱 Admin: @FriendlyAdmin\n📧 hello@friendlyindonesia.id\n\n_AI siap 24/7!_ 🤖`,
    { parse_mode:"Markdown", ...mainKeyboard }
  );

  // AI Chat
  try {
    await bot.sendChatAction(id, "typing");
    if (!sessions[id]) sessions[id] = [];
    sessions[id].push({ role:"user", content:text });
    if (sessions[id].length > 20) sessions[id] = sessions[id].slice(-20);
    const res = await claude.messages.create({
      model:"claude-sonnet-4-20250514", max_tokens:1000,
      system: SYSTEM + `\nUser: ${name}, Poin: ${user.points||0}, Tier: ${user.tier||"Bronze"}`,
      messages: sessions[id]
    });
    const reply = res.content[0].text;
    sessions[id].push({ role:"assistant", content:reply });
    await bot.sendMessage(id, reply, { parse_mode:"Markdown", ...mainKeyboard });
  } catch(e) {
    console.error(e);
    await bot.sendMessage(id, "⚠️ Gangguan sementara. Coba lagi ya!", mainKeyboard);
  }
});

// ── CALLBACKS ────────────────────────────────────────────────
bot.on("callback_query", async (query) => {
  const id = query.from.id, name = query.from.first_name || "Pengguna";
  const data = query.data;
  await getOrCreateUser(id, name);
  await bot.answerCallbackQuery(query.id);

  if (data === "back_main") return bot.sendMessage(id, "🏠 Menu utama:", mainKeyboard);
  if (data === "back_ppob") return bot.sendMessage(id, "⚡ *Layanan PPOB*", { parse_mode:"Markdown", ...ppobKeyboard });
  if (data === "back_crypto") return bot.sendMessage(id, "🪙 *Pilih Koin:*", { parse_mode:"Markdown", ...cryptoKeyboard });

  // PPOB
  if (data.startsWith("ppob_")) {
    const type = data.replace("ppob_", "");
    const info = {
      pulsa:   { icon:"📱", name:"Pulsa",       fee:500,  msg:"Nomor HP & nominal:\nContoh: *08123456789 50000*" },
      data:    { icon:"📶", name:"Paket Data",  fee:1000, msg:"Nomor HP:\nContoh: *08123456789*" },
      pln:     { icon:"⚡", name:"Listrik PLN", fee:2000, msg:"ID Pelanggan PLN:\nContoh: *123456789012*" },
      bpjs:    { icon:"🏥", name:"BPJS",        fee:2500, msg:"Nomor BPJS:\nContoh: *0001234567890*" },
      game:    { icon:"🎮", name:"Top-up Game", fee:1000, msg:"Game & nominal:\nContoh: *Mobile Legends 100 diamond*" },
      ewallet: { icon:"💚", name:"E-Wallet",    fee:1500, msg:"E-wallet + nomor:\nContoh: *GoPay 08123456789 100000*" },
      tv:      { icon:"📺", name:"TV Kabel",    fee:2000, msg:"Nomor pelanggan TV:" },
      internet:{ icon:"🌐", name:"Internet",    fee:2500, msg:"ID pelanggan internet:" },
    };
    const svc = info[type]; if (!svc) return;
    return bot.sendMessage(id,
      `${svc.icon} *${svc.name}*\n\n${svc.msg}\n\n💰 Fee: *${fmt(svc.fee)}*\n🏛️ PPN: *${fmt(ppn(svc.fee))}*\n💳 Bayar: QRIS/Transfer/GoPay/OVO\n🎁 Poin: 0.1% nominal\n\n_Ketik detail transaksi 👆_`,
      { parse_mode:"Markdown", reply_markup:{ inline_keyboard:[[{text:"⬅️ Kembali",callback_data:"back_ppob"}]] } }
    );
  }

  // CRYPTO
  if (data.startsWith("crypto_")) {
    const ticker = data.replace("crypto_", "");
    await bot.sendChatAction(id, "typing");
    const prices = await getCryptoPrices();

    if (ticker === "all") {
      const lines = Object.entries(prices).map(([k,v]) => `${k.padEnd(6)} ${fmt(v.price).padStart(22)}  ${v.change>=0?"▲":"▼"}${Math.abs(v.change)}%`).join("\n");
      return bot.sendMessage(id, `📊 *Harga Crypto Realtime*\n\`\`\`\n${lines}\n\`\`\``, { parse_mode:"Markdown", ...cryptoKeyboard });
    }

    const coin = prices[ticker];
    if (!coin) return bot.sendMessage(id, "⚠️ Gagal ambil harga. Coba lagi!", mainKeyboard);
    const nominal = 500000, feeVal = Math.round(nominal*0.01), taxVal = Math.round(nominal*0.0021), total = nominal+feeVal+taxVal;
    return bot.sendMessage(id,
      `${coin.change>=0?"🟢":"🔴"} *${ticker}*\n\n💰 Harga: *${fmt(coin.price)}*\n📈 24 jam: *${coin.change>=0?"▲":"▼"} ${Math.abs(coin.change)}%*\n\n─────────\n*Simulasi Beli Rp 500.000:*\nNilai        : ${fmt(nominal)}\nFee (1%)     : ${fmt(feeVal)}\nPajak (0.21%): ${fmt(taxVal)}\n─────────\n*Total : ${fmt(total)}*\nKoin  : ≈${(nominal/coin.price).toFixed(8)} ${ticker}\n🎁 Poin: +${getPoints(nominal)} poin\n💳 Bayar: QRIS/Transfer/GoPay/OVO`,
      { parse_mode:"Markdown", reply_markup:{ inline_keyboard:[
        [{text:`🟢 Beli ${ticker}`,callback_data:`order_buy_${ticker}`},{text:`🔴 Jual ${ticker}`,callback_data:`order_sell_${ticker}`}],
        [{text:"⬅️ Kembali",callback_data:"back_crypto"}]
      ]}}
    );
  }

  // ORDER + MIDTRANS
  if (data.startsWith("order_")) {
    const [, type, ticker] = data.split("_");
    const prices  = await getCryptoPrices();
    const coin    = prices[ticker] || { price:0 };
    const orderId = genOrderId(id);
    const nominal = 500000, feeVal = Math.round(nominal*0.01), taxVal = Math.round(nominal*0.0021), total = nominal+feeVal+taxVal;

    const payment = await createPayment({ orderId, amount:total, customerName:name, itemName:`${type==="buy"?"Beli":"Jual"} ${ticker} - Friendly Indonesia` });

    if (payment?.redirect_url) {
      await dbAddTransaction(id, { type:`${type==="buy"?"Beli":"Jual"} ${ticker}`, amount:total, order_id:orderId, status:"pending", date:new Date().toLocaleDateString("id-ID") });
      return bot.sendMessage(id,
        `💳 *Link Pembayaran*\n\nOrder: \`${orderId}\`\nTotal: *${fmt(total)}*\n\nKlik tombol untuk bayar:`,
        { parse_mode:"Markdown", reply_markup:{ inline_keyboard:[
          [{text:"💳 Bayar Sekarang",url:payment.redirect_url}],
          [{text:"⬅️ Kembali",callback_data:`crypto_${ticker}`}]
        ]}}
      );
    }
    return bot.sendMessage(id,
      `${type==="buy"?"🟢 Beli":"🔴 Jual"} *${ticker}*\n\nKetik nominal:\n*${type==="buy"?"Beli":"Jual"} ${ticker} 500000*\n\n_Min: Rp 50.000 · Bayar via Midtrans_`,
      { parse_mode:"Markdown", reply_markup:{ inline_keyboard:[[{text:"⬅️ Kembali",callback_data:`crypto_${ticker}`}]] } }
    );
  }
});

// ── ADMIN ────────────────────────────────────────────────────
bot.onText(/\/admin/, async (msg) => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return;
  const saldo = await digiCekSaldo();
  await bot.sendMessage(msg.from.id,
    `🔧 *Admin Dashboard v2.0*\n\n🤖 Bot: *Online ✅*\n📡 Crypto: *CoinGecko Realtime ✅*\n💳 Midtrans: *${MIDTRANS_SERVER_KEY?"✅ Aktif ("+MIDTRANS_MODE+")":"⚠️ Belum diisi"}*\n🏪 Digiflazz: *${DIGI_USER?"✅ Aktif":"⚠️ Belum diisi"}*\n🗄️ Database: *${SUPABASE_URL?"✅ Supabase":"⚠️ In-memory"}*${saldo?.data?.deposit?"\n💰 Saldo Digi: *"+fmt(saldo.data.deposit)+"*":""}`,
    { parse_mode:"Markdown" }
  );
});

bot.on("polling_error", (err) => console.error("Polling:", err.message));
process.on("unhandledRejection", (err) => console.error("Unhandled:", err));

console.log("🤝 Friendly Indonesia Bot v2.0 RUNNING");
console.log(`📡 CoinGecko: Realtime | 💳 Midtrans: ${MIDTRANS_SERVER_KEY?"ACTIVE":"pending"} | 🏪 Digiflazz: ${DIGI_USER?"ACTIVE":"pending"} | 🗄️ DB: ${SUPABASE_URL?"Supabase":"in-memory"}`);
