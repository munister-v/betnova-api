const express = require('express')
const router = express.Router()
const { supabaseAdmin } = require('../config/supabase')
const { authMiddleware } = require('../middleware/auth')
const { generateFloat, generateServerSeed, generateClientSeed, hashSeed } = require('../utils/provablyFair')
const { awardXP } = require('../utils/xp')
const { emitWin } = require('../utils/emitWin')
const config = require('../config')

// POST /api/dice/bet
// body: { betAmount, target (1-98), direction ('over'|'under') }
// direction 'over'  → win if roll > target
// direction 'under' → win if roll < target
// roll = floor(generateFloat * 10000) / 100  → 0.00..99.99
router.post('/bet', authMiddleware, async (req, res) => {
  try {
    const { betAmount, target, direction = 'over' } = req.body
    const userId = req.user.sub

    const t = parseFloat(target)
    if (!betAmount || betAmount <= 0) return res.status(400).json({ success: false, error: 'Invalid bet amount' })
    if (isNaN(t) || t < 2 || t > 98) return res.status(400).json({ success: false, error: 'Target must be 2–98' })
    if (!['over', 'under'].includes(direction)) return res.status(400).json({ success: false, error: 'Direction must be over or under' })

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

    const float = generateFloat(serverSeed, clientSeed, String(nonce))
    const roll = Math.floor(float * 10000) / 100 // 0.00–99.99

    // Win chance and multiplier
    const winChance = direction === 'over' ? (99 - t) : (t - 1)
    const multiplier = parseFloat(((100 - config.houseEdge) / winChance).toFixed(4))

    const won = direction === 'over' ? roll > t : roll < t
    const profit = won ? parseFloat((betAmount * multiplier).toFixed(2)) : 0
    const netProfit = parseFloat((profit - betAmount).toFixed(2))
    const newBalance = parseFloat((user.balance - betAmount + profit).toFixed(2))

    await supabaseAdmin
      .from('users')
      .update({ balance: newBalance, nonce: nonce + 1 })
      .eq('id', userId)

    await supabaseAdmin.from('game_history').insert({
      user_id: userId,
      game_type: 'dice',
      bet_amount: betAmount,
      multiplier: won ? multiplier : 0,
      profit: netProfit,
      result: { roll, target: t, direction, won },
      server_seed_hash: hashSeed(serverSeed),
      client_seed: clientSeed,
      nonce,
    })

    awardXP(userId, betAmount).catch(() => {})

    if (won) {
      const { data: usr } = await supabaseAdmin.from('users').select('username, avatar_url').eq('id', userId).single().catch(() => ({ data: null }))
      emitWin({ gameType: 'dice', username: usr?.username, avatarUrl: usr?.avatar_url, betAmount, profit: netProfit, multiplier })
    }

    return res.json({
      success: true,
      roll,
      won,
      multiplier: won ? multiplier : 0,
      profit,
      netProfit,
      newBalance,
      winChance,
      serverSeedHash: hashSeed(serverSeed),
      clientSeed,
      nonce,
    })
  } catch (err) {
    console.error('Dice bet error:', err)
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/dice/history
router.get('/history', authMiddleware, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20
    const { data } = await supabaseAdmin
      .from('game_history')
      .select('id, bet_amount, multiplier, profit, result, created_at')
      .eq('user_id', req.user.sub)
      .eq('game_type', 'dice')
      .order('created_at', { ascending: false })
      .limit(limit)
    return res.json({ success: true, games: data || [] })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// POST /api/dice/verify
router.post('/verify', async (req, res) => {
  try {
    const { serverSeed, clientSeed, nonce } = req.body
    if (!serverSeed || !clientSeed || nonce === undefined) {
      return res.status(400).json({ success: false, error: 'serverSeed, clientSeed, nonce required' })
    }
    const float = generateFloat(serverSeed, clientSeed, String(nonce))
    const roll = Math.floor(float * 10000) / 100
    return res.json({ success: true, roll, serverSeedHash: hashSeed(serverSeed) })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

module.exports = router
