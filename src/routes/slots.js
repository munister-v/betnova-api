const express = require('express')
const router = express.Router()
const { supabaseAdmin } = require('../config/supabase')
const { authMiddleware } = require('../middleware/auth')
const { generateFloat, generateServerSeed, generateClientSeed, hashSeed } = require('../utils/provablyFair')
const { awardXP } = require('../utils/xp')
const config = require('../config')

// ─── Symbol sets per game ──────────────────────────────────────────────────

const GAMES = {
  // 3×3 PAYLINE GAMES
  classic: {
    name: 'Classic Fruits', engine: '3x3',
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
  vegas: {
    name: 'Vegas Lights', engine: '3x3',
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
    name: 'Jungle Spirits', engine: '3x3',
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

  // 5×3 PAYLINE GAMES (10 lines, with WILD as last symbol — substitutes anything)
  egypt: {
    name: 'Book of Pyramids', engine: '5x3',
    symbols: [
      { id: 0, emoji: '🪙', weight: 30, pay5: 5,  pay4: 1, pay3: 0.5 },
      { id: 1, emoji: '🐍', weight: 24, pay5: 8,  pay4: 2, pay3: 0.5 },
      { id: 2, emoji: '🦂', weight: 20, pay5: 12, pay4: 3, pay3: 1   },
      { id: 3, emoji: '🦅', weight: 14, pay5: 20, pay4: 5, pay3: 1.5 },
      { id: 4, emoji: '👁️', weight: 9,  pay5: 50, pay4: 10, pay3: 3  },
      { id: 5, emoji: '🔱', weight: 4,  pay5: 100,pay4: 25, pay3: 6  },
      { id: 6, emoji: '📜', weight: 2,  pay5: 250,pay4: 50, pay3: 10, wild: true },
    ],
  },
  dragon: {
    name: 'Dragon Fortune', engine: '5x3',
    symbols: [
      { id: 0, emoji: '🪙', weight: 28, pay5: 5,  pay4: 1, pay3: 0.5 },
      { id: 1, emoji: '🏮', weight: 24, pay5: 8,  pay4: 2, pay3: 0.5 },
      { id: 2, emoji: '🧧', weight: 19, pay5: 12, pay4: 3, pay3: 1   },
      { id: 3, emoji: '🀄', weight: 13, pay5: 20, pay4: 5, pay3: 1.5 },
      { id: 4, emoji: '👑', weight: 9,  pay5: 50, pay4: 12, pay3: 3  },
      { id: 5, emoji: '🐉', weight: 5,  pay5: 100,pay4: 25, pay3: 6  },
      { id: 6, emoji: '🐲', weight: 2,  pay5: 200,pay4: 50, pay3: 10, wild: true },
    ],
  },
  pirate: {
    name: 'Pirates Treasure', engine: '5x3',
    symbols: [
      { id: 0, emoji: '🦜', weight: 28, pay5: 5,  pay4: 1, pay3: 0.5 },
      { id: 1, emoji: '🗺️', weight: 23, pay5: 8,  pay4: 2, pay3: 0.5 },
      { id: 2, emoji: '⚓', weight: 19, pay5: 12, pay4: 3, pay3: 1   },
      { id: 3, emoji: '🦴', weight: 13, pay5: 20, pay4: 5, pay3: 1.5 },
      { id: 4, emoji: '⚔️', weight: 9,  pay5: 50, pay4: 12, pay3: 3  },
      { id: 5, emoji: '💰', weight: 5,  pay5: 100,pay4: 25, pay3: 6  },
      { id: 6, emoji: '🏴‍☠️', weight: 2, pay5: 200,pay4: 50, pay3: 10, wild: true },
    ],
  },
  space: {
    name: 'Cosmic Spins', engine: '5x3',
    symbols: [
      { id: 0, emoji: '🪐', weight: 28, pay5: 5,  pay4: 1, pay3: 0.5 },
      { id: 1, emoji: '☄️', weight: 23, pay5: 8,  pay4: 2, pay3: 0.5 },
      { id: 2, emoji: '🌌', weight: 19, pay5: 12, pay4: 3, pay3: 1   },
      { id: 3, emoji: '🛸', weight: 13, pay5: 20, pay4: 5, pay3: 1.5 },
      { id: 4, emoji: '👽', weight: 9,  pay5: 50, pay4: 12, pay3: 3  },
      { id: 5, emoji: '🌠', weight: 5,  pay5: 100,pay4: 25, pay3: 6  },
      { id: 6, emoji: '🚀', weight: 2,  pay5: 200,pay4: 50, pay3: 10, wild: true },
    ],
  },

  // CLUSTER PAYS WITH CASCADE — 5×5 grid
  bonanza: {
    name: 'Sweet Bonanza', engine: 'cluster',
    symbols: [
      // pay = multiplier per cluster size [5,6,7,8,9,10+]
      { id: 0, emoji: '🍬', weight: 22, payCluster: { 5: 0.5, 6: 1, 7: 2,  8: 4,  10: 8   } },
      { id: 1, emoji: '🍭', weight: 20, payCluster: { 5: 0.7, 6: 1.5, 7: 3, 8: 6,  10: 12 } },
      { id: 2, emoji: '🍫', weight: 17, payCluster: { 5: 1,   6: 2.5, 7: 5, 8: 10, 10: 20 } },
      { id: 3, emoji: '🧁', weight: 14, payCluster: { 5: 1.5, 6: 3,   7: 7, 8: 14, 10: 30 } },
      { id: 4, emoji: '🎂', weight: 10, payCluster: { 5: 2,   6: 5,   7: 10,8: 20, 10: 50 } },
      { id: 5, emoji: '💖', weight: 6,  payCluster: { 5: 4,   6: 8,   7: 15,8: 30, 10: 100 } },
      { id: 6, emoji: '🌟', weight: 3,  payCluster: { 5: 8,   6: 16,  7: 30,8: 60, 10: 200 } },
    ],
  },
}

// ─── 3×3 paylines ──────────────────────────────────────────────────────────
const PAYLINES_3x3 = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 4, 8], [6, 4, 2],
]

