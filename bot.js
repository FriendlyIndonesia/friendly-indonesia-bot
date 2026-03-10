// ============================================================
// FRIENDLY INDONESIA — TELEGRAM BOT AI v3.0
// Fitur: Wallet/Deposit, Pay-per-tx, Midtrans Webhook, CoinGecko
// ============================================================

const TelegramBot = require("node-telegram-bot-api");

const https       = require("https");
const http        = require("http");
const crypto      = require("crypto");

// ── CONFIG ──────────────────────────────────────────────────
const BOT_TOKEN           = process.env.BOT_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const ADMIN_ID            = process.env.ADMIN_ID;
const DIGI_USER           = process.env.DIGIFLAZZ_USER     || "";
const DIGI_KEY_DEV        = process.env.DIGIFLAZZ_KEY_DEV  || "";
const DIGI_KEY_PROD       = process.env.DIGIFLAZZ_KEY_PROD || "";
const MIDTRANS_SERVER_KEY = process.env.MIDTRANS_SERVER_KEY || "";
const MIDTRANS_CLIENT_KEY = process.env.MIDTRANS_CLIENT_KEY || "";
const MIDTRANS_MODE       = process.env.MIDTRANS_MODE       || "sandbox";
const SUPABASE_URL        = process.env.SUPABASE_URL        || "";
const SUPABASE_KEY        = process.env.SUPABASE_ANON_KEY   || "";
const WEBHOOK_SECRET      = process.env.WEBHOOK_SECRET      || "friendlyindonesia";
const PORT                = process.env.PORT                || 3000;

const bot    = new TelegramBot(BOT_TOKEN, { polling: true });


// ── IN-MEMORY STORE (fallback kalau Supabase belum diisi) ───
const users    = {}; // { userId: { name, points, tier, saldo, history } }
const sessions = {};
const pendingTx= {}; // { orderId: { userId, type, amount, detail } }

// ── FETCH HELPER ─────────────────────────────────────────────
function fetchJSON(url, options = {}) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith("https");
    const lib = isHttps ? https : http;
    const req = lib.request(url, options, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { reject(new Error(data)); } });
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ── SUPABASE ─────────────────────────────────────────────────
const SB = {
  headers: {
    "apikey": SUPABASE_KEY,
    "Authorization": `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
    "Prefer": "return=representation"
  },
  async get(table, query) {
    if (!SUPABASE_URL) return null;
    try {
      const res = await fetchJSON(`${SUPABASE_URL}/rest/v1/${table}?${query}`, { method:"GET", headers:this.headers });
      return Array.isArray(res) ? res[0] || null : res;
    } catch(e) { return null; }
  },
  async upsert(table, data) {
    if (!SUPABASE_URL) return null;
    try {
      return await fetchJSON(`${SUPABASE_URL}/rest/v1/${table}`, {
        method:"POST",
        headers: { ...this.headers, "Prefer":"resolution=merge-duplicates,return=representation" },
        body: JSON.stringify(data)
      });
    } catch(e) { return null; }
  },
  async insert(table, data) {
    if (!SUPABASE_URL) return null;
    try {
      return await fetchJSON(`${SUPABASE_URL}/rest/v1/${table}`, {
        method:"POST", headers:this.headers,
        body: JSON.stringify(data)
      });
    } catch(e) { return null; }
  },
  async list(table, query, limit=5) {
    if (!SUPABASE_URL) return [];
    try {
      return await fetchJSON(`${SUPABASE_URL}/rest/v1/${table}?${query}&order=created_at.desc&limit=${limit}`, { method:"GET", headers:this.headers });
    } catch(e) { return []; }
  }
};

// ── USER DB ──────────────────────────────────────────────────
async function getOrCreateUser(id, name) {
  // Cek cache dulu
  if (users[id]?.loaded) return users[id];

  let user = await SB.get("users", `telegram_id=eq.${id}`);
  if (!user) {
    user = { telegram_id:id, name, points:500, tier:"🥉 Bronze", saldo:0, joined:new Date().toLocaleDateString("id-ID") };
    await SB.upsert("users", user);
    await addTxHistory(id, { type:"Bonus Daftar", points:500, status:"success" });
  }
  users[id] = { ...user, loaded:true };
  return users[id];
}

async function saveUser(id) {
  const u = users[id]; if (!u) return;
  u.tier = getTier(u.points);
  await SB.upsert("users", { telegram_id:id, name:u.name, points:u.points, tier:u.tier, saldo:u.saldo });
}

async function addTxHistory(userId, tx) {
  const record = { telegram_id:userId, ...tx, created_at:new Date().toISOString() };
  await SB.insert("transactions", record);
  // Juga simpan in-memory
  if (!users[userId]) users[userId] = { history:[] };
  if (!users[userId].history) users[userId].history = [];
  users[userId].history.unshift(record);
}

async function getHistory(userId, limit=5) {
  const dbHist = await SB.list("transactions", `telegram_id=eq.${userId}`, limit);
  if (dbHist?.length) return dbHist;
  return (users[userId]?.history || []).slice(0, limit);
}

// ── SALDO ────────────────────────────────────────────────────
async function getSaldo(userId) {
  const u = users[userId];
  return u?.saldo || 0;
}

async function tambahSaldo(userId, amount) {
  if (!users[userId]) users[userId] = { saldo:0 };
  users[userId].saldo = (users[userId].saldo || 0) + amount;
  await saveUser(userId);
}

async function kurangiSaldo(userId, amount) {
  if (!users[userId]) users[userId] = { saldo:0 };
  const saldo = users[userId].saldo || 0;
  if (saldo < amount) return false;
  users[userId].saldo = saldo - amount;
  await saveUser(userId);
  return true;
}

// ── CRYPTO REALTIME ──────────────────────────────────────────
// Binance symbol map
const BINANCE_MAP = {
  BTCUSDT:"BTC", ETHUSDT:"ETH", BNBUSDT:"BNB", SOLUSDT:"SOL",
  XRPUSDT:"XRP", DOGEUSDT:"DOGE", ADAUSDT:"ADA", MATICUSDT:"MATIC", AVAXUSDT:"AVAX"
};
let cryptoCache = {}, cryptoCacheAt = 0;

async function getCryptoPrices() {
  if (Date.now() - cryptoCacheAt < 60000 && Object.keys(cryptoCache).length) return cryptoCache;
  try {
    // Ambil rate USDT/IDR
    const usdtIdr = await fetchJSON("https://api.binance.com/api/v3/ticker/price?symbol=USDTIDR");
    const idrRate = parseFloat(usdtIdr.price) || 16200;

    // Ambil semua harga 24hr sekaligus
    const syms   = Object.keys(BINANCE_MAP).map(s => `"${s}"`).join(",");
    const prices = await fetchJSON(`https://api.binance.com/api/v3/ticker/24hr?symbols=[${syms}]`);

    const result = {};
    for (const item of prices) {
      const ticker = BINANCE_MAP[item.symbol];
      if (ticker) result[ticker] = {
        price:  Math.round(parseFloat(item.lastPrice) * idrRate),
        change: parseFloat(parseFloat(item.priceChangePercent).toFixed(2))
      };
    }
    // USDT = 1 USD
    result["USDT"] = { price: Math.round(idrRate), change: 0 };

    cryptoCache = result; cryptoCacheAt = Date.now();
    console.log("✅ Crypto updated via Binance, rate:", idrRate);
    return result;
  } catch(e) {
    console.error("Binance error:", e.message);
    // Fallback hardcode kalau API gagal
    if (Object.keys(cryptoCache).length) return cryptoCache;
    return {
      BTC:{price:1580000000,change:0}, ETH:{price:47000000,change:0},
      BNB:{price:9800000,change:0},   SOL:{price:2400000,change:0},
      XRP:{price:38000,change:0},     USDT:{price:16200,change:0},
      DOGE:{price:5200,change:0},     ADA:{price:15000,change:0},
      MATIC:{price:11500,change:0},   AVAX:{price:580000,change:0}
    };
  }
}

