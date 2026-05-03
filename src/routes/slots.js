const express = require('express')
const router = express.Router()
const { supabaseAdmin } = require('../config/supabase')
const { authMiddleware } = require('../middleware/auth')
const { generateFloat, generateServerSeed, generateClientSeed, hashSeed } = require('../utils/provablyFair')
const { awardXP } = require('../utils/xp')
const config = require('../config')

// Symbols: index → { emoji, weight, payouts for 3/2 of a kind }
const SYMBOLS = [
  { id: 0, emoji: '🍒', weight: 30, pay3: 2,  pay2: 0.5 },
  { id: 1, emoji: '🍋', weight: 25, pay3: 3,  pay2: 0   },
  { id: 2, emoji: '🍊', weight: 20, pay3: 5,  pay2: 0   },
  { id: 3, emoji: '🍇', weight: 15, pay3: 8,  pay2: 0   },
  { id: 4, emoji: '⭐', weight: 6,  pay3: 15, pay2: 0   },
  { id: 5, emoji: '💎', weight: 3,  pay3: 25, pay2: 0   },
  { id: 6, emoji: '7️⃣', weight: 1,  pay3: 50, pay2: 0   },
]

const TOTAL_WEIGHT = SYMBOLS.reduce((s, sym) => s + sym.weight, 0)

// 3 reels × 3 rows = 9 symbols
// Paylines: row0, row1, row2, diagonal↘, diagonal↗
const PAYLINES = [
  [0, 1, 2],   // top row    (reel0[0], reel1[0], reel2[0])
  [3, 4, 5],   // mid row
  [6, 7, 8],   // bottom row
  [0, 4, 8],   // diagonal ↘
  [6, 4, 2],   // diagonal ↗
]

function pickSymbol(float) {
  let cumulative = 0
  for (const sym of SYMBOLS) {
    cumulative += sym.weight
    if (float * TOTAL_WEIGHT < cumulative) return sym
  }
  return SYMBOLS[0]
}

function spinReels(serverSeed, clientSeed, nonce) {
  // 9 cells: reel0col0, reel0col1, reel0col2, reel1col0 ...
  return Array.from({ length: 9 }, (_, i) => {
    const float = generateFloat(serverSeed, clientSeed, `${nonce}:${i}`)
    return pickSymbol(float)
  })
}

function calcWin(grid, betAmount) {
  let totalMultiplier = 0
  const winningLines = []

  for (const line of PAYLINES) {
    const [a, b, c] = line.map(i => grid[i])
    if (a.id === b.id && b.id === c.id) {
      totalMultiplier += a.pay3
      winningLines.push({ line, symbol: a.emoji, multiplier: a.pay3 })
    } else if (a.id === b.id && a.pay2 > 0) {
      totalMultiplier += a.pay2
      winningLines.push({ line, symbol: a.emoji, multiplier: a.pay2 })
    }
  }

  const rawWin = betAmount * totalMultiplier
  const houseEdgeFactor = 1 - config.houseEdge / 100
  const payout = totalMultiplier > 0 ? rawWin * houseEdgeFactor : 0

  return { totalMultiplier, payout, winningLines }
}

// GET /api/slots/config
router.get('/config', (req, res) => {
  res.json({
    success: true,
    symbols: SYMBOLS,
    paylines: PAYLINES,
    minBet: 0.01,
    maxBet: 1000,
    houseEdge: config.houseEdge,
  })
})

// POST /api/slots/spin
router.post('/spin', authMiddleware, async (req, res) => {
  try {
    const { betAmount } = req.body
    const userId = req.user.sub

    if (!betAmount || betAmount <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid bet amount' })
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
    const nonce = user.nonce || 0

    const grid = spinReels(serverSeed, clientSeed, nonce)
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
      metadata: { grid: grid.map(s => s.emoji), winningLines },
    })

    awardXP(userId, betAmount).catch(() => {})

    res.json({
      success: true,
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
