// ============================================================
// FRIENDLY INDONESIA — TELEGRAM BOT AI
// Deploy gratis di Railway.app atau Render.com
// ============================================================

const TelegramBot = require("node-telegram-bot-api");
const Anthropic = require("@anthropic-ai/sdk");

// ── CONFIG (isi di Railway Environment Variables) ──────────
const BOT_TOKEN = process.env.BOT_TOKEN;       // dari @BotFather
const CLAUDE_KEY = process.env.CLAUDE_API_KEY; // dari console.anthropic.com
const ADMIN_ID   = process.env.ADMIN_ID;       // Telegram user ID lo

const bot    = new TelegramBot(BOT_TOKEN, { polling: true });
const claude = new Anthropic({ apiKey: CLAUDE_KEY });

// ── DATABASE SEDERHANA (in-memory, ganti Redis/Supabase nanti) ──
const users    = {};   // { userId: { name, points, tier, history, joined } }
const sessions = {};   // { userId: [{ role, content }] }

// ── HARGA PPOB (nanti diganti Digiflazz API) ─────────────
const PPOB = {
  pulsa: { Telkomsel: { 5000:5500,10000:10700,20000:20900,25000:25900,50000:51500,100000:102000 },
           Indosat:   { 5000:5500,10000:10700,20000:20900,50000:51500,100000:102000 },
           XL:        { 5000:5500,10000:10700,20000:20900,50000:51500,100000:102000 } },
  fee: { pulsa:500, data:1000, pln:2000, bpjs:2500, ewallet:1500, game:1000 }
};

// ── HARGA CRYPTO (nanti diganti CoinGecko API) ────────────
const CRYPTO = {
  BTC:  { name:"Bitcoin",     price:1523450000, change:2.4  },
  ETH:  { name:"Ethereum",    price:45230000,   change:1.8  },
  BNB:  { name:"BNB",         price:9640000,    change:-0.5 },
  SOL:  { name:"Solana",      price:2340000,    change:-1.2 },
  XRP:  { name:"XRP",         price:36500,      change:4.1  },
  USDT: { name:"Tether",      price:16200,      change:0.02 },
  DOGE: { name:"Dogecoin",    price:5100,       change:6.3  },
  ADA:  { name:"Cardano",     price:14800,      change:3.5  },
  MATIC:{ name:"Polygon",     price:11200,      change:2.1  },
  AVAX: { name:"Avalanche",   price:563000,     change:3.2  },
};

// ── HELPER ────────────────────────────────────────────────
const fmt = (n) => "Rp " + Math.round(n).toLocaleString("id-ID");
const ppn = (fee) => Math.round(fee * 0.12);
const tax_crypto = (n) => Math.round(n * 0.0021);
const fee_crypto = (n) => Math.round(n * 0.01);
const getPoints = (n) => Math.round(n * 0.001);
const getTier = (pts) => pts >= 50001 ? "💎 Diamond" : pts >= 10001 ? "🥇 Gold" : pts >= 2001 ? "🥈 Silver" : "🥉 Bronze";

function getUser(id, name) {
  if (!users[id]) users[id] = { name, points: 0, tier: "🥉 Bronze", history: [], joined: new Date().toLocaleDateString("id-ID") };
  return users[id];
}

function addPoints(userId, pts) {
  const u = users[userId];
  if (!u) return;
  u.points += pts;
  u.tier = getTier(u.points);
}

