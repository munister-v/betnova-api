const express = require('express')
const router = express.Router()
const { supabaseAdmin } = require('../config/supabase')
const { authMiddleware } = require('../middleware/auth')
const { v4: uuidv4 } = require('uuid')

// Supported crypto assets
const SUPPORTED_ASSETS = [
  { symbol: 'BTC', name: 'Bitcoin', network: 'bitcoin', minDeposit: 0.0001, minWithdraw: 0.0005 },
  { symbol: 'ETH', name: 'Ethereum', network: 'ethereum', minDeposit: 0.001, minWithdraw: 0.005 },
  { symbol: 'SOL', name: 'Solana', network: 'solana', minDeposit: 0.1, minWithdraw: 0.5 },
  { symbol: 'LTC', name: 'Litecoin', network: 'litecoin', minDeposit: 0.01, minWithdraw: 0.05 },
  { symbol: 'USDT', name: 'Tether', network: 'erc20', minDeposit: 1, minWithdraw: 5 },
]

// GET /api/payment/assets
router.get('/assets', (req, res) => {
  return res.json({ success: true, assets: SUPPORTED_ASSETS })
})

// POST /api/payment/user/create — create deposit address for user
router.post('/user/create', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.sub

    // In production integrate a crypto payment processor (e.g. CoinPayments, NOWPayments)
    // For now we generate a placeholder address per user
    const { data: existing } = await supabaseAdmin
      .from('payment_wallets')
      .select('id, address, asset')
      .eq('user_id', userId)

    if (existing?.length > 0) {
      return res.json({ success: true, wallets: existing })
    }

    const wallets = SUPPORTED_ASSETS.map(asset => ({
      id: uuidv4(),
      user_id: userId,
      asset: asset.symbol,
      network: asset.network,
      address: `placeholder_${asset.symbol.toLowerCase()}_${userId.slice(0, 8)}`,
      created_at: new Date().toISOString(),
    }))

    const { data, error } = await supabaseAdmin
      .from('payment_wallets')
      .insert(wallets)
      .select()

    if (error) return res.status(500).json({ success: false, error: error.message })

    return res.json({ success: true, wallets: data })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// POST /api/payment/user/wallet — get or create wallet for specific asset
router.post('/user/wallet', authMiddleware, async (req, res) => {
  try {
    const { asset } = req.body
    const userId = req.user.sub

    if (!asset) return res.status(400).json({ success: false, error: 'asset required' })

    const { data: existing } = await supabaseAdmin
      .from('payment_wallets')
      .select('*')
      .eq('user_id', userId)
      .eq('asset', asset.toUpperCase())
      .single()

    if (existing) return res.json({ success: true, wallet: existing })

    const assetInfo = SUPPORTED_ASSETS.find(a => a.symbol === asset.toUpperCase())
    if (!assetInfo) return res.status(400).json({ success: false, error: 'Unsupported asset' })

    const { data, error } = await supabaseAdmin
      .from('payment_wallets')
      .insert({
        user_id: userId,
        asset: assetInfo.symbol,
        network: assetInfo.network,
        address: `placeholder_${assetInfo.symbol.toLowerCase()}_${userId.slice(0, 8)}`,
      })
      .select()
      .single()

    if (error) return res.status(500).json({ success: false, error: error.message })

    return res.json({ success: true, wallet: data })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
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

    return res.json({ success: true, wallets: data || [] })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
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
      .from('users')
      .select('balance')
      .eq('id', userId)
      .single()

    if (!user || user.balance < amount) {
      return res.status(400).json({ success: false, error: 'Insufficient balance' })
    }

    // Deduct balance
    await supabaseAdmin.from('users').update({ balance: user.balance - amount }).eq('id', userId)

    // Record withdrawal transaction
    const { data: tx } = await supabaseAdmin
      .from('transactions')
      .insert({
        user_id: userId,
        type: 'withdrawal',
        amount,
        asset: asset.toUpperCase(),
        address,
        status: 'pending',
        reference: uuidv4(),
      })
      .select()
      .single()

    // In production: trigger actual crypto transfer via payment processor

    return res.json({ success: true, transaction: tx })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
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

    return res.json({ success: true, transactions: data, total: count, page, limit })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
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

    const deposited = data?.filter(t => t.type === 'deposit').reduce((s, t) => s + t.amount, 0) || 0
    const withdrawn = data?.filter(t => t.type === 'withdrawal').reduce((s, t) => s + t.amount, 0) || 0

    return res.json({ success: true, totalDeposited: deposited, totalWithdrawn: withdrawn })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

module.exports = router
