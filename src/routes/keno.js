/**
 * Keno — pick 1-10 numbers (1-40), backend draws 20, pay based on matches
 * Provably fair: each drawn number via generateFloat
 */
const express = require('express')
const router = express.Router()
const { supabaseAdmin } = require('../config/supabase')
const { authMiddleware } = require('../middleware/auth')
const { generateFloat, generateServerSeed, generateClientSeed, hashSeed } = require('../utils/provablyFair')
const { awardXP } = require('../utils/xp')
const { emitWin } = require('../utils/emitWin')
const config = require('../config')

const TOTAL_NUMBERS = 40
const DRAWN_COUNT   = 20

// Multiplier table: [picks][matches] → multiplier
// picks = how many numbers player selected (1-10)
// matches = how many of those hit in drawn 20
const PAYOUTS = {
  1:  [0, 3.8],
  2:  [0, 0, 7],
  3:  [0, 0, 2, 27],
  4:  [0, 0, 1.4, 5, 80],
  5:  [0, 0, 1.2, 3, 20, 300],
  6:  [0, 0, 1, 2, 8, 100, 1500],
  7:  [0, 0, 0.5, 1.5, 5, 30, 500, 5000],
  8:  [0, 0, 0.5, 1.2, 3, 15, 100, 1000, 10000],
  9:  [0, 0, 0.5, 1, 2, 8, 50, 300, 3000, 30000],
  10: [0, 0, 0.5, 1, 1.5, 5, 20, 100, 1000, 10000, 100000],
}

function drawNumbers(serverSeed, clientSeed, nonce) {
  const pool = Array.from({ length: TOTAL_NUMBERS }, (_, i) => i + 1)
  const drawn = []
  for (let i = 0; i < DRAWN_COUNT; i++) {
    const f = generateFloat(serverSeed, clientSeed, `${nonce}:${i}`)
    const idx = Math.floor(f * (pool.length))
    drawn.push(pool.splice(idx, 1)[0])
  }
  return drawn
}

// POST /api/keno/bet
router.post('/bet', authMiddleware, async (req, res) => {
  try {
    const { betAmount, picks } = req.body   // picks: number[] 1-40, length 1-10
    const userId = req.user.sub

    if (!betAmount || betAmount <= 0) return res.status(400).json({ success: false, error: 'Invalid bet' })
    if (!Array.isArray(picks) || picks.length < 1 || picks.length > 10) {
      return res.status(400).json({ success: false, error: 'Pick 1-10 numbers' })
    }
    if (picks.some(n => n < 1 || n > TOTAL_NUMBERS || !Number.isInteger(n))) {
      return res.status(400).json({ success: false, error: 'Numbers must be 1-40' })
    }
    if (new Set(picks).size !== picks.length) {
      return res.status(400).json({ success: false, error: 'Duplicate numbers not allowed' })
    }

    const { data: user } = await supabaseAdmin
      .from('users').select('balance, server_seed, client_seed, nonce').eq('id', userId).single()

    if (!user || user.balance < betAmount) {
      return res.status(400).json({ success: false, error: 'Insufficient balance' })
    }

    const serverSeed  = user.server_seed  || generateServerSeed()
    const clientSeed  = user.client_seed  || generateClientSeed()
    const nonce       = user.nonce        || 0

    const drawn   = drawNumbers(serverSeed, clientSeed, nonce)
    const matches = picks.filter(n => drawn.includes(n)).length
    const multiplier = PAYOUTS[picks.length][matches] || 0
    const profit  = parseFloat((betAmount * multiplier).toFixed(2))
    const netProfit = parseFloat((profit - betAmount).toFixed(2))
    const newBalance = parseFloat((user.balance - betAmount + profit).toFixed(2))

    await supabaseAdmin.from('users')
      .update({ balance: newBalance, nonce: nonce + 1 }).eq('id', userId)

    await supabaseAdmin.from('game_history').insert({
      user_id: userId,
      game_type: 'keno',
      bet_amount: betAmount,
      multiplier,
      profit: netProfit,
      result: { picks, drawn, matches },
      server_seed_hash: hashSeed(serverSeed),
      client_seed: clientSeed,
      nonce,
    })

    awardXP(userId, betAmount).catch(() => {})
    if (netProfit > 0) {
      const { data: usr } = await supabaseAdmin.from('users').select('username, avatar_url').eq('id', userId).single().catch(() => ({ data: null }))
      emitWin({ gameType: 'keno', username: usr?.username, avatarUrl: usr?.avatar_url, betAmount, profit: netProfit, multiplier })
    }

    return res.json({ success: true, drawn, picks, matches, multiplier, profit, netProfit, newBalance, serverSeedHash: hashSeed(serverSeed), clientSeed, nonce })
  } catch (err) {
    console.error('Keno bet error:', err)
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/keno/payouts
router.get('/payouts', (req, res) => res.json({ success: true, payouts: PAYOUTS, totalNumbers: TOTAL_NUMBERS, drawnCount: DRAWN_COUNT }))

// GET /api/keno/history
router.get('/history', authMiddleware, async (req, res) => {
  try {
    const { data } = await supabaseAdmin.from('game_history')
      .select('id, bet_amount, multiplier, profit, result, created_at')
      .eq('user_id', req.user.sub).eq('game_type', 'keno')
      .order('created_at', { ascending: false }).limit(20)
    return res.json({ success: true, games: data || [] })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

module.exports = router
