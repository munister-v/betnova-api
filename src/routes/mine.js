const express = require('express')
const router = express.Router()
const { supabaseAdmin } = require('../config/supabase')
const { authMiddleware } = require('../middleware/auth')
const { generateFloat, generateServerSeed, generateClientSeed, hashSeed } = require('../utils/provablyFair')
const { awardXP } = require('../utils/xp')
const config = require('../config')

const GRID_SIZE = 25 // 5x5

function generateMinePositions(serverSeed, clientSeed, nonce, mineCount) {
  const positions = []
  const available = Array.from({ length: GRID_SIZE }, (_, i) => i)

  for (let i = 0; i < mineCount; i++) {
    const float = generateFloat(serverSeed, clientSeed, `${nonce}:${i}`)
    const idx = Math.floor(float * available.length)
    positions.push(available.splice(idx, 1)[0])
  }

  return positions
}

function calculateMineMultiplier(revealed, mineCount) {
  // Based on hypergeometric distribution
  const safe = GRID_SIZE - mineCount
  let multiplier = 1
  for (let i = 0; i < revealed; i++) {
    multiplier *= (safe - i) / (GRID_SIZE - i)
  }
  return Math.round((1 / multiplier) * (1 - config.houseEdge / 100) * 100) / 100
}

// GET /api/mine/config
router.get('/config', (req, res) => {
  return res.json({
    success: true,
    gridSize: GRID_SIZE,
    minMines: 1,
    maxMines: 24,
    minBet: 0.01,
    maxBet: 10000,
    houseEdge: config.houseEdge,
  })
})

