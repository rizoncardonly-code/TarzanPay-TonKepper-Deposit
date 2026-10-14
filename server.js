const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const admin = require('firebase-admin');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '1mb' }));

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

// ============ FIREBASE INIT ============
let db = null;
try {
  let saRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!saRaw) throw new Error('FIREBASE_SERVICE_ACCOUNT missing');
  saRaw = saRaw.trim();
  // Render env এ কখনো কখনো পুরো JSON quote সহ পেস্ট হয়
  if (saRaw.startsWith('"') && saRaw.endsWith('"')) saRaw = JSON.parse(saRaw);
  const sa = typeof saRaw === 'string' ? JSON.parse(saRaw) : saRaw;
  // private_key এর \n ঠিক করা (Render এর সবচেয়ে common সমস্যা)
  if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
  admin.initializeApp({
    credential: admin.credential.cert(sa),
    databaseURL: process.env.FIREBASE_DB_URL || 'https://tarzan-pay-ok-default-rtdb.firebaseio.com'
  });
  db = admin.database();
  console.log('✅ Firebase initialized for:', sa.project_id);
} catch (e) {
  console.error('❌ Firebase init failed:', e.message);
}

const TONAPI_KEY = process.env.TONAPI_KEY || '';
const MASTER_WALLET = process.env.MASTER_WALLET || '';
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const POLL_SECRET = process.env.POLL_SECRET || ''; // optional: /poll?key=...
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ''; // optional: /webhook?key=...

const tonHeaders = () => ({ Authorization: 'Bearer ' + TONAPI_KEY });

// ============ HEALTH ============
app.get('/', (req, res) => res.json({ ok: true, service: 'Tarzan TON Deposit', ts: Date.now() }));
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));
app.head('/health', (req, res) => res.status(200).end());

// ============ HELPERS ============
function genReference() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let r = 'TP';
  for (let i = 0; i < 6; i++) r += chars[crypto.randomInt(chars.length)];
  return r;
}

async function sendTelegram(uid, text) {
  if (!BOT_TOKEN || !uid) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: uid, text, parse_mode: 'HTML' })
    });
  } catch (e) {}
}

// master wallet এর raw address (0:abcd...) — destination মেলানোর জন্য
const rawCache = {};
async function getRawAddress(addr) {
  if (!addr) throw new Error('no wallet');
  if (rawCache[addr]) return rawCache[addr];
  const r = await fetch(`https://tonapi.io/v2/address/${encodeURIComponent(addr)}/parse`, {
    headers: tonHeaders()
  });
  if (!r.ok) throw new Error('address parse failed: ' + r.status);
  const j = await r.json();
  rawCache[addr] = String(j.raw_form || '').toLowerCase();
  return rawCache[addr];
}

async function getWallet() {
  const cfgSnap = await db.ref('config/ton_deposit').once('value');
  const cfg = cfgSnap.val() || {};
  return cfg.masterWallet || MASTER_WALLET;
}

// ============ CREATE DEPOSIT ============
app.post('/create-deposit', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'DB not ready' });
    const { userId, userName, usdAmount, coin } = req.body || {};
    if (!userId || !usdAmount) return res.status(400).json({ error: 'Missing fields' });

    const cfgSnap = await db.ref('config/ton_deposit').once('value');
    const cfg = cfgSnap.val() || {};
    if (cfg.enabled !== true) return res.status(400).json({ error: 'Deposit disabled' });

    const rate = Number(cfg.rate || 1000);
    const minUSD = Number(cfg.minUSD || 1);
    const maxUSD = Number(cfg.maxUSD || 10000);
    const tonPrice = Number(cfg.tonPrice || 5.0);
    const usd = Number(usdAmount);
    if (!Number.isFinite(usd) || usd <= 0) return res.status(400).json({ error: 'Invalid amount' });
    if (usd < minUSD) return res.status(400).json({ error: `Min $${minUSD}` });
    if (usd > maxUSD) return res.status(400).json({ error: `Max $${maxUSD}` });

    const wallet = cfg.masterWallet || MASTER_WALLET;
    if (!wallet) return res.status(500).json({ error: 'Wallet not configured' });

    const tpcAmount = Math.round(usd * rate);
    const orderId = 'TDEP_' + String(userId).replace(/[.#$\[\]\/]/g, '_') + '_' + Date.now();

    // unique reference
    let reference = genReference();
    for (let i = 0; i < 5; i++) {
      const ex = await db.ref('deposits').orderByChild('reference').equalTo(reference).limitToFirst(1).once('value');
      if (!ex.exists()) break;
      reference = genReference();
    }

    const tonAmount = Number((usd / tonPrice).toFixed(4));
    const nanoTon = Math.round(tonAmount * 1e9);
    const paymentLink = `ton://transfer/${wallet}?amount=${nanoTon}&text=${encodeURIComponent(reference)}`;

    await db.ref('deposits/' + orderId).set({
      orderId,
      userId: String(userId),
      userName: userName || 'User',
      usdAmount: usd,
      tpcAmount,
      coin: coin || 'TON',
      reference,
      masterWallet: wallet,
      tonAmount,
      nanoTon,
      paymentLink,
      status: 'waiting',
      createdAt: Date.now(),
      credited: false,
      provider: 'tonapi'
    });

    return res.json({
      ok: true,
      orderId,
      reference,
      masterWallet: wallet,
      usdAmount: usd,
      tpcAmount,
      coin: coin || 'TON',
      tonAmount,
      nanoTon,
      paymentLink
    });
  } catch (e) {
    console.error('create-deposit error:', e);
    return res.status(500).json({ error: e.message });
  }
});