// ── SYSTEM PROMPT ─────────────────────────────────────────
const SYSTEM = `Kamu adalah asisten AI Friendly Indonesia — platform PPOB dan Crypto terpercaya Indonesia.

KEPRIBADIAN:
- Ramah, sopan, dan profesional tapi tetap santai
- Selalu jawab dalam Bahasa Indonesia
- Jangan bertele-tele, langsung ke inti jawaban
- Gunakan emoji secukupnya

LAYANAN YANG BISA KAMU BANTU:
1. PPOB: Pulsa, Paket Data, Listrik (PLN), BPJS, TV Kabel, Internet, Top-up Game, GoPay, OVO, Dana, ShopeePay
2. CRYPTO: Beli/Jual BTC, ETH, BNB, SOL, XRP, USDT, DOGE, ADA, MATIC, AVAX
3. CEK POIN: Saldo Friendly Points, tier membership, cara redeem
4. RIWAYAT: Transaksi terakhir user

STRUKTUR FEE:
- Pulsa: fee Rp 500 + PPN 12% dari fee
- PLN/BPJS: fee Rp 2.000-2.500 + PPN 12% dari fee
- Crypto: fee 1% + PPh 0.1% + PPN 0.11% (ditanggung customer)
- Semua pajak transparan dan tercantum di invoice PDF

FRIENDLY POINTS:
- Tiap transaksi: 0.1% dari nominal → poin
- Referral: +1.000 poin
- Tier: Bronze(0-2K) → Silver(2K-10K) → Gold(10K-50K) → Diamond(50K+)
- Diskon fee: Silver 10%, Gold 20%, Diamond 30%

PENTING:
- Jangan menjanjikan keuntungan investasi crypto
- Selalu ingatkan risiko jika user nanya soal crypto
- Jika ada masalah teknis, arahkan ke admin
- Semua transaksi menghasilkan invoice PDF otomatis`;

// ── KEYBOARD UTAMA ─────────────────────────────────────────
const mainKeyboard = {
  reply_markup: {
    keyboard: [
      ["⚡ PPOB", "🪙 Crypto"],
      ["⭐ Poin & Reward", "📋 Riwayat"],
      ["💬 Bantuan", "ℹ️ Tentang Kami"]
    ],
    resize_keyboard: true
  }
};

const ppobKeyboard = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "📱 Pulsa", callback_data: "ppob_pulsa" }, { text: "📶 Paket Data", callback_data: "ppob_data" }],
      [{ text: "⚡ PLN", callback_data: "ppob_pln" }, { text: "🏥 BPJS", callback_data: "ppob_bpjs" }],
      [{ text: "🎮 Top-up Game", callback_data: "ppob_game" }, { text: "💚 E-Wallet", callback_data: "ppob_ewallet" }],
      [{ text: "📺 TV Kabel", callback_data: "ppob_tv" }, { text: "🌐 Internet", callback_data: "ppob_internet" }],
      [{ text: "🏠 Menu Utama", callback_data: "back_main" }]
    ]
  }
};

const cryptoKeyboard = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "₿ BTC", callback_data: "crypto_BTC" }, { text: "Ξ ETH", callback_data: "crypto_ETH" }, { text: "◎ SOL", callback_data: "crypto_SOL" }],
      [{ text: "🟡 BNB", callback_data: "crypto_BNB" }, { text: "✕ XRP", callback_data: "crypto_XRP" }, { text: "💵 USDT", callback_data: "crypto_USDT" }],
      [{ text: "Ð DOGE", callback_data: "crypto_DOGE" }, { text: "🔵 ADA", callback_data: "crypto_ADA" }, { text: "🟣 MATIC", callback_data: "crypto_MATIC" }],
      [{ text: "🔺 AVAX", callback_data: "crypto_AVAX" }],
      [{ text: "📊 Semua Harga", callback_data: "crypto_all" }],
      [{ text: "🏠 Menu Utama", callback_data: "back_main" }]
    ]
  }
};

// ── /START ─────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const id   = msg.from.id;
  const name = msg.from.first_name || "Pengguna";
  const user = getUser(id, name);

  // Bonus welcome points
  if (user.history.length === 0) {
    user.points = 500;
    user.history.push({ type: "Bonus Daftar", date: new Date().toLocaleDateString("id-ID"), points: 500 });
  }

  await bot.sendMessage(id,
    `👋 Halo *${name}!* Selamat datang di *Friendly Indonesia* 🤝\n\n` +
    `Platform PPOB & Crypto #1 yang transparan, terpercaya, dan berpihak ke kamu.\n\n` +
    `🎁 Kamu dapat *500 Friendly Points* sebagai bonus daftar!\n` +
    `🏆 Tier kamu: ${user.tier}\n\n` +
    `Pilih layanan di bawah atau ketik pertanyaan langsung ke saya:`,
    { parse_mode: "Markdown", ...mainKeyboard }
  );
});