// POST /api/mine/create
router.post('/create', authMiddleware, async (req, res) => {
  try {
    const { betAmount, mineCount } = req.body
    const userId = req.user.sub

    if (!betAmount || betAmount <= 0) return res.status(400).json({ success: false, error: 'Invalid bet amount' })
    if (!mineCount || mineCount < 1 || mineCount > 24) return res.status(400).json({ success: false, error: 'Mine count must be 1-24' })

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
    const minePositions = generateMinePositions(serverSeed, clientSeed, nonce, mineCount)

    await supabaseAdmin
      .from('users')
      .update({ balance: user.balance - betAmount, nonce: nonce + 1 })
      .eq('id', userId)

    const { data: game } = await supabaseAdmin
      .from('mine_games')
      .insert({
        user_id: userId,
        bet_amount: betAmount,
        mine_count: mineCount,
        mine_positions: minePositions,
        revealed_positions: [],
        status: 'active',
        server_seed,
        server_seed_hash: hashSeed(serverSeed),
        client_seed,
        nonce,
      })
      .select('id, bet_amount, mine_count, revealed_positions, status, server_seed_hash, client_seed')
      .single()

    awardXP(userId, betAmount).catch(() => {})
    return res.json({ success: true, game })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/mine/game/:gameId
router.get('/game/:gameId', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('mine_games')
      .select('id, bet_amount, mine_count, revealed_positions, status, server_seed_hash, client_seed, mine_positions, profit')
      .eq('id', req.params.gameId)
      .eq('user_id', req.user.sub)
      .single()

    if (error || !data) return res.status(404).json({ success: false, error: 'Game not found' })

    // Only reveal mine positions if game is over
    const response = { ...data }
    if (data.status === 'active') delete response.mine_positions

    return res.json({ success: true, game: response })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/mine/game/:gameId/public
router.get('/game/:gameId/public', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('mine_games')
      .select('id, bet_amount, mine_count, status, server_seed_hash')
      .eq('id', req.params.gameId)
      .single()

    if (error || !data) return res.status(404).json({ success: false, error: 'Game not found' })

    return res.json({ success: true, game: data })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// POST /api/mine/game/:gameId/reveal — reveal a tile
router.post('/game/:gameId/reveal', authMiddleware, async (req, res) => {
  try {
    const { position } = req.body
    const userId = req.user.sub

    if (position === undefined || position < 0 || position >= GRID_SIZE) {
      return res.status(400).json({ success: false, error: 'Invalid position' })
    }

    const { data: game } = await supabaseAdmin
      .from('mine_games')
      .select('*')
      .eq('id', req.params.gameId)
      .eq('user_id', userId)
      .single()

    if (!game) return res.status(404).json({ success: false, error: 'Game not found' })
    if (game.status !== 'active') return res.status(400).json({ success: false, error: 'Game is not active' })
    if (game.revealed_positions.includes(position)) return res.status(400).json({ success: false, error: 'Position already revealed' })

    const isMine = game.mine_positions.includes(position)

    if (isMine) {
      // Game over — lost
      await supabaseAdmin
        .from('mine_games')
        .update({ status: 'lost', revealed_positions: [...game.revealed_positions, position] })
        .eq('id', game.id)

      return res.json({ success: true, isMine: true, game: { ...game, status: 'lost', mine_positions: game.mine_positions } })
    }

    const newRevealed = [...game.revealed_positions, position]
    const multiplier = calculateMineMultiplier(newRevealed.length, game.mine_count)

    await supabaseAdmin
      .from('mine_games')
      .update({ revealed_positions: newRevealed, current_multiplier: multiplier })
      .eq('id', game.id)

    return res.json({ success: true, isMine: false, multiplier, revealed: newRevealed })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// POST /api/mine/game/:gameId/cashout
router.post('/game/:gameId/cashout', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.sub

    const { data: game } = await supabaseAdmin
      .from('mine_games')
      .select('*')
      .eq('id', req.params.gameId)
      .eq('user_id', userId)
      .single()

    if (!game) return res.status(404).json({ success: false, error: 'Game not found' })
    if (game.status !== 'active') return res.status(400).json({ success: false, error: 'Game is not active' })
    if (game.revealed_positions.length === 0) return res.status(400).json({ success: false, error: 'Reveal at least one tile before cashing out' })

    const multiplier = calculateMineMultiplier(game.revealed_positions.length, game.mine_count)
    const profit = game.bet_amount * multiplier

    await supabaseAdmin
      .from('mine_games')
      .update({ status: 'won', profit, current_multiplier: multiplier })
      .eq('id', game.id)

    const { data: user } = await supabaseAdmin.from('users').select('balance').eq('id', userId).single()
    await supabaseAdmin.from('users').update({ balance: user.balance + profit }).eq('id', userId)

    return res.json({ success: true, profit, multiplier, minePositions: game.mine_positions })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/mine/games
router.get('/games', authMiddleware, async (req, res) => {
  try {
    const { data } = await supabaseAdmin
      .from('mine_games')
      .select('id, bet_amount, mine_count, status, created_at')
      .eq('user_id', req.user.sub)
      .order('created_at', { ascending: false })
      .limit(10)

    return res.json({ success: true, games: data || [] })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// DELETE /api/mine/game/:gameId
router.delete('/game/:gameId', authMiddleware, async (req, res) => {
  try {
    const { data: game } = await supabaseAdmin
      .from('mine_games')
      .select('user_id, status')
      .eq('id', req.params.gameId)
      .single()

    if (!game || game.user_id !== req.user.sub) return res.status(403).json({ success: false, error: 'Forbidden' })

    await supabaseAdmin.from('mine_games').update({ status: 'cancelled' }).eq('id', req.params.gameId)

    return res.json({ success: true })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/mine/history
router.get('/history', authMiddleware, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20
    const page = parseInt(req.query.page) || 1
    const offset = (page - 1) * limit

    const { data, error, count } = await supabaseAdmin
      .from('mine_games')
      .select('id, bet_amount, mine_count, status, profit, current_multiplier, created_at', { count: 'exact' })
      .eq('user_id', req.user.sub)
      .in('status', ['won', 'lost'])
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) return res.status(500).json({ success: false, error: error.message })

    return res.json({ success: true, games: data, total: count, page, limit })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/mine/stats
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const { data } = await supabaseAdmin
      .from('mine_games')
      .select('profit, bet_amount, status')
      .eq('user_id', req.user.sub)
      .in('status', ['won', 'lost'])

    const wins = data?.filter(g => g.status === 'won') || []
    const totalWagered = data?.reduce((s, g) => s + g.bet_amount, 0) || 0
    const totalProfit = wins.reduce((s, g) => s + (g.profit || 0), 0)

    return res.json({
      success: true,
      totalGames: data?.length || 0,
      wins: wins.length,
      losses: (data?.length || 0) - wins.length,
      totalWagered,
      totalProfit,
    })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/mine/incomplete — resume an active game
router.get('/incomplete', authMiddleware, async (req, res) => {
  try {
    const { data } = await supabaseAdmin
      .from('mine_games')
      .select('id, bet_amount, mine_count, revealed_positions, current_multiplier, server_seed_hash, client_seed')
      .eq('user_id', req.user.sub)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    return res.json({ success: true, game: data || null })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// POST /api/mine/verify
router.post('/verify', async (req, res) => {
  try {
    const { serverSeed, clientSeed, nonce, mineCount } = req.body
    if (!serverSeed || !clientSeed || nonce === undefined || !mineCount) {
      return res.status(400).json({ success: false, error: 'serverSeed, clientSeed, nonce and mineCount required' })
    }

    const positions = generateMinePositions(serverSeed, clientSeed, nonce, mineCount)

    return res.json({ success: true, minePositions: positions, serverSeedHash: hashSeed(serverSeed) })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

module.exports = router