// ============ WEBHOOK ============
app.post('/webhook', async (req, res) => {
  try {
    if (WEBHOOK_SECRET && req.query.key !== WEBHOOK_SECRET) {
      return res.status(401).json({ ok: false });
    }
    if (!db) return res.status(500).json({ ok: false });
    const body = req.body || {};
    console.log('📥 Webhook:', JSON.stringify(body).slice(0, 400));

    const txId = body.tx_id || body.tx_hash || (body.tx && body.tx.hash) || body.event_id;
    if (!txId || typeof txId !== 'string' || /[.#$\[\]\/]/.test(txId)) {
      return res.json({ ok: true, msg: 'no tx_id' });
    }

    const proc = await db.ref('processedTxs/' + txId).once('value');
    if (proc.exists()) return res.json({ ok: true, msg: 'already processed' });

    const txRes = await fetch(`https://tonapi.io/v2/blockchain/transactions/${txId}`, {
      headers: tonHeaders()
    });
    if (!txRes.ok) {
      console.error('TONAPI fetch fail:', txRes.status);
      return res.status(500).json({ ok: false });
    }
    const tx = await txRes.json();
    await processTx(txId, tx);
    return res.json({ ok: true });
  } catch (e) {
    console.error('Webhook error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ============ TRANSACTION PROCESSOR ============
async function processTx(txId, tx) {
  const inMsg = tx.in_msg || {};
  const valueNano = Number(inMsg.value || 0);
  const valueTon = valueNano / 1e9;
  let comment = '';
  if (inMsg.decoded_body && typeof inMsg.decoded_body.text === 'string') {
    comment = inMsg.decoded_body.text.trim();
  } else if (typeof inMsg.message === 'string') {
    comment = inMsg.message.trim();
  }
  console.log(`TX ${txId}: ${valueTon} TON, comment="${comment}"`);

  // ফেইল/abort হওয়া tx ইগনোর
  if (tx.success === false || tx.aborted === true) {
    await db.ref('processedTxs/' + txId).set({ ts: Date.now(), reason: 'failed_tx' });
    return;
  }

  if (!comment || !comment.startsWith('TP')) {
    await db.ref('processedTxs/' + txId).set({ ts: Date.now(), reason: 'no_ref' });
    return;
  }

  // ✅ টাকা সত্যিই আমাদের master wallet এ এসেছে কিনা চেক
  const wallet = await getWallet();
  const masterRaw = await getRawAddress(wallet);
  const txAccount = String((tx.account && tx.account.address) || '').toLowerCase();
  const destAddr = String((inMsg.destination && inMsg.destination.address) || '').toLowerCase();
  if (txAccount !== masterRaw && destAddr !== masterRaw) {
    console.log('TX not to master wallet, skip:', txId);
    await db.ref('processedTxs/' + txId).set({ ts: Date.now(), reason: 'wrong_wallet' });
    return;
  }

  const depSnap = await db.ref('deposits').orderByChild('reference').equalTo(comment).once('value');
  let matched = null;
  depSnap.forEach((c) => {
    const d = c.val();
    if (d && !d.credited && d.status === 'waiting') matched = { key: c.key, ...d };
    return false;
  });

  if (!matched) {
    console.log('No deposit for reference:', comment);
    await db.ref('processedTxs/' + txId).set({ ts: Date.now(), reason: 'no_match' });
    return;
  }

  // ✅ পরিমাণ চেক (২% tolerance)
  const expectedNano = Number(matched.nanoTon || 0);
  if (valueNano < expectedNano * 0.98) {
    console.log(`Underpaid: got ${valueNano}, expected ${expectedNano}`);
    await db.ref('deposits/' + matched.key).update({
      status: 'underpaid',
      receivedTON: valueTon,
      txId
    });
    await db.ref('processedTxs/' + txId).set({ ts: Date.now(), reason: 'underpaid', depositKey: matched.key });
    return;
  }

  // atomic lock — দুইবার credit আটকানোর জন্য
  const lock = await db.ref('deposits/' + matched.key).transaction((cur) => {
    if (cur === null) return cur; // প্রথম কলে null আসে, সার্ভার আসল ডাটা দিয়ে আবার চালাবে
    if (cur.credited) return; // abort
    cur.credited = true;
    cur.creditedAt = Date.now();
    cur.status = 'finished';
    cur.txId = txId;
    cur.receivedTON = valueTon;
    cur.creditedBy = 'webhook';
    return cur;
  });

  if (!lock.committed) return;

  const d = lock.snapshot.val();
  if (!d || d.txId !== txId) return;

  // lock পাওয়ার সাথে সাথেই processed মার্ক
  await db.ref('processedTxs/' + txId).set({ ts: Date.now(), depositKey: matched.key, userId: d.userId });

  const tpc = Number(d.tpcAmount || 0);
  const uid = d.userId;

  await db.ref('users/' + uid + '/spBalance').transaction((c) => {
    return Math.round((Number(c || 0) + tpc) * 100) / 100;
  });
  await db.ref('users/' + uid + '/totalDeposited').transaction((c) => {
    return Number(c || 0) + Number(d.usdAmount || 0);
  });

  const txRid = 'DEP_' + matched.key;
  await db.ref('users/' + uid + '/transactions/' + txRid).set({
    transactionId: txRid,
    type: 'deposit',
    method: 'TON Deposit',
    amountSP: tpc,
    usdAmount: Number(d.usdAmount || 0),
    netUSDT: Number(d.usdAmount || 0),
    status: 'success',
    timestamp: Date.now(),
    dateStr: new Date().toLocaleString(),
    isDeposit: true,
    txHash: txId
  });

  await db.ref('users/' + uid + '/notifications').push({
    title: '✅ Deposit Received',
    text: `Your deposit of $${d.usdAmount} has been credited. +${tpc} TPC added.`,
    status: 'success',
    txId: txRid,
    timestamp: Date.now()
  });

  await sendTelegram(
    uid,
    `✅ <b>Deposit Confirmed</b>\n\n💰 Amount: $${d.usdAmount}\n🎁 TPC Added: ${tpc}\n🪙 ${d.coin}\n\nThank you! 🚀`
  );
  console.log(`✅ Credited ${tpc} TPC to ${uid}`);
}

// ============ BACKUP POLL ============
app.get('/poll', async (req, res) => {
  try {
    if (POLL_SECRET && req.query.key !== POLL_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!db) return res.status(500).json({ error: 'DB not ready' });
    const wallet = await getWallet();
    if (!wallet) return res.json({ ok: true, msg: 'no wallet' });

    const r = await fetch(`https://tonapi.io/v2/blockchain/accounts/${wallet}/transactions?limit=30`, {
      headers: tonHeaders()
    });
    if (!r.ok) return res.status(500).json({ error: 'TONAPI fail' });
    const data = await r.json();

    let checked = 0, credited = 0;
    for (const tx of data.transactions || []) {
      try {
        const txId = tx.hash;
        const proc = await db.ref('processedTxs/' + txId).once('value');
        if (proc.exists()) continue;
        const inMsg = tx.in_msg || {};
        if (!inMsg.value || Number(inMsg.value) === 0) continue;
        const comment = (inMsg.decoded_body?.text || inMsg.message || '').trim();
        if (!comment || !comment.startsWith('TP')) continue;
        checked++;
        const fullRes = await fetch(`https://tonapi.io/v2/blockchain/transactions/${txId}`, {
          headers: tonHeaders()
        });
        if (fullRes.ok) {
          const full = await fullRes.json();
          await processTx(txId, full);
          credited++;
        }
      } catch (e) {
        console.error('poll tx error:', e.message);
      }
    }
    res.json({ ok: true, checked, credited });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Tarzan Deposit on port ${PORT}`));