// ── MIDTRANS ─────────────────────────────────────────────────
const MT_BASE = MIDTRANS_MODE === "production"
  ? "https://app.midtrans.com/snap/v1"
  : "https://app.sandbox.midtrans.com/snap/v1";

async function createMidtransPayment({ orderId, amount, customerName, itemName }) {
  if (!MIDTRANS_SERVER_KEY) return null;
  const auth    = Buffer.from(MIDTRANS_SERVER_KEY + ":").toString("base64");
  const payload = JSON.stringify({
    transaction_details: { order_id:orderId, gross_amount:amount },
    customer_details: { first_name:customerName },
    item_details: [{ id:orderId, price:amount, quantity:1, name:itemName }],
    callbacks: { finish:`https://t.me/${(await bot.getMe()).username}` }
  });
  try {
    return await fetchJSON(`${MT_BASE}/transactions`, {
      method:"POST",
      headers:{ "Authorization":`Basic ${auth}`, "Content-Type":"application/json" },
      body: payload
    });
  } catch(e) { console.error("Midtrans:", e.message); return null; }
}

// Verifikasi notifikasi dari Midtrans
function verifyMidtransSignature(orderId, statusCode, grossAmount, serverKey) {
  const str = orderId + statusCode + grossAmount + serverKey;
  return crypto.createHash("sha512").update(str).digest("hex");
}

// ── DIGIFLAZZ ────────────────────────────────────────────────
const DIGI_MODE = process.env.DIGIFLAZZ_MODE || "dev";
const DIGI_KEY  = () => DIGI_MODE === "prod" ? DIGI_KEY_PROD : DIGI_KEY_DEV;

function digiSign(user, key, refId="") {
  return crypto.createHash("md5").update(user + key + refId).digest("hex");
}

async function digiCekSaldo() {
  if (!DIGI_USER) return null;
  try {
    const sign = digiSign(DIGI_USER, DIGI_KEY(), "info");
    const payload = JSON.stringify({ cmd:"deposit", username:DIGI_USER, sign });
    return fetchJSON("https://api.digiflazz.com/v1/cek-saldo", {
      method:"POST", headers:{"Content-Type":"application/json"}, body:payload
    });
  } catch(e) { return null; }
}

let digiProdukCache = {}, digiProdukCacheAt = 0;

// ── DETEKSI OPERATOR DARI NOMOR HP ──────────────────────────
function detectOperator(nomor) {
  const n = nomor.replace(/^0/, "62").replace(/^\+/, "");
  const prefix4 = n.substring(0, 4);
  const prefix5 = n.substring(0, 5);

  const map = {
    // Telkomsel
    "6281":"telkomsel","6282":"telkomsel","6283":"telkomsel","6285":"telkomsel",
    "62852":"telkomsel","62853":"telkomsel","62811":"telkomsel","62812":"telkomsel","62813":"telkomsel",
    // Indosat
    "6284":"indosat","6285":"indosat",
    "62855":"indosat","62856":"indosat","62857":"indosat","62858":"indosat",
    "62814":"indosat","62815":"indosat","62816":"indosat",
    // XL
    "62817":"xl","62818":"xl","62819":"xl","62859":"xl","62877":"xl","62878":"xl",
    // Axis
    "62831":"axis","62832":"axis","62833":"axis","62838":"axis",
    // Tri
    "62895":"tri","62896":"tri","62897":"tri","62898":"tri","62899":"tri",
    // Smartfren
    "62881":"smartfren","62882":"smartfren","62883":"smartfren","62884":"smartfren",
    "62885":"smartfren","62886":"smartfren","62887":"smartfren","62888":"smartfren","62889":"smartfren",
    // by.U
    "62851":"byu",
  };

  return map[prefix5] || map[prefix4] || null;
}

function filterByOperator(produkList, nomor) {
  const op = detectOperator(nomor);
  if (!op) return produkList; // tidak terdeteksi, tampilkan semua

  const opRegex = {
    "telkomsel": /telkomsel|simpati|kartu as|loop/i,
    "indosat":   /indosat|im3|mentari/i,
    "xl":        /^xl/i,
    "axis":      /^axis/i,
    "tri":       /^tri|^three/i,
    "smartfren": /smartfren/i,
    "byu":       /by.?u/i,
  };

  const regex = opRegex[op];
  if (!regex) return produkList;

  const filtered = produkList.filter(p => regex.test(p.product_name));
  console.log(`📱 Operator: ${op} → ${filtered.length} produk`);
  return filtered.length > 0 ? filtered : produkList; // fallback ke semua kalau kosong
}

// Cache semua produk sekaligus
let digiAllProduk = null;
let digiAllProdukAt = 0;

async function digiGetAllProduk() {
  if (digiAllProduk && Date.now() - digiAllProdukAt < 3600000) return digiAllProduk;
  try {
    const sign = digiSign(DIGI_USER, DIGI_KEY(), "pricelist");
    const res = await fetchJSON("https://api.digiflazz.com/v1/price-list", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ cmd:"prepaid", username:DIGI_USER, sign })
    });
    if (res?.data) {
      digiAllProduk = res.data;
      digiAllProdukAt = Date.now();
      const cats = [...new Set(res.data.map(p => p.category))].sort();
      console.log("📦 SEMUA KATEGORI DIGIFLAZZ:", JSON.stringify(cats));
      return digiAllProduk;
    }
    console.error("digiGetAllProduk invalid:", JSON.stringify(res).substring(0,300));
    return [];
  } catch(e) { console.error("digiGetAllProduk error:", e.message); return []; }
}

async function digiGetProduk(kategori) {
  const all = await digiGetAllProduk();
  if (!all.length) return [];

  const cats = [...new Set(all.map(p => p.category))];

  // Map fleksibel: cocokkan semua kemungkinan nama kategori Digiflazz
  // Nama kategori ASLI dari Digiflazz (hasil /katdigi):
  // Pulsa, Data, PLN, E-Money, Games, TV, Masa Aktif, Paket SMS & Telpon, Voucher, dll
  const katMap = {
    "pulsa":    c => c === "Pulsa" || c === "Masa Aktif" || c === "Paket SMS & Telpon",
    "data":     c => c === "Data",
    "pln":      c => c === "PLN",
    "bpjs":     c => /bpjs/i.test(c),
    "game":     c => c === "Games" || c === "Voucher" || c === "Aktivasi Voucher",
    "ewallet":  c => c === "E-Money",
    "tv":       c => c === "TV",
    "gas":      c => c === "Gas",
    "internet": c => /internet|wifi/i.test(c),
  };

  const filterFn = katMap[kategori.toLowerCase()];
  const matchCats = filterFn ? cats.filter(filterFn) : cats.filter(c => c.toLowerCase().includes(kategori.toLowerCase()));

  console.log(`🔍 Kategori "${kategori}" → [${matchCats.join(", ")}]`);

  const filtered = all.filter(p =>
    matchCats.includes(p.category) &&
    p.seller_product_status === true
  );
  console.log(`✅ ${filtered.length} produk untuk "${kategori}"`);
  return filtered;
}

