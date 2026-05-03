const express = require('express')
const router = express.Router()
const { supabaseAdmin } = require('../config/supabase')
const { authMiddleware } = require('../middleware/auth')
const { generateFloat, generateServerSeed, generateClientSeed } = require('../utils/provablyFair')
const { awardXP } = require('../utils/xp')
const config = require('../config')

const SUITS = ['♠', '♥', '♦', '♣']
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A']

function buildDeck() {
  const deck = []
  for (const suit of SUITS)
    for (const rank of RANKS)
      deck.push({ rank, suit })
  return deck
}

function shuffleDeck(deck, serverSeed, clientSeed, nonce) {
  const shuffled = [...deck]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const float = generateFloat(serverSeed, clientSeed, `${nonce}:${i}`)
    const j = Math.floor(float * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled
}

function cardValue(rank) {
  if (['J','Q','K'].includes(rank)) return 10
  if (rank === 'A') return 11
  return parseInt(rank)
}

function handTotal(hand) {
  let total = 0
  let aces = 0
  for (const card of hand) {
    total += cardValue(card.rank)
    if (card.rank === 'A') aces++
  }
  while (total > 21 && aces > 0) {
    total -= 10
    aces--
  }
  return total
}

function isBust(hand) { return handTotal(hand) > 21 }
function isBlackjack(hand) { return hand.length === 2 && handTotal(hand) === 21 }

// Active games in memory (use Redis in prod)
const activeGames = new Map()

// POST /api/blackjack/deal
router.post('/deal', authMiddleware, async (req, res) => {
  try {
    const { betAmount } = req.body
    const userId = req.user.sub

    if (!betAmount || betAmount <= 0)
      return res.status(400).json({ success: false, error: 'Invalid bet' })

    const { data: user } = await supabaseAdmin
      .from('users').select('balance, server_seed, client_seed, nonce').eq('id', userId).single()

    if (!user || user.balance < betAmount)
      return res.status(400).json({ success: false, error: 'Insufficient balance' })

    const serverSeed = user.server_seed || generateServerSeed()
    const clientSeed = user.client_seed || generateClientSeed()
    const nonce = user.nonce || 0

    const deck = shuffleDeck(buildDeck(), serverSeed, clientSeed, nonce)

    const playerHand = [deck[0], deck[2]]
    const dealerHand = [deck[1], deck[3]]
    const remainingDeck = deck.slice(4)

    // Deduct bet
    await supabaseAdmin.from('users')
      .update({ balance: user.balance - betAmount, nonce: nonce + 1, server_seed: serverSeed, client_seed: clientSeed })
      .eq('id', userId)

    const gameId = `${userId}_${Date.now()}`
    activeGames.set(gameId, {
      userId, betAmount, playerHand, dealerHand, deck: remainingDeck,
      status: 'playing', doubled: false,
    })

    // Auto-resolve on player blackjack
    if (isBlackjack(playerHand)) {
      const dealerBJ = isBlackjack(dealerHand)
      if (dealerBJ) {
        // Push — refund
        await supabaseAdmin.from('users').update({ balance: user.balance }).eq('id', userId)
        activeGames.delete(gameId)
        return res.json({
          success: true, gameId, playerHand, dealerHand: dealerHand,
          result: 'push', payout: betAmount, message: 'Both Blackjack — Push!',
        })
      }
      const payout = betAmount * 2.5 // BJ pays 3:2
      const { data: u } = await supabaseAdmin.from('users').select('balance').eq('id', userId).single()
      await supabaseAdmin.from('users').update({ balance: u.balance + payout }).eq('id', userId)
      activeGames.delete(gameId)
      awardXP(userId, betAmount).catch(() => {})
      return res.json({
        success: true, gameId, playerHand, dealerHand,
        result: 'blackjack', payout, message: 'Blackjack! 🎉',
      })
    }

    awardXP(userId, betAmount).catch(() => {})

    res.json({
      success: true, gameId,
      playerHand, playerTotal: handTotal(playerHand),
      dealerCard: dealerHand[0], // only show first dealer card
      canDouble: user.balance - betAmount >= betAmount,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// POST /api/blackjack/hit
router.post('/hit', authMiddleware, async (req, res) => {
  try {
    const { gameId } = req.body
    const game = activeGames.get(gameId)

    if (!game || game.userId !== req.user.sub)
      return res.status(404).json({ success: false, error: 'Game not found' })
    if (game.status !== 'playing')
      return res.status(400).json({ success: false, error: 'Game already ended' })

    const card = game.deck.shift()
    game.playerHand.push(card)

    if (isBust(game.playerHand)) {
      game.status = 'bust'
      activeGames.delete(gameId)
      await supabaseAdmin.from('game_history').insert({
        user_id: game.userId, game_type: 'blackjack', bet_amount: game.betAmount,
        profit: -game.betAmount, wagered: game.betAmount,
        metadata: { result: 'bust', playerHand: game.playerHand, dealerHand: game.dealerHand },
      })
      return res.json({
        success: true, playerHand: game.playerHand, dealerHand: game.dealerHand,
        playerTotal: handTotal(game.playerHand), result: 'bust', message: 'Bust! 💥',
      })
    }

    res.json({
      success: true, playerHand: game.playerHand,
      playerTotal: handTotal(game.playerHand), dealerCard: game.dealerHand[0],
      canDouble: false,
    })
  } catch (err) {
    res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// POST /api/blackjack/double
router.post('/double', authMiddleware, async (req, res) => {
  try {
    const { gameId } = req.body
    const userId = req.user.sub
    const game = activeGames.get(gameId)

    if (!game || game.userId !== userId)
      return res.status(404).json({ success: false, error: 'Game not found' })
    if (game.playerHand.length !== 2)
      return res.status(400).json({ success: false, error: 'Can only double on first two cards' })

    const { data: user } = await supabaseAdmin.from('users').select('balance').eq('id', userId).single()
    if (!user || user.balance < game.betAmount)
      return res.status(400).json({ success: false, error: 'Insufficient balance' })

    // Deduct extra bet
    await supabaseAdmin.from('users').update({ balance: user.balance - game.betAmount }).eq('id', userId)
    game.betAmount *= 2
    game.doubled = true

    // Take exactly one card then stand
    const card = game.deck.shift()
    game.playerHand.push(card)
    req.body.gameId = gameId
    // Fall through to stand logic
    return resolveStand(game, gameId, userId, res)
  } catch (err) {
    res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// POST /api/blackjack/stand
router.post('/stand', authMiddleware, async (req, res) => {
  try {
    const { gameId } = req.body
    const game = activeGames.get(gameId)
    if (!game || game.userId !== req.user.sub)
      return res.status(404).json({ success: false, error: 'Game not found' })
    return resolveStand(game, gameId, req.user.sub, res)
  } catch (err) {
    res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

async function resolveStand(game, gameId, userId, res) {
  // Dealer draws until 17+
  while (handTotal(game.dealerHand) < 17) {
    game.dealerHand.push(game.deck.shift())
  }

  const playerTotal = handTotal(game.playerHand)
  const dealerTotal = handTotal(game.dealerHand)
  const dealerBust = isBust(game.dealerHand)

  let result, payout, message
  if (isBust(game.playerHand)) {
    result = 'bust'; payout = 0; message = 'Bust! 💥'
  } else if (dealerBust || playerTotal > dealerTotal) {
    result = 'win'; payout = game.betAmount * 2; message = 'You Win! 🎉'
  } else if (playerTotal === dealerTotal) {
    result = 'push'; payout = game.betAmount; message = 'Push — Tie!'
  } else {
    result = 'lose'; payout = 0; message = 'Dealer wins!'
  }

  if (payout > 0) {
    const { data: user } = await supabaseAdmin.from('users').select('balance').eq('id', userId).single()
    await supabaseAdmin.from('users').update({ balance: user.balance + payout }).eq('id', userId)
  }

  await supabaseAdmin.from('game_history').insert({
    user_id: userId, game_type: 'blackjack', bet_amount: game.betAmount,
    profit: payout - game.betAmount, wagered: game.betAmount,
    metadata: { result, playerHand: game.playerHand, dealerHand: game.dealerHand, playerTotal, dealerTotal },
  })

  activeGames.delete(gameId)

  res.json({
    success: true,
    playerHand: game.playerHand, playerTotal,
    dealerHand: game.dealerHand, dealerTotal,
    result, payout, message,
  })
}

// GET /api/blackjack/config
router.get('/config', (req, res) => {
  res.json({ success: true, minBet: 0.01, maxBet: 5000, blackjackPays: '3:2', houseEdge: config.houseEdge })
})

module.exports = router
