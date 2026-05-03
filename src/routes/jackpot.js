const express = require('express')
const router = express.Router()
const { supabaseAdmin } = require('../config/supabase')
const { authMiddleware, optionalAuth } = require('../middleware/auth')
const { generateFloat, generateServerSeed, generateClientSeed } = require('../utils/provablyFair')
const { awardXP } = require('../utils/xp')
const config = require('../config')

const ROUND_DURATION_MS = 60 * 1000  // 60 seconds
const MIN_ENTRY = 0.01
const MAX_ENTRY = 10000

// In-memory state (use Redis in prod)
let currentRound = null
let roundTimer = null

function createRound() {
  const serverSeed = generateServerSeed()
  const clientSeed = generateClientSeed()
  const endsAt = new Date(Date.now() + ROUND_DURATION_MS).toISOString()
  currentRound = {
    id: `jr_${Date.now()}`,
    serverSeed,
    clientSeed,
    endsAt,
    totalPool: 0,
    entries: [],   // { userId, username, avatar, amount, tickets }
    status: 'open',
    winner: null,
  }
  return currentRound
}

function pickWinner(entries, serverSeed, clientSeed) {
  if (!entries.length) return null
  const totalTickets = entries.reduce((s, e) => s + e.tickets, 0)
  const float = generateFloat(serverSeed, clientSeed, 'winner')
  let pick = float * totalTickets
  for (const entry of entries) {
    pick -= entry.tickets
    if (pick <= 0) return entry
  }
  return entries[entries.length - 1]
}

async function resolveRound(io) {
  if (!currentRound || currentRound.status !== 'open') return
  currentRound.status = 'resolving'

  if (currentRound.entries.length < 2) {
    // Refund single entry
    for (const entry of currentRound.entries) {
      const { data: user } = await supabaseAdmin.from('users').select('balance').eq('id', entry.userId).single()
      await supabaseAdmin.from('users').update({ balance: user.balance + entry.amount }).eq('id', entry.userId)
    }
    if (io) io.emit('jackpot:cancelled', { roundId: currentRound.id, reason: 'Not enough players' })
    currentRound = createRound()
    scheduleRound(io)
    return
  }

  const winner = pickWinner(currentRound.entries, currentRound.serverSeed, currentRound.clientSeed)
  const payout = currentRound.totalPool * (1 - config.houseEdge / 100)

  const { data: winnerUser } = await supabaseAdmin.from('users').select('balance').eq('id', winner.userId).single()
  await supabaseAdmin.from('users').update({ balance: winnerUser.balance + payout }).eq('id', winner.userId)

  await supabaseAdmin.from('game_history').insert({
    user_id: winner.userId,
    game_type: 'jackpot',
    bet_amount: winner.amount,
    profit: payout - winner.amount,
    wagered: currentRound.totalPool,
    metadata: { roundId: currentRound.id, payout, entries: currentRound.entries.length },
  })

  currentRound.winner = { ...winner, payout }
  currentRound.status = 'completed'

  if (io) io.emit('jackpot:winner', {
    roundId: currentRound.id,
    winner: { username: winner.username, avatar: winner.avatar, amount: winner.amount },
    payout,
    totalPool: currentRound.totalPool,
    serverSeed: currentRound.serverSeed,
  })

  setTimeout(() => {
    currentRound = createRound()
    if (io) io.emit('jackpot:new_round', getRoundPublic())
    scheduleRound(io)
  }, 5000)
}

function scheduleRound(io) {
  if (roundTimer) clearTimeout(roundTimer)
  roundTimer = setTimeout(() => resolveRound(io), ROUND_DURATION_MS)
}

function getRoundPublic() {
  if (!currentRound) return null
  return {
    id: currentRound.id,
    endsAt: currentRound.endsAt,
    totalPool: currentRound.totalPool,
    status: currentRound.status,
    entries: currentRound.entries.map(e => ({
      userId: e.userId, username: e.username,
      avatar: e.avatar, amount: e.amount,
      tickets: e.tickets, chance: currentRound.totalPool > 0
        ? Math.round((e.tickets / currentRound.totalPool) * 10000) / 100
        : 0,
    })),
    winner: currentRound.winner ? {
      username: currentRound.winner.username,
      payout: currentRound.winner.payout,
    } : null,
  }
}

// Init first round
createRound()

// GET /api/jackpot/current
router.get('/current', optionalAuth, (req, res) => {
  res.json({ success: true, round: getRoundPublic() })
})

// POST /api/jackpot/enter
router.post('/enter', authMiddleware, async (req, res) => {
  try {
    const { amount } = req.body
    const userId = req.user.sub

    if (!amount || amount < MIN_ENTRY || amount > MAX_ENTRY)
      return res.status(400).json({ success: false, error: `Min entry $${MIN_ENTRY}` })

    if (!currentRound || currentRound.status !== 'open')
      return res.status(400).json({ success: false, error: 'Round not open' })

    const { data: user } = await supabaseAdmin
      .from('users').select('balance, username, avatar_url').eq('id', userId).single()

    if (!user || user.balance < amount)
      return res.status(400).json({ success: false, error: 'Insufficient balance' })

    await supabaseAdmin.from('users').update({ balance: user.balance - amount }).eq('id', userId)

    // Add or increase existing entry
    const existing = currentRound.entries.find(e => e.userId === userId)
    if (existing) {
      existing.amount += amount
      existing.tickets += amount
    } else {
      currentRound.entries.push({
        userId, username: user.username, avatar: user.avatar_url,
        amount, tickets: amount,
      })
    }
    currentRound.totalPool += amount

    awardXP(userId, amount).catch(() => {})

    // If this is first entry, start the timer
    if (currentRound.entries.length === 1) {
      currentRound.endsAt = new Date(Date.now() + ROUND_DURATION_MS).toISOString()
      scheduleRound(req.app.get('io'))
    }

    req.app.get('io')?.emit('jackpot:update', getRoundPublic())

    res.json({ success: true, round: getRoundPublic() })
  } catch (err) {
    console.error(err)
    res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// Expose resolve fn for socket setup
module.exports = router
module.exports.initJackpot = (io) => {
  io.app = io.app || {}
  scheduleRound(io)
}