async function digiTransaksi({ sku, customerNo, refId }) {
  if (!DIGI_USER) return null;
  try {
    const sign = digiSign(DIGI_USER, DIGI_KEY(), refId);
    const payload = JSON.stringify({
      username: DIGI_USER,
      buyer_sku_code: sku,
      customer_no: customerNo,
      ref_id: refId,
      sign,
      testing: DIGI_MODE === "dev"
    });
    console.log("Digiflazz tx: SKU=" + sku + " No=" + customerNo);
    return await fetchJSON("https://api.digiflazz.com/v1/transaction", {
      method:"POST", headers:{"Content-Type":"application/json"}, body:payload
    });
  } catch(e) { console.error("digiTransaksi:", e.message); return null; }
}

// ── HELPERS ──────────────────────────────────────────────────
const fmt        = (n) => "Rp " + Math.round(n).toLocaleString("id-ID");
const ppn        = (fee) => Math.round(fee * 0.12);
const getPoints  = (n) => Math.round(n * 0.001);
const getTier    = (pts) => pts>=50001?"💎 Diamond":pts>=10001?"🥇 Gold":pts>=2001?"🥈 Silver":"🥉 Bronze";
const genOrderId = (uid, type) => `FRI-${type.toUpperCase()}-${uid}-${Date.now()}`;

// ── DEPOSIT MENU ─────────────────────────────────────────────
const DEPOSIT_OPTIONS = [50000, 100000, 200000, 500000, 1000000];

async function showDepositMenu(chatId, user) {
  const saldo = await getSaldo(chatId);
  const btns  = DEPOSIT_OPTIONS.map(n => [{ text:`💰 Top Up ${fmt(n)}`, callback_data:`deposit_${n}` }]);
  btns.push([{ text:"✏️ Nominal Lain", callback_data:"deposit_custom" }]);
  btns.push([{ text:"🏠 Menu Utama", callback_data:"back_main" }]);
  await bot.sendMessage(chatId,
    `💳 *Top Up Saldo*\n\n` +
    `💵 Saldo kamu sekarang: *${fmt(saldo)}*\n\n` +
    `Pilih nominal top up:\n` +
    `_Bayar via QRIS, Transfer Bank, GoPay, OVO, Dana, ShopeePay_`,
    { parse_mode:"Markdown", reply_markup:{ inline_keyboard:btns } }
  );
}

// ── KEYBOARDS ────────────────────────────────────────────────
const mainKeyboard = { reply_markup: { keyboard:[
  ["⚡ PPOB","🪙 Crypto"],
  ["💳 Deposit & Saldo","⭐ Poin & Reward"],
  ["📋 Riwayat","💬 Bantuan"]
], resize_keyboard:true }};

const ppobKeyboard = { reply_markup: { inline_keyboard:[
  [{text:"📱 Pulsa",callback_data:"ppob_pulsa"},{text:"📶 Paket Data",callback_data:"ppob_data"}],
  [{text:"⚡ PLN",callback_data:"ppob_pln"}],
  [{text:"🎮 Top-up Game",callback_data:"ppob_game"},{text:"💚 E-Wallet",callback_data:"ppob_ewallet"}],
  [{text:"📺 TV Kabel",callback_data:"ppob_tv"},{text:"🔥 Gas Pertamina",callback_data:"ppob_gas"}],
  [{text:"🏠 Menu Utama",callback_data:"back_main"}]
]}};

const cryptoKeyboard = { reply_markup: { inline_keyboard:[
  [{text:"₿ BTC",callback_data:"crypto_BTC"},{text:"Ξ ETH",callback_data:"crypto_ETH"},{text:"◎ SOL",callback_data:"crypto_SOL"}],
  [{text:"🟡 BNB",callback_data:"crypto_BNB"},{text:"✕ XRP",callback_data:"crypto_XRP"},{text:"💵 USDT",callback_data:"crypto_USDT"}],
  [{text:"Ð DOGE",callback_data:"crypto_DOGE"},{text:"🔵 ADA",callback_data:"crypto_ADA"},{text:"🟣 MATIC",callback_data:"crypto_MATIC"}],
  [{text:"🔺 AVAX",callback_data:"crypto_AVAX"},{text:"📊 Semua",callback_data:"crypto_all"}],
  [{text:"🏠 Menu Utama",callback_data:"back_main"}]
]}};

// ── SYSTEM PROMPT ─────────────────────────────────────────────
const SYSTEM = `Kamu adalah asisten AI Friendly Indonesia — platform PPOB dan Crypto terpercaya Indonesia.
KEPRIBADIAN: Ramah, sopan, profesional tapi santai. Selalu Bahasa Indonesia. Pakai emoji secukupnya.
LAYANAN: PPOB (Pulsa, Data, PLN, Game, E-Wallet, TV Kabel) & CRYPTO realtime.
SISTEM SALDO: User bisa deposit saldo dulu (via Midtrans), lalu pakai saldo untuk transaksi. Atau bisa langsung bayar per transaksi via Midtrans tanpa deposit.
FEE: Pulsa Rp500+PPN12%, PLN Rp2000-2500+PPN12%, Crypto fee1%+PPh0.1%+PPN0.11%.
PENTING: Jangan janjikan keuntungan crypto. Selalu ingatkan risiko.`;

// ── /START ───────────────────────────────────────────────────
bot.onText(/\/katdigi/, async (msg) => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return;
  const all = await digiGetAllProduk();
  if (!all.length) return bot.sendMessage(msg.chat.id, "❌ Gagal ambil data Digiflazz");
  const cats = [...new Set(all.map(p => p.category))].sort();
  const txt = cats.map((c,i) => `${i+1}. ${c} (${all.filter(p=>p.category===c).length})`).join("\n");
  bot.sendMessage(msg.chat.id, `📦 *Kategori Digiflazz:*\n\n${txt}`, {parse_mode:"Markdown"});
});

