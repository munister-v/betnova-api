const express = require('express')
const router = express.Router()
const { supabaseAdmin } = require('../config/supabase')
const { authMiddleware } = require('../middleware/auth')
const { generateFloat, generateServerSeed, generateClientSeed, hashSeed } = require('../utils/provablyFair')
const { awardXP } = require('../utils/xp')
const config = require('../config')

// GET /api/coinflip/config
router.get('/config', (req, res) => {
  return res.json({
    success: true,
    houseEdge: config.houseEdge,
    minBet: 0.01,
    maxBet: 10000,
    sides: ['heads', 'tails'],
  })
})

// POST /api/coinflip/create — create a game waiting for opponent
router.post('/create', authMiddleware, async (req, res) => {
  try {
    const { betAmount, side } = req.body
    const userId = req.user.sub

    if (!betAmount || betAmount <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid bet amount' })
    }

    if (!['heads', 'tails'].includes(side)) {
      return res.status(400).json({ success: false, error: 'Side must be heads or tails' })
    }

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

    await supabaseAdmin
      .from('users')
      .update({ balance: user.balance - betAmount })
      .eq('id', userId)

    const { data: game, error } = await supabaseAdmin
      .from('coinflip_games')
      .insert({
        creator_id: userId,
        bet_amount: betAmount,
        creator_side: side,
        status: 'waiting',
        server_seed_hash: hashSeed(serverSeed),
      })
      .select()
      .single()

    if (error) {
      return res.status(500).json({ success: false, error: 'Failed to create game' })
    }

    awardXP(userId, betAmount).catch(() => {})
    return res.json({ success: true, game })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// POST /api/coinflip/game/:gameId/join
router.post('/game/:gameId/join', authMiddleware, async (req, res) => {
  try {
    const { gameId } = req.params
    const userId = req.user.sub

    const { data: game } = await supabaseAdmin
      .from('coinflip_games')
      .select('*')
      .eq('id', gameId)
      .single()

    if (!game) return res.status(404).json({ success: false, error: 'Game not found' })
    if (game.status !== 'waiting') return res.status(400).json({ success: false, error: 'Game not available' })
    if (game.creator_id === userId) return res.status(400).json({ success: false, error: 'Cannot join your own game' })

    const { data: user } = await supabaseAdmin
      .from('users')
      .select('balance, server_seed, client_seed, nonce')
      .eq('id', userId)
      .single()

    if (!user || user.balance < game.bet_amount) {
      return res.status(400).json({ success: false, error: 'Insufficient balance' })
    }

    // Deduct joiner balance
    await supabaseAdmin
      .from('users')
      .update({ balance: user.balance - game.bet_amount })
      .eq('id', userId)

    // Resolve game
    const serverSeed = generateServerSeed()
    const clientSeed = user.client_seed || generateClientSeed()
    const nonce = user.nonce || 0
    const float = generateFloat(serverSeed, clientSeed, nonce)
    const winnerSide = float < 0.5 ? 'heads' : 'tails'
    const creatorWins = winnerSide === game.creator_side
    const winnerId = creatorWins ? game.creator_id : userId
    const prize = game.bet_amount * 2 * (1 - config.houseEdge / 100)

    // Credit winner
    const { data: winner } = await supabaseAdmin
      .from('users')
      .select('balance')
      .eq('id', winnerId)
      .single()

    await supabaseAdmin
      .from('users')
      .update({ balance: winner.balance + prize })
      .eq('id', winnerId)

    // Update game
    const { data: updated } = await supabaseAdmin
      .from('coinflip_games')
      .update({
        joiner_id: userId,
        winner_id: winnerId,
        result_side: winnerSide,
        status: 'completed',
        server_seed,
        server_seed_hash: hashSeed(serverSeed),
        ended_at: new Date().toISOString(),
      })
      .eq('id', gameId)
      .select()
      .single()

    awardXP(userId, game.bet_amount).catch(() => {})
    return res.json({ success: true, game: updated, winnerSide, winnerId })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/coinflip/game/:gameId
router.get('/game/:gameId', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('coinflip_games')
      .select('*, creator:users!creator_id(username, avatar_url), joiner:users!joiner_id(username, avatar_url)')
      .eq('id', req.params.gameId)
      .single()

    if (error || !data) return res.status(404).json({ success: false, error: 'Game not found' })

    return res.json({ success: true, game: data })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/coinflip/game/:gameId/public
router.get('/game/:gameId/public', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('coinflip_games')
      .select('id, bet_amount, creator_side, status, result_side, server_seed_hash, creator:users!creator_id(username, avatar_url)')
      .eq('id', req.params.gameId)
      .single()

    if (error || !data) return res.status(404).json({ success: false, error: 'Game not found' })

    return res.json({ success: true, game: data })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/coinflip/games — open games
router.get('/games', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('coinflip_games')
      .select('id, bet_amount, creator_side, status, created_at, creator:users!creator_id(username, avatar_url)')
      .eq('status', 'waiting')
      .order('created_at', { ascending: false })
      .limit(20)

    if (error) return res.status(500).json({ success: false, error: error.message })

    return res.json({ success: true, games: data })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/coinflip/my-games
router.get('/my-games', authMiddleware, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20
    const page = parseInt(req.query.page) || 1
    const offset = (page - 1) * limit

    const { data, error, count } = await supabaseAdmin
      .from('coinflip_games')
      .select('*', { count: 'exact' })
      .or(`creator_id.eq.${req.user.sub},joiner_id.eq.${req.user.sub}`)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) return res.status(500).json({ success: false, error: error.message })

    return res.json({ success: true, games: data, total: count, page, limit })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/coinflip/recent
router.get('/recent', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10
    const { data, error } = await supabaseAdmin
      .from('coinflip_games')
      .select('id, bet_amount, result_side, ended_at, winner:users!winner_id(username, avatar_url)')
      .eq('status', 'completed')
      .order('ended_at', { ascending: false })
      .limit(limit)

    if (error) return res.status(500).json({ success: false, error: error.message })

    return res.json({ success: true, games: data })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/coinflip/players
router.get('/players', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('coinflip_games')
      .select('creator_id, users!creator_id(username, avatar_url)')
      .eq('status', 'waiting')

    if (error) return res.status(500).json({ success: false, error: error.message })

    return res.json({ success: true, players: data })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/coinflip/statistics
router.get('/statistics', async (req, res) => {
  try {
    const { count: total } = await supabaseAdmin
      .from('coinflip_games')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'completed')

    const { count: heads } = await supabaseAdmin
      .from('coinflip_games')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'completed')
      .eq('result_side', 'heads')

    return res.json({
      success: true,
      totalGames: total || 0,
      headsPercent: total > 0 ? Math.round((heads / total) * 100) : 50,
      tailsPercent: total > 0 ? Math.round(((total - heads) / total) * 100) : 50,
    })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// DELETE /api/coinflip/game/:gameId — cancel own waiting game
router.delete('/game/:gameId', authMiddleware, async (req, res) => {
  try {
    const { data: game } = await supabaseAdmin
      .from('coinflip_games')
      .select('creator_id, bet_amount, status')
      .eq('id', req.params.gameId)
      .single()

    if (!game) return res.status(404).json({ success: false, error: 'Game not found' })
    if (game.creator_id !== req.user.sub) return res.status(403).json({ success: false, error: 'Not your game' })
    if (game.status !== 'waiting') return res.status(400).json({ success: false, error: 'Cannot cancel this game' })

    await supabaseAdmin
      .from('coinflip_games')
      .update({ status: 'cancelled' })
      .eq('id', req.params.gameId)

    // Refund
    const { data: user } = await supabaseAdmin.from('users').select('balance').eq('id', req.user.sub).single()
    await supabaseAdmin.from('users').update({ balance: user.balance + game.bet_amount }).eq('id', req.user.sub)

    return res.json({ success: true })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// POST /api/coinflip/verify
router.post('/verify', async (req, res) => {
  try {
    const { serverSeed, clientSeed, nonce } = req.body
    if (!serverSeed || !clientSeed || nonce === undefined) {
      return res.status(400).json({ success: false, error: 'serverSeed, clientSeed and nonce required' })
    }

    const float = generateFloat(serverSeed, clientSeed, nonce)
    const result = float < 0.5 ? 'heads' : 'tails'

    return res.json({ success: true, result, float, serverSeedHash: hashSeed(serverSeed) })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

module.exports = router
