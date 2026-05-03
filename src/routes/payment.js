const express = require('express')
const router = express.Router()
const axios = require('axios')
const crypto = require('crypto')
const { supabaseAdmin } = require('../config/supabase')
const { authMiddleware } = require('../middleware/auth')
const { v4: uuidv4 } = require('uuid')
const config = require('../config')

const NP_API = 'https://api.nowpayments.io/v1'
const NP_HEADERS = () => ({ 'x-api-key': config.nowpayments.apiKey, 'Content-Type': 'application/json' })

const SUPPORTED_ASSETS = [
  { symbol: 'BTC',  name: 'Bitcoin',  nowpCurrency: 'btc',   minDeposit: 0.0001, minWithdraw: 0.0005 },
  { symbol: 'ETH',  name: 'Ethereum', nowpCurrency: 'eth',   minDeposit: 0.001,  minWithdraw: 0.005  },
  { symbol: 'SOL',  name: 'Solana',   nowpCurrency: 'sol',   minDeposit: 0.1,    minWithdraw: 0.5    },
  { symbol: 'LTC',  name: 'Litecoin', nowpCurrency: 'ltc',   minDeposit: 0.01,   minWithdraw: 0.05   },
  { symbol: 'USDT', name: 'Tether',   nowpCurrency: 'usdterc20', minDeposit: 1,  minWithdraw: 5      },
]

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getNowPaymentsEstimate(amount, currency) {
  const { data } = await axios.get(`${NP_API}/estimate`, {
    params: { amount, currency_from: currency, currency_to: 'usd' },
    headers: NP_HEADERS(),
  })
  return parseFloat(data.estimated_amount) || 0
}

function verifyIpnSignature(payload, signature) {
  if (!config.nowpayments.ipnSecret) return true
  const sorted = JSON.stringify(
    Object.keys(payload).sort().reduce((acc, k) => { acc[k] = payload[k]; return acc }, {})
  )
  const hmac = crypto.createHmac('sha512', config.nowpayments.ipnSecret).update(sorted).digest('hex')
  return hmac === signature
}

// ── Routes ───────────────────────────────────────────────────────────────────

// GET /api/payment/assets
router.get('/assets', (req, res) => {
  res.json({ success: true, assets: SUPPORTED_ASSETS })
})

// POST /api/payment/deposit/create
// Creates a NOWPayments payment and returns the deposit address
router.post('/deposit/create', authMiddleware, async (req, res) => {
  try {
    const { asset } = req.body
    const userId = req.user.sub

    const assetInfo = SUPPORTED_ASSETS.find(a => a.symbol === (asset || '').toUpperCase())
    if (!assetInfo) return res.status(400).json({ success: false, error: 'Unsupported asset' })

    // Reuse existing pending payment if exists
    const { data: existing } = await supabaseAdmin
      .from('payment_wallets')
      .select('*')
      .eq('user_id', userId)
      .eq('asset', assetInfo.symbol)
      .single()

    if (existing) return res.json({ success: true, wallet: existing })

    // Create payment with NOWPayments
    const orderId = `${userId}_${assetInfo.symbol}_${Date.now()}`
    const { data: payment } = await axios.post(`${NP_API}/payment`, {
      price_amount: 100,
      price_currency: 'usd',
      pay_currency: assetInfo.nowpCurrency,
      order_id: orderId,
      order_description: `BetNova deposit – ${userId}`,
      ipn_callback_url: config.nowpayments.callbackUrl,
      is_fixed_rate: false,
      is_fee_paid_by_user: false,
    }, { headers: NP_HEADERS() })

    // Save wallet address
    const { data: wallet, error } = await supabaseAdmin
      .from('payment_wallets')
      .insert({
        user_id: userId,
        asset: assetInfo.symbol,
        network: assetInfo.nowpCurrency,
        address: payment.pay_address,
      })
      .select()
      .single()

    if (error) return res.status(500).json({ success: false, error: error.message })

    // Save pending transaction reference
    await supabaseAdmin.from('transactions').insert({
      user_id: userId,
      type: 'deposit',
      amount: 0,
      asset: assetInfo.symbol,
      address: payment.pay_address,
      status: 'pending',
      reference: payment.payment_id?.toString() || orderId,
      metadata: { nowpayments_id: payment.payment_id, order_id: orderId },
    })

    res.json({ success: true, wallet })
  } catch (err) {
    console.error('Deposit create error:', err.response?.data || err.message)
    res.status(500).json({ success: false, error: 'Failed to create deposit address' })
  }
})