bot.onText(/\/start/, async (msg) => {
  const id = msg.from.id, name = msg.from.first_name || "Pengguna";
  const user = await getOrCreateUser(id, name);
  const saldo = await getSaldo(id);
  await bot.sendMessage(id,
    `👋 Halo *${name}!* Selamat datang di *Friendly Indonesia* 🤝\n\n` +
    `Platform PPOB & Crypto #1 yang transparan & terpercaya.\n\n` +
    `💵 Saldo: *${fmt(saldo)}*\n` +
    `⭐ Poin: *${(user.points||500).toLocaleString("id-ID")} poin*\n` +
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

  if (text === "💳 Deposit & Saldo") return showDepositMenu(id, user);

  if (text === "🪙 Crypto") {
    await bot.sendChatAction(id, "typing");
    const prices = await getCryptoPrices();
    if (!Object.keys(prices).length) return bot.sendMessage(id, "⚠️ Gagal ambil harga. Coba lagi!", mainKeyboard);
    const lines = Object.entries(prices).map(([k,v]) => `${k}: *${fmt(v.price)}* ${v.change>=0?"▲":"▼"} ${Math.abs(v.change)}%`).join("\n");
    const saldo = await getSaldo(id);
    return bot.sendMessage(id,
      `🪙 *Harga Crypto Realtime*\n_CoinGecko · update 60 detik_\n\n${lines}\n\n💵 Saldo kamu: *${fmt(saldo)}*\n_Pilih koin:_`,
      { parse_mode:"Markdown", ...cryptoKeyboard }
    );
  }

  if (text === "⭐ Poin & Reward") {
    const pts = user.points||0;
    const next = user.tier==="🥉 Bronze"?"🥈 Silver (2.001)":user.tier==="🥈 Silver"?"🥇 Gold (10.001)":user.tier==="🥇 Gold"?"💎 Diamond (50.001)":"Sudah tertinggi! 🎉";
    return bot.sendMessage(id,
      `⭐ *Friendly Points*\n\n💰 Saldo: *${(users[id]?.saldo||0).toLocaleString()} poin... eh Rp ${(users[id]?.saldo||0).toLocaleString("id-ID")}*\n` +
      `⭐ Poin: *${pts.toLocaleString("id-ID")} poin*\n🏆 Tier: *${user.tier}*\n🎯 Berikutnya: ${next}\n\n` +
      `*Kumpul Poin:*\n• Tiap transaksi = 0.1% nominal\n• Referral = +1.000 poin\n\n` +
      `*Redeem:*\n• 500 poin = Pulsa Rp 5.000\n• 300 poin = Diskon fee 50%\n• 1.000 poin = Gratis 1x PLN`,
      { parse_mode:"Markdown", ...mainKeyboard }
    );
  }

  if (text === "📋 Riwayat") {
    const history = await getHistory(id, 5);
    if (!history?.length) return bot.sendMessage(id, "📋 Belum ada riwayat. Yuk transaksi pertama!", mainKeyboard);
    const hist = history.map((h,i) =>
      `${i+1}. *${h.type}* — ${h.date||h.created_at?.split("T")[0]}\n` +
      `   ${h.amount?fmt(h.amount):""} ${h.points?`+${h.points} poin`:""} ${h.status==="success"?"✅":h.status==="pending"?"⏳":"❌"}`
    ).join("\n\n");
    return bot.sendMessage(id, `📋 *Riwayat (5 terakhir)*\n\n${hist}`, { parse_mode:"Markdown", ...mainKeyboard });
  }

  if (text === "💬 Bantuan") return bot.sendMessage(id,
    `💬 *Bantuan*\n\nKetik pertanyaan langsung, atau:\n\n📱 Admin: @ariiyaantoo\n📧 friendlyidbusiness@gmail.com\n\n_AI siap 24/7!_ 🤖`,
    { parse_mode:"Markdown", ...mainKeyboard }
  );

  // ── DEPOSIT CUSTOM INPUT ──
  if (sessions[id]?.__waitingDeposit) {
    const amount = parseInt(text.replace(/[^0-9]/g, ""));
    if (!amount || amount < 10000) {
      return bot.sendMessage(id, "⚠️ Nominal minimal Rp 10.000. Ketik angka saja, contoh: *150000*", { parse_mode:"Markdown", reply_markup:{ inline_keyboard:[[{text:"❌ Batal",callback_data:"back_main"}]] } });
    }
    sessions[id].__waitingDeposit = false;
    const orderId = genOrderId(id, "DEP");
    const payment = await createMidtransPayment({ orderId, amount, customerName:name, itemName:`Deposit Saldo Friendly Indonesia ${fmt(amount)}` });
    pendingTx[orderId] = { userId:id, type:"deposit", amount, userName:name };
    if (payment?.redirect_url) {
      await addTxHistory(id, { type:`Deposit ${fmt(amount)}`, amount, order_id:orderId, status:"pending" });
      return bot.sendMessage(id,
        `💳 *Link Pembayaran Deposit*

Nominal: *${fmt(amount)}*
Order ID: \`${orderId}\`

✅ Saldo otomatis masuk setelah bayar!`,
        { parse_mode:"Markdown", reply_markup:{ inline_keyboard:[
          [{ text:`💳 Bayar ${fmt(amount)}`, url:payment.redirect_url }],
          [{ text:"🏠 Menu Utama", callback_data:"back_main" }]
        ]}}
      );
    }
    return bot.sendMessage(id, "⚠️ Gagal buat link pembayaran. Cek konfigurasi Midtrans.", mainKeyboard);
  }

  // ── PPOB INPUT HANDLER ──
  if (sessions[id]?.__ppobStep === "input_nomor") {
    const type = sessions[id].__ppobType;
    const nomor = text.replace(/\s+/g, "").replace(/[^0-9]/g, "");
    if (nomor.length < 6) return bot.sendMessage(id, "⚠️ Nomor tidak valid. Coba lagi!", { reply_markup:{ inline_keyboard:[[{text:"❌ Batal",callback_data:"back_ppob"}]] } });

    const digiKats = { pulsa:"pulsa", data:"data", pln:"pln", bpjs:"bpjs", game:"game", ewallet:"ewallet", tv:"tv", internet:"internet" };
    await bot.sendChatAction(id, "typing");
    await bot.sendMessage(id, "🔍 Mengambil daftar produk...");

    let produkList = await digiGetProduk(digiKats[type] || type);
    if (!produkList.length) {
      delete sessions[id].__ppobType; delete sessions[id].__ppobStep;
      return bot.sendMessage(id, "⚠️ Produk tidak tersedia saat ini. Coba lagi nanti.", mainKeyboard);
    }

    // Filter by operator untuk pulsa & data
    if (type === "pulsa" || type === "data") {
      produkList = filterByOperator(produkList, nomor);
    }

    // Sort by harga ascending
    produkList.sort((a, b) => (a.price || 0) - (b.price || 0));

    // Simpan nomor & produk list di session
    sessions[id].__ppobNomor = nomor;
    sessions[id].__ppobStep = "pilih_produk";
    sessions[id].__ppobProduk = produkList;

    const PAGE_SIZE = 8;
    sessions[id].__ppobPage = 0;
    const allProduk = sessions[id].__ppobProduk;
    const totalPages = Math.ceil(allProduk.length / PAGE_SIZE);
    const displayed = allProduk.slice(0, PAGE_SIZE);

    const op = (type === "pulsa" || type === "data") ? detectOperator(nomor) : null;
    const opLabel = op ? ` (${op.charAt(0).toUpperCase()+op.slice(1)})` : "";
    const svcNames = { pulsa:"Pulsa", data:"Paket Data", pln:"Listrik PLN", game:"Top-up Game", ewallet:"E-Wallet", tv:"TV Kabel", gas:"Gas Pertamina" };

    const btns = displayed.map((p, i) => [{ text: `${p.product_name} — ${fmt(p.price)}`, callback_data: `px_${type}_${i}_${nomor}` }]);
    if (totalPages > 1) btns.push([{ text:`➡️ Lainnya (hal 2/${totalPages})`, callback_data:`pxp_${type}_1_${nomor}` }]);
    btns.push([{ text:"❌ Batal", callback_data:"back_ppob" }]);

    return bot.sendMessage(id,
      `📱 *Pilih Produk ${svcNames[type] || type}${opLabel}*\nNomor: *${nomor}*\n\nPilih nominal:`,
      { parse_mode:"Markdown", reply_markup:{ inline_keyboard: btns } }
    );
  }

  // AI Chat — Gemini
  try {
    await bot.sendChatAction(id, "typing");

    // Cek GEMINI_KEY
    if (!GEMINI_KEY) {
      console.error("❌ GEMINI_API_KEY tidak diset di environment variables!");
      return bot.sendMessage(id, "⚠️ Konfigurasi AI belum lengkap. Hubungi admin.", mainKeyboard);
    }

    if (!sessions[id]) sessions[id] = {};
    if (!sessions[id].__chat) sessions[id].__chat = [];
    sessions[id].__chat.push({ role:"user", parts:[{ text }] });
    if (sessions[id].__chat.length > 20) sessions[id].__chat = sessions[id].__chat.slice(-20);
    const saldo = await getSaldo(id);
    const systemPrompt = SYSTEM + `\nUser: ${name}, Saldo: ${fmt(saldo)}, Poin: ${user.points||0}, Tier: ${user.tier||"Bronze"}`;
    const geminiBody = JSON.stringify({
      system_instruction: { parts:[{ text: systemPrompt }] },
      contents: sessions[id].__chat
    });

    console.log(`🤖 Gemini request dari user ${id} (${name}): "${text.substring(0,50)}"`);

    const geminiRes = await fetchJSON(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      { method:"POST", headers:{"Content-Type":"application/json"}, body: geminiBody }
    );

    // Log response untuk debug
    if (geminiRes?.error) {
      console.error("❌ Gemini API error:", JSON.stringify(geminiRes.error));
      return bot.sendMessage(id, `⚠️ Gagal menghubungi AI: ${geminiRes.error.message||"Unknown error"}`, mainKeyboard);
    }

    const reply = geminiRes?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!reply) {
      console.error("❌ Gemini response kosong:", JSON.stringify(geminiRes).substring(0,200));
      return bot.sendMessage(id, "⚠️ AI tidak bisa menjawab sekarang. Coba lagi!", mainKeyboard);
    }

    console.log(`✅ Gemini OK, reply length: ${reply.length}`);
    sessions[id].__chat.push({ role:"model", parts:[{ text: reply }] });
    await bot.sendMessage(id, reply, { parse_mode:"Markdown", ...mainKeyboard });
  } catch(e) {
    console.error("❌ Gemini exception:", e.message);
    await bot.sendMessage(id, "⚠️ Gangguan sementara. Coba lagi ya!", mainKeyboard);
  }
});

