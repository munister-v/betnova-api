const express = require('express')
const router = express.Router()
const { supabaseAdmin } = require('../config/supabase')
const { authMiddleware } = require('../middleware/auth')
const { generateFloat, hashSeed } = require('../utils/provablyFair')
const { awardXP } = require('../utils/xp')
const config = require('../config')

const RED_NUMBERS = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]
const BLACK_NUMBERS = [2,4,6,8,10,11,13,15,17,20,22,24,26,28,29,31,33,35]

function resolveRoulettePayout(number, betType) {
  if (betType === 'red' && RED_NUMBERS.includes(number)) return 2
  if (betType === 'black' && BLACK_NUMBERS.includes(number)) return 2
  if (betType === 'even' && number !== 0 && number % 2 === 0) return 2
  if (betType === 'odd' && number % 2 !== 0) return 2
  if (betType === '1-18' && number >= 1 && number <= 18) return 2
  if (betType === '19-36' && number >= 19 && number <= 36) return 2
  if (betType === '1st12' && number >= 1 && number <= 12) return 3
  if (betType === '2nd12' && number >= 13 && number <= 24) return 3
  if (betType === '3rd12' && number >= 25 && number <= 36) return 3
  if (!isNaN(betType) && parseInt(betType) === number) return 36
  return 0
}

// GET /api/roulette/current
router.get('/current', async (req, res) => {
  try {
    const { data } = await supabaseAdmin
      .from('roulette_games')
      .select('id, status, result_number, started_at, betting_closes_at')
      .in('status', ['betting', 'spinning'])
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    return res.json({ success: true, game: data || null })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// POST /api/roulette/bet
router.post('/bet', authMiddleware, async (req, res) => {
  try {
    const { betAmount, betType } = req.body
    const userId = req.user.sub

    if (!betAmount || betAmount <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid bet amount' })
    }

    const { data: user } = await supabaseAdmin
      .from('users')
      .select('balance')
      .eq('id', userId)
      .single()

    if (!user || user.balance < betAmount) {
      return res.status(400).json({ success: false, error: 'Insufficient balance' })
    }

    const { data: game } = await supabaseAdmin
      .from('roulette_games')
      .select('id, status, betting_closes_at')
      .eq('status', 'betting')
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    if (!game) {
      return res.status(400).json({ success: false, error: 'No game accepting bets' })
    }

    if (new Date() > new Date(game.betting_closes_at)) {
      return res.status(400).json({ success: false, error: 'Betting period is closed' })
    }

    await supabaseAdmin
      .from('users')
      .update({ balance: user.balance - betAmount })
      .eq('id', userId)

    const { data: bet } = await supabaseAdmin
      .from('roulette_bets')
      .insert({ game_id: game.id, user_id: userId, bet_amount: betAmount, bet_type: betType })
      .select()
      .single()

    awardXP(req.user.sub, betAmount).catch(() => {})
    return res.json({ success: true, bet })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/roulette/history
router.get('/history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20
    const page = parseInt(req.query.page) || 1
    const offset = (page - 1) * limit

    const { data, error, count } = await supabaseAdmin
      .from('roulette_games')
      .select('id, result_number, started_at, ended_at', { count: 'exact' })
      .eq('status', 'completed')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) return res.status(500).json({ success: false, error: error.message })

    return res.json({ success: true, games: data, total: count, page, limit })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/roulette/stats
router.get('/stats', async (req, res) => {
  try {
    const { data } = await supabaseAdmin
      .from('roulette_games')
      .select('result_number')
      .eq('status', 'completed')
      .order('created_at', { ascending: false })
      .limit(100)

    const numbers = data?.map(g => g.result_number) || []
    const reds = numbers.filter(n => RED_NUMBERS.includes(n)).length
    const blacks = numbers.filter(n => BLACK_NUMBERS.includes(n)).length
    const zeros = numbers.filter(n => n === 0).length

    return res.json({
      success: true,
      totalGames: numbers.length,
      redPercent: numbers.length > 0 ? Math.round((reds / numbers.length) * 100) : 0,
      blackPercent: numbers.length > 0 ? Math.round((blacks / numbers.length) * 100) : 0,
      zeroPercent: numbers.length > 0 ? Math.round((zeros / numbers.length) * 100) : 0,
      lastNumbers: numbers.slice(0, 10),
    })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/roulette/my-games
router.get('/my-games', authMiddleware, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20
    const page = parseInt(req.query.page) || 1
    const offset = (page - 1) * limit

    const { data, error, count } = await supabaseAdmin
      .from('roulette_bets')
      .select('id, bet_amount, bet_type, profit, status, created_at, roulette_games(result_number)', { count: 'exact' })
      .eq('user_id', req.user.sub)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) return res.status(500).json({ success: false, error: error.message })

    return res.json({ success: true, games: data, total: count, page, limit })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// POST /api/roulette/verify
router.post('/verify', async (req, res) => {
  try {
    const { serverSeed, clientSeed, nonce } = req.body
    if (!serverSeed || !clientSeed || nonce === undefined) {
      return res.status(400).json({ success: false, error: 'serverSeed, clientSeed and nonce required' })
    }

    const float = generateFloat(serverSeed, clientSeed, nonce)
    const number = Math.floor(float * 37) // 0-36

    return res.json({ success: true, number, float, serverSeedHash: hashSeed(serverSeed) })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

module.exports = router
