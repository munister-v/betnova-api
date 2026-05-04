const express = require('express')
const router = express.Router()
const { supabaseAdmin } = require('../config/supabase')
const { authMiddleware } = require('../middleware/auth')
const { generateFloat, generateServerSeed, generateClientSeed, hashSeed } = require('../utils/provablyFair')
const { awardXP } = require('../utils/xp')
const config = require('../config')

// In-memory active games (cleared on server restart — acceptable for single-server)
// Key: userId, Value: game object
const activeGames = new Map()

const DECK_SIZE = 52
const RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K']
const SUITS = ['♠','♥','♦','♣']

function indexToCard(idx) {
  return { rank: RANKS[idx % 13], suit: SUITS[Math.floor(idx / 13)], value: (idx % 13) + 1 }
}

function drawCard(serverSeed, clientSeed, nonce, drawIndex) {
  const float = generateFloat(serverSeed, clientSeed, `${nonce}:${drawIndex}`)
  return indexToCard(Math.floor(float * DECK_SIZE))
}

function calcMultiplier(currentValue, guess) {
  let winCount
  if (guess === 'higher') winCount = (13 - currentValue) * 4
  else if (guess === 'lower') winCount = (currentValue - 1) * 4
  else winCount = 4 // equal
  if (winCount <= 0) return 0
  const chance = winCount / DECK_SIZE
  return parseFloat(((1 - config.houseEdge / 100) / chance).toFixed(4))
}

// POST /api/hilo/start
router.post('/start', authMiddleware, async (req, res) => {
  try {
    const { betAmount } = req.body
    const userId = req.user.sub

    if (!betAmount || betAmount <= 0) return res.status(400).json({ success: false, error: 'Invalid bet amount' })

    // Cancel any existing active game (refund not issued — player forfeits)
    activeGames.delete(userId)

    const { data: user } = await supabaseAdmin
      .from('users')
      .select('balance, server_seed, client_seed, nonce')
      .eq('id', userId)
      .single()

    if (!user || user.balance < betAmount) return res.status(400).json({ success: false, error: 'Insufficient balance' })

    const serverSeed = user.server_seed || generateServerSeed()
    const clientSeed = user.client_seed || generateClientSeed()
    const nonce = user.nonce || 0

    const firstCard = drawCard(serverSeed, clientSeed, nonce, 0)

    await supabaseAdmin.from('users')
      .update({ balance: user.balance - betAmount, nonce: nonce + 1 })
      .eq('id', userId)

    const game = {
      userId,
      betAmount,
      serverSeed,
      clientSeed,
      nonce,
      drawIndex: 1,
      cards: [firstCard],
      currentMultiplier: 1,
      startedAt: Date.now(),
    }
    activeGames.set(userId, game)

    awardXP(userId, betAmount).catch(() => {})

    return res.json({
      success: true,
      firstCard,
      serverSeedHash: hashSeed(serverSeed),
      clientSeed,
    })
  } catch (err) {
    console.error('HiLo start error:', err)
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// POST /api/hilo/guess  — body: { guess: 'higher'|'lower'|'equal' }
router.post('/guess', authMiddleware, async (req, res) => {
  try {
    const { guess } = req.body
    const userId = req.user.sub

    if (!['higher', 'lower', 'equal'].includes(guess)) {
      return res.status(400).json({ success: false, error: 'Guess must be higher, lower, or equal' })
    }

    const game = activeGames.get(userId)
    if (!game) return res.status(404).json({ success: false, error: 'No active game — start a new one' })

    const currentCard = game.cards[game.cards.length - 1]
    const nextCard = drawCard(game.serverSeed, game.clientSeed, game.nonce, game.drawIndex)
    game.drawIndex++
    game.cards.push(nextCard)

    const won =
      (guess === 'higher' && nextCard.value > currentCard.value) ||
      (guess === 'lower'  && nextCard.value < currentCard.value) ||
      (guess === 'equal'  && nextCard.value === currentCard.value)

    if (!won) {
      activeGames.delete(userId)

      await supabaseAdmin.from('game_history').insert({
        user_id: userId,
        game_type: 'hilo',
        bet_amount: game.betAmount,
        multiplier: 0,
        profit: -game.betAmount,
        result: { cards: game.cards, guess, won: false, finalMultiplier: game.currentMultiplier },
        server_seed_hash: hashSeed(game.serverSeed),
        client_seed: game.clientSeed,
        nonce: game.nonce,
      }).catch(() => {})

      return res.json({ success: true, won: false, nextCard, cards: game.cards })
    }

    const roundMultiplier = calcMultiplier(currentCard.value, guess)
    game.currentMultiplier = parseFloat((game.currentMultiplier * roundMultiplier).toFixed(4))

    return res.json({
      success: true,
      won: true,
      nextCard,
      roundMultiplier,
      currentMultiplier: game.currentMultiplier,
      cards: game.cards,
      potentialWin: parseFloat((game.betAmount * game.currentMultiplier).toFixed(2)),
    })
  } catch (err) {
    console.error('HiLo guess error:', err)
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// POST /api/hilo/cashout
router.post('/cashout', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.sub
    const game = activeGames.get(userId)

    if (!game) return res.status(404).json({ success: false, error: 'No active game' })
    if (game.cards.length < 2) return res.status(400).json({ success: false, error: 'Make at least one guess before cashing out' })

    activeGames.delete(userId)

    const profit = parseFloat((game.betAmount * game.currentMultiplier).toFixed(2))
    const netProfit = parseFloat((profit - game.betAmount).toFixed(2))

    const { data: user } = await supabaseAdmin.from('users').select('balance').eq('id', userId).single()
    await supabaseAdmin.from('users').update({ balance: user.balance + profit }).eq('id', userId)

    await supabaseAdmin.from('game_history').insert({
      user_id: userId,
      game_type: 'hilo',
      bet_amount: game.betAmount,
      multiplier: game.currentMultiplier,
      profit: netProfit,
      result: { cards: game.cards, won: true },
      server_seed_hash: hashSeed(game.serverSeed),
      client_seed: game.clientSeed,
      nonce: game.nonce,
    }).catch(() => {})

    return res.json({ success: true, profit, multiplier: game.currentMultiplier, netProfit, newBalance: user.balance + profit })
  } catch (err) {
    console.error('HiLo cashout error:', err)
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/hilo/state — get current active game state (for page refresh)
router.get('/state', authMiddleware, (req, res) => {
  const game = activeGames.get(req.user.sub)
  if (!game) return res.json({ success: true, game: null })
  return res.json({
    success: true,
    game: {
      cards: game.cards,
      currentMultiplier: game.currentMultiplier,
      betAmount: game.betAmount,
      potentialWin: parseFloat((game.betAmount * game.currentMultiplier).toFixed(2)),
      serverSeedHash: hashSeed(game.serverSeed),
      clientSeed: game.clientSeed,
    }
  })
})

// GET /api/hilo/history
router.get('/history', authMiddleware, async (req, res) => {
  try {
    const { data } = await supabaseAdmin
      .from('game_history')
      .select('id, bet_amount, multiplier, profit, result, created_at')
      .eq('user_id', req.user.sub)
      .eq('game_type', 'hilo')
      .order('created_at', { ascending: false })
      .limit(20)
    return res.json({ success: true, games: data || [] })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

module.exports = router