// ── CALLBACKS ────────────────────────────────────────────────
bot.on("callback_query", async (query) => {
  const id   = query.from.id;
  const name = query.from.first_name || "Pengguna";
  const data = query.data;
  await getOrCreateUser(id, name);
  await bot.answerCallbackQuery(query.id);

  if (data === "back_main")   return bot.sendMessage(id, "🏠 Menu utama:", mainKeyboard);
  if (data === "back_ppob")   return bot.sendMessage(id, "⚡ *Layanan PPOB*", { parse_mode:"Markdown", ...ppobKeyboard });
  if (data === "back_crypto") return bot.sendMessage(id, "🪙 *Pilih Koin:*", { parse_mode:"Markdown", ...cryptoKeyboard });

  // ── DEPOSIT ──
  if (data === "deposit_custom") {
    if (!sessions[id]) sessions[id] = {};
    sessions[id].__waitingDeposit = true;
    // Clear PPOB session jika ada
    delete sessions[id].__ppobStep;
    delete sessions[id].__ppobType;
    return bot.sendMessage(id, "💳 Ketik nominal deposit (min Rp 10.000):\nContoh: *150000*", { parse_mode:"Markdown", reply_markup:{ inline_keyboard:[[{text:"❌ Batal",callback_data:"back_main"}]] } });
  }

  if (data.startsWith("deposit_")) {
    const amount  = parseInt(data.replace("deposit_", ""));
    const orderId = genOrderId(id, "DEP");
    const payment = await createMidtransPayment({ orderId, amount, customerName:name, itemName:`Deposit Saldo Friendly Indonesia ${fmt(amount)}` });

    // Simpan pending
    pendingTx[orderId] = { userId:id, type:"deposit", amount, userName:name };

    if (payment?.redirect_url) {
      await addTxHistory(id, { type:`Deposit ${fmt(amount)}`, amount, order_id:orderId, status:"pending" });
      return bot.sendMessage(id,
        `💳 *Link Pembayaran Deposit*\n\n` +
        `Nominal: *${fmt(amount)}*\n` +
        `Order ID: \`${orderId}\`\n\n` +
        `✅ Saldo otomatis masuk setelah bayar!\n` +
        `_Bayar via QRIS, Transfer, GoPay, OVO, Dana_`,
        { parse_mode:"Markdown", reply_markup:{ inline_keyboard:[
          [{ text:`💳 Bayar ${fmt(amount)}`, url:payment.redirect_url }],
          [{ text:"💰 Cek Saldo", callback_data:"cek_saldo" }],
          [{ text:"🏠 Menu Utama", callback_data:"back_main" }]
        ]}}
      );
    } else {
      return bot.sendMessage(id, "⚠️ Gagal buat link pembayaran. Cek konfigurasi Midtrans atau coba lagi.", mainKeyboard);
    }
  }

  if (data === "cek_saldo") {
    const saldo = await getSaldo(id);
    const u = users[id];
    return bot.sendMessage(id,
      `💵 *Saldo Kamu*\n\n` +
      `💰 Saldo: *${fmt(saldo)}*\n` +
      `⭐ Poin: *${(u?.points||0).toLocaleString("id-ID")} poin*\n` +
      `🏆 Tier: *${u?.tier||"🥉 Bronze"}*`,
      { parse_mode:"Markdown", reply_markup:{ inline_keyboard:[
        [{ text:"💳 Top Up Saldo", callback_data:"show_deposit" }],
        [{ text:"🏠 Menu Utama", callback_data:"back_main" }]
      ]}}
    );
  }

  if (data === "show_deposit") return showDepositMenu(id, users[id]);

  // ── PPOB ──
  if (data.startsWith("ppob_")) {
    const type = data.replace("ppob_", "");
    const info = {
      pulsa:   { icon:"📱", name:"Pulsa",       digiKat:"Pulsa",   inputMsg:"Ketik *nomor HP* tujuan pulsa:\nContoh: *08123456789*" },
      data:    { icon:"📶", name:"Paket Data",  digiKat:"Data",    inputMsg:"Ketik *nomor HP* untuk paket data:\nContoh: *08123456789*" },
      pln:     { icon:"⚡", name:"Listrik PLN", digiKat:"PLN",     inputMsg:"Ketik *ID Pelanggan PLN*:\nContoh: *123456789012*" },
      bpjs:    { icon:"🏥", name:"BPJS",        digiKat:"BPJS",    inputMsg:"Ketik *nomor BPJS*:\nContoh: *0001234567890*" },
      game:    { icon:"🎮", name:"Top-up Game", digiKat:"Games",   inputMsg:"Ketik *ID akun game*:\nContoh: *123456789 (Mobile Legends)*" },
      ewallet: { icon:"💚", name:"E-Wallet",    digiKat:"E-Money", inputMsg:"Ketik *nomor e-wallet*:\nContoh: *08123456789*" },
      tv:      { icon:"📺", name:"TV Kabel",    digiKat:"TV",      inputMsg:"Ketik *nomor pelanggan TV*:" },
      internet:{ icon:"🌐", name:"Internet",    digiKat:"Internet",inputMsg:"Ketik *ID pelanggan internet*:" },
    };
    const svc = info[type]; if (!svc) return;

    // Simpan session: user sedang input nomor untuk layanan ini
    if (!sessions[id]) sessions[id] = {};
    sessions[id].__ppobType = type;
    sessions[id].__ppobStep = "input_nomor";
    // Clear deposit session jika ada
    delete sessions[id].__waitingDeposit;

    const saldo = await getSaldo(id);
    return bot.sendMessage(id,
      `${svc.icon} *${svc.name}*\n\n${svc.inputMsg}\n\n💵 Saldo kamu: *${fmt(saldo)}*`,
      { parse_mode:"Markdown", reply_markup:{ inline_keyboard:[[{text:"❌ Batal",callback_data:"back_ppob"}]] } }
    );
  }

  // ── PPOB PICK (dari index session) ──
  if (data.startsWith("px_")) {
    // format: px_TYPE_IDX_NOMOR
    const parts2 = data.split("_");
    const type   = parts2[1];
    const idx    = parseInt(parts2[2]);
    const nomor  = parts2[3];
    if (!type || !nomor) return bot.sendMessage(id, "⚠️ Data tidak valid. Mulai ulang.", mainKeyboard);

    // Update session
    if (!sessions[id]) sessions[id] = {};
    sessions[id].__ppobType  = type;
    sessions[id].__ppobNomor = nomor;

    // Ambil produk dari cache atau fresh
    const produkList2 = await digiGetProduk(type);
    const produk = produkList2?.[idx];
    if (!produk) return bot.sendMessage(id, "⚠️ Produk tidak ditemukan. Mulai ulang.", mainKeyboard);

    const harga = produk.price || 0;
    const pts   = getPoints(harga);
    const saldo = await getSaldo(id);
    const svcNames = { pulsa:"Pulsa", data:"Paket Data", pln:"Listrik PLN", game:"Top-up Game", ewallet:"E-Wallet", tv:"TV Kabel", gas:"Gas Pertamina" };

    // Simpan pilihan produk ke session
    sessions[id].__ppobSku = produk.buyer_sku_code;

    return bot.sendMessage(id,
      `📋 *Konfirmasi Transaksi*\n\n` +
      `Layanan  : *${svcNames[type] || type}*\n` +
      `Produk   : *${produk.product_name}*\n` +
      `Nomor    : *${nomor}*\n` +
      `Harga    : *${fmt(harga)}*\n` +
      `🎁 Poin  : *+${pts} poin*\n\n` +
      `💵 Saldo : *${fmt(saldo)}*\n` +
      `${saldo >= harga ? "✅ Saldo cukup" : "⚠️ Saldo kurang — top up dulu"}`,
      { parse_mode:"Markdown", reply_markup:{ inline_keyboard:[
        saldo >= harga
          ? [{ text:"✅ Bayar Pakai Saldo", callback_data:"ppob_bayar_now" }]
          : [{ text:"💳 Top Up Dulu", callback_data:"show_deposit" }],
        [{ text:"❌ Batal", callback_data:"back_ppob" }]
      ]}}
    );
  }

  // ── PPOB PAGINASI ──
  if (data.startsWith("pxp_")) {
    // format: pxp_TYPE_PAGE_NOMOR
    const [,type, pageStr, nomor] = data.split("_");
    const page = parseInt(pageStr);
    const PAGE_SIZE = 8;
    const allProduk = sessions[id]?.__ppobProduk;
    if (!allProduk?.length) return bot.sendMessage(id, "⚠️ Session expired. Mulai ulang.", mainKeyboard);

    // Update session
    sessions[id].__ppobPage = page;
    const totalPages = Math.ceil(allProduk.length / PAGE_SIZE);
    const displayed = allProduk.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const svcNames = { pulsa:"Pulsa", data:"Paket Data", pln:"Listrik PLN", game:"Top-up Game", ewallet:"E-Wallet", tv:"TV Kabel", gas:"Gas Pertamina" };

    const btns = displayed.map((p, i) => [{ text: `${p.product_name} — ${fmt(p.price)}`, callback_data: `px_${type}_${page * PAGE_SIZE + i}_${nomor}` }]);
    const navRow = [];
    if (page > 0) navRow.push({ text:`⬅️ Hal ${page}`, callback_data:`pxp_${type}_${page-1}_${nomor}` });
    if (page < totalPages - 1) navRow.push({ text:`➡️ Hal ${page+2}/${totalPages}`, callback_data:`pxp_${type}_${page+1}_${nomor}` });
    if (navRow.length) btns.push(navRow);
    btns.push([{ text:"❌ Batal", callback_data:"back_ppob" }]);

    return bot.sendMessage(id,
      `📱 *${svcNames[type]||type}* — Hal ${page+1}/${totalPages}
Nomor: *${nomor}*`,
      { parse_mode:"Markdown", reply_markup:{ inline_keyboard: btns } }
    );
  }

  // ── PPOB KONFIRMASI ──
  if (data.startsWith("ppob_confirm_")) {
    const parts = data.split("_");
    // format: ppob_confirm_TYPE_SKU_NOMOR
    const type   = parts[2];
    const sku    = parts[3];
    const nomor  = parts[4];

    // Ambil info produk dari cache
    const svcNames = { pulsa:"Pulsa", data:"Paket Data", pln:"Listrik PLN", game:"Top-up Game", ewallet:"E-Wallet", tv:"TV Kabel", gas:"Gas Pertamina" };
    const digiKats = { pulsa:"Pulsa", data:"Data", pln:"PLN", game:"Games", ewallet:"E-Money", tv:"TV", gas:"Gas" };
    const produkList = await digiGetProduk(digiKats[type] || type);
    const produk = produkList.find(p => p.buyer_sku_code === sku);
    if (!produk) return bot.sendMessage(id, "⚠️ Produk tidak ditemukan. Coba lagi.", mainKeyboard);

    const harga  = produk.price || 0;
    const pts    = getPoints(harga);
    const saldo  = await getSaldo(id);

    return bot.sendMessage(id,
      `📋 *Konfirmasi Transaksi*\n\n` +
      `Layanan  : *${svcNames[type] || type}*\n` +
      `Produk   : *${produk.product_name}*\n` +
      `Nomor    : *${nomor}*\n` +
      `Harga    : *${fmt(harga)}*\n` +
      `🎁 Poin  : *+${pts} poin*\n\n` +
      `💵 Saldo : *${fmt(saldo)}*\n` +
      `${saldo >= harga ? "✅ Saldo cukup" : "⚠️ Saldo kurang — top up dulu"}`,
      { parse_mode:"Markdown", reply_markup:{ inline_keyboard:[
        saldo >= harga
          ? [{ text:"✅ Bayar Pakai Saldo", callback_data:`ppob_bayar_${type}_${sku}_${nomor}` }]
          : [{ text:"💳 Top Up Dulu", callback_data:"show_deposit" }],
        [{ text:"❌ Batal", callback_data:"back_ppob" }]
      ]}}
    );
  }

  // ── PPOB BAYAR ──
  if (data === "ppob_bayar_now" || data.startsWith("ppob_bayar_")) {
    const type  = sessions[id]?.__ppobType;
    const sku   = sessions[id]?.__ppobSku;
    const nomor = sessions[id]?.__ppobNomor;
    if (!type || !sku || !nomor) return bot.sendMessage(id, "⚠️ Session expired. Mulai ulang.", mainKeyboard);

    const digiKats = { pulsa:"Pulsa", data:"Data", pln:"PLN", game:"Games", ewallet:"E-Money", tv:"TV", gas:"Gas" };
    const produkList = await digiGetProduk(digiKats[type] || type);
    const produk = produkList.find(p => p.buyer_sku_code === sku);
    if (!produk) return bot.sendMessage(id, "⚠️ Produk tidak ditemukan.", mainKeyboard);

    const harga = produk.price || 0;
    const saldo = await getSaldo(id);
    if (saldo < harga) return bot.sendMessage(id, `⚠️ Saldo tidak cukup!\n\nSaldo: *${fmt(saldo)}*\nDibutuhkan: *${fmt(harga)}*`, { parse_mode:"Markdown", ...mainKeyboard });

    await bot.sendChatAction(id, "typing");
    const refId = genOrderId(id, "PPB");
    const result = await digiTransaksi({ sku, customerNo: nomor, refId });

    if (!result) return bot.sendMessage(id, "⚠️ Gagal terhubung ke server. Coba lagi!", mainKeyboard);

    const status = result?.data?.status;
    if (status === "Sukses" || status === "Pending") {
      const berhasil = await kurangiSaldo(id, harga);
      if (!berhasil) return bot.sendMessage(id, "⚠️ Gagal potong saldo.", mainKeyboard);

      const pts = getPoints(harga);
      users[id].points = (users[id].points || 0) + pts;
      await saveUser(id);
      await addTxHistory(id, { type: produk.product_name, amount: harga, order_id: refId, points: pts, status: status === "Sukses" ? "success" : "pending", date: new Date().toLocaleDateString("id-ID") });

      // Clear session
      if (sessions[id]) { delete sessions[id].__ppobType; delete sessions[id].__ppobStep; }

      return bot.sendMessage(id,
        `${status === "Sukses" ? "✅" : "⏳"} *Transaksi ${status}!*\n\n` +
        `Produk  : *${produk.product_name}*\n` +
        `Nomor   : *${nomor}*\n` +
        `Harga   : *${fmt(harga)}*\n` +
        `🎁 Poin : *+${pts} poin*\n` +
        `💵 Saldo: *${fmt(await getSaldo(id))}*\n\n` +
        `_Ref ID: \`${refId}\`_`,
        { parse_mode:"Markdown", ...mainKeyboard }
      );
    } else {
      const errMsg = result?.data?.message || result?.message || "Transaksi gagal";
      console.error("Digiflazz gagal:", JSON.stringify(result));
      return bot.sendMessage(id, `❌ *Transaksi Gagal*\n\n${errMsg}\n\nSaldo tidak dipotong.`, { parse_mode:"Markdown", ...mainKeyboard });
    }
  }

  // ── CRYPTO ──
  if (data.startsWith("crypto_")) {
    const ticker = data.replace("crypto_", "");
    await bot.sendChatAction(id, "typing");
    const prices = await getCryptoPrices();

    if (ticker === "all") {
      const lines = Object.entries(prices).map(([k,v]) =>
        `${k.padEnd(6)} ${fmt(v.price).padStart(22)}  ${v.change>=0?"▲":"▼"}${Math.abs(v.change)}%`
      ).join("\n");
      return bot.sendMessage(id, `📊 *Harga Crypto Realtime*\n\`\`\`\n${lines}\n\`\`\``, { parse_mode:"Markdown", ...cryptoKeyboard });
    }

    const coin = prices[ticker];
    if (!coin) return bot.sendMessage(id, "⚠️ Gagal ambil harga. Coba lagi!", mainKeyboard);
    const saldo   = await getSaldo(id);
    const nominal = 500000;
    const feeVal  = Math.round(nominal*0.01);
    const taxVal  = Math.round(nominal*0.0021);
    const total   = nominal+feeVal+taxVal;

    return bot.sendMessage(id,
      `${coin.change>=0?"🟢":"🔴"} *${ticker}*\n\n` +
      `💰 Harga: *${fmt(coin.price)}*\n` +
      `📈 24 jam: *${coin.change>=0?"▲":"▼"} ${Math.abs(coin.change)}%*\n\n` +
      `─────────────────\n` +
      `*Simulasi Beli Rp 500.000:*\n` +
      `Nilai        : ${fmt(nominal)}\nFee (1%)     : ${fmt(feeVal)}\nPajak (0.21%): ${fmt(taxVal)}\n` +
      `─────────────────\n` +
      `*Total Bayar : ${fmt(total)}*\n` +
      `Koin didapat : ≈${(nominal/coin.price).toFixed(8)} ${ticker}\n` +
      `🎁 Poin      : +${getPoints(nominal)} poin\n\n` +
      `💵 Saldo kamu: *${fmt(saldo)}*\n` +
      `${saldo>=total?"✅ Saldo cukup untuk transaksi ini":"⚠️ Saldo kurang — top up dulu atau bayar langsung"}`,
      { parse_mode:"Markdown", reply_markup:{ inline_keyboard:[
        saldo>=total
          ? [{text:`🟢 Beli ${ticker} (Pakai Saldo)`,callback_data:`buy_saldo_${ticker}_${nominal}`}]
          : [{text:`💳 Beli ${ticker} (Bayar Langsung)`,callback_data:`buy_direct_${ticker}_${nominal}`},{text:"💰 Top Up",callback_data:"show_deposit"}],
        [{text:`🔴 Jual ${ticker}`,callback_data:`order_sell_${ticker}`},{text:"⬅️ Kembali",callback_data:"back_crypto"}]
      ]}}
    );
  }

  // ── BELI PAKAI SALDO ──
  if (data.startsWith("buy_saldo_")) {
    const parts   = data.split("_");
    const ticker  = parts[2];
    const nominal = parseInt(parts[3]);
    const prices  = await getCryptoPrices();
    const coin    = prices[ticker];
    const feeVal  = Math.round(nominal*0.01);
    const taxVal  = Math.round(nominal*0.0021);
    const total   = nominal+feeVal+taxVal;
    const saldo   = await getSaldo(id);

    if (saldo < total) {
      return bot.sendMessage(id, `⚠️ Saldo tidak cukup!\n\nSaldo: *${fmt(saldo)}*\nDibutuhkan: *${fmt(total)}*\n\nSilakan top up dulu.`, { parse_mode:"Markdown", reply_markup:{ inline_keyboard:[[{text:"💳 Top Up",callback_data:"show_deposit"}]] } });
    }

    // Proses
    const berhasil = await kurangiSaldo(id, total);
    if (!berhasil) return bot.sendMessage(id, "⚠️ Gagal proses. Coba lagi!", mainKeyboard);

    const pts = getPoints(nominal);
    users[id].points = (users[id].points||0) + pts;
    await saveUser(id);

    const orderId = genOrderId(id, "BUY");
    await addTxHistory(id, { type:`Beli ${ticker}`, amount:total, order_id:orderId, points:pts, status:"success", date:new Date().toLocaleDateString("id-ID") });

    return bot.sendMessage(id,
      `✅ *Transaksi Berhasil!*\n\n` +
      `₿ Beli *${ticker}*\n` +
      `Nominal  : ${fmt(nominal)}\nFee      : ${fmt(feeVal)}\nPajak    : ${fmt(taxVal)}\n` +
      `─────────────────\n` +
      `*Total   : ${fmt(total)}*\n` +
      `Koin     : ≈${(nominal/coin.price).toFixed(8)} ${ticker}\n` +
      `🎁 Poin  : +${pts} poin\n` +
      `💵 Saldo : ${fmt(await getSaldo(id))}\n\n` +
      `_Order ID: \`${orderId}\`_`,
      { parse_mode:"Markdown", ...mainKeyboard }
    );
  }

  // ── BELI BAYAR LANGSUNG (Midtrans) ──
  if (data.startsWith("buy_direct_")) {
    const parts   = data.split("_");
    const ticker  = parts[2];
    const nominal = parseInt(parts[3]);
    const feeVal  = Math.round(nominal*0.01);
    const taxVal  = Math.round(nominal*0.0021);
    const total   = nominal+feeVal+taxVal;
    const orderId = genOrderId(id, "BUY");

    const payment = await createMidtransPayment({ orderId, amount:total, customerName:name, itemName:`Beli ${ticker} - Friendly Indonesia` });
    pendingTx[orderId] = { userId:id, type:`Beli ${ticker}`, amount:total, ticker, nominal };

    if (payment?.redirect_url) {
      await addTxHistory(id, { type:`Beli ${ticker}`, amount:total, order_id:orderId, status:"pending", date:new Date().toLocaleDateString("id-ID") });
      return bot.sendMessage(id,
        `💳 *Pembayaran Langsung*\n\nBeli *${ticker}*\nTotal: *${fmt(total)}*\nOrder: \`${orderId}\`\n\n_Saldo otomatis dikreditkan setelah bayar_`,
        { parse_mode:"Markdown", reply_markup:{ inline_keyboard:[
          [{ text:`💳 Bayar ${fmt(total)}`, url:payment.redirect_url }],
          [{ text:"⬅️ Kembali", callback_data:`crypto_${ticker}` }]
        ]}}
      );
    }
    return bot.sendMessage(id, "⚠️ Gagal buat link pembayaran. Coba lagi.", mainKeyboard);
  }

  // ── JUAL CRYPTO ──
  if (data.startsWith("order_sell_")) {
    const ticker = data.replace("order_sell_", "");
    return bot.sendMessage(id,
      `🔴 *Jual ${ticker}*\n\nFitur jual crypto akan segera tersedia!\n\nUntuk sementara hubungi admin:\n📱 @ariiyaantoo`,
      { parse_mode:"Markdown", reply_markup:{ inline_keyboard:[[{text:"⬅️ Kembali",callback_data:`crypto_${ticker}`}]] } }
    );
  }
});