// ── PESAN TEKS ─────────────────────────────────────────────
bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;
  const id   = msg.from.id;
  const name = msg.from.first_name || "Pengguna";
  const text = msg.text.trim();
  getUser(id, name);

  // Menu shortcuts
  if (text === "⚡ PPOB") {
    return bot.sendMessage(id, "⚡ *Layanan PPOB*\n\nPilih layanan yang kamu butuhkan:", { parse_mode: "Markdown", ...ppobKeyboard });
  }
  if (text === "🪙 Crypto") {
    const allPrices = Object.entries(CRYPTO).map(([k, v]) => {
      const sign = v.change >= 0 ? "▲" : "▼";
      return `${k}: *${fmt(v.price)}* ${sign} ${Math.abs(v.change)}%`;
    }).join("\n");
    return bot.sendMessage(id,
      `🪙 *Harga Crypto Real-time*\n\n${allPrices}\n\n_Pilih koin untuk beli/jual:_`,
      { parse_mode: "Markdown", ...cryptoKeyboard }
    );
  }
  if (text === "⭐ Poin & Reward") {
    const u = users[id];
    const nextTier = u.tier === "🥉 Bronze" ? "🥈 Silver (2.001 poin)" : u.tier === "🥈 Silver" ? "🥇 Gold (10.001 poin)" : u.tier === "🥇 Gold" ? "💎 Diamond (50.001 poin)" : "Kamu sudah di tier tertinggi! 🎉";
    return bot.sendMessage(id,
      `⭐ *Friendly Points Kamu*\n\n` +
      `💰 Saldo: *${u.points.toLocaleString("id-ID")} poin*\n` +
      `🏆 Tier: *${u.tier}*\n` +
      `🎯 Tier berikutnya: ${nextTier}\n\n` +
      `*Cara Kumpul Poin:*\n` +
      `• Tiap transaksi PPOB = 0.1% nominal\n` +
      `• Tiap transaksi Crypto = 0.1% nominal\n` +
      `• Referral teman = +1.000 poin\n\n` +
      `*Cara Redeem:*\n` +
      `• 500 poin = Pulsa Rp 5.000\n` +
      `• 300 poin = Diskon fee 50% (1x)\n` +
      `• 1.000 poin = Gratis 1x transaksi PLN`,
      { parse_mode: "Markdown", ...mainKeyboard }
    );
  }
  if (text === "📋 Riwayat") {
    const u = users[id];
    if (!u.history.length) {
      return bot.sendMessage(id, "📋 Belum ada riwayat transaksi.\n\nYuk mulai transaksi pertamamu!", mainKeyboard);
    }
    const hist = u.history.slice(-5).reverse().map((h, i) =>
      `${i+1}. ${h.type} — ${h.date}\n   ${h.amount ? fmt(h.amount) : ""} ${h.points ? `+${h.points} poin` : ""}`
    ).join("\n\n");
    return bot.sendMessage(id, `📋 *Riwayat Transaksi (5 terakhir)*\n\n${hist}`, { parse_mode: "Markdown", ...mainKeyboard });
  }
  if (text === "ℹ️ Tentang Kami") {
    return bot.sendMessage(id,
      `🤝 *Friendly Indonesia*\n\n` +
      `Platform PPOB & Crypto yang transparan dan terpercaya.\n\n` +
      `✅ Harga transparan, pajak jelas\n` +
      `✅ Invoice PDF tiap transaksi\n` +
      `✅ Friendly Points di setiap transaksi\n` +
      `✅ Support 24/7 via AI Agent\n\n` +
      `🌐 friendlyindonesia.netlify.app\n` +
      `📧 hello@friendlyindonesia.id`,
      { parse_mode: "Markdown", ...mainKeyboard }
    );
  }
  if (text === "💬 Bantuan") {
    return bot.sendMessage(id,
      `💬 *Butuh Bantuan?*\n\nKetik pertanyaan kamu langsung, atau:\n\n📱 Telegram Admin: @FriendlyAdmin\n📧 Email: hello@friendlyindonesia.id\n🌐 Web: friendlyindonesia.netlify.app\n\n_Atau tanya apa saja ke saya, AI selalu siap 24/7!_ 🤖`,
      { parse_mode: "Markdown", ...mainKeyboard }
    );
  }

  // AI Chat (Claude)
  try {
    await bot.sendChatAction(id, "typing");
    if (!sessions[id]) sessions[id] = [];
    sessions[id].push({ role: "user", content: text });
    if (sessions[id].length > 20) sessions[id] = sessions[id].slice(-20);

    const res = await claude.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: SYSTEM + `\n\nInfo user: Nama: ${name}, Poin: ${users[id]?.points || 0}, Tier: ${users[id]?.tier || "Bronze"}`,
      messages: sessions[id]
    });

    const reply = res.content[0].text;
    sessions[id].push({ role: "assistant", content: reply });
    await bot.sendMessage(id, reply, { parse_mode: "Markdown", ...mainKeyboard });
  } catch (e) {
    console.error(e);
    await bot.sendMessage(id, "⚠️ Maaf, terjadi gangguan sementara. Silakan coba lagi ya!", mainKeyboard);
  }
});