// GET /api/payment/user/wallets
router.get('/user/wallets', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('payment_wallets')
      .select('*')
      .eq('user_id', req.user.sub)

    if (error) return res.status(500).json({ success: false, error: error.message })
    res.json({ success: true, wallets: data || [] })
  } catch (err) {
    res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// POST /api/payment/webhook  (NOWPayments IPN)
router.post('/webhook', express.json({ type: '*/*' }), async (req, res) => {
  try {
    const signature = req.headers['x-nowpayments-sig']
    if (!verifyIpnSignature(req.body, signature)) {
      return res.status(401).json({ error: 'Invalid signature' })
    }

    const { payment_id, payment_status, price_amount, price_currency, order_id, actually_paid, pay_currency } = req.body

    // Only process confirmed/finished payments
    if (!['confirmed', 'finished'].includes(payment_status)) {
      return res.json({ received: true })
    }

    // Find transaction by reference
    const { data: tx } = await supabaseAdmin
      .from('transactions')
      .select('*')
      .eq('reference', payment_id?.toString())
      .single()

    if (!tx || tx.status === 'completed') return res.json({ received: true })

    // Convert to USD — use price_amount if currency is usd, else estimate
    let usdAmount = price_currency === 'usd' ? parseFloat(price_amount) : 0
    if (!usdAmount) {
      try { usdAmount = await getNowPaymentsEstimate(actually_paid, pay_currency) } catch (_) {}
    }
    if (!usdAmount) usdAmount = parseFloat(actually_paid) || 0

    // Credit user balance
    const { data: user } = await supabaseAdmin
      .from('users')
      .select('balance')
      .eq('id', tx.user_id)
      .single()

    await Promise.all([
      supabaseAdmin
        .from('users')
        .update({ balance: (user?.balance || 0) + usdAmount })
        .eq('id', tx.user_id),
      supabaseAdmin
        .from('transactions')
        .update({ status: 'completed', amount: usdAmount, metadata: req.body })
        .eq('id', tx.id),
    ])

    console.log(`✅ Deposit confirmed: $${usdAmount} for user ${tx.user_id}`)
    res.json({ received: true })
  } catch (err) {
    console.error('Webhook error:', err.message)
    res.status(500).json({ error: 'Webhook processing failed' })
  }
})

// POST /api/payment/user/withdraw
router.post('/user/withdraw', authMiddleware, async (req, res) => {
  try {
    const { asset, amount, address } = req.body
    const userId = req.user.sub

    if (!asset || !amount || !address) {
      return res.status(400).json({ success: false, error: 'asset, amount and address required' })
    }

    const assetInfo = SUPPORTED_ASSETS.find(a => a.symbol === asset.toUpperCase())
    if (!assetInfo) return res.status(400).json({ success: false, error: 'Unsupported asset' })

    if (amount < assetInfo.minWithdraw) {
      return res.status(400).json({ success: false, error: `Minimum withdrawal is ${assetInfo.minWithdraw} ${asset}` })
    }

    const { data: user } = await supabaseAdmin
      .from('users').select('balance').eq('id', userId).single()

    if (!user || user.balance < amount) {
      return res.status(400).json({ success: false, error: 'Insufficient balance' })
    }

    // Deduct balance immediately
    await supabaseAdmin
      .from('users')
      .update({ balance: user.balance - amount })
      .eq('id', userId)

    const reference = uuidv4()

    const { data: tx } = await supabaseAdmin
      .from('transactions')
      .insert({
        user_id: userId,
        type: 'withdrawal',
        amount,
        asset: asset.toUpperCase(),
        address,
        status: 'pending',
        reference,
      })
      .select()
      .single()

    // NOWPayments Payouts (requires approved payout account)
    if (config.nowpayments.apiKey) {
      try {
        await axios.post(`${NP_API}/payout`, {
          ipn_callback_url: config.nowpayments.callbackUrl,
          withdrawals: [{
            address,
            currency: assetInfo.nowpCurrency,
            amount,
            ipn_callback_url: config.nowpayments.callbackUrl,
            extra_id: reference,
          }],
        }, { headers: NP_HEADERS() })

        await supabaseAdmin
          .from('transactions')
          .update({ status: 'processing' })
          .eq('id', tx.id)
      } catch (payoutErr) {
        console.error('Payout API error:', payoutErr.response?.data || payoutErr.message)
        // Keep as pending for manual processing
      }
    }

    res.json({ success: true, transaction: tx })
  } catch (err) {
    console.error('Withdraw error:', err.message)
    res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/payment/user/transactions
router.get('/user/transactions', authMiddleware, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20
    const page = parseInt(req.query.page) || 1
    const offset = (page - 1) * limit

    const { data, error, count } = await supabaseAdmin
      .from('transactions')
      .select('*', { count: 'exact' })
      .eq('user_id', req.user.sub)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) return res.status(500).json({ success: false, error: error.message })
    res.json({ success: true, transactions: data, total: count, page, limit })
  } catch (err) {
    res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/payment/user/stats
router.get('/user/stats', authMiddleware, async (req, res) => {
  try {
    const { data } = await supabaseAdmin
      .from('transactions')
      .select('type, amount, status')
      .eq('user_id', req.user.sub)
      .eq('status', 'completed')

    const deposited = data?.filter(t => t.type === 'deposit').reduce((s, t) => s + parseFloat(t.amount), 0) || 0
    const withdrawn = data?.filter(t => t.type === 'withdrawal').reduce((s, t) => s + parseFloat(t.amount), 0) || 0

    res.json({ success: true, totalDeposited: deposited, totalWithdrawn: withdrawn })
  } catch (err) {
    res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

module.exports = router