// ─── 5×3 paylines (15 cells: row0 = 0..4, row1 = 5..9, row2 = 10..14) ──────
const PAYLINES_5x3 = [
  [0,1,2,3,4],         // top row
  [5,6,7,8,9],         // middle
  [10,11,12,13,14],    // bottom
  [0,6,12,8,4],        // V
  [10,6,2,8,14],       // ^
  [0,1,7,13,14],       // top→bot
  [10,11,7,3,4],       // bot→top
  [5,1,2,3,9],         // dip top
  [5,11,12,13,9],      // hump bot
  [0,6,7,8,4],         // wave
]

// ─── Helpers ───────────────────────────────────────────────────────────────
function pickSymbol(symbols, totalWeight, float) {
  let cumulative = 0
  for (const sym of symbols) {
    cumulative += sym.weight
    if (float * totalWeight < cumulative) return sym
  }
  return symbols[0]
}

function spinFlat(symbols, totalWeight, count, serverSeed, clientSeed, nonce, salt = '') {
  return Array.from({ length: count }, (_, i) => {
    const float = generateFloat(serverSeed, clientSeed, `${nonce}:${salt}${i}`)
    return pickSymbol(symbols, totalWeight, float)
  })
}

// ─── Engine: 3×3 paylines ──────────────────────────────────────────────────
function play3x3(symbols, totalWeight, serverSeed, clientSeed, nonce, betAmount) {
  const grid = spinFlat(symbols, totalWeight, 9, serverSeed, clientSeed, nonce)
  let totalMultiplier = 0
  const winningLines = []

  PAYLINES_3x3.forEach((line, lineIdx) => {
    const [a, b, c] = line.map(i => grid[i])
    if (a.id === b.id && b.id === c.id) {
      totalMultiplier += a.pay3
      winningLines.push({ line, lineIdx, symbol: a.emoji, multiplier: a.pay3, count: 3 })
    } else if (a.id === b.id && a.pay2 > 0) {
      totalMultiplier += a.pay2
      winningLines.push({ line, lineIdx, symbol: a.emoji, multiplier: a.pay2, count: 2 })
    }
  })

  return { grid: grid.map(s => s.emoji), totalMultiplier, winningLines }
}

