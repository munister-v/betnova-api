const express = require('express')
const router = express.Router()
const { supabaseAdmin } = require('../config/supabase')
const { authMiddleware } = require('../middleware/auth')
const { generateServerSeed, generateClientSeed, hashSeed } = require('../utils/provablyFair')

// GET /api/user/profile
router.get('/profile', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('id, email, username, balance, avatar_url, created_at, server_seed_hash, client_seed, nonce')
      .eq('id', req.user.sub)
      .single()

    if (error || !data) {
      return res.status(404).json({ success: false, error: 'User not found' })
    }

    return res.json({ success: true, ...data })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// PUT /api/user/profile
router.put('/profile', authMiddleware, async (req, res) => {
  try {
    const allowed = ['username', 'avatar_url']
    const updates = {}
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key]
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: 'No valid fields to update' })
    }

    updates.updated_at = new Date().toISOString()

    const { data, error } = await supabaseAdmin
      .from('users')
      .update(updates)
      .eq('id', req.user.sub)
      .select()
      .single()

    if (error) {
      return res.status(500).json({ success: false, error: error.message })
    }

    return res.json({ success: true, ...data })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/user/statistics
router.get('/statistics', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.sub

    const { data: stats, error } = await supabaseAdmin
      .from('game_history')
      .select('profit, wagered, game_type')
      .eq('user_id', userId)

    if (error) {
      return res.status(500).json({ success: false, error: error.message })
    }

    const totalWagered = stats.reduce((sum, g) => sum + (g.wagered || 0), 0)
    const totalProfit = stats.reduce((sum, g) => sum + (g.profit || 0), 0)
    const totalGames = stats.length
    const wins = stats.filter(g => g.profit > 0).length

    const byGame = stats.reduce((acc, g) => {
      if (!acc[g.game_type]) acc[g.game_type] = { wagered: 0, profit: 0, games: 0 }
      acc[g.game_type].wagered += g.wagered || 0
      acc[g.game_type].profit += g.profit || 0
      acc[g.game_type].games++
      return acc
    }, {})

    return res.json({
      success: true,
      totalWagered,
      totalProfit,
      totalGames,
      wins,
      losses: totalGames - wins,
      winRate: totalGames > 0 ? Math.round((wins / totalGames) * 100) : 0,
      byGame,
    })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// POST /api/user/regenerate-seed
// Rotates provably fair seeds
router.post('/regenerate-seed', authMiddleware, async (req, res) => {
  try {
    const newServerSeed = generateServerSeed()
    const newClientSeed = generateClientSeed()

    const { error } = await supabaseAdmin
      .from('users')
      .update({
        server_seed: newServerSeed,
        server_seed_hash: hashSeed(newServerSeed),
        client_seed: newClientSeed,
        nonce: 0,
        updated_at: new Date().toISOString(),
      })
      .eq('id', req.user.sub)

    if (error) {
      return res.status(500).json({ success: false, error: error.message })
    }

    return res.json({ success: true, serverSeedHash: hashSeed(newServerSeed), clientSeed: newClientSeed })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

module.exports = router
