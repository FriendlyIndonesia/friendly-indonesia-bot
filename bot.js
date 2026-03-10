// ============================================================
// FRIENDLY INDONESIA — TELEGRAM BOT AI v3.0
// Fitur: Wallet/Deposit, Pay-per-tx, Midtrans Webhook, CoinGecko
// ============================================================

const TelegramBot = require("node-telegram-bot-api");
const Anthropic   = require("@anthropic-ai/sdk");
const https       = require("https");
const http        = require("http");
const crypto      = require("crypto");

// ── CONFIG ──────────────────────────────────────────────────
const BOT_TOKEN           = process.env.BOT_TOKEN;
const CLAUDE_KEY          = process.env.CLAUDE_API_KEY;
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
const claude = new Anthropic({ apiKey: CLAUDE_KEY });

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
      if (ticker) result[ticker] = { price:val.idr||0, change:parseFloat((val.idr_24h_change||0).toFixed(2)) };
    }
    cryptoCache = result; cryptoCacheAt = Date.now();
    return result;
  } catch(e) { console.error("CoinGecko:", e.message); return cryptoCache; }
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
function digiSign(user, key, refId="") {
  return crypto.createHash("md5").update(user + key + refId).digest("hex");
}
async function digiCekSaldo() {
  if (!DIGI_USER) return null;
  try {
    const sign = digiSign(DIGI_USER, DIGI_KEY_DEV, "info");
    const payload = JSON.stringify({ cmd:"deposit", username:DIGI_USER, sign });
    return fetchJSON("https://api.digiflazz.com/v1/cek-saldo", {
      method:"POST", headers:{"Content-Type":"application/json"}, body:payload
    });
  } catch(e) { return null; }
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

// ── SYSTEM PROMPT ─────────────────────────────────────────────
const SYSTEM = `Kamu adalah asisten AI Friendly Indonesia — platform PPOB dan Crypto terpercaya Indonesia.
KEPRIBADIAN: Ramah, sopan, profesional tapi santai. Selalu Bahasa Indonesia. Pakai emoji secukupnya.
LAYANAN: PPOB (Pulsa, Data, PLN, BPJS, Game, E-Wallet, TV, Internet) & CRYPTO realtime.
SISTEM SALDO: User bisa deposit saldo dulu (via Midtrans), lalu pakai saldo untuk transaksi. Atau bisa langsung bayar per transaksi via Midtrans tanpa deposit.
FEE: Pulsa Rp500+PPN12%, PLN/BPJS Rp2000-2500+PPN12%, Crypto fee1%+PPh0.1%+PPN0.11%.
PENTING: Jangan janjikan keuntungan crypto. Selalu ingatkan risiko.`;

// ── /START ───────────────────────────────────────────────────
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
    `💬 *Bantuan*\n\nKetik pertanyaan langsung, atau:\n\n📱 Admin: @FriendlyAdmin\n📧 hello@friendlyindonesia.id\n\n_AI siap 24/7!_ 🤖`,
    { parse_mode:"Markdown", ...mainKeyboard }
  );

  // AI Chat
  try {
    await bot.sendChatAction(id, "typing");
    if (!sessions[id]) sessions[id] = [];
    sessions[id].push({ role:"user", content:text });
    if (sessions[id].length > 20) sessions[id] = sessions[id].slice(-20);
    const saldo = await getSaldo(id);
    const res = await claude.messages.create({
      model:"claude-sonnet-4-20250514", max_tokens:1000,
      system: SYSTEM + `\nUser: ${name}, Saldo: ${fmt(saldo)}, Poin: ${user.points||0}, Tier: ${user.tier||"Bronze"}`,
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
    sessions[id] = sessions[id] || [];
    sessions[id].__waitingDeposit = true;
    return bot.sendMessage(id, "💳 Ketik nominal deposit (min Rp 10.000):\nContoh: *150000*", { parse_mode:"Markdown" });
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
    const saldo = await getSaldo(id);
    return bot.sendMessage(id,
      `${svc.icon} *${svc.name}*\n\n${svc.msg}\n\n` +
      `💰 Fee: *${fmt(svc.fee)}* + PPN *${fmt(ppn(svc.fee))}*\n` +
      `💵 Saldo kamu: *${fmt(saldo)}*\n` +
      `🎁 Poin: 0.1% dari nominal\n\n` +
      `_Ketik detail transaksi — bayar pakai saldo atau langsung via Midtrans_ 👆`,
      { parse_mode:"Markdown", reply_markup:{ inline_keyboard:[[{text:"⬅️ Kembali",callback_data:"back_ppob"},{text:"💳 Top Up Dulu",callback_data:"show_deposit"}]] } }
    );
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
      `🔴 *Jual ${ticker}*\n\nFitur jual crypto akan segera tersedia!\n\nUntuk sementara hubungi admin:\n📱 @FriendlyAdmin`,
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
