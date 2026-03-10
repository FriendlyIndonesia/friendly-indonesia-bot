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

// ── CRYPTO DEPOSIT CONFIG ────────────────────────────────────
const ETHERSCAN_KEY   = process.env.ETHERSCAN_KEY   || "YZMMS47ASVN8YI5J1EDTXUAQB1TCJT1Z9E";
const TRONGRID_KEY    = process.env.TRONGRID_KEY    || "c4ea2cd1-37fa-4ed2-8125-7c155513e025";
const EVM_WALLET      = "0x7962531c30d5d793525aef90e20fcc23fe955c53";
const TRON_WALLET     = "TBaAYLwDWPUgdiMra4BAR5AY6kMAXDwX3d";

// USDT contract addresses per network
const USDT_CONTRACTS = {
  eth:      { chainId:"1",   contract:"0xdac17f958d2ee523a2206206994597c13d831ec7", name:"ERC-20", symbol:"ETH",  decimals:6  },
  bsc:      { chainId:"56",  contract:"0x55d398326f99059ff775485246999027b3197955", name:"BEP-20", symbol:"BSC",  decimals:18 },
  polygon:  { chainId:"137", contract:"0xc2132d05d31c914a87c6611c10748aeb04b58e8f", name:"Polygon",symbol:"POL",  decimals:6  },
  arbitrum: { chainId:"42161",contract:"0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", name:"Arbitrum",symbol:"ARB", decimals:6  },
  tron:     { chainId:"tron",contract:"TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",         name:"TRC-20", symbol:"TRX", decimals:6  },
};

// Pending crypto deposits: { txHash: { userId, amount, network, createdAt } }
const pendingCryptoDeposit = {};
// Processed tx hashes (anti double-process)
const processedCryptoTx = new Set();

const bot    = new TelegramBot(BOT_TOKEN, { polling: true });


// ── IN-MEMORY STORE (fallback kalau Supabase belum diisi) ───
const users    = {}; // { userId: { name, points, tier, saldo, history } }
const sessions = {};
const pendingTx= {}; // { orderId: { userId, type, amount, detail } }

// ── FETCH HELPER ─────────────────────────────────────────────
function fetchJSON(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;
    const body = options.body;
    const hdrs = Object.assign({}, options.headers || {});
    if (body) hdrs["Content-Length"] = Buffer.byteLength(body);
    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: options.method || "GET",
      headers: hdrs,
    };
    const req = lib.request(reqOpts, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { console.error("fetchJSON parse error url=" + url.split("?")[0], data.substring(0,300)); reject(new Error(data)); }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
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
  users[id] = { ...user, portfolio: user.portfolio || {}, loaded:true };
  return users[id];
}

async function saveUser(id) {
  const u = users[id]; if (!u) return;
  u.tier = getTier(u.points);
  await SB.upsert("users", {
    telegram_id: id,
    name:      u.name,
    points:    u.points,
    tier:      u.tier,
    saldo:     u.saldo,
    portfolio: u.portfolio || {},
    prefs:     u.prefs || {}
  });
}

