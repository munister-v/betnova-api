const express = require('express')
const router = express.Router()
const { supabaseAdmin } = require('../config/supabase')
const { authMiddleware } = require('../middleware/auth')
const { generateFloat, generateServerSeed, generateClientSeed, hashSeed } = require('../utils/provablyFair')
const { awardXP } = require('../utils/xp')
const config = require('../config')

// ─── Game catalog ──────────────────────────────────────────────────────────
// Each game = { symbols, name }. 3x3 grid with 5 paylines.

const GAMES = {
  classic: {
    name: 'Classic Fruits',
    symbols: [
      { id: 0, emoji: '🍒', weight: 30, pay3: 2,  pay2: 0.5 },
      { id: 1, emoji: '🍋', weight: 25, pay3: 3,  pay2: 0   },
      { id: 2, emoji: '🍊', weight: 20, pay3: 5,  pay2: 0   },
      { id: 3, emoji: '🍇', weight: 15, pay3: 8,  pay2: 0   },
      { id: 4, emoji: '⭐', weight: 6,  pay3: 15, pay2: 0   },
      { id: 5, emoji: '💎', weight: 3,  pay3: 25, pay2: 0   },
      { id: 6, emoji: '7️⃣', weight: 1,  pay3: 50, pay2: 0   },
    ],
  },
  bonanza: {
    name: 'Sweet Bonanza',
    symbols: [
      { id: 0, emoji: '🍬', weight: 28, pay3: 2,  pay2: 0.4 },
      { id: 1, emoji: '🍭', weight: 24, pay3: 3,  pay2: 0   },
      { id: 2, emoji: '🍫', weight: 20, pay3: 4,  pay2: 0   },
      { id: 3, emoji: '🧁', weight: 14, pay3: 7,  pay2: 0   },
      { id: 4, emoji: '🎂', weight: 8,  pay3: 12, pay2: 0   },
      { id: 5, emoji: '💖', weight: 4,  pay3: 25, pay2: 0   },
      { id: 6, emoji: '🌟', weight: 2,  pay3: 75, pay2: 0   },
    ],
  },
  egypt: {
    name: 'Book of Pyramids',
    symbols: [
      { id: 0, emoji: '🪙', weight: 30, pay3: 2,  pay2: 0.5 },
      { id: 1, emoji: '🐍', weight: 22, pay3: 3,  pay2: 0   },
      { id: 2, emoji: '🦂', weight: 18, pay3: 5,  pay2: 0   },
      { id: 3, emoji: '🦅', weight: 13, pay3: 8,  pay2: 0   },
      { id: 4, emoji: '👁️', weight: 9,  pay3: 15, pay2: 0   },
      { id: 5, emoji: '📜', weight: 5,  pay3: 30, pay2: 0   },
      { id: 6, emoji: '🔱', weight: 3,  pay3: 100, pay2: 0  },
    ],
  },
  dragon: {
    name: 'Dragon Fortune',
    symbols: [
      { id: 0, emoji: '🪙', weight: 28, pay3: 2,  pay2: 0.5 },
      { id: 1, emoji: '🏮', weight: 23, pay3: 3,  pay2: 0   },
      { id: 2, emoji: '🐉', weight: 18, pay3: 6,  pay2: 0   },
      { id: 3, emoji: '🧧', weight: 14, pay3: 9,  pay2: 0   },
      { id: 4, emoji: '🀄', weight: 9,  pay3: 18, pay2: 0   },
      { id: 5, emoji: '👑', weight: 5,  pay3: 35, pay2: 0   },
      { id: 6, emoji: '🐲', weight: 3,  pay3: 80, pay2: 0   },
    ],
  },
  pirate: {
    name: 'Pirates Treasure',
    symbols: [
      { id: 0, emoji: '🦜', weight: 28, pay3: 2,  pay2: 0.5 },
      { id: 1, emoji: '🗺️', weight: 23, pay3: 3,  pay2: 0   },
      { id: 2, emoji: '⚓', weight: 18, pay3: 5,  pay2: 0   },
      { id: 3, emoji: '🏴‍☠️', weight: 13, pay3: 8, pay2: 0   },
      { id: 4, emoji: '🦴', weight: 9,  pay3: 15, pay2: 0   },
      { id: 5, emoji: '🪙', weight: 6,  pay3: 30, pay2: 0   },
      { id: 6, emoji: '💰', weight: 3,  pay3: 75, pay2: 0   },
    ],
  },
  space: {
    name: 'Cosmic Spins',
    symbols: [
      { id: 0, emoji: '🪐', weight: 28, pay3: 2,  pay2: 0.5 },
      { id: 1, emoji: '☄️', weight: 23, pay3: 3,  pay2: 0   },
      { id: 2, emoji: '🛸', weight: 18, pay3: 5,  pay2: 0   },
      { id: 3, emoji: '🌌', weight: 13, pay3: 9,  pay2: 0   },
      { id: 4, emoji: '👽', weight: 9,  pay3: 18, pay2: 0   },
      { id: 5, emoji: '🌠', weight: 5,  pay3: 35, pay2: 0   },
      { id: 6, emoji: '🚀', weight: 3,  pay3: 90, pay2: 0   },
    ],
  },
  vegas: {
    name: 'Vegas Lights',
    symbols: [
      { id: 0, emoji: '🎲', weight: 28, pay3: 2,  pay2: 0.5 },
      { id: 1, emoji: '🃏', weight: 23, pay3: 3,  pay2: 0   },
      { id: 2, emoji: '♠️', weight: 18, pay3: 5,  pay2: 0   },
      { id: 3, emoji: '♦️', weight: 14, pay3: 8,  pay2: 0   },
      { id: 4, emoji: '🎰', weight: 9,  pay3: 15, pay2: 0   },
      { id: 5, emoji: '💵', weight: 5,  pay3: 30, pay2: 0   },
      { id: 6, emoji: '🎩', weight: 3,  pay3: 70, pay2: 0   },
    ],
  },
  jungle: {
    name: 'Jungle Spirits',
    symbols: [
      { id: 0, emoji: '🍌', weight: 28, pay3: 2,  pay2: 0.5 },
      { id: 1, emoji: '🌴', weight: 23, pay3: 3,  pay2: 0   },
      { id: 2, emoji: '🐒', weight: 18, pay3: 5,  pay2: 0   },
      { id: 3, emoji: '🦓', weight: 14, pay3: 8,  pay2: 0   },
      { id: 4, emoji: '🦁', weight: 9,  pay3: 15, pay2: 0   },
      { id: 5, emoji: '🐘', weight: 5,  pay3: 30, pay2: 0   },
      { id: 6, emoji: '💎', weight: 3,  pay3: 70, pay2: 0   },
    ],
  },
}

