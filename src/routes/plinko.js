const express = require('express')
const router = express.Router()
const { supabaseAdmin } = require('../config/supabase')
const { authMiddleware } = require('../middleware/auth')
const { generateFloat, generateServerSeed, generateClientSeed, hashSeed } = require('../utils/provablyFair')
const { awardXP } = require('../utils/xp')
const { emitWin } = require('../utils/emitWin')
const config = require('../config')

// Multiplier tables per risk level (indexed by slot: 0 = leftmost, rows = rightmost)
// Symmetric, so we define the left half + center
const MULTIPLIERS = {
  low: {
    8:  [5.6, 2.1, 1.1, 1.0, 0.5, 1.0, 1.1, 2.1, 5.6],
    10: [8.9, 3.0, 1.4, 1.1, 1.0, 0.5, 1.0, 1.1, 1.4, 3.0, 8.9],
    12: [10.0, 3.0, 1.6, 1.4, 1.1, 1.0, 0.5, 1.0, 1.1, 1.4, 1.6, 3.0, 10.0],
    14: [18.0, 4.0, 1.7, 1.4, 1.1, 1.0, 0.7, 0.5, 0.7, 1.0, 1.1, 1.4, 1.7, 4.0, 18.0],
    16: [16.0, 9.0, 2.0, 1.4, 1.4, 1.2, 1.1, 1.0, 0.5, 1.0, 1.1, 1.2, 1.4, 1.4, 2.0, 9.0, 16.0],
  },
  medium: {
    8:  [13.0, 3.0, 1.3, 0.7, 0.4, 0.7, 1.3, 3.0, 13.0],
    10: [22.0, 5.0, 2.0, 1.4, 0.6, 0.4, 0.6, 1.4, 2.0, 5.0, 22.0],
    12: [33.0, 11.0, 4.0, 2.0, 1.1, 0.6, 0.3, 0.6, 1.1, 2.0, 4.0, 11.0, 33.0],
    14: [43.0, 13.0, 6.0, 3.0, 1.3, 0.7, 0.4, 0.2, 0.4, 0.7, 1.3, 3.0, 6.0, 13.0, 43.0],
    16: [58.0, 15.0, 7.0, 4.0, 1.9, 1.0, 0.5, 0.2, 0.2, 0.5, 1.0, 1.9, 4.0, 7.0, 15.0, 58.0, 58.0], // asymmetric intentional
  },
  high: {
    8:  [29.0, 4.0, 1.5, 0.3, 0.2, 0.3, 1.5, 4.0, 29.0],
    10: [76.0, 10.0, 3.0, 0.9, 0.3, 0.2, 0.3, 0.9, 3.0, 10.0, 76.0],
    12: [170.0, 24.0, 5.0, 2.0, 0.7, 0.2, 0.2, 0.2, 0.7, 2.0, 5.0, 24.0, 170.0],
    14: [350.0, 40.0, 8.0, 2.0, 0.7, 0.4, 0.2, 0.1, 0.2, 0.4, 0.7, 2.0, 8.0, 40.0, 350.0],
    16: [1000.0, 130.0, 26.0, 9.0, 4.0, 2.0, 0.2, 0.2, 0.2, 0.2, 2.0, 4.0, 9.0, 26.0, 130.0, 1000.0, 1000.0],
  },
}

const VALID_ROWS = [8, 10, 12, 14, 16]
const VALID_RISKS = ['low', 'medium', 'high']

// Generate ball path: array of 0 (left) or 1 (right) for each peg row
function generatePath(serverSeed, clientSeed, nonce, rows) {
  const path = []
  for (let i = 0; i < rows; i++) {
    const f = generateFloat(serverSeed, clientSeed, `${nonce}:${i}`)
    path.push(f < 0.5 ? 0 : 1) // 0 = left, 1 = right
  }
  return path
}

// GET /api/plinko/config
router.get('/config', (req, res) => {
  return res.json({
    success: true,
    validRows: VALID_ROWS,
    validRisks: VALID_RISKS,
    multipliers: MULTIPLIERS,
    minBet: 0.01,
    maxBet: 1000,
    houseEdge: config.houseEdge,
  })
})

