const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '1mb' }));

// ============ FIREBASE INIT ============
let db = null;
try {
  const saRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!saRaw) throw new Error('FIREBASE_SERVICE_ACCOUNT missing');
  const sa = JSON.parse(saRaw);
  admin.initializeApp({
    credential: admin.credential.cert(sa),
    databaseURL: 'https://tarzan-pay-ok-default-rtdb.firebaseio.com'
  });
  db = admin.database();
  console.log('✅ Firebase initialized for:', sa.project_id);
} catch (e) {
  console.error('❌ Firebase init failed:', e.message);
}

const TONAPI_KEY = process.env.TONAPI_KEY || '';
const MASTER_WALLET = process.env.MASTER_WALLET || '';
const BOT_TOKEN = process.env.BOT_TOKEN || '';

// ============ HEALTH ============
app.get('/', (req, res) => res.json({ ok: true, service: 'Tarzan TON Deposit', ts: Date.now() }));
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));
app.head('/health', (req, res) => res.status(200).end());

// ============ HELPERS ============
function genReference() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let r = 'TP';
  for (let i = 0; i < 6; i++) r += chars[Math.floor(Math.random() * chars.length)];
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
    const tonPrice = Number(cfg.tonPrice || 5.0);
    const usd = Number(usdAmount);
    if (usd < minUSD) return res.status(400).json({ error: `Min $${minUSD}` });

    const tpcAmount = Math.round(usd * rate);
    const orderId = 'TDEP_' + userId + '_' + Date.now();
    const reference = genReference();
    const tonAmount = Number((usd / tonPrice).toFixed(4));
    const nanoTon = Math.round(tonAmount * 1e9);
    const wallet = cfg.masterWallet || MASTER_WALLET;
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
    if (!db) return res.status(500).json({ ok: false });
    const body = req.body;
    console.log('📥 Webhook:', JSON.stringify(body).slice(0, 400));

    const txId = body.tx_id || body.tx_hash || (body.tx && body.tx.hash) || body.event_id;
    if (!txId) return res.json({ ok: true, msg: 'no tx_id' });

    const proc = await db.ref('processedTxs/' + txId).once('value');
    if (proc.exists()) return res.json({ ok: true, msg: 'already processed' });

    const txRes = await fetch(`https://tonapi.io/v2/blockchain/transactions/${txId}`, {
      headers: { 'Authorization': 'Bearer ' + TONAPI_KEY }
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
  try {
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

    if (!comment || !comment.startsWith('TP')) {
      await db.ref('processedTxs/' + txId).set({ ts: Date.now(), reason: 'no_ref' });
      return;
    }

    const depSnap = await db.ref('deposits').orderByChild('reference').equalTo(comment).once('value');
    let matched = null;
    depSnap.forEach(c => {
      const d = c.val();
      if (d && !d.credited && d.status === 'waiting') matched = { key: c.key, ...d };
      return false;
    });

    if (!matched) {
      console.log('No deposit for reference:', comment);
      await db.ref('processedTxs/' + txId).set({ ts: Date.now(), reason: 'no_match' });
      return;
    }

    const lock = await db.ref('deposits/' + matched.key).transaction(cur => {
      if (!cur || cur.credited) return;
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
    const tpc = Number(d.tpcAmount || 0);
    const uid = d.userId;

    await db.ref('users/' + uid + '/spBalance').transaction(c => {
      return Math.round((Number(c || 0) + tpc) * 100) / 100;
    });
    await db.ref('users/' + uid + '/totalDeposited').transaction(c => {
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

    await db.ref('processedTxs/' + txId).set({ ts: Date.now(), depositKey: matched.key, userId: uid });
    await sendTelegram(uid, `✅ <b>Deposit Confirmed</b>\n\n💰 Amount: $${d.usdAmount}\n🎁 TPC Added: ${tpc}\n🪙 ${d.coin}\n\nThank you! 🚀`);
    console.log(`✅ Credited ${tpc} TPC to ${uid}`);
  } catch (e) {
    console.error('processTx error:', e);
  }
}

// ============ BACKUP POLL ============
app.get('/poll', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'DB not ready' });
    const cfgSnap = await db.ref('config/ton_deposit').once('value');
    const cfg = cfgSnap.val() || {};
    const wallet = cfg.masterWallet || MASTER_WALLET;
    if (!wallet) return res.json({ ok: true, msg: 'no wallet' });

    const r = await fetch(`https://tonapi.io/v2/blockchain/accounts/${wallet}/transactions?limit=30`, {
      headers: { 'Authorization': 'Bearer ' + TONAPI_KEY }
    });
    if (!r.ok) return res.status(500).json({ error: 'TONAPI fail' });
    const data = await r.json();

    let checked = 0, credited = 0;
    for (const tx of (data.transactions || [])) {
      const txId = tx.hash;
      const proc = await db.ref('processedTxs/' + txId).once('value');
      if (proc.exists()) continue;
      const inMsg = tx.in_msg || {};
      if (!inMsg.value || Number(inMsg.value) === 0) continue;
      const comment = (inMsg.decoded_body?.text || inMsg.message || '').trim();
      if (!comment || !comment.startsWith('TP')) continue;
      checked++;
      const fullRes = await fetch(`https://tonapi.io/v2/blockchain/transactions/${txId}`, {
        headers: { 'Authorization': 'Bearer ' + TONAPI_KEY }
      });
      if (fullRes.ok) {
        const full = await fullRes.json();
        await processTx(txId, full);
        credited++;
      }
    }
    res.json({ ok: true, checked, credited });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Tarzan Deposit on port ${PORT}`));