// ─── Engine: 5×3 paylines (with WILD substitution) ─────────────────────────
function play5x3(symbols, totalWeight, serverSeed, clientSeed, nonce, betAmount) {
  const grid = spinFlat(symbols, totalWeight, 15, serverSeed, clientSeed, nonce)
  let totalMultiplier = 0
  const winningLines = []
  const wildSym = symbols.find(s => s.wild)

  PAYLINES_5x3.forEach((line, lineIdx) => {
    const cells = line.map(i => grid[i])
    // Find the run from left: take first non-wild as anchor, count matches+wilds
    let anchor = null
    for (const c of cells) {
      if (!c.wild) { anchor = c; break }
    }
    // If all wilds, use wild itself
    const target = anchor || wildSym
    let count = 0
    for (const c of cells) {
      if (c.id === target.id || c.wild) count++
      else break
    }
    if (count >= 3) {
      const key = count === 5 ? 'pay5' : count === 4 ? 'pay4' : 'pay3'
      const mult = target[key] || 0
      if (mult > 0) {
        totalMultiplier += mult
        winningLines.push({
          line: line.slice(0, count), lineIdx,
          symbol: target.emoji, multiplier: mult, count,
        })
      }
    }
  })

  return { grid: grid.map(s => s.emoji), totalMultiplier, winningLines }
}

// ─── Engine: Cluster pays with cascading wins ──────────────────────────────
function playCluster(symbols, totalWeight, serverSeed, clientSeed, nonce, betAmount) {
  const ROWS = 5, COLS = 5
  let grid = spinFlat(symbols, totalWeight, ROWS * COLS, serverSeed, clientSeed, nonce, 'g')

  let totalMultiplier = 0
  const cascades = []
  let cascadeLevel = 0
  let cascadeMult = 1

  while (cascadeLevel < 6) {
    // Find connected clusters (flood fill, 4-neighbor)
    const visited = new Array(ROWS * COLS).fill(false)
    const clusters = []
    for (let i = 0; i < ROWS * COLS; i++) {
      if (visited[i]) continue
      const sym = grid[i]
      const cluster = []
      const queue = [i]
      while (queue.length) {
        const idx = queue.shift()
        if (visited[idx]) continue
        if (grid[idx].id !== sym.id) continue
        visited[idx] = true
        cluster.push(idx)
        const r = Math.floor(idx / COLS), c = idx % COLS
        if (r > 0)        queue.push(idx - COLS)
        if (r < ROWS - 1) queue.push(idx + COLS)
        if (c > 0)        queue.push(idx - 1)
        if (c < COLS - 1) queue.push(idx + 1)
      }
      if (cluster.length >= 5) {
        clusters.push({ symbol: sym, cells: cluster })
      }
    }

    if (clusters.length === 0) break

    // Award + mark cells for removal
    let cascadeWin = 0
    const toClear = new Set()
    for (const cl of clusters) {
      const size = cl.cells.length
      const tier = size >= 10 ? 10 : size >= 8 ? 8 : size >= 7 ? 7 : size >= 6 ? 6 : 5
      const baseMult = cl.symbol.payCluster[tier] || cl.symbol.payCluster[5]
      const mult = baseMult * cascadeMult
      cascadeWin += mult
      cl.cells.forEach(c => toClear.add(c))
    }

    cascades.push({
      level: cascadeLevel,
      grid: grid.map(s => s.emoji),
      multiplier: cascadeWin,
      clusters: clusters.map(cl => ({ symbol: cl.symbol.emoji, cells: cl.cells, size: cl.cells.length })),
      cascadeMult,
    })

    totalMultiplier += cascadeWin

    // Cascade: remove cleared cells, drop above, refill top
    const newGrid = [...grid]
    for (let c = 0; c < COLS; c++) {
      const col = []
      for (let r = ROWS - 1; r >= 0; r--) {
        const idx = r * COLS + c
        if (!toClear.has(idx)) col.push(newGrid[idx])
      }
      // Refill from top
      while (col.length < ROWS) {
        const float = generateFloat(serverSeed, clientSeed, `${nonce}:cascade${cascadeLevel}:${c}:${col.length}`)
        col.push(pickSymbol(symbols, totalWeight, float))
      }
      // Write back (col[0] = bottom)
      for (let r = ROWS - 1, k = 0; r >= 0; r--, k++) {
        newGrid[r * COLS + c] = col[k]
      }
    }
    grid = newGrid
    cascadeLevel++
    cascadeMult++
  }

  return {
    grid: grid.map(s => s.emoji),
    totalMultiplier,
    winningLines: cascades.map(c => ({
      cascade: c.level + 1,
      multiplier: c.multiplier,
      clusters: c.clusters,
      cascadeMult: c.cascadeMult,
    })),
    cascades,
  }
}