// Catat preferensi user (produk yang sering dibeli)
async function catatPreferensi(userId, type, detail) {
  if (!users[userId]) return;
  if (!users[userId].prefs) users[userId].prefs = {};
  const key = type; // "pulsa", "data", "pln", dll
  if (!users[userId].prefs[key]) users[userId].prefs[key] = {};
  // Simpan detail terakhir dan hitung frekuensi
  const prev = users[userId].prefs[key];
  users[userId].prefs[key] = {
    last:    detail,
    count:  (prev.count || 0) + 1,
    lastAt:  new Date().toISOString()
  };
  await saveUser(userId);
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
  // Kalau belum di-load dari DB, ambil dulu
  if (!users[userId]?.loaded) {
    const dbUser = await SB.get("users", `telegram_id=eq.${userId}`);
    if (dbUser) {
      users[userId] = { ...dbUser, loaded:true };
    }
  }
  return users[userId]?.saldo || 0;
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
// CoinGecko ID map → ticker
const COINGECKO_MAP = {
  bitcoin:"BTC", ethereum:"ETH", binancecoin:"BNB", solana:"SOL",
  ripple:"XRP", dogecoin:"DOGE", cardano:"ADA",
  "polygon-ecosystem-token":"MATIC", avalanche:"AVAX", tether:"USDT"
};
let cryptoCache = {}, cryptoCacheAt = 0;

async function getCryptoPrices() {
  if (Date.now() - cryptoCacheAt < 60000 && Object.keys(cryptoCache).length) return cryptoCache;

  // ── Sumber 1: CoinGecko (harga dalam IDR langsung + % change akurat) ──
  try {
    const ids  = Object.keys(COINGECKO_MAP).join(",");
    // Pakai endpoint simple/price yang lebih ringan & jarang di-rate-limit
    const data = await fetchJSON(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=idr&include_24hr_change=true`
    );
    if (!data || typeof data !== "object" || !Object.keys(data).length) throw new Error("CoinGecko empty");

    const result = {};
    for (const [id, val] of Object.entries(data)) {
      const ticker = COINGECKO_MAP[id];
      if (ticker && val.idr) result[ticker] = {
        price:  Math.round(val.idr),
        change: parseFloat((val.idr_24h_change || 0).toFixed(2))
      };
    }
    if (!Object.keys(result).length) throw new Error("CoinGecko no data parsed");

    cryptoCache = result; cryptoCacheAt = Date.now();
    console.log("✅ Crypto updated via CoinGecko simple/price");
    return result;
  } catch(e) {
    console.error("CoinGecko error:", e.message, "— trying KuCoin fallback...");
  }

  // ── Sumber 2: KuCoin (tidak diblokir Railway, support IDR via USDT rate) ──
  try {
    // Ambil kurs USD/IDR dari exchangerate-api (ringan, bebas blokir)
    const fxData  = await fetchJSON("https://open.er-api.com/v6/latest/USD");
    const idrRate = fxData?.rates?.IDR || 16200;

    // KuCoin: semua pair vs USDT
    const KUCOIN_TICKERS = ["BTC-USDT","ETH-USDT","BNB-USDT","SOL-USDT","XRP-USDT","DOGE-USDT","ADA-USDT","MATIC-USDT","AVAX-USDT"];
    const KUCOIN_MAP     = {"BTC-USDT":"BTC","ETH-USDT":"ETH","BNB-USDT":"BNB","SOL-USDT":"SOL","XRP-USDT":"XRP","DOGE-USDT":"DOGE","ADA-USDT":"ADA","MATIC-USDT":"MATIC","AVAX-USDT":"AVAX"};

    const kcData = await fetchJSON("https://api.kucoin.com/api/v1/market/allTickers");
    const tickers = kcData?.data?.ticker;
    if (!Array.isArray(tickers)) throw new Error("KuCoin response invalid");

    const result = {};
    for (const item of tickers) {
      const ticker = KUCOIN_MAP[item.symbol];
      if (ticker) result[ticker] = {
        price:  Math.round(parseFloat(item.last) * idrRate),
        change: parseFloat((parseFloat(item.changeRate || 0) * 100).toFixed(2))
      };
    }
    result["USDT"] = { price: Math.round(idrRate), change: 0 };
    if (!Object.keys(result).length) throw new Error("KuCoin no data parsed");

    cryptoCache = result; cryptoCacheAt = Date.now();
    console.log("✅ Crypto updated via KuCoin, IDR rate:", idrRate);
    return result;
  } catch(e) {
    console.error("KuCoin fallback error:", e.message);
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
const MT_PAYMENT_LINK_BASE = MIDTRANS_MODE === "production"
  ? "https://api.midtrans.com/v1/payment-links"
  : "https://api.sandbox.midtrans.com/v1/payment-links";

let _botUsername = null;
async function getBotUsername() {
  if (!_botUsername) { try { _botUsername = (await bot.getMe()).username; } catch(e) { _botUsername = "FriendlyIndonesiaBot"; } }
  return _botUsername;
}

async function createMidtransPayment({ orderId, amount, customerName, itemName }) {
  if (!MIDTRANS_SERVER_KEY) { console.error("MIDTRANS_SERVER_KEY tidak diset!"); return null; }
  const auth = Buffer.from(MIDTRANS_SERVER_KEY + ":").toString("base64");
  const authHeader = { "Authorization":"Basic " + auth, "Content-Type":"application/json" };
  const botUser = await getBotUsername();

  // Coba Payment Link API dulu
  try {
    const plPayload = JSON.stringify({
      transaction_details: { order_id:orderId, gross_amount:amount },
      customer_details: { first_name: customerName.substring(0,20) },
      item_details: [{ id:"1", price:amount, quantity:1, name:itemName.substring(0,50) }],
    });
    const plRes = await fetchJSON(MT_PAYMENT_LINK_BASE, {
      method:"POST", headers:authHeader, body:plPayload
    });
    console.log("Midtrans PaymentLink response:", JSON.stringify(plRes));
    if (plRes?.payment_url) return { redirect_url: plRes.payment_url };
  } catch(e) { console.error("Midtrans PaymentLink error:", e.message); }

  // Fallback ke Snap
  try {
    const snapPayload = JSON.stringify({
      transaction_details: { order_id:orderId, gross_amount:amount },
      customer_details: { first_name: customerName.substring(0,20) },
      item_details: [{ id:"1", price:amount, quantity:1, name:itemName.substring(0,50) }],
      callbacks: { finish:"https://t.me/" + botUser }
    });
    const snapRes = await fetchJSON(MT_BASE + "/transactions", {
      method:"POST", headers:authHeader, body:snapPayload
    });
    console.log("Midtrans Snap response:", JSON.stringify(snapRes));
    if (snapRes?.redirect_url) return snapRes;
  } catch(e) { console.error("Midtrans Snap error:", e.message); }

  return null;
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
    "game_ml":  c => c === "Games" || c === "Voucher" || c === "Aktivasi Voucher",
    "game_ff":  c => c === "Games" || c === "Voucher" || c === "Aktivasi Voucher",
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
const getTier    = (pts) => pts>=50000?"💎 Diamond":pts>=15000?"🥇 Gold":pts>=5000?"🥈 Silver":"🥉 Bronze";
const MIN_REDEEM = 5000; // minimum poin untuk redeem
const genOrderId = (uid, type) => `FRI-${type.toUpperCase()}-${uid}-${Date.now()}`;

// ── CRYPTO DEPOSIT DETAIL (pilih network) ────────────────────
async function showCryptoDepositDetail(chatId, userName, idrAmount) {
  const prices    = await getCryptoPrices();
  const usdtPrice = prices["USDT"]?.price || 16000;
  const usdtAmount = (idrAmount / usdtPrice).toFixed(2);
  await bot.sendMessage(chatId,
    `🔗 *Pilih Network*

` +
    `💰 Nominal: *${fmt(idrAmount)}*
` +
    `💵 USDT   : *≈ ${usdtAmount} USDT*

` +
    `Pilih network pengiriman:`,
    { parse_mode:"Markdown", reply_markup:{ inline_keyboard:[
      [{ text:"🟡 BEP-20 (BSC) — Fee Murah ⭐", callback_data:`crypto_dep_net_bsc_${idrAmount}` }],
      [{ text:"🔴 TRC-20 (Tron) — Fee Termurah ⭐", callback_data:`crypto_dep_net_tron_${idrAmount}` }],
      [{ text:"🟣 Polygon — Fee Murah", callback_data:`crypto_dep_net_polygon_${idrAmount}` }],
      [{ text:"🔵 Arbitrum", callback_data:`crypto_dep_net_arbitrum_${idrAmount}` }],
      [{ text:"⚫ ERC-20 (Ethereum) — Fee Mahal", callback_data:`crypto_dep_net_eth_${idrAmount}` }],
      [{ text:"⬅️ Kembali", callback_data:"deposit_method_crypto" }]
    ]}}
  );
}

// ── CRYPTO DEPOSIT MONITOR ───────────────────────────────────
async function checkEVMDeposit(network) {
  try {
    const cfg = USDT_CONTRACTS[network];
    const url = `https://api.etherscan.io/v2/api?chainid=${cfg.chainId}&module=account&action=tokentx&contractaddress=${cfg.contract}&address=${EVM_WALLET}&sort=desc&page=1&offset=20&apikey=${ETHERSCAN_KEY}`;
    const res = await fetchJSON(url);
    if (!Array.isArray(res?.result)) return;

    const now = Math.floor(Date.now() / 1000);
    for (const tx of res.result) {
      if (processedCryptoTx.has(tx.hash)) continue;
      if (now - parseInt(tx.timeStamp) > 3600) continue; // max 1 jam lalu
      if (tx.to?.toLowerCase() !== EVM_WALLET.toLowerCase()) continue;

      const usdtAmount = parseFloat(tx.value) / Math.pow(10, cfg.decimals);
      if (usdtAmount < 0.5) continue; // min $0.5

      // Cocokkan dengan pending deposit
      for (const [orderId, dep] of Object.entries(pendingCryptoDeposit)) {
        if (dep.network !== network) continue;
        if (dep.txConfirmed) continue;
        const expectedUsdt = dep.usdtAmount;
        if (Math.abs(usdtAmount - expectedUsdt) > expectedUsdt * 0.02) continue; // toleransi 2%

        // MATCH! Proses deposit
        processedCryptoTx.add(tx.hash);
        dep.txConfirmed = true;
        const idrAmount = dep.idrAmount;
        await tambahSaldo(dep.userId, idrAmount);
        const pts = getPoints(idrAmount);
        if (users[dep.userId]) { users[dep.userId].points = (users[dep.userId].points||0) + pts; await saveUser(dep.userId); }
        await addTxHistory(dep.userId, { type:`Deposit Crypto ${cfg.name}`, amount:idrAmount, order_id:orderId, points:pts, status:"success", date:new Date().toLocaleDateString("id-ID") });
        delete pendingCryptoDeposit[orderId];

        const saldoBaru = await getSaldo(dep.userId);
        await bot.sendMessage(dep.userId,
          `✅ *Deposit Berhasil!*

` +
          `🌐 Network  : *${cfg.name}*
` +
          `💵 USDT     : *${usdtAmount.toFixed(2)} USDT*
` +
          `💰 IDR      : *${fmt(idrAmount)}*
` +
          `🎁 Poin     : *+${pts} poin*
` +
          `💵 Saldo    : *${fmt(saldoBaru)}*

` +
          `🔖 Tx Hash  : \`${tx.hash.slice(0,20)}...\`
` +
          `_Screenshot sebagai bukti_ 📸`,
          { parse_mode:"Markdown", ...mainKeyboard }
        );
        if (ADMIN_ID) {
          await bot.sendMessage(ADMIN_ID, `💰 *Deposit Crypto Masuk*

User: ${dep.userName}
Network: ${cfg.name}
USDT: ${usdtAmount.toFixed(2)}
IDR: ${fmt(idrAmount)}`, { parse_mode:"Markdown" });
        }
        break;
      }
    }
  } catch(e) { console.error(`checkEVMDeposit ${network}:`, e.message); }
}

async function checkTronDeposit() {
  try {
    const url = `https://api.trongrid.io/v1/accounts/${TRON_WALLET}/transactions/trc20?limit=20&contract_address=${USDT_CONTRACTS.tron.contract}`;
    const res = await fetchJSON(url, { headers:{ "TRON-PRO-API-KEY": TRONGRID_KEY } });
    if (!Array.isArray(res?.data)) return;

    const now = Date.now();
    for (const tx of res.data) {
      if (processedCryptoTx.has(tx.transaction_id)) continue;
      if (now - tx.block_timestamp > 3600000) continue; // max 1 jam
      if (tx.to !== TRON_WALLET) continue;

      const usdtAmount = parseFloat(tx.value) / 1e6;
      if (usdtAmount < 0.5) continue;

      for (const [orderId, dep] of Object.entries(pendingCryptoDeposit)) {
        if (dep.network !== "tron") continue;
        if (dep.txConfirmed) continue;
        if (Math.abs(usdtAmount - dep.usdtAmount) > dep.usdtAmount * 0.02) continue;

        processedCryptoTx.add(tx.transaction_id);
        dep.txConfirmed = true;
        const idrAmount = dep.idrAmount;
        await tambahSaldo(dep.userId, idrAmount);
        const pts = getPoints(idrAmount);
        if (users[dep.userId]) { users[dep.userId].points = (users[dep.userId].points||0) + pts; await saveUser(dep.userId); }
        await addTxHistory(dep.userId, { type:`Deposit Crypto TRC-20`, amount:idrAmount, order_id:orderId, points:pts, status:"success", date:new Date().toLocaleDateString("id-ID") });
        delete pendingCryptoDeposit[orderId];

        const saldoBaru = await getSaldo(dep.userId);
        await bot.sendMessage(dep.userId,
          `✅ *Deposit Berhasil!*

` +
          `🌐 Network  : *TRC-20 (Tron)*
` +
          `💵 USDT     : *${usdtAmount.toFixed(2)} USDT*
` +
          `💰 IDR      : *${fmt(idrAmount)}*
` +
          `🎁 Poin     : *+${pts} poin*
` +
          `💵 Saldo    : *${fmt(saldoBaru)}*

` +
          `🔖 Tx Hash  : \`${tx.transaction_id.slice(0,20)}...\`
` +
          `_Screenshot sebagai bukti_ 📸`,
          { parse_mode:"Markdown", ...mainKeyboard }
        );
        if (ADMIN_ID) {
          await bot.sendMessage(ADMIN_ID, `💰 *Deposit Crypto Masuk*

User: ${dep.userName}
Network: TRC-20
USDT: ${usdtAmount.toFixed(2)}
IDR: ${fmt(idrAmount)}`, { parse_mode:"Markdown" });
        }
        break;
      }
    }
  } catch(e) { console.error("checkTronDeposit:", e.message); }
}

// Polling monitor setiap 20 detik
setInterval(async () => {
  if (Object.keys(pendingCryptoDeposit).length === 0) return; // skip kalau tidak ada pending
  await Promise.all([
    checkEVMDeposit("eth"),
    checkEVMDeposit("bsc"),
    checkEVMDeposit("polygon"),
    checkEVMDeposit("arbitrum"),
    checkTronDeposit()
  ]);
}, 20000);

// ── DEPOSIT MENU ─────────────────────────────────────────────
const DEPOSIT_OPTIONS = [50000, 100000, 200000, 500000, 1000000];

async function showDepositMenu(chatId, user) {
  const saldo = await getSaldo(chatId);
  await bot.sendMessage(chatId,
    `💳 *Top Up Saldo*

` +
    `💵 Saldo kamu: *${fmt(saldo)}*

` +
    `Pilih metode deposit:`,
    { parse_mode:"Markdown", reply_markup:{ inline_keyboard:[
      [{ text:"💳 Via Midtrans (QRIS/Bank)", callback_data:"deposit_method_midtrans" }],
      [{ text:"🔗 Via Crypto (USDT Otomatis)", callback_data:"deposit_method_crypto" }],
      [{ text:"🏠 Menu Utama", callback_data:"back_main" }]
    ]}}
  );
}

async function showMidtransDepositMenu(chatId) {
  const saldo = await getSaldo(chatId);
  const btns  = DEPOSIT_OPTIONS.map(n => [{ text:`💰 Top Up ${fmt(n)}`, callback_data:`deposit_${n}` }]);
  btns.push([{ text:"✏️ Nominal Lain", callback_data:"deposit_custom" }]);
  btns.push([{ text:"⬅️ Kembali", callback_data:"show_deposit" }]);
  await bot.sendMessage(chatId,
    `💳 *Top Up via Midtrans*

` +
    `💵 Saldo kamu: *${fmt(saldo)}*

` +
    `Pilih nominal:
` +
    `_Bayar via QRIS, Transfer Bank, GoPay, OVO, Dana_`,
    { parse_mode:"Markdown", reply_markup:{ inline_keyboard:btns } }
  );
}

async function showCryptoDepositMenu(chatId, userName) {
  const prices = await getCryptoPrices();
  const usdtPrice = prices["USDT"]?.price || 16000;
  await bot.sendMessage(chatId,
    `🔗 *Top Up via Crypto (USDT)*

` +
    `Kirim USDT ke wallet kami, saldo IDR otomatis masuk!

` +
    `💱 Rate: *1 USDT ≈ ${fmt(usdtPrice)}*

` +
    `Pilih nominal deposit:`,
    { parse_mode:"Markdown", reply_markup:{ inline_keyboard:[
      [{ text:"💰 Rp 50.000 (~$3)", callback_data:"crypto_dep_50000" }, { text:"💰 Rp 100.000 (~$6)", callback_data:"crypto_dep_100000" }],
      [{ text:"💰 Rp 200.000 (~$12)", callback_data:"crypto_dep_200000" }, { text:"💰 Rp 500.000 (~$31)", callback_data:"crypto_dep_500000" }],
      [{ text:"💰 Rp 1.000.000 (~$62)", callback_data:"crypto_dep_1000000" }],
      [{ text:"✏️ Nominal Lain", callback_data:"crypto_dep_custom" }],
      [{ text:"⬅️ Kembali", callback_data:"show_deposit" }]
    ]}}
  );
}

// ── KEYBOARDS ────────────────────────────────────────────────
const mainKeyboard = { reply_markup: { keyboard:[
  ["⚡ PPOB","🪙 Crypto"],
  ["💳 Deposit & Saldo","⭐ Poin & Reward"],
  ["📋 Riwayat","📦 Portfolio"],
  ["💬 Bantuan"]
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
PENTING: Jangan janjikan keuntungan crypto. Selalu ingatkan risiko.

PANDUAN REKOMENDASI PRODUK:
Kalau user menyebut niat beli/isi/bayar sesuatu, langsung arahkan ke menu yang tepat dengan instruksi spesifik. Contoh:
- "mau isi pulsa Telkomsel 50rb" -> "Yuk langsung tap menu ⚡ PPOB -> pilih Pulsa -> masukkan nomor Telkomsel kamu, nanti muncul pilihan nominal 50rb! 📱"
- "mau beli data XL" -> "Tap ⚡ PPOB -> pilih Data -> masukkan nomor XL kamu 🌐"
- "mau bayar listrik / PLN" -> "Tap ⚡ PPOB -> pilih PLN -> masukkan ID Pelanggan kamu ⚡"
- "mau topup GoPay/OVO/Dana/ShopeePay" -> "Tap ⚡ PPOB -> pilih E-Wallet -> pilih [nama ewallet] -> masukkan nomor HP kamu 💳"
- "mau beli game / top up ML / FF" -> "Tap ⚡ PPOB -> pilih Game -> pilih [nama game] 🎮"
- "mau beli BTC/ETH/crypto" -> "Tap menu 🪙 Crypto -> pilih koin -> pilih nominal 🚀"
- "mau deposit / isi saldo" -> "Tap menu 💳 Deposit & Saldo -> pilih nominal deposit 💵"
Selalu sebutkan menu dengan emoji yang sama persis agar user mudah menemukan.`;

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
  const isNew = (user.points || 0) === 500 && saldo === 0;

  // Ambil harga BTC realtime untuk ditampilkan di welcome
  let btcInfo = "";
  try {
    const prices = await getCryptoPrices();
    const btc = prices["BTC"];
    if (btc) btcInfo = `\n📈 BTC sekarang: *${fmt(btc.price)}* ${btc.change>=0?"▲":"▼"} ${Math.abs(btc.change)}%`;
  } catch(e) {}

  if (isNew) {
    // User baru
    await bot.sendMessage(id,
      `🎉 *Halo ${name}, selamat datang!*\n` +
      `Kamu baru bergabung di *Friendly Indonesia* 🤝\n\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `⚡ *PPOB* — Pulsa, Data, PLN, Game, E-Wallet\n` +
      `🪙 *Crypto* — Beli & pantau harga realtime\n` +
      `🤖 *AI Chat* — Tanya apapun, kami jawab!\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `🎁 Bonus daftar: *+500 poin* sudah masuk!\n` +
      `💵 Saldo: *${fmt(saldo)}*\n` +
      `⭐ Poin: *500 poin*\n` +
      `🏆 Tier: *🥉 Bronze*\n` +
      `${btcInfo}\n\n` +
      `_Ketik pertanyaan atau pilih menu di bawah 👇_`,
      { parse_mode:"Markdown", ...mainKeyboard }
    );
  } else {
    // User lama
    const hour = new Date().getHours();
    const greeting = hour < 11 ? "Selamat pagi" : hour < 15 ? "Selamat siang" : hour < 19 ? "Selamat sore" : "Selamat malam";
    await bot.sendMessage(id,
      `👋 *${greeting}, ${name}!*\n` +
      `Selamat kembali di *Friendly Indonesia* 🤝\n\n` +
      `💵 Saldo: *${fmt(saldo)}*\n` +
      `⭐ Poin: *${(user.points||0).toLocaleString("id-ID")} poin*\n` +
      `🏆 Tier: *${user.tier||"🥉 Bronze"}*\n` +
      `${btcInfo}\n\n` +
      `_Ada yang bisa dibantu hari ini? 😊_`,
      { parse_mode:"Markdown", ...mainKeyboard }
    );
  }
});

// ── MESSAGES ─────────────────────────────────────────────────
// ── RATE LIMITER ─────────────────────────────────────────────
const rateLimiter = {}; // { userId: { count, resetAt } }
function checkRateLimit(userId) {
  const now  = Date.now();
  const rl   = rateLimiter[userId];
  if (!rl || now > rl.resetAt) {
    rateLimiter[userId] = { count:1, resetAt: now + 10000 }; // window 10 detik
    return true;
  }
  if (rl.count >= 8) return false; // max 8 pesan per 10 detik
  rl.count++;
  return true;
}

bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;
  const id = msg.from.id, name = msg.from.first_name || "Pengguna";
  const text = msg.text.trim();

  // Rate limit check
  if (!checkRateLimit(id)) {
    // Kirim warning hanya sekali per window
    if (rateLimiter[id]?.count === 9) {
      await bot.sendMessage(id, "⚠️ Terlalu banyak pesan! Tunggu beberapa detik ya. 🙏");
    }
    return;
  }

  const user = await getOrCreateUser(id, name);

  if (text === "⚡ PPOB") return bot.sendMessage(id, "⚡ *Layanan PPOB*\nPilih layanan:", { parse_mode:"Markdown", ...ppobKeyboard });

  if (text === "💳 Deposit & Saldo") return showDepositMenu(id, user);

  if (text === "🪙 Crypto") {
    await bot.sendChatAction(id, "typing");
    const prices = await getCryptoPrices();
    if (!Object.keys(prices).length) return bot.sendMessage(id, "⚠️ Gagal ambil harga. Coba lagi!", mainKeyboard);
    const CRYPTO_ORDER = ["BTC","ETH","BNB","SOL","XRP","DOGE","ADA","MATIC","AVAX","USDT"];
    const sortedPrices = CRYPTO_ORDER.filter(k => prices[k]).map(k => [k, prices[k]]);
    const lines = sortedPrices.map(([k,v]) => `${k}: *${fmt(v.price)}* ${v.change>=0?"▲":"▼"} ${Math.abs(v.change)}%`).join("\n");
    const saldo = await getSaldo(id);
    return bot.sendMessage(id,
      `🪙 *Harga Crypto Realtime*\n_CoinGecko · update 60 detik_\n\n${lines}\n\n💵 Saldo kamu: *${fmt(saldo)}*\n_Pilih koin:_`,
      { parse_mode:"Markdown", ...cryptoKeyboard }
    );
  }

  if (text === "⭐ Poin & Reward") {
    const pts = user.points||0;
    const next = user.tier==="🥉 Bronze"?"🥈 Silver (5.000 poin)":user.tier==="🥈 Silver"?"🥇 Gold (15.000 poin)":user.tier==="🥇 Gold"?"💎 Diamond (50.000 poin)":"Sudah tertinggi! 🎉";
    return bot.sendMessage(id,
      `⭐ *Friendly Points*\n\n` +
      `💰 Saldo Bot: *Rp ${(users[id]?.saldo||0).toLocaleString("id-ID")}*\n` +
      `⭐ Poin: *${pts.toLocaleString("id-ID")} poin*\n🏆 Tier: *${user.tier}*\n🎯 Berikutnya: ${next}\n\n` +
      `*Kumpul Poin:*\n• Tiap transaksi = 0.1% dari nominal\n\n` +
      `*Redeem (1 poin = Rp 1):*\n• Gunakan poin sebagai potongan harga\n• Min. redeem: 5.000 poin (= Rp 5.000)\n• Redeem saat konfirmasi transaksi`,
      { parse_mode:"Markdown", ...mainKeyboard }
    );
  }

  if (text === "📋 Riwayat") {
    const history = await getHistory(id, 10);
    if (!history?.length) return bot.sendMessage(id, "📋 Belum ada riwayat. Yuk transaksi pertama!", mainKeyboard);
    const hist = history.map((h,i) => {
      const tgl  = h.date || (h.created_at ? new Date(h.created_at).toLocaleDateString("id-ID",{day:"2-digit",month:"short",year:"numeric"}) : "-");
      const jam  = h.created_at ? new Date(h.created_at).toLocaleTimeString("id-ID",{hour:"2-digit",minute:"2-digit"}) : "";
      const statusIcon = h.status==="success"?"✅":h.status==="pending"?"⏳":"❌";
      const statusLabel = h.status==="success"?"Sukses":h.status==="pending"?"Pending":"Gagal";
      const nominal = h.amount ? `💵 *${fmt(h.amount)}*` : "";
      const poin    = h.points ? `🎁 +${h.points} poin` : "";
      const orderId = h.order_id ? `\n   🔖 \`${h.order_id}\`` : "";
      return `${i+1}. ${statusIcon} *${h.type}*\n   📅 ${tgl}${jam?" "+jam:""} · ${statusLabel}\n   ${nominal} ${poin}${orderId}`;
    }).join("\n\n");
    const saldo = await getSaldo(id);
    return bot.sendMessage(id,
      `📋 *Riwayat Transaksi (10 terakhir)*\n💵 Saldo: *${fmt(saldo)}*\n\n${hist}`,
      { parse_mode:"Markdown", ...mainKeyboard }
    );
  }

  if (text === "📦 Portfolio") {
    await bot.sendChatAction(id, "typing");
    // Ambil portfolio dari Supabase / in-memory
    const portfolio = users[id]?.portfolio || {};
    const prices = await getCryptoPrices();
    const saldo = await getSaldo(id);

    if (!Object.keys(portfolio).length) {
      return bot.sendMessage(id,
        `📦 *Portfolio Crypto*\n\n` +
        `Kamu belum punya portfolio.\n\n` +
        `Cara tambah: ketik\n*portfolio tambah BTC 0.001*\n\n` +
        `_Contoh: portfolio tambah ETH 0.5_`,
        { parse_mode:"Markdown", ...mainKeyboard }
      );
    }

    let total = 0;
    const CRYPTO_ORDER = ["BTC","ETH","BNB","SOL","XRP","DOGE","ADA","MATIC","AVAX","USDT"];
    const lines = CRYPTO_ORDER.filter(k => portfolio[k]).map(k => {
      const qty   = portfolio[k];
      const price = prices[k]?.price || 0;
      const change = prices[k]?.change || 0;
      const nilai  = Math.round(qty * price);
      total += nilai;
      return `${change>=0?"🟢":"🔴"} *${k}*: ${qty} koin\n   💰 *${fmt(nilai)}* ${change>=0?"▲":"▼"} ${Math.abs(change)}%`;
    }).join("\n\n");

    return bot.sendMessage(id,
      `📦 *Portfolio Crypto*\n\n${lines}\n\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `💎 Total nilai: *${fmt(total)}*\n` +
      `💵 Saldo bot  : *${fmt(saldo)}*\n\n` +
      `_Tambah: *portfolio tambah BTC 0.001*_\n` +
      `_Hapus: *portfolio hapus BTC*_`,
      { parse_mode:"Markdown", ...mainKeyboard }
    );
  }

  // Handler input portfolio tambah/hapus
  if (/^portfolio (tambah|hapus)/i.test(text)) {
    const parts = text.trim().split(/\s+/);
    const action = parts[1]?.toLowerCase();
    const ticker = parts[2]?.toUpperCase();
    const qty    = parseFloat(parts[3]);
    const validTickers = ["BTC","ETH","BNB","SOL","XRP","DOGE","ADA","MATIC","AVAX","USDT"];

    if (!ticker || !validTickers.includes(ticker)) {
      return bot.sendMessage(id, `⚠️ Ticker tidak valid. Pilih: ${validTickers.join(", ")}`, mainKeyboard);
    }

    if (!users[id]) users[id] = {};
    if (!users[id].portfolio) users[id].portfolio = {};

    if (action === "hapus") {
      delete users[id].portfolio[ticker];
      await SB.upsert("users", { telegram_id:id, portfolio: users[id].portfolio });
      return bot.sendMessage(id, `✅ *${ticker}* dihapus dari portfolio.`, { parse_mode:"Markdown", ...mainKeyboard });
    }

    if (action === "tambah") {
      if (isNaN(qty) || qty <= 0) return bot.sendMessage(id, "⚠️ Jumlah tidak valid. Contoh: *portfolio tambah BTC 0.001*", { parse_mode:"Markdown", mainKeyboard });
      users[id].portfolio[ticker] = (users[id].portfolio[ticker] || 0) + qty;
      await SB.upsert("users", { telegram_id:id, portfolio: users[id].portfolio });
      const prices = await getCryptoPrices();
      const nilai  = Math.round(users[id].portfolio[ticker] * (prices[ticker]?.price || 0));
      return bot.sendMessage(id,
        `✅ Portfolio diperbarui!\n\n*${ticker}*: ${users[id].portfolio[ticker]} koin\n💰 Nilai sekarang: *${fmt(nilai)}*`,
        { parse_mode:"Markdown", ...mainKeyboard }
      );
    }
  }

  if (text === "💬 Bantuan") return bot.sendMessage(id,
    `💬 *Bantuan*\n\nKetik pertanyaan langsung, atau:\n\n📱 Admin: @ariiyaantoo\n📧 friendlyidbusiness@gmail.com\n\n_AI siap 24/7!_ 🤖`,
    { parse_mode:"Markdown", ...mainKeyboard }
  );

  // ── DEPOSIT CUSTOM INPUT ──
  // ── CRYPTO DEPOSIT NOMINAL CUSTOM ──
  if (sessions[id]?.__waitingCryptoDeposit) {
    sessions[id].__waitingCryptoDeposit = false;
    const amount = parseInt(text.replace(/[^0-9]/g, ""));
    if (isNaN(amount) || amount < 50000) return bot.sendMessage(id, "⚠️ Min deposit Rp 50.000.", mainKeyboard);
    await showCryptoDepositDetail(id, name, amount);
    return;
  }

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
    // Game ML: simpan format "userID zoneID" (ada spasi), game lain & ewallet strip non-digit
    let nomor;
    if (type === "game_ml") {
      // Format ML: "112412569 (2559)" → "112412569 2559" (hanya angka dan spasi)
      nomor = text.replace(/[^0-9 ]/g, "").trim();
    } else {
      nomor = text.replace(/[^0-9]/g, "");
    }
    if (nomor.length < 4) return bot.sendMessage(id, "⚠️ Nomor tidak valid. Coba lagi!", { reply_markup:{ inline_keyboard:[[{text:"❌ Batal",callback_data:"back_ppob"}]] } });

    const digiKats = { pulsa:"pulsa", data:"data", pln:"pln", bpjs:"bpjs", game:"game", ewallet:"ewallet", ewallet_dana:"ewallet", ewallet_gopay:"ewallet", ewallet_ovo:"ewallet", ewallet_shopee:"ewallet", tv:"tv", internet:"internet" };
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
    // Filter by game type
    if (type === "game_ml") {
      produkList = produkList.filter(p => /mobilelegend|mobile legend/i.test(p.product_name));
    } else if (type === "game_ff") {
      produkList = produkList.filter(p => /free.?fire/i.test(p.product_name));
    }
    // Filter by ewallet brand
    const ewalletBrandRegex = {
      ewallet_dana:   /dana/i,
      ewallet_gopay:  /gopay/i,
      ewallet_ovo:    /\bovo\b/i,
      ewallet_shopee: /shopee/i,
    };
    if (ewalletBrandRegex[type]) {
      const filtered = produkList.filter(p => ewalletBrandRegex[type].test(p.product_name));
      if (filtered.length > 0) produkList = filtered;
    }

    // Cek tagihan PLN dulu sebelum tampil produk
    if (type === "pln") {
      try {
        await bot.sendMessage(id, "🔍 Mengecek ID Pelanggan PLN...");
        const refId  = "CEK-PLN-" + Date.now();
        const sign   = require("crypto").createHash("md5").update(DIGI_USER + DIGI_KEY() + refId).digest("hex");
        // Cari produk PLN pascabayar / cek tagihan
        const cekProd = produkList.find(p => /pascabayar|tagihan/i.test(p.product_name)) || produkList[0];
        const inqRes = await fetchJSON("https://api.digiflazz.com/v1/transaction", {
          method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({ username:DIGI_USER, buyer_sku_code:cekProd.buyer_sku_code, customer_no:nomor, ref_id:refId, sign, testing: DIGI_MODE==="dev" })
        });
        const cekData = inqRes?.data;
        if (cekData?.customer_name) {
          await bot.sendMessage(id,
            `⚡ *Info Pelanggan PLN*\n\n` +
            `👤 Nama     : *${cekData.customer_name}*\n` +
            `🔢 ID       : *${nomor}*\n` +
            (cekData.selling_price ? `💵 Tagihan  : *${fmt(cekData.selling_price)}*\n` : "") +
            (cekData.desc ? `📋 Keterangan: ${cekData.desc}\n` : "") +
            `\nSilakan pilih produk di bawah:`,
            { parse_mode:"Markdown" }
          );
        }
      } catch(e) { console.error("PLN inquiry error:", e.message); }
    }

    // Sort by harga ascending
    // Filter produk yang dinonaktifkan admin
    produkList = produkList.filter(p => !disabledProducts.has(p.buyer_sku_code));
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
    const svcNames = { pulsa:"Pulsa", data:"Paket Data", pln:"Listrik PLN", game:"Top-up Game", ewallet:"E-Wallet", ewallet_dana:"DANA", ewallet_gopay:"GoPay", ewallet_ovo:"OVO", ewallet_shopee:"ShopeePay", tv:"TV Kabel", gas:"Gas Pertamina" };

    // Cek nama otomatis untuk e-wallet (gunakan produk "Cek Nama" di Digiflazz)
    const ewalletCekNamaSku = {
      ewallet_dana:   "dana-cek-nama",    // SKU akan dicari otomatis
      ewallet_gopay:  "gopay-cek-nama",
      ewallet_ovo:    "ovo-cek-nama",
      ewallet_shopee: "shopee-cek-nama",
    };

    if (type.startsWith("ewallet_")) {
      // Cari produk "Cek Nama" dari list produk
      const allEwallet = await digiGetProduk("ewallet");
      const cekNamaRegex = {
        ewallet_dana:   /cek.*nama.*dana|dana.*cek.*nama/i,
        ewallet_gopay:  /cek.*nama.*gopay|gopay.*cek.*nama/i,
        ewallet_ovo:    /cek.*nama.*ovo|ovo.*cek.*nama/i,
        ewallet_shopee: /cek.*nama.*shopee|shopee.*cek.*nama/i,
      };
      const cekNamaProduk = allEwallet.find(p => cekNamaRegex[type]?.test(p.product_name));

      if (cekNamaProduk) {
        await bot.sendMessage(id, `🔍 Mengecek nama pengguna ${svcNames[type]}...`);
        try {
          const refId = genOrderId(id, "CEK");
          const cekResult = await digiTransaksi({ sku: cekNamaProduk.buyer_sku_code, customerNo: nomor, refId });
          const namaUser = cekResult?.data?.customer_name || cekResult?.data?.sn || null;
          if (namaUser) {
            sessions[id].__ewalletNama = namaUser;
            await bot.sendMessage(id, `✅ *Nama ditemukan!*\n\n👤 Nama: *${namaUser}*\n📱 Nomor: *${nomor}*\n\nLanjut pilih nominal top-up:`, { parse_mode:"Markdown" });
          } else {
            await bot.sendMessage(id, `⚠️ Nama tidak ditemukan, lanjut pilih nominal:`, { parse_mode:"Markdown" });
          }
        } catch(e) {
          console.error("Cek nama ewallet error:", e.message);
          await bot.sendMessage(id, `⚠️ Gagal cek nama, lanjut pilih nominal:`);
        }
      }
    }

    const nomorEncoded = nomor.replace(/ /g, "-");
    const btns = displayed.map((p) => [{ text: `${p.product_name} — ${fmt(p.price)}`, callback_data: `pX.${type}.${p.buyer_sku_code}.${nomorEncoded}` }]);
    if (totalPages > 1) btns.push([{ text:`➡️ Lainnya (hal 2/${totalPages})`, callback_data:`pXp.${type}.1.${nomorEncoded}` }]);
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
    if (sessions[id].__chat.length > 50) sessions[id].__chat = sessions[id].__chat.slice(-50);
    const saldo = await getSaldo(id);

    // ── Ringkasan pengeluaran bulanan ──
    const ringkasanKeywords = /ringkasan|pengeluaran|total belanja|habis berapa|transaksi bulan|rekap|bulan ini|bulan lalu/i;
    if (ringkasanKeywords.test(text)) {
      try {
        const hist = await getHistory(id, 50);
        const now  = new Date();
        const thisMonth = now.getMonth();
        const thisYear  = now.getFullYear();
        const filtered  = hist.filter(h => {
          if (!h.created_at) return false;
          const d = new Date(h.created_at);
          return d.getMonth() === thisMonth && d.getFullYear() === thisYear && h.status === "success";
        });
        const totalSpend = filtered.reduce((s, h) => s + (h.amount || 0), 0);
        const totalPoin  = filtered.reduce((s, h) => s + (h.points || 0), 0);
        const byType = {};
        filtered.forEach(h => { byType[h.type] = (byType[h.type] || 0) + (h.amount || 0); });
        const topTypes = Object.entries(byType).sort((a,b) => b[1]-a[1]).slice(0,5)
          .map(([t,v]) => `${t}: Rp ${v.toLocaleString("id-ID")}`).join(", ");
        const bulanNama = now.toLocaleString("id-ID", { month:"long", year:"numeric" });
        const ringkasanCtx = `\nRINGKASAN PENGELUARAN USER BULAN ${bulanNama.toUpperCase()}: Total transaksi sukses: ${filtered.length} transaksi, Total pengeluaran: Rp ${totalSpend.toLocaleString("id-ID")}, Total poin didapat: ${totalPoin} poin. Rincian: ${topTypes || "belum ada transaksi"}. Gunakan data ini untuk menjawab pertanyaan user.`;
        const saldo2 = await getSaldo(id);
        const sp2 = SYSTEM + ringkasanCtx + `\nUser: ${name}, Saldo: ${fmt(saldo2)}, Poin: ${user.points||0}, Tier: ${user.tier||"Bronze"}`;
        await bot.sendChatAction(id, "typing");
        sessions[id].__chat.push({ role:"user", parts:[{ text }] });
        const gbody = JSON.stringify({ system_instruction:{ parts:[{ text:sp2 }] }, contents: sessions[id].__chat });
        const gres  = await fetchJSON(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`, { method:"POST", headers:{"Content-Type":"application/json"}, body:gbody });
        const greply = gres?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (greply) {
          sessions[id].__chat.push({ role:"model", parts:[{ text:greply }] });
          return bot.sendMessage(id, greply, { parse_mode:"Markdown", ...mainKeyboard });
        }
      } catch(e) { console.error("Ringkasan error:", e.message); }
    }

    // Inject harga realtime kalau user nanya soal crypto/harga
    const cryptoKeywords = /harga|price|berapa|btc|eth|sol|bnb|xrp|doge|ada|matic|avax|usdt|bitcoin|ethereum|solana|crypto|kripto/i;
    let cryptoContext = "";
    if (cryptoKeywords.test(text)) {
      try {
        const prices = await getCryptoPrices();
        const priceLines = Object.entries(prices).map(([k,v]) => `${k}: Rp ${v.price.toLocaleString("id-ID")} (${v.change >= 0 ? "+" : ""}${v.change}% 24h)`).join(", ");
        cryptoContext = `\nHARGA CRYPTO REALTIME SEKARANG (gunakan data ini, jangan tebak sendiri): ${priceLines}`;
        console.log("💰 Injecting realtime crypto prices to Gemini context");
      } catch(e) { console.error("Gagal inject harga crypto:", e.message); }
    }

    // Inject preferensi user ke context AI
    let prefsCtx = "";
    const prefs = users[id]?.prefs || user.prefs || {};
    if (Object.keys(prefs).length) {
      const prefLines = Object.entries(prefs)
        .sort((a,b) => (b[1].count||0) - (a[1].count||0))
        .slice(0,3)
        .map(([k,v]) => `${k} (${v.count}x, terakhir: ${v.last||"-"})`).join(", ");
      prefsCtx = `\nPREFERENSI USER (produk yang sering dibeli, suggest ini duluan): ${prefLines}`;
    }
    const systemPrompt = SYSTEM + cryptoContext + prefsCtx + `\nUser: ${name}, Saldo: ${fmt(saldo)}, Poin: ${user.points||0}, Tier: ${user.tier||"Bronze"}`;
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

// ── INVOICE GENERATOR ────────────────────────────────────────
function generateInvoice({ type, ticker, productName, nomor, nominal, feeVal, taxVal, total, jumlahKoin, pts, saldoSisa, orderId, namaCustomer }) {
  const tgl = new Date().toLocaleString("id-ID", { day:"2-digit", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit" });
  const isCrypto = !!ticker;

  let lines = "";
  if (isCrypto) {
    lines =
      `📋 Jenis    : *Pembelian Crypto*
` +
      `🪙 Aset     : *${ticker}*
` +
      `─────────────────────
` +
      `💵 Nominal  : *${fmt(nominal)}*
` +
      `💸 Fee (1%) : *${fmt(feeVal)}*
` +
      `🏛️ Pajak    : *${fmt(taxVal)}*
` +
      `─────────────────────
` +
      `💰 Total    : *${fmt(total)}*
` +
      `🔢 Koin     : *≈${jumlahKoin} ${ticker}*
`;
  } else {
    lines =
      `📋 Jenis    : *${type || "PPOB"}*
` +
      `📦 Produk   : *${productName}*
` +
      `📱 Nomor    : \`${nomor}\`
` +
      (namaCustomer ? `👤 Nama     : *${namaCustomer}*
` : "") +
      `─────────────────────
` +
      `💰 Total    : *${fmt(total)}*
`;
  }

  return (
    `✅ *INVOICE TRANSAKSI*
` +
    `━━━━━━━━━━━━━━━━━━━━
` +
    `📅 *${tgl}*

` +
    lines +
    `🎁 Poin     : *+${pts} poin*
` +
    `💵 Sisa     : *${fmt(saldoSisa)}*
` +
    `━━━━━━━━━━━━━━━━━━━━
` +
    `🔖 Order ID : \`${orderId}\`

` +
    `_Screenshot sebagai bukti transaksi_ 📸`
  );
}

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
  // ── PILIH METODE DEPOSIT ──
  if (data === "deposit_method_midtrans") return showMidtransDepositMenu(id);
  if (data === "deposit_method_crypto")   return showCryptoDepositMenu(id, name);

  // ── CRYPTO DEPOSIT NOMINAL ──
  if (data === "crypto_dep_custom") {
    if (!sessions[id]) sessions[id] = {};
    sessions[id].__waitingCryptoDeposit = true;
    return bot.sendMessage(id, "🔗 Ketik nominal deposit IDR (min Rp 50.000):
Contoh: *150000*", { parse_mode:"Markdown", reply_markup:{ inline_keyboard:[[{text:"❌ Batal",callback_data:"show_deposit"}]] } });
  }

  if (data.startsWith("crypto_dep_")) {
    const idrAmount = parseInt(data.replace("crypto_dep_", ""));
    if (isNaN(idrAmount) || idrAmount < 50000) return bot.sendMessage(id, "⚠️ Nominal tidak valid.");
    await showCryptoDepositDetail(id, name, idrAmount);
    return;
  }

  if (data.startsWith("crypto_dep_net_")) {
    // format: crypto_dep_net_[network]_[idrAmount]
    const parts   = data.replace("crypto_dep_net_", "").split("_");
    const network = parts[0];
    const idrAmount = parseInt(parts[1]);
    const cfg     = USDT_CONTRACTS[network];
    if (!cfg) return;

    const prices    = await getCryptoPrices();
    const usdtPrice = prices["USDT"]?.price || 16000;
    const usdtAmount = (idrAmount / usdtPrice).toFixed(2);
    const orderId   = genOrderId(id, "CDEP");
    const walletAddr = network === "tron" ? TRON_WALLET : EVM_WALLET;

    pendingCryptoDeposit[orderId] = {
      userId: id, userName: name, network,
      idrAmount, usdtAmount: parseFloat(usdtAmount),
      createdAt: Date.now(), txConfirmed: false
    };

    // Auto-expire 1 jam
    setTimeout(() => {
      if (pendingCryptoDeposit[orderId] && !pendingCryptoDeposit[orderId].txConfirmed) {
        delete pendingCryptoDeposit[orderId];
        bot.sendMessage(id, "⏰ Sesi deposit crypto kamu sudah expired (1 jam). Silakan buat deposit baru.", mainKeyboard).catch(()=>{});
      }
    }, 3600000);

    await bot.sendMessage(id,
      `🔗 *Deposit USDT ${cfg.name}*

` +
      `💰 Nominal IDR : *${fmt(idrAmount)}*
` +
      `💵 Kirim USDT  : *${usdtAmount} USDT*

` +
      `📤 *Alamat Tujuan:*
` +
      `\`${walletAddr}\`

` +
      `🌐 Network: *${cfg.name}*
` +
      `⚠️ *PASTIKAN kirim di network ${cfg.name}!*

` +
      `⏳ Bot otomatis deteksi dalam 20-60 detik setelah transfer confirmed.
` +
      `⏰ Sesi berlaku *1 jam*.

` +
      `🔖 Order: \`${orderId}\``,
      { parse_mode:"Markdown", reply_markup:{ inline_keyboard:[
        [{ text:"📋 Salin Alamat", callback_data:`copy_addr_${network}` }],
        [{ text:"🔄 Cek Status", callback_data:`check_crypto_dep_${orderId}` }],
        [{ text:"🏠 Menu Utama", callback_data:"back_main" }]
      ]}}
    );
    return;
  }

  if (data.startsWith("check_crypto_dep_")) {
    const orderId = data.replace("check_crypto_dep_", "");
    const dep = pendingCryptoDeposit[orderId];
    if (!dep) return bot.sendMessage(id, "✅ Deposit sudah diproses atau expired.", mainKeyboard);
    const elapsed = Math.round((Date.now() - dep.createdAt) / 60000);
    return bot.sendMessage(id,
      `⏳ *Menunggu Transfer...*

` +
      `💵 USDT: *${dep.usdtAmount} USDT*
` +
      `🌐 Network: *${USDT_CONTRACTS[dep.network]?.name}*
` +
      `⏱️ Sudah ${elapsed} menit

` +
      `Bot otomatis deteksi setelah transfer confirmed di blockchain.`,
      { parse_mode:"Markdown", reply_markup:{ inline_keyboard:[
        [{ text:"🔄 Refresh", callback_data:`check_crypto_dep_${orderId}` }],
        [{ text:"🏠 Menu Utama", callback_data:"back_main" }]
      ]}}
    );
  }

  if (data.startsWith("copy_addr_")) {
    const network = data.replace("copy_addr_", "");
    const addr = network === "tron" ? TRON_WALLET : EVM_WALLET;
    return bot.sendMessage(id, `\`${addr}\`

_Tap untuk copy_`, { parse_mode:"Markdown" });
  }

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
      return bot.sendMessage(id, "⚠️ Gagal buat link pembayaran.\n\nKemungkinan penyebab:\n• Server Key Midtrans salah\n• Akun Midtrans belum aktif\n\nHubungi admin: @ariiyaantoo", mainKeyboard);
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
      game_ml: { icon:"🗡️", name:"Mobile Legends", digiKat:"Games",   inputMsg:"Ketik *User ID Mobile Legends*:\nContoh: *123456789 (1234)*\n_(User ID spasi Zone ID)_" },
      game_ff: { icon:"🔫", name:"Free Fire",       digiKat:"Games",   inputMsg:"Ketik *User ID Free Fire*:\nContoh: *123456789*" },
      ewallet_dana:     { icon:"🔵", name:"DANA",       digiKat:"E-Money", inputMsg:"Ketik *nomor HP* terdaftar DANA:\nContoh: *08123456789*" },
      ewallet_gopay:    { icon:"🟢", name:"GoPay",      digiKat:"E-Money", inputMsg:"Ketik *nomor HP* terdaftar GoPay:\nContoh: *08123456789*" },
      ewallet_ovo:      { icon:"🟣", name:"OVO",        digiKat:"E-Money", inputMsg:"Ketik *nomor HP* terdaftar OVO:\nContoh: *08123456789*" },
      ewallet_shopee:   { icon:"🟠", name:"ShopeePay",  digiKat:"E-Money", inputMsg:"Ketik *nomor HP* terdaftar ShopeePay:\nContoh: *08123456789*" },
      tv:      { icon:"📺", name:"TV Kabel",    digiKat:"TV",      inputMsg:"Ketik *nomor pelanggan TV*:" },
      gas:     { icon:"🔥", name:"Gas Pertamina", digiKat:"Gas",   inputMsg:"Ketik *nomor pelanggan Gas Pertamina*:\nContoh: *001234567890*" },
    };

    // E-Wallet: tampilkan pilihan brand dulu
    if (type === "ewallet") {
      return bot.sendMessage(id, "💚 *Pilih E-Wallet:*", { parse_mode:"Markdown", reply_markup:{ inline_keyboard:[
        [{text:"🔵 DANA", callback_data:"ppob_ewallet_dana"},{text:"🟢 GoPay", callback_data:"ppob_ewallet_gopay"}],
        [{text:"🟣 OVO",  callback_data:"ppob_ewallet_ovo"}, {text:"🟠 ShopeePay", callback_data:"ppob_ewallet_shopee"}],
        [{text:"❌ Batal", callback_data:"back_ppob"}]
      ]}});
    }

    // Game: tampilkan pilihan game dulu
    if (type === "game") {
      return bot.sendMessage(id, "🎮 *Pilih Game:*", { parse_mode:"Markdown", reply_markup:{ inline_keyboard:[
        [{text:"🗡️ Mobile Legends", callback_data:"ppob_game_ml"},{text:"🔫 Free Fire", callback_data:"ppob_game_ff"}],
        [{text:"❌ Batal", callback_data:"back_ppob"}]
      ]}});
    }

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
  if (data.startsWith("pX.")) {
    // format: pX.TYPE.SKU.NOMOR
    const parts2 = data.split(".");
    const type   = parts2[1];
    const sku    = parts2[2];
    const nomor  = (parts2[3] || "").replace(/-/g, " ").trim();
    if (!type || !sku || !nomor) return bot.sendMessage(id, "⚠️ Data tidak valid. Mulai ulang.", mainKeyboard);

    // Update session
    if (!sessions[id]) sessions[id] = {};
    sessions[id].__ppobType  = type;
    sessions[id].__ppobNomor = nomor;

    // Cari produk by SKU — fetch semua produk di kategori yang sesuai
    const digiKatMap = { pulsa:"pulsa", data:"data", pln:"pln", game_ml:"game_ml", game_ff:"game_ff", ewallet:"ewallet", ewallet_dana:"ewallet", ewallet_gopay:"ewallet", ewallet_ovo:"ewallet", ewallet_shopee:"ewallet", tv:"tv", gas:"gas" };
    let allProds = await digiGetProduk(digiKatMap[type] || type);
    const produk = allProds.find(p => p.buyer_sku_code === sku);
    if (!produk) return bot.sendMessage(id, "⚠️ Produk tidak ditemukan. Mulai ulang.", mainKeyboard);

    const harga = produk.price || 0;
    const pts   = getPoints(harga);
    const saldo = await getSaldo(id);
    const svcNames = { pulsa:"Pulsa", data:"Paket Data", pln:"Listrik PLN", game:"Top-up Game", game_ml:"Mobile Legends", game_ff:"Free Fire", ewallet:"E-Wallet", ewallet_dana:"DANA", ewallet_gopay:"GoPay", ewallet_ovo:"OVO", ewallet_shopee:"ShopeePay", tv:"TV Kabel", gas:"Gas Pertamina" };

    // Simpan pilihan produk ke session
    sessions[id].__ppobSku = produk.buyer_sku_code;

    const namaCustomer = sessions[id]?.__ewalletNama || sessions[id]?.__plnNama || "";
    return bot.sendMessage(id,
      `📋 *Konfirmasi Transaksi*\n\n` +
      `Layanan  : *${svcNames[type] || type}*\n` +
      `Produk   : *${produk.product_name}*\n` +
      `Nomor    : *${nomor}*\n` +
      (namaCustomer ? `👤 Nama   : *${namaCustomer}*\n` : "") +
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
  if (data.startsWith("pXp.")) {
    // format: pXp.TYPE.PAGE.NOMOR
    const [,type, pageStr, nomorRaw] = data.split(".");
    const nomor = (nomorRaw || "").replace(/-/g, " ").trim();
    const page = parseInt(pageStr);
    const PAGE_SIZE = 8;
    const allProduk = sessions[id]?.__ppobProduk;
    if (!allProduk?.length) return bot.sendMessage(id, "⚠️ Session expired. Mulai ulang.", mainKeyboard);

    // Update session
    sessions[id].__ppobPage = page;
    const totalPages = Math.ceil(allProduk.length / PAGE_SIZE);
    const displayed = allProduk.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const svcNames = { pulsa:"Pulsa", data:"Paket Data", pln:"Listrik PLN", game:"Top-up Game", ewallet:"E-Wallet", ewallet_dana:"DANA", ewallet_gopay:"GoPay", ewallet_ovo:"OVO", ewallet_shopee:"ShopeePay", tv:"TV Kabel", gas:"Gas Pertamina" };

    const nomorEnc = nomor.replace(/ /g, "-");
    const btns = displayed.map((p) => [{ text: `${p.product_name} — ${fmt(p.price)}`, callback_data: `pX.${type}.${p.buyer_sku_code}.${nomorEnc}` }]);
    const navRow = [];
    if (page > 0) navRow.push({ text:`⬅️ Hal ${page}`, callback_data:`pXp.${type}.${page-1}.${nomorEnc}` });
    if (page < totalPages - 1) navRow.push({ text:`➡️ Hal ${page+2}/${totalPages}`, callback_data:`pXp.${type}.${page+1}.${nomorEnc}` });
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
    const svcNames = { pulsa:"Pulsa", data:"Paket Data", pln:"Listrik PLN", game:"Top-up Game", ewallet:"E-Wallet", ewallet_dana:"DANA", ewallet_gopay:"GoPay", ewallet_ovo:"OVO", ewallet_shopee:"ShopeePay", tv:"TV Kabel", gas:"Gas Pertamina" };
    const digiKats = { pulsa:"Pulsa", data:"Data", pln:"PLN", game:"Games", ewallet:"E-Money", ewallet_dana:"E-Money", ewallet_gopay:"E-Money", ewallet_ovo:"E-Money", ewallet_shopee:"E-Money", tv:"TV", gas:"Gas" };
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

    const digiKats = { pulsa:"Pulsa", data:"Data", pln:"PLN", game:"Games", ewallet:"E-Money", ewallet_dana:"E-Money", ewallet_gopay:"E-Money", ewallet_ovo:"E-Money", ewallet_shopee:"E-Money", tv:"TV", gas:"Gas" };
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
      // Catat preferensi untuk suggest di kemudian hari
      if (status === "Sukses") await catatPreferensi(id, type, `${produk.product_name} - ${nomor}`);

      // Clear session
      if (sessions[id]) { delete sessions[id].__ppobType; delete sessions[id].__ppobStep; delete sessions[id].__ewalletNama; }

      const namaEwallet = sessions[id]?.__ewalletNama || sessions[id]?.__plnNama || "";
      const saldoSisa   = await getSaldo(id);
      const invoiceMsg  = status === "Sukses"
        ? generateInvoice({ type: svcNames[type]||type, productName: produk.product_name, nomor, namaCustomer: namaEwallet, total: harga, pts, saldoSisa, orderId: refId })
        : `⏳ *TRANSAKSI PENDING*\n\n📦 *${produk.product_name}*\n📱 \`${nomor}\`\n💰 *${fmt(harga)}*\n\n🔖 Ref ID: \`${refId}\`\n_Notif dikirim saat selesai diproses_`;
      return bot.sendMessage(id, invoiceMsg, { parse_mode:"Markdown", ...mainKeyboard });
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
    const saldo = await getSaldo(id);

    return bot.sendMessage(id,
      `${coin.change>=0?"🟢":"🔴"} *${ticker}*\n\n` +
      `💰 Harga: *${fmt(coin.price)}*\n` +
      `📈 24 jam: *${coin.change>=0?"▲":"▼"} ${Math.abs(coin.change)}%*\n\n` +
      `💵 Saldo kamu: *${fmt(saldo)}*\n\n` +
      `Pilih nominal pembelian:`,
      { parse_mode:"Markdown", reply_markup:{ inline_keyboard:[
        [{text:"Rp 50.000",  callback_data:`buy_nom_${ticker}_50000`},  {text:"Rp 100.000", callback_data:`buy_nom_${ticker}_100000`}],
        [{text:"Rp 250.000", callback_data:`buy_nom_${ticker}_250000`}, {text:"Rp 500.000", callback_data:`buy_nom_${ticker}_500000`}],
        [{text:"Rp 1.000.000",callback_data:`buy_nom_${ticker}_1000000`},{text:"Rp 2.000.000",callback_data:`buy_nom_${ticker}_2000000`}],
        [{text:`🔴 Jual ${ticker}`,callback_data:`order_sell_${ticker}`},{text:"⬅️ Kembali",callback_data:"back_crypto"}]
      ]}}
    );
  }

  // ── PILIH NOMINAL BELI CRYPTO ──
  if (data.startsWith("buy_nom_")) {
    const parts   = data.split("_");
    const ticker  = parts[2];
    const nominal = parseInt(parts[3]);
    const prices  = await getCryptoPrices();
    const coin    = prices[ticker];
    if (!coin) return bot.sendMessage(id, "⚠️ Harga tidak tersedia.", mainKeyboard);
    const saldo   = await getSaldo(id);
    const feeVal  = Math.round(nominal*0.01);
    const taxVal  = Math.round(nominal*0.0021);
    const total   = nominal+feeVal+taxVal;

    return bot.sendMessage(id,
      `${coin.change>=0?"🟢":"🔴"} *${ticker}* — Konfirmasi Pembelian\n\n` +
      `─────────────────\n` +
      `Nilai        : ${fmt(nominal)}\nFee (1%)     : ${fmt(feeVal)}\nPajak (0.21%): ${fmt(taxVal)}\n` +
      `─────────────────\n` +
      `*Total Bayar : ${fmt(total)}*\n` +
      `Koin didapat : ≈${(nominal/coin.price).toFixed(8)} ${ticker}\n` +
      `🎁 Poin      : +${getPoints(nominal)} poin\n\n` +
      `💵 Saldo kamu: *${fmt(saldo)}*\n` +
      `${saldo>=total?"✅ Saldo cukup":"⚠️ Saldo kurang — top up dulu atau bayar langsung"}`,
      { parse_mode:"Markdown", reply_markup:{ inline_keyboard:[
        saldo>=total
          ? [{text:`🟢 Beli Pakai Saldo`,callback_data:`buy_saldo_${ticker}_${nominal}`}]
          : [{text:`💳 Bayar Langsung`,callback_data:`buy_direct_${ticker}_${nominal}`},{text:"💰 Top Up",callback_data:"show_deposit"}],
        [{text:"⬅️ Pilih Nominal Lain",callback_data:`crypto_${ticker}`}]
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

    const invoiceMsg = generateInvoice({
      ticker, nominal, feeVal, taxVal, total,
      jumlahKoin: (nominal/coin.price).toFixed(8),
      pts, saldoSisa: await getSaldo(id), orderId
    });
    return bot.sendMessage(id, invoiceMsg, { parse_mode:"Markdown", ...mainKeyboard });
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
    return bot.sendMessage(id, "⚠️ Gagal buat link pembayaran.\n\nKemungkinan penyebab:\n• Server Key Midtrans salah\n• Akun Midtrans belum aktif\n\nHubungi admin: @ariiyaantoo", mainKeyboard);
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

// ── HELPER: Parse request body ───────────────────────────────
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch(e) { resolve({}); }
    });
    req.on("error", reject);
  });
}

// ── HELPER: Send JSON response ────────────────────────────────
function sendJSON(res, data, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  });
  res.end(JSON.stringify(data));
}

// ── WEBHOOK SERVER (Midtrans Notification) ───────────────────
// Railway otomatis expose PORT
http.createServer(async (req, res) => {

  // ── CORS preflight ──
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    });
    return res.end();
  }

  const url = new URL(req.url, `http://localhost`);
  const path = url.pathname;

  // ══════════════════════════════════════════════════════════
  // API: GET /api/products?type=pulsa&nomor=08xx
  // ══════════════════════════════════════════════════════════
  if (req.method === "GET" && path === "/api/products") {
    try {
      const type  = url.searchParams.get("type") || "";
      const brand = url.searchParams.get("brand") || ""; // untuk ewallet

      const allProds = await digiGetAllProduk();

      const typeMap = {
        pulsa:   p => p.category === "Pulsa" && !p.product_name.toLowerCase().includes("transfer"),
        data:    p => p.category === "Data",
        pln:     p => p.category === "PLN",
        game:    p => p.category === "Games",
        tv:      p => p.category === "TV Kabel",
        gas:     p => p.category === "Gas",
        ewallet: p => {
          if (p.category !== "E-Money") return false;
          const n = p.product_name.toLowerCase();
          const brandFilter = { dana: "dana", gopay: "gopay", ovo: "ovo", shopee: "shopee" };
          return brand ? n.includes(brandFilter[brand] || "") : true;
        }
      };

      const filtered = allProds
        .filter(typeMap[type] || (() => false))
        .filter(p => p.seller_product_status && p.buyer_product_status)
        .sort((a, b) => a.price - b.price)
        .slice(0, 40)
        .map(p => ({
          sku:   p.buyer_sku_code,
          name:  p.product_name,
          price: p.price,
          desc:  p.desc || ""
        }));

      return sendJSON(res, { success: true, data: filtered });
    } catch(e) {
      return sendJSON(res, { success: false, error: e.message }, 500);
    }
  }

  // ══════════════════════════════════════════════════════════
  // API: GET /api/user/:webId
  // ══════════════════════════════════════════════════════════
  if (req.method === "GET" && path.startsWith("/api/user/")) {
    try {
      const webId = decodeURIComponent(path.replace("/api/user/", ""));
      if (!SUPABASE_URL) return sendJSON(res, { success: false, error: "DB tidak tersedia" }, 503);

      const r = await fetch(`${SUPABASE_URL}/rest/v1/users?telegram_id=eq.${webId}&select=*`, {
        headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY }
      });
      const data = await r.json();
      if (Array.isArray(data) && data.length) {
        return sendJSON(res, { success: true, data: data[0] });
      }
      return sendJSON(res, { success: false, error: "User tidak ditemukan" }, 404);
    } catch(e) {
      return sendJSON(res, { success: false, error: e.message }, 500);
    }
  }

  // ══════════════════════════════════════════════════════════
  // API: POST /api/user — buat user baru dari web
  // ══════════════════════════════════════════════════════════
  if (req.method === "POST" && path === "/api/user") {
    try {
      const body = await parseBody(req);
      const { webId, name, email } = body;
      if (!webId) return sendJSON(res, { success: false, error: "webId wajib" }, 400);

      const newUser = {
        telegram_id: webId,
        name: name || "User",
        email: email || "",
        saldo: 0,
        points: 500,
        tier: "🥉 Bronze",
        created_at: new Date().toISOString()
      };

      if (SUPABASE_URL) {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/users`, {
          method: "POST",
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: "Bearer " + SUPABASE_KEY,
            "Content-Type": "application/json",
            Prefer: "return=representation"
          },
          body: JSON.stringify(newUser)
        });
        const data = await r.json();
        return sendJSON(res, { success: true, data: Array.isArray(data) ? data[0] : newUser });
      }
      return sendJSON(res, { success: true, data: newUser });
    } catch(e) {
      return sendJSON(res, { success: false, error: e.message }, 500);
    }
  }

  // ══════════════════════════════════════════════════════════
  // API: POST /api/transaction — proses transaksi PPOB/Crypto
  // ══════════════════════════════════════════════════════════
  if (req.method === "POST" && path === "/api/transaction") {
    try {
      const body = await parseBody(req);
      const { webId, sku, productName, price, target, type } = body;

      if (!webId || !sku || !price || !target) {
        return sendJSON(res, { success: false, error: "Field tidak lengkap" }, 400);
      }

      // Cek & kurangi saldo di Supabase
      if (SUPABASE_URL) {
        const ur = await fetch(`${SUPABASE_URL}/rest/v1/users?telegram_id=eq.${webId}&select=saldo,points`, {
          headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY }
        });
        const userData = await ur.json();
        if (!Array.isArray(userData) || !userData.length) {
          return sendJSON(res, { success: false, error: "User tidak ditemukan" }, 404);
        }
        const saldo = parseInt(userData[0].saldo || 0);
        if (saldo < price) {
          return sendJSON(res, { success: false, error: "Saldo tidak cukup" }, 402);
        }

        // Kurangi saldo
        await fetch(`${SUPABASE_URL}/rest/v1/users?telegram_id=eq.${webId}`, {
          method: "PATCH",
          headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ saldo: saldo - price })
        });
      }

      // Panggil Digiflazz
      const orderId = "WEB-" + Date.now() + "-" + Math.random().toString(36).substr(2, 5).toUpperCase();
      const sign = require("crypto").createHash("md5").update(DIGI_USER + DIGI_KEY_PROD + orderId).digest("hex");

      const digiRes = await fetch("https://api.digiflazz.com/v1/transaction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: DIGI_USER,
          buyer_sku_code: sku,
          customer_no: target,
          ref_id: orderId,
          sign,
          testing: DIGI_MODE === "dev"
        })
      });
      const digiData = await digiRes.json();
      const txResult = digiData.data || {};
      const status = txResult.status === "Sukses" ? "success" : txResult.status === "Gagal" ? "failed" : "pending";
      const sn = txResult.sn || "";

      // Refund jika gagal
      if (status === "failed" && SUPABASE_URL) {
        const ur2 = await fetch(`${SUPABASE_URL}/rest/v1/users?telegram_id=eq.${webId}&select=saldo`, {
          headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY }
        });
        const ud2 = await ur2.json();
        if (Array.isArray(ud2) && ud2.length) {
          await fetch(`${SUPABASE_URL}/rest/v1/users?telegram_id=eq.${webId}`, {
            method: "PATCH",
            headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY, "Content-Type": "application/json" },
            body: JSON.stringify({ saldo: parseInt(ud2[0].saldo || 0) + price })
          });
        }
      }

      // Tambah poin jika sukses
      const pts = Math.floor(price / 1000);
      if (status !== "failed" && SUPABASE_URL) {
        const ur3 = await fetch(`${SUPABASE_URL}/rest/v1/users?telegram_id=eq.${webId}&select=points`, {
          headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY }
        });
        const ud3 = await ur3.json();
        if (Array.isArray(ud3) && ud3.length) {
          await fetch(`${SUPABASE_URL}/rest/v1/users?telegram_id=eq.${webId}`, {
            method: "PATCH",
            headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY, "Content-Type": "application/json" },
            body: JSON.stringify({ points: parseInt(ud3[0].points || 0) + pts })
          });
        }
      }

      // Simpan ke history
      if (SUPABASE_URL) {
        await fetch(`${SUPABASE_URL}/rest/v1/transactions`, {
          method: "POST",
          headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({
            telegram_id: webId,
            type: productName || type,
            amount: price,
            order_id: orderId,
            status,
            target,
            sn,
            created_at: new Date().toISOString()
          })
        });
      }

      return sendJSON(res, { success: true, status, orderId, sn, message: txResult.message || "" });
    } catch(e) {
      return sendJSON(res, { success: false, error: e.message }, 500);
    }
  }

  // ══════════════════════════════════════════════════════════
  // API: POST /api/crypto — beli crypto
  // ══════════════════════════════════════════════════════════
  if (req.method === "POST" && path === "/api/crypto") {
    try {
      const body = await parseBody(req);
      const { webId, ticker, idr } = body;
      if (!webId || !ticker || !idr) return sendJSON(res, { success: false, error: "Field tidak lengkap" }, 400);
      if (idr < 10000) return sendJSON(res, { success: false, error: "Minimum Rp 10.000" }, 400);

      if (SUPABASE_URL) {
        const ur = await fetch(`${SUPABASE_URL}/rest/v1/users?telegram_id=eq.${webId}&select=saldo,points`, {
          headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY }
        });
        const userData = await ur.json();
        if (!Array.isArray(userData) || !userData.length) {
          return sendJSON(res, { success: false, error: "User tidak ditemukan" }, 404);
        }
        const saldo = parseInt(userData[0].saldo || 0);
        if (saldo < idr) return sendJSON(res, { success: false, error: "Saldo tidak cukup" }, 402);

        // Ambil harga crypto
        const priceRes = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${ticker}USDT`);
        const priceData = await priceRes.json();
        const priceUSD = parseFloat(priceData.price || 0);
        const priceIDR = priceUSD * 16000;
        const fee = Math.round(idr * 0.0111);
        const coinAmt = (idr - fee) / priceIDR;

        // Kurangi saldo
        await fetch(`${SUPABASE_URL}/rest/v1/users?telegram_id=eq.${webId}`, {
          method: "PATCH",
          headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ saldo: saldo - idr, points: parseInt(userData[0].points || 0) + Math.floor(idr / 1000) })
        });

        const orderId = "CRYPTO-WEB-" + Date.now();
        await fetch(`${SUPABASE_URL}/rest/v1/transactions`, {
          method: "POST",
          headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({
            telegram_id: webId,
            type: `Beli ${ticker}`,
            amount: idr,
            order_id: orderId,
            status: "success",
            sn: `${coinAmt.toFixed(6)} ${ticker}`,
            created_at: new Date().toISOString()
          })
        });

        return sendJSON(res, { success: true, coinAmt: coinAmt.toFixed(6), ticker, fee, orderId });
      }
      return sendJSON(res, { success: false, error: "Database tidak tersedia" }, 503);
    } catch(e) {
      return sendJSON(res, { success: false, error: e.message }, 500);
    }
  }

  // ══════════════════════════════════════════════════════════
  // API: GET /api/history/:webId
  // ══════════════════════════════════════════════════════════
  if (req.method === "GET" && path.startsWith("/api/history/")) {
    try {
      const webId = decodeURIComponent(path.replace("/api/history/", ""));
      if (!SUPABASE_URL) return sendJSON(res, { success: false, error: "DB tidak tersedia" }, 503);

      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/transactions?telegram_id=eq.${webId}&order=created_at.desc&limit=50`,
        { headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY } }
      );
      const data = await r.json();
      return sendJSON(res, { success: true, data: Array.isArray(data) ? data : [] });
    } catch(e) {
      return sendJSON(res, { success: false, error: e.message }, 500);
    }
  }

  // ══════════════════════════════════════════════════════════
  // API: POST /api/topup — buat link Midtrans untuk top up saldo
  // ══════════════════════════════════════════════════════════
  if (req.method === "POST" && path === "/api/topup") {
    try {
      const body = await parseBody(req);
      const { webId, amount, name } = body;
      if (!amount || amount < 10000) return sendJSON(res, { success: false, error: "Minimum Rp 10.000" }, 400);

      if (!MIDTRANS_SERVER_KEY) {
        return sendJSON(res, { success: false, error: "Midtrans belum dikonfigurasi", manual: true }, 503);
      }

      const orderId = "TOPUP-WEB-" + Date.now();
      const payment = await createMidtransPayment({
        orderId,
        amount: amount + 2500,
        customerName: name || "User Web",
        itemName: `Top Up Saldo - Friendly Indonesia`
      });

      if (payment?.token) {
        // Simpan pending tx
        if (SUPABASE_URL) {
          await fetch(`${SUPABASE_URL}/rest/v1/transactions`, {
            method: "POST",
            headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY, "Content-Type": "application/json" },
            body: JSON.stringify({
              telegram_id: webId,
              type: `Top Up Saldo`,
              amount: amount,
              order_id: orderId,
              status: "pending",
              created_at: new Date().toISOString()
            })
          });
        }
        pendingTx[orderId] = { userId: webId, type: "deposit", amount, isWeb: true };
        return sendJSON(res, { success: true, token: payment.token, orderId });
      }
      return sendJSON(res, { success: false, error: "Gagal buat payment" }, 500);
    } catch(e) {
      return sendJSON(res, { success: false, error: e.message }, 500);
    }
  }

  // ══════════════════════════════════════════════════════════
  // API: GET /api/cek-nama?brand=dana&nomor=08xx
  // ══════════════════════════════════════════════════════════
  if (req.method === "GET" && path === "/api/cek-nama") {
    try {
      const brand = url.searchParams.get("brand") || "";
      const nomor = url.searchParams.get("nomor") || "";
      if (!brand || !nomor) return sendJSON(res, { success: false, error: "Brand dan nomor wajib" }, 400);

      const allProds = await digiGetAllProduk();
      const brandRegex = { dana: /dana/i, gopay: /gopay/i, ovo: /ovo/i, shopee: /shopee/i };
      const cekNamaProd = allProds.find(p =>
        p.category === "E-Money" &&
        /cek nama/i.test(p.product_name) &&
        brandRegex[brand]?.test(p.product_name)
      );

      if (!cekNamaProd) return sendJSON(res, { success: false, nama: null });

      const sign = require("crypto").createHash("md5").update(DIGI_USER + DIGI_KEY_PROD + "ceknama" + Date.now()).digest("hex").substr(0, 8);
      const orderId = "CEK-" + Date.now();
      const digiSign = require("crypto").createHash("md5").update(DIGI_USER + DIGI_KEY_PROD + orderId).digest("hex");

      const r = await fetch("https://api.digiflazz.com/v1/transaction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: DIGI_USER,
          buyer_sku_code: cekNamaProd.buyer_sku_code,
          customer_no: nomor,
          ref_id: orderId,
          sign: digiSign,
          testing: DIGI_MODE === "dev"
        })
      });
      const data = await r.json();
      const nama = data.data?.customer_name || null;
      return sendJSON(res, { success: !!nama, nama });
    } catch(e) {
      return sendJSON(res, { success: false, nama: null });
    }
  }

  // ══════════════════════════════════════════════════════════
  // MIDTRANS WEBHOOK
  // ══════════════════════════════════════════════════════════
  if (req.method === "POST" && path === "/midtrans-webhook") {
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
            const feeV  = Math.round((tx.nominal||tx.amount)*0.01);
            const taxV  = Math.round((tx.nominal||tx.amount)*0.0021);
            const saldoAfter = users[userId]?.saldo || 0;
            const invoiceMW  = generateInvoice({
              ticker: tx.ticker,
              nominal: tx.nominal || tx.amount,
              feeVal: feeV, taxVal: taxV, total: tx.amount,
              jumlahKoin: coin ? ((tx.nominal||tx.amount)/coin.price).toFixed(8) : "?",
              pts, saldoSisa: saldoAfter, orderId: order_id
            });
            await bot.sendMessage(userId, invoiceMW, { parse_mode:"Markdown", ...mainKeyboard });
          }
          delete pendingTx[order_id];
        }

        res.writeHead(200); res.end("OK");
      } catch(e) {
        console.error("Webhook error:", e.message);
        res.writeHead(500); res.end("Error");
      }
    });
  } else if (path === "/health") {
    res.writeHead(200, { "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ status:"ok", version:"3.0", uptime:process.uptime() }));
  } else {
    res.writeHead(200, { "Access-Control-Allow-Origin": "*" });
    res.end("🤝 Friendly Indonesia Bot v3.0 — API Ready");
  }
}).listen(PORT, () => console.log(`🌐 Webhook server: http://localhost:${PORT}`));

// ── ADMIN ────────────────────────────────────────────────────
async function getStatistikHarian() {
  const now   = new Date();
  const today = now.toISOString().split("T")[0];
  let txHari = [], revenueHari = 0, userAktif = new Set();
  try {
    const rows = await SB.list("transactions", `created_at=gte.${today}T00:00:00`, 500);
    if (Array.isArray(rows)) {
      txHari     = rows.filter(r => r.status === "success");
      revenueHari= txHari.reduce((s,r) => s + (r.amount||0), 0);
      txHari.forEach(r => userAktif.add(r.telegram_id));
    }
  } catch(e) {}
  return { txCount: txHari.length, revenue: revenueHari, userAktif: userAktif.size };
}

bot.onText(/\/admin/, async (msg) => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return;
  const [saldo, stat] = await Promise.all([digiCekSaldo(), getStatistikHarian()]);
  const totalUsers = Object.keys(users).length;
  const uptime = Math.floor(process.uptime());
  const uptimeStr = `${Math.floor(uptime/3600)}j ${Math.floor((uptime%3600)/60)}m`;
  await bot.sendMessage(msg.from.id,
    `🔧 *Admin Dashboard v4.0*\n\n` +
    `📊 *Statistik Hari Ini:*\n` +
    `   💰 Revenue : *${fmt(stat.revenue)}*\n` +
    `   📦 Transaksi: *${stat.txCount} sukses*\n` +
    `   👤 User aktif: *${stat.userAktif} user*\n\n` +
    `⚙️ *Status Sistem:*\n` +
    `   🤖 Bot: *Online ✅* (uptime ${uptimeStr})\n` +
    `   👥 Session: *${totalUsers} user*\n` +
    `   ⏳ Pending tx: *${Object.keys(pendingTx).length}*\n` +
    `   📡 Crypto: *CoinGecko ✅*\n\n` +
    `🔌 *Integrasi:*\n` +
    `   🏪 Digiflazz: *${DIGI_MODE === "prod"?"🟢 Production":"🟡 Development"}*\n` +
    `   💳 Midtrans: *${MIDTRANS_SERVER_KEY?"✅ "+MIDTRANS_MODE:"⚠️ Belum diisi"}*\n` +
    `   🗄️ Database: *${SUPABASE_URL?"✅ Supabase":"⚠️ In-memory"}*\n` +
    `${saldo?.data?.deposit?"   💰 Saldo Digi: *"+fmt(saldo.data.deposit)+"*":""}\n\n` +
    `_Ketik /broadcast [pesan] untuk kirim ke semua user_\n` +
    `_Ketik /stats untuk laporan detail_`,
    { parse_mode:"Markdown" }
  );
});

// ── LAPORAN STATISTIK DETAIL ─────────────────────────────────
bot.onText(/\/stats/, async (msg) => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return;
  await bot.sendChatAction(msg.from.id, "typing");
  try {
    // Statistik 7 hari
    const rows7 = await SB.list("transactions", "status=eq.success", 1000);
    const now = new Date();
    const stats7 = {};
    if (Array.isArray(rows7)) {
      rows7.forEach(r => {
        const d = r.created_at?.split("T")[0];
        if (!d) return;
        const diff = Math.floor((now - new Date(d)) / 86400000);
        if (diff > 7) return;
        if (!stats7[d]) stats7[d] = { tx:0, rev:0 };
        stats7[d].tx++;
        stats7[d].rev += (r.amount||0);
      });
    }
    const lines = Object.entries(stats7).sort((a,b) => b[0].localeCompare(a[0])).slice(0,7)
      .map(([d,v]) => `📅 ${d}: *${v.tx} tx* — ${fmt(v.rev)}`).join("\n");
    const totalRev = Object.values(stats7).reduce((s,v) => s+v.rev, 0);
    const totalTx  = Object.values(stats7).reduce((s,v) => s+v.tx, 0);
    await bot.sendMessage(msg.from.id,
      `📊 *Statistik 7 Hari Terakhir*\n\n${lines||"Belum ada data"}\n\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `📦 Total transaksi: *${totalTx}*\n` +
      `💰 Total revenue  : *${fmt(totalRev)}*`,
      { parse_mode:"Markdown" }
    );
  } catch(e) {
    await bot.sendMessage(msg.from.id, "⚠️ Gagal ambil statistik: " + e.message);
  }
});

// ── BROADCAST ────────────────────────────────────────────────
bot.onText(/\/broadcast (.+)/, async (msg, match) => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return;
  const pesan = match[1];
  if (!SUPABASE_URL) return bot.sendMessage(msg.from.id, "⚠️ Supabase belum dikonfigurasi.");
  await bot.sendMessage(msg.from.id, "📢 Mengirim broadcast...");
  try {
    const allUsers = await fetchJSON(`${SUPABASE_URL}/rest/v1/users?select=telegram_id`, { method:"GET", headers: SB.headers });
    let sukses = 0, gagal = 0;
    for (const u of allUsers) {
      try {
        await bot.sendMessage(u.telegram_id, `📢 *Info dari Admin*

${pesan}`, { parse_mode:"Markdown" });
        sukses++;
        await new Promise(r => setTimeout(r, 50)); // delay anti-flood
      } catch(e) { gagal++; }
    }
    await bot.sendMessage(msg.from.id, `✅ Broadcast selesai!

✅ Terkirim: *${sukses}*
❌ Gagal: *${gagal}*`, { parse_mode:"Markdown" });
  } catch(e) {
    await bot.sendMessage(msg.from.id, "⚠️ Gagal broadcast: " + e.message);
  }
});

// ── KELOLA PRODUK ADMIN ───────────────────────────────────────
const disabledProducts = new Set(); // SKU yang dinonaktifkan admin

bot.onText(/\/produk/, async (msg) => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return;
  await bot.sendMessage(msg.from.id,
    `🛒 *Kelola Produk*

` +
    `Perintah yang tersedia:
` +
    `• \`/nonaktif [SKU]\` — nonaktifkan produk
` +
    `• \`/aktifkan [SKU]\` — aktifkan kembali
` +
    `• \`/listnonaktif\` — lihat produk nonaktif

` +
    `_Cari SKU di menu PPOB atau via /katdigi_`,
    { parse_mode:"Markdown" }
  );
});

bot.onText(/\/nonaktif (.+)/, async (msg, match) => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return;
  const sku = match[1].trim();
  disabledProducts.add(sku);
  await bot.sendMessage(msg.from.id, `✅ Produk \`${sku}\` dinonaktifkan.`, { parse_mode:"Markdown" });
});