// ── WEBHOOK SERVER (Midtrans Notification) ───────────────────
// Railway otomatis expose PORT
http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/midtrans-webhook") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const notif = JSON.parse(body);
        const { order_id, transaction_status, fraud_status, gross_amount, signature_key } = notif;

        // Verifikasi signature
        const expectedSig = verifyMidtransSignature(order_id, notif.status_code, gross_amount, MIDTRANS_SERVER_KEY);
        if (signature_key !== expectedSig) {
          console.log("Invalid Midtrans signature:", order_id);
          res.writeHead(400); res.end("Invalid signature");
          return;
        }

        const isSuccess = (transaction_status === "capture" && fraud_status === "accept") ||
                           transaction_status === "settlement";

        if (isSuccess && pendingTx[order_id]) {
          const tx = pendingTx[order_id];
          const userId = tx.userId;

          if (tx.type === "deposit") {
            // Tambah saldo
            await tambahSaldo(userId, tx.amount);
            await addTxHistory(userId, { type:`Deposit ${fmt(tx.amount)}`, amount:tx.amount, order_id, status:"success", date:new Date().toLocaleDateString("id-ID") });
            // Notif ke user
            await bot.sendMessage(userId,
              `✅ *Deposit Berhasil!*\n\n💵 *${fmt(tx.amount)}* sudah masuk ke saldo kamu!\n\nSaldo sekarang: *${fmt(await getSaldo(userId))}*\n\nYuk mulai transaksi! 🚀`,
              { parse_mode:"Markdown", ...mainKeyboard }
            );
          } else if (tx.type?.startsWith("Beli")) {
            // Proses beli crypto setelah bayar
            const prices = await getCryptoPrices();
            const coin   = prices[tx.ticker];
            const pts    = getPoints(tx.nominal||tx.amount);
            if (users[userId]) { users[userId].points = (users[userId].points||0) + pts; await saveUser(userId); }
            await addTxHistory(userId, { type:tx.type, amount:tx.amount, order_id, points:pts, status:"success", date:new Date().toLocaleDateString("id-ID") });
            await bot.sendMessage(userId,
              `✅ *Pembelian Berhasil!*\n\n${tx.type}\nTotal bayar: *${fmt(tx.amount)}*\n${coin?`Koin: ≈${((tx.nominal||tx.amount)/coin.price).toFixed(8)} ${tx.ticker}`:""}\n🎁 Poin: +${pts} poin\n\n_Order ID: \`${order_id}\`_`,
              { parse_mode:"Markdown", ...mainKeyboard }
            );
          }
          delete pendingTx[order_id];
        }

        res.writeHead(200); res.end("OK");
      } catch(e) {
        console.error("Webhook error:", e.message);
        res.writeHead(500); res.end("Error");
      }
    });
  } else if (req.url === "/health") {
    res.writeHead(200); res.end(JSON.stringify({ status:"ok", version:"3.0", uptime:process.uptime() }));
  } else {
    res.writeHead(200); res.end("🤝 Friendly Indonesia Bot v3.0");
  }
}).listen(PORT, () => console.log(`🌐 Webhook server: http://localhost:${PORT}`));