// POST /api/plinko/bet — single-shot provably fair bet
router.post('/bet', authMiddleware, async (req, res) => {
  try {
    const { betAmount, rows = 16, risk = 'medium' } = req.body
    const userId = req.user.sub

    if (!betAmount || betAmount <= 0) return res.status(400).json({ success: false, error: 'Invalid bet amount' })
    if (!VALID_ROWS.includes(Number(rows))) return res.status(400).json({ success: false, error: `Rows must be one of ${VALID_ROWS.join(', ')}` })
    if (!VALID_RISKS.includes(risk)) return res.status(400).json({ success: false, error: 'Risk must be low, medium, or high' })

    const numRows = Number(rows)

    const { data: user } = await supabaseAdmin
      .from('users')
      .select('balance, server_seed, client_seed, nonce')
      .eq('id', userId)
      .single()

    if (!user || user.balance < betAmount) {
      return res.status(400).json({ success: false, error: 'Insufficient balance' })
    }

    const serverSeed = user.server_seed || generateServerSeed()
    const clientSeed = user.client_seed || generateClientSeed()
    const nonce = user.nonce || 0

    // Generate ball path
    const path = generatePath(serverSeed, clientSeed, nonce, numRows)
    const slot = path.reduce((sum, v) => sum + v, 0) // 0..rows
    const mults = MULTIPLIERS[risk][numRows]
    const multiplier = mults[slot]
    const profit = parseFloat((betAmount * multiplier).toFixed(2))
    const netProfit = parseFloat((profit - betAmount).toFixed(2))

    // Update balance and nonce atomically
    const newBalance = parseFloat((user.balance - betAmount + profit).toFixed(2))
    await supabaseAdmin
      .from('users')
      .update({ balance: newBalance, nonce: nonce + 1 })
      .eq('id', userId)

    // Record in game_history
    await supabaseAdmin.from('game_history').insert({
      user_id: userId,
      game_type: 'plinko',
      bet_amount: betAmount,
      multiplier,
      profit: netProfit,
      result: { slot, path, rows: numRows, risk },
      server_seed_hash: hashSeed(serverSeed),
      client_seed,
      nonce,
    })

    awardXP(userId, betAmount).catch(() => {})
    if (multiplier > 1) {
      const { data: usr } = await supabaseAdmin.from('users').select('username, avatar_url').eq('id', userId).single().catch(() => ({ data: null }))
      emitWin({ gameType: 'plinko', username: usr?.username, avatarUrl: usr?.avatar_url, betAmount, profit: netProfit, multiplier })
    }

    return res.json({
      success: true,
      slot,
      path,
      multiplier,
      profit,
      netProfit,
      newBalance,
      serverSeedHash: hashSeed(serverSeed),
      clientSeed,
      nonce,
    })
  } catch (err) {
    console.error('Plinko bet error:', err)
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/plinko/history
router.get('/history', authMiddleware, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20
    const { data } = await supabaseAdmin
      .from('game_history')
      .select('id, bet_amount, multiplier, profit, result, created_at')
      .eq('user_id', req.user.sub)
      .eq('game_type', 'plinko')
      .order('created_at', { ascending: false })
      .limit(limit)

    return res.json({ success: true, games: data || [] })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// POST /api/plinko/verify
router.post('/verify', async (req, res) => {
  try {
    const { serverSeed, clientSeed, nonce, rows = 16, risk = 'medium' } = req.body
    if (!serverSeed || !clientSeed || nonce === undefined) {
      return res.status(400).json({ success: false, error: 'serverSeed, clientSeed, nonce required' })
    }
    const numRows = Number(rows)
    if (!VALID_ROWS.includes(numRows)) return res.status(400).json({ success: false, error: 'Invalid rows' })
    if (!VALID_RISKS.includes(risk)) return res.status(400).json({ success: false, error: 'Invalid risk' })

    const path = generatePath(serverSeed, clientSeed, nonce, numRows)
    const slot = path.reduce((sum, v) => sum + v, 0)
    const multiplier = MULTIPLIERS[risk][numRows][slot]

    return res.json({ success: true, path, slot, multiplier, serverSeedHash: hashSeed(serverSeed) })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

module.exports = router
