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

// POST /api/user/change-password
router.post('/change-password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, error: 'Both passwords required' })
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, error: 'New password must be at least 6 characters' })
    }

    // Get user email
    const { data: profile } = await supabaseAdmin
      .from('users').select('email').eq('id', req.user.sub).single()
    if (!profile) return res.status(404).json({ success: false, error: 'User not found' })

    // Verify current password by trying to sign in
    const { error: signInErr } = await supabaseAdmin.auth.signInWithPassword({
      email: profile.email,
      password: currentPassword,
    })
    if (signInErr) return res.status(401).json({ success: false, error: 'Current password is incorrect' })

    // Update password
    const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(req.user.sub, {
      password: newPassword,
    })
    if (updateErr) throw updateErr

    return res.json({ success: true, message: 'Password changed successfully' })
  } catch (err) {
    console.error('change-password error:', err)
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// POST /api/user/change-email
router.post('/change-email', authMiddleware, async (req, res) => {
  try {
    const { email } = req.body
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, error: 'Valid email required' })
    }

    // Check email not taken
    const { data: existing } = await supabaseAdmin
      .from('users').select('id').eq('email', email).maybeSingle()
    if (existing) return res.status(409).json({ success: false, error: 'Email already in use' })

    // Update in both auth and profile
    await supabaseAdmin.auth.admin.updateUserById(req.user.sub, { email })
    await supabaseAdmin.from('users').update({ email, updated_at: new Date().toISOString() }).eq('id', req.user.sub)

    return res.json({ success: true, message: 'Email updated' })
  } catch (err) {
    console.error('change-email error:', err)
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