bot.onText(/\/aktifkan (.+)/, async (msg, match) => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return;
  const sku = match[1].trim();
  disabledProducts.delete(sku);
  await bot.sendMessage(msg.from.id, `✅ Produk \`${sku}\` diaktifkan kembali.`, { parse_mode:"Markdown" });
});

bot.onText(/\/listnonaktif/, async (msg) => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return;
  const list = [...disabledProducts];
  if (!list.length) return bot.sendMessage(msg.from.id, "✅ Tidak ada produk yang dinonaktifkan.");
  await bot.sendMessage(msg.from.id, `🚫 *Produk Nonaktif:*

${list.map(s => `• \`${s}\``).join("
")}`, { parse_mode:"Markdown" });
});

// ── JADWAL LAPORAN HARIAN TENGAH MALAM ───────────────────────
function scheduleHarianReport() {
  const now    = new Date();
  const next   = new Date();
  next.setHours(0, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const delay  = next - now;
  setTimeout(async () => {
    if (ADMIN_ID) {
      try {
        const stat = await getStatistikHarian();
        const tgl  = new Date().toLocaleDateString("id-ID", { day:"2-digit", month:"long", year:"numeric" });
        await bot.sendMessage(ADMIN_ID,
          `📊 *Laporan Harian — ${tgl}*\n\n` +
          `💰 Revenue   : *${fmt(stat.revenue)}*\n` +
          `📦 Transaksi : *${stat.txCount} sukses*\n` +
          `👤 User aktif: *${stat.userAktif} user*\n\n` +
          `_Laporan otomatis Friendly Indonesia_ 🤝`,
          { parse_mode:"Markdown" }
        );
      } catch(e) {}
    }
    scheduleHarianReport(); // jadwal ulang untuk besok
  }, delay);
  console.log(`📅 Laporan harian dijadwalkan dalam ${Math.round(delay/3600000)} jam`);
}
scheduleHarianReport();

// ── AUTO-RECONNECT POLLING ──────────────────────────────────
let pollingRestartCount = 0;
bot.on("polling_error", async (err) => {
  console.error("Polling error:", err.message);
  pollingRestartCount++;
  // Notif admin kalau error terus-terusan
  if (pollingRestartCount % 5 === 1 && ADMIN_ID) {
    try {
      await bot.sendMessage(ADMIN_ID,
        `⚠️ *Bot Polling Error*\n\nError ke-${pollingRestartCount}: \`${err.message}\`\n\nBot akan auto-reconnect...`,
        { parse_mode:"Markdown" }
      );
    } catch(e) {}
  }
  // Auto restart polling setelah 5 detik
  setTimeout(() => {
    console.log("🔄 Restarting polling...");
    bot.stopPolling().then(() => {
      bot.startPolling();
      console.log("✅ Polling restarted");
    }).catch(e => console.error("Restart failed:", e.message));
  }, 5000);
});

process.on("unhandledRejection", (err) => console.error("Unhandled:", err?.message));
process.on("uncaughtException",  (err) => console.error("Uncaught:", err?.message));

console.log("🤝 Friendly Indonesia Bot v3.0 RUNNING");
console.log(`Midtrans: ${MIDTRANS_SERVER_KEY?"ACTIVE ("+MIDTRANS_MODE+")":"pending config"}`);
console.log(`Digiflazz: ${DIGI_USER?"ACTIVE":"pending config"}`);
console.log(`Database: ${SUPABASE_URL?"Supabase":"in-memory fallback"}`);
