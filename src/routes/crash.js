const express = require('express')
const router = express.Router()
const { supabaseAdmin } = require('../config/supabase')
const { authMiddleware } = require('../middleware/auth')
const { generateCrashMultiplier, generateServerSeed, hashSeed } = require('../utils/provablyFair')
const config = require('../config')

// GET /api/crash/config
router.get('/config', (req, res) => {
  return res.json({
    success: true,
    houseEdge: config.houseEdge,
    minBet: 0.01,
    maxBet: 10000,
    maxMultiplier: 1000,
  })
})

// GET /api/crash/current
// Returns the current active crash game state
router.get('/current', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('crash_games')
      .select('id, status, multiplier, started_at, hash')
      .in('status', ['waiting', 'running'])
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    if (error || !data) {
      return res.json({ success: true, game: null })
    }

    return res.json({ success: true, game: data })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// POST /api/crash/bet
router.post('/bet', authMiddleware, async (req, res) => {
  try {
    const { betAmount, autoCashout } = req.body
    const userId = req.user.sub

    if (!betAmount || betAmount <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid bet amount' })
    }

    // Check user balance
    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .select('balance')
      .eq('id', userId)
      .single()

    if (userError || !user) {
      return res.status(404).json({ success: false, error: 'User not found' })
    }

    if (user.balance < betAmount) {
      return res.status(400).json({ success: false, error: 'Insufficient balance' })
    }

    // Find current waiting game
    const { data: game } = await supabaseAdmin
      .from('crash_games')
      .select('id, status')
      .eq('status', 'waiting')
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    if (!game) {
      return res.status(400).json({ success: false, error: 'No game accepting bets right now' })
    }

    // Deduct balance
    const { error: balanceError } = await supabaseAdmin
      .from('users')
      .update({ balance: user.balance - betAmount })
      .eq('id', userId)

    if (balanceError) {
      return res.status(500).json({ success: false, error: 'Balance update failed' })
    }

    // Create bet record
    const { data: bet, error: betError } = await supabaseAdmin
      .from('crash_bets')
      .insert({
        game_id: game.id,
        user_id: userId,
        bet_amount: betAmount,
        auto_cashout: autoCashout || null,
        status: 'active',
      })
      .select()
      .single()

    if (betError) {
      return res.status(500).json({ success: false, error: 'Failed to place bet' })
    }

    return res.json({ success: true, bet })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// POST /api/crash/cashout
router.post('/cashout', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.sub

    // Find active bet in running game
    const { data: bet, error: betError } = await supabaseAdmin
      .from('crash_bets')
      .select('id, bet_amount, game_id, crash_games(multiplier, status)')
      .eq('user_id', userId)
      .eq('status', 'active')
      .single()

    if (betError || !bet) {
      return res.status(400).json({ success: false, error: 'No active bet found' })
    }

    if (bet.crash_games.status !== 'running') {
      return res.status(400).json({ success: false, error: 'Game is not running' })
    }

    const currentMultiplier = bet.crash_games.multiplier
    const profit = bet.bet_amount * currentMultiplier

    // Update bet
    await supabaseAdmin
      .from('crash_bets')
      .update({ status: 'cashed_out', cashout_multiplier: currentMultiplier, profit })
      .eq('id', bet.id)

    // Credit user
    const { data: user } = await supabaseAdmin
      .from('users')
      .select('balance')
      .eq('id', userId)
      .single()

    await supabaseAdmin
      .from('users')
      .update({ balance: user.balance + profit })
      .eq('id', userId)

    return res.json({ success: true, multiplier: currentMultiplier, profit })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/crash/history
router.get('/history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20
    const page = parseInt(req.query.page) || 1
    const offset = (page - 1) * limit

    const { data, error, count } = await supabaseAdmin
      .from('crash_games')
      .select('id, crash_multiplier, started_at, ended_at, hash', { count: 'exact' })
      .eq('status', 'crashed')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) return res.status(500).json({ success: false, error: error.message })

    return res.json({ success: true, games: data, total: count, page, limit })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/crash/bets — current game bets
router.get('/bets', async (req, res) => {
  try {
    const { data: game } = await supabaseAdmin
      .from('crash_games')
      .select('id')
      .in('status', ['waiting', 'running'])
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    if (!game) return res.json({ success: true, bets: [] })

    const { data, error } = await supabaseAdmin
      .from('crash_bets')
      .select('id, bet_amount, cashout_multiplier, profit, status, users(username, avatar_url)')
      .eq('game_id', game.id)

    if (error) return res.status(500).json({ success: false, error: error.message })

    return res.json({ success: true, bets: data })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/crash/statistics
router.get('/statistics', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('crash_games')
      .select('crash_multiplier')
      .eq('status', 'crashed')
      .order('created_at', { ascending: false })
      .limit(100)

    if (error) return res.status(500).json({ success: false, error: error.message })

    const multipliers = data.map(g => g.crash_multiplier)
    const avg = multipliers.reduce((s, m) => s + m, 0) / (multipliers.length || 1)
    const under2x = multipliers.filter(m => m < 2).length

    return res.json({
      success: true,
      totalGames: multipliers.length,
      averageMultiplier: Math.round(avg * 100) / 100,
      under2xPercent: multipliers.length > 0 ? Math.round((under2x / multipliers.length) * 100) : 0,
    })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/crash/stats — alias
router.get('/stats', async (req, res) => {
  req.url = '/statistics'
  router.handle(req, res, () => {})
})

// GET /api/crash/user-games
router.get('/user-games', authMiddleware, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20
    const page = parseInt(req.query.page) || 1
    const offset = (page - 1) * limit

    const { data, error, count } = await supabaseAdmin
      .from('crash_bets')
      .select('id, bet_amount, cashout_multiplier, profit, status, created_at, crash_games(crash_multiplier, started_at)', { count: 'exact' })
      .eq('user_id', req.user.sub)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) return res.status(500).json({ success: false, error: error.message })

    return res.json({ success: true, games: data, total: count, page, limit })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/crash/games — recent games list
router.get('/games', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('crash_games')
      .select('id, crash_multiplier, started_at, hash')
      .eq('status', 'crashed')
      .order('created_at', { ascending: false })
      .limit(10)

    if (error) return res.status(500).json({ success: false, error: error.message })

    return res.json({ success: true, games: data })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// POST /api/crash/verify — provably fair verification
router.post('/verify', async (req, res) => {
  try {
    const { serverSeed, clientSeed, nonce } = req.body

    if (!serverSeed || !clientSeed || nonce === undefined) {
      return res.status(400).json({ success: false, error: 'serverSeed, clientSeed and nonce required' })
    }

    const multiplier = generateCrashMultiplier(serverSeed, clientSeed, nonce, config.houseEdge)

    return res.json({
      success: true,
      multiplier,
      serverSeedHash: hashSeed(serverSeed),
    })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

module.exports = router