// ── ADMIN ────────────────────────────────────────────────────
bot.onText(/\/admin/, async (msg) => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return;
  const saldo = await digiCekSaldo();
  const totalUsers = Object.keys(users).length;
  await bot.sendMessage(msg.from.id,
    `🔧 *Admin Dashboard v3.0*\n\n` +
    `👥 Session aktif: *${totalUsers} user*\n` +
    `⏳ Pending tx: *${Object.keys(pendingTx).length}*\n` +
    `🤖 Bot: *Online ✅*\n` +
    `📡 Crypto: *CoinGecko Realtime ✅*\n` +
    `🏪 Digiflazz Mode: *${DIGI_MODE === "prod"?"🟢 Production":"🟡 Development"}*\n` +
    `💳 Midtrans: *${MIDTRANS_SERVER_KEY?"✅ "+MIDTRANS_MODE:"⚠️ Belum diisi"}*\n` +
    `🏪 Digiflazz: *${DIGI_USER?"✅ Aktif":"⚠️ Belum diisi"}*\n` +
    `🗄️ Database: *${SUPABASE_URL?"✅ Supabase":"⚠️ In-memory"}*` +
    `${saldo?.data?.deposit?"\n💰 Saldo Digi: *"+fmt(saldo.data.deposit)+"*":""}`,
    { parse_mode:"Markdown" }
  );
});

bot.on("polling_error", (err) => console.error("Polling:", err.message));
process.on("unhandledRejection", (err) => console.error("Unhandled:", err.message));

console.log("🤝 Friendly Indonesia Bot v3.0 RUNNING");
console.log(`Midtrans: ${MIDTRANS_SERVER_KEY?"ACTIVE ("+MIDTRANS_MODE+")":"pending config"}`);
console.log(`Digiflazz: ${DIGI_USER?"ACTIVE":"pending config"}`);
console.log(`Database: ${SUPABASE_URL?"Supabase":"in-memory fallback"}`);