// ── CALLBACK QUERIES (tombol inline) ──────────────────────
bot.on("callback_query", async (query) => {
  const id   = query.from.id;
  const name = query.from.first_name || "Pengguna";
  const data = query.data;
  getUser(id, name);
  await bot.answerCallbackQuery(query.id);

  // Back to main
  if (data === "back_main") {
    return bot.sendMessage(id, "🏠 Menu utama:", mainKeyboard);
  }

  // ── PPOB callbacks ──
  if (data.startsWith("ppob_")) {
    const type = data.replace("ppob_", "");
    const info = {
      pulsa:   { icon:"📱", name:"Pulsa",        fee:500,  msg:"Masukkan nomor HP dan nominal:\nContoh: *08123456789 50000*" },
      data:    { icon:"📶", name:"Paket Data",    fee:1000, msg:"Masukkan nomor HP:\nContoh: *08123456789*\nNanti saya tampilkan pilihan paket." },
      pln:     { icon:"⚡", name:"Listrik PLN",   fee:2000, msg:"Masukkan nomor meteran/ID Pelanggan:\nContoh: *123456789012*" },
      bpjs:    { icon:"🏥", name:"BPJS",          fee:2500, msg:"Masukkan nomor BPJS:\nContoh: *0001234567890*" },
      game:    { icon:"🎮", name:"Top-up Game",   fee:1000, msg:"Sebutkan game dan nominal:\nContoh: *Mobile Legends 100 diamond*" },
      ewallet: { icon:"💚", name:"E-Wallet",      fee:1500, msg:"Pilih e-wallet dan masukkan nomor:\nContoh: *GoPay 08123456789 100000*" },
      tv:      { icon:"📺", name:"TV Kabel",      fee:2000, msg:"Masukkan nomor pelanggan TV:\nContoh: *1234567890*" },
      internet:{ icon:"🌐", name:"Internet",      fee:2500, msg:"Masukkan ID pelanggan internet:\nContoh: *ISP-1234567*" },
    };
    const svc = info[type];
    if (!svc) return;
    const feeVal = svc.fee;
    const ppnVal = ppn(feeVal);
    sessions[id] = sessions[id] || [];
    sessions[id].push({ role: "assistant", content: `User mau ${svc.name}. Fee: ${fmt(feeVal)}, PPN: ${fmt(ppnVal)}` });
    return bot.sendMessage(id,
      `${svc.icon} *${svc.name}*\n\n` +
      `${svc.msg}\n\n` +
      `💰 Fee layanan: *${fmt(feeVal)}*\n` +
      `🏛️ PPN (12% dari fee): *${fmt(ppnVal)}*\n` +
      `🎁 Poin didapat: sesuai nominal transaksi\n\n` +
      `_Ketik detail transaksi di atas 👆_`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "back_ppob" }]] } }
    );
  }
  if (data === "back_ppob") {
    return bot.sendMessage(id, "⚡ *Layanan PPOB*\n\nPilih layanan:", { parse_mode: "Markdown", ...ppobKeyboard });
  }

  // ── CRYPTO callbacks ──
  if (data === "crypto_all") {
    const lines = Object.entries(CRYPTO).map(([k, v]) => {
      const sign = v.change >= 0 ? "▲" : "▼";
      return `${k.padEnd(6)} ${fmt(v.price).padStart(20)}  ${sign} ${Math.abs(v.change)}%`;
    }).join("\n");
    return bot.sendMessage(id,
      `📊 *Semua Harga Crypto*\n\`\`\`\n${lines}\n\`\`\`\n_Data bersifat ilustratif_`,
      { parse_mode: "Markdown", ...cryptoKeyboard }
    );
  }

  if (data.startsWith("crypto_")) {
    const ticker = data.replace("crypto_", "");
    const coin   = CRYPTO[ticker];
    if (!coin) return;
    const sign  = coin.change >= 0 ? "▲" : "▼";
    const color = coin.change >= 0 ? "🟢" : "🔴";

    // Contoh nominal 500rb
    const nominal  = 500000;
    const feeVal   = fee_crypto(nominal);
    const taxVal   = tax_crypto(nominal);
    const total    = nominal + feeVal + taxVal;
    const coinAmt  = (nominal / coin.price).toFixed(6);
    const pts      = getPoints(nominal);

    return bot.sendMessage(id,
      `${color} *${coin.name} (${ticker})*\n\n` +
      `💰 Harga: *${fmt(coin.price)}*\n` +
      `📈 24 jam: *${sign} ${Math.abs(coin.change)}%*\n\n` +
      `─────────────────\n` +
      `*Simulasi Beli Rp 500.000:*\n` +
      `Nilai        : ${fmt(nominal)}\n` +
      `Fee (1%)     : ${fmt(feeVal)}\n` +
      `Pajak (0.21%): ${fmt(taxVal)}\n` +
      `─────────────────\n` +
      `*Total Bayar : ${fmt(total)}*\n` +
      `Koin didapat : ≈ ${coinAmt} ${ticker}\n` +
      `🎁 Poin      : +${pts} poin\n\n` +
      `_Ketik nominal untuk beli/jual, contoh:_\n` +
      `*Beli ${ticker} 500000*\n` +
      `*Jual ${ticker} 0.001*`,
      { parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [
          [{ text: `🟢 Beli ${ticker}`, callback_data: `order_buy_${ticker}` }, { text: `🔴 Jual ${ticker}`, callback_data: `order_sell_${ticker}` }],
          [{ text: "⬅️ Kembali", callback_data: "back_crypto" }]
        ]}
      }
    );
  }
  if (data === "back_crypto") {
    return bot.sendMessage(id, "🪙 *Pilih Koin:*", { parse_mode: "Markdown", ...cryptoKeyboard });
  }

  // ── ORDER CRYPTO ──
  if (data.startsWith("order_")) {
    const [, type, ticker] = data.split("_");
    const coin = CRYPTO[ticker];
    sessions[id] = sessions[id] || [];
    sessions[id].push({ role: "assistant", content: `User mau ${type === "buy" ? "beli" : "jual"} ${ticker}. Harga: ${fmt(coin.price)}` });
    return bot.sendMessage(id,
      `${type === "buy" ? "🟢 Beli" : "🔴 Jual"} *${ticker}*\n\n` +
      `Masukkan jumlah IDR yang ingin kamu ${type === "buy" ? "belikan" : "jual"}:\n\n` +
      `Contoh: *${type === "buy" ? "Beli" : "Jual"} ${ticker} 500000*\n\n` +
      `_Minimum transaksi: Rp 50.000_`,
      { parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: `crypto_${ticker}` }]] }
      }
    );
  }
});

// ── ADMIN COMMAND ─────────────────────────────────────────
bot.onText(/\/admin/, async (msg) => {
  if (String(msg.from.id) !== String(ADMIN_ID)) return;
  const totalUsers = Object.keys(users).length;
  const totalTx    = Object.values(users).reduce((a, u) => a + u.history.length, 0);
  await bot.sendMessage(msg.from.id,
    `🔧 *Admin Dashboard*\n\n` +
    `👥 Total User: *${totalUsers}*\n` +
    `📋 Total Transaksi: *${totalTx}*\n` +
    `🤖 Bot Status: *Online ✅*`,
    { parse_mode: "Markdown" }
  );
});

// ── ERROR HANDLING ────────────────────────────────────────
bot.on("polling_error", (err) => console.error("Polling error:", err));
process.on("unhandledRejection", (err) => console.error("Unhandled:", err));

console.log("🤝 Friendly Indonesia Bot is RUNNING...");