const PAYLINES = [
  [0, 1, 2],   // top row
  [3, 4, 5],   // mid row
  [6, 7, 8],   // bottom row
  [0, 4, 8],   // diagonal ↘
  [6, 4, 2],   // diagonal ↗
]

function pickSymbol(symbols, totalWeight, float) {
  let cumulative = 0
  for (const sym of symbols) {
    cumulative += sym.weight
    if (float * totalWeight < cumulative) return sym
  }
  return symbols[0]
}

function spinReels(symbols, totalWeight, serverSeed, clientSeed, nonce) {
  return Array.from({ length: 9 }, (_, i) => {
    const float = generateFloat(serverSeed, clientSeed, `${nonce}:${i}`)
    return pickSymbol(symbols, totalWeight, float)
  })
}

function calcWin(grid, betAmount) {
  let totalMultiplier = 0
  const winningLines = []

  PAYLINES.forEach((line, lineIdx) => {
    const [a, b, c] = line.map(i => grid[i])
    if (a.id === b.id && b.id === c.id) {
      totalMultiplier += a.pay3
      winningLines.push({ line, lineIdx, symbol: a.emoji, multiplier: a.pay3 })
    } else if (a.id === b.id && a.pay2 > 0) {
      totalMultiplier += a.pay2
      winningLines.push({ line, lineIdx, symbol: a.emoji, multiplier: a.pay2 })
    }
  })

  const rawWin = betAmount * totalMultiplier
  const houseEdgeFactor = 1 - config.houseEdge / 100
  const payout = totalMultiplier > 0 ? rawWin * houseEdgeFactor : 0

  return { totalMultiplier, payout, winningLines }
}

// GET /api/slots/games — list all available games
router.get('/games', (req, res) => {
  res.json({
    success: true,
    games: Object.entries(GAMES).map(([id, g]) => ({ id, name: g.name, symbols: g.symbols })),
  })
})

// GET /api/slots/config?gameId=classic
router.get('/config', (req, res) => {
  const gameId = req.query.gameId || 'classic'
  const game = GAMES[gameId] || GAMES.classic
  res.json({
    success: true,
    gameId,
    name: game.name,
    symbols: game.symbols,
    paylines: PAYLINES,
    minBet: 0.01,
    maxBet: 1000,
    houseEdge: config.houseEdge,
  })
})

// POST /api/slots/spin   body: { betAmount, gameId }
router.post('/spin', authMiddleware, async (req, res) => {
  try {
    const { betAmount, gameId = 'classic' } = req.body
    const userId = req.user.sub

    const game = GAMES[gameId]
    if (!game) return res.status(400).json({ success: false, error: 'Unknown game' })

    if (!betAmount || betAmount <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid bet amount' })
    }

    const totalWeight = game.symbols.reduce((s, sym) => s + sym.weight, 0)

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

    const grid = spinReels(game.symbols, totalWeight, serverSeed, clientSeed, nonce)
    const { totalMultiplier, payout, winningLines } = calcWin(grid, betAmount)

    const newBalance = user.balance - betAmount + payout
    const profit = payout - betAmount

    await supabaseAdmin
      .from('users')
      .update({ balance: newBalance, nonce: nonce + 1, server_seed: serverSeed, client_seed: clientSeed })
      .eq('id', userId)

    await supabaseAdmin.from('game_history').insert({
      user_id: userId,
      game_type: 'slots',
      bet_amount: betAmount,
      profit,
      wagered: betAmount,
      multiplier: totalMultiplier,
      metadata: { gameId, gameName: game.name, grid: grid.map(s => s.emoji), winningLines },
    })

    awardXP(userId, betAmount).catch(() => {})

    res.json({
      success: true,
      gameId,
      grid: grid.map(s => s.emoji),
      winningLines,
      multiplier: totalMultiplier,
      payout,
      profit,
      balance: newBalance,
      serverSeedHash: hashSeed(serverSeed),
    })
  } catch (err) {
    console.error('Slots spin error:', err)
    res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/slots/history
router.get('/history', authMiddleware, async (req, res) => {
  try {
    const { data } = await supabaseAdmin
      .from('game_history')
      .select('*')
      .eq('user_id', req.user.sub)
      .eq('game_type', 'slots')
      .order('created_at', { ascending: false })
      .limit(20)

    res.json({ success: true, history: data || [] })
  } catch (err) {
    res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

module.exports = router