// ─── Routes ────────────────────────────────────────────────────────────────

router.get('/games', (req, res) => {
  res.json({
    success: true,
    games: Object.entries(GAMES).map(([id, g]) => ({
      id, name: g.name, engine: g.engine, symbols: g.symbols,
    })),
  })
})

router.get('/config', (req, res) => {
  const gameId = req.query.gameId || 'classic'
  const game = GAMES[gameId] || GAMES.classic
  const paylines = game.engine === '3x3' ? PAYLINES_3x3 :
                   game.engine === '5x3' ? PAYLINES_5x3 : []
  res.json({
    success: true,
    gameId, name: game.name, engine: game.engine,
    symbols: game.symbols, paylines,
    minBet: 0.01, maxBet: 1000, houseEdge: config.houseEdge,
  })
})

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
      .from('users').select('balance, server_seed, client_seed, nonce')
      .eq('id', userId).single()

    if (!user || user.balance < betAmount) {
      return res.status(400).json({ success: false, error: 'Insufficient balance' })
    }

    const serverSeed = user.server_seed || generateServerSeed()
    const clientSeed = user.client_seed || generateClientSeed()
    const nonce = user.nonce || 0

    let result
    if (game.engine === '3x3') result = play3x3(game.symbols, totalWeight, serverSeed, clientSeed, nonce, betAmount)
    else if (game.engine === '5x3') result = play5x3(game.symbols, totalWeight, serverSeed, clientSeed, nonce, betAmount)
    else if (game.engine === 'cluster') result = playCluster(game.symbols, totalWeight, serverSeed, clientSeed, nonce, betAmount)
    else return res.status(500).json({ success: false, error: 'Unknown engine' })

    const houseEdgeFactor = 1 - config.houseEdge / 100
    const payout = result.totalMultiplier > 0 ? betAmount * result.totalMultiplier * houseEdgeFactor : 0
    const newBalance = user.balance - betAmount + payout
    const profit = payout - betAmount

    await supabaseAdmin.from('users')
      .update({ balance: newBalance, nonce: nonce + 1, server_seed: serverSeed, client_seed: clientSeed })
      .eq('id', userId)

    await supabaseAdmin.from('game_history').insert({
      user_id: userId, game_type: 'slots',
      bet_amount: betAmount, profit, wagered: betAmount,
      multiplier: result.totalMultiplier,
      metadata: { gameId, gameName: game.name, engine: game.engine, grid: result.grid },
    })

    awardXP(userId, betAmount).catch(() => {})

    res.json({
      success: true, gameId, engine: game.engine,
      grid: result.grid,
      cascades: result.cascades?.map(c => ({
        grid: c.grid, multiplier: c.multiplier,
        clusters: c.clusters, cascadeMult: c.cascadeMult,
      })),
      winningLines: result.winningLines,
      multiplier: result.totalMultiplier,
      payout, profit, balance: newBalance,
      serverSeedHash: hashSeed(serverSeed),
    })
  } catch (err) {
    console.error('Slots spin error:', err)
    res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

router.get('/history', authMiddleware, async (req, res) => {
  try {
    const { data } = await supabaseAdmin.from('game_history')
      .select('*').eq('user_id', req.user.sub).eq('game_type', 'slots')
      .order('created_at', { ascending: false }).limit(20)
    res.json({ success: true, history: data || [] })
  } catch (err) {
    res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

module.exports = router
