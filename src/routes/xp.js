const express = require('express')
const router = express.Router()
const { supabaseAdmin } = require('../config/supabase')
const { authMiddleware } = require('../middleware/auth')

// GET /api/xp/user
router.get('/user', authMiddleware, async (req, res) => {
  try {
    const { data } = await supabaseAdmin
      .from('users')
      .select('xp, level, total_wagered')
      .eq('id', req.user.sub)
      .single()

    return res.json({ success: true, ...data })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/xp/achievements
router.get('/achievements', authMiddleware, async (req, res) => {
  try {
    const { data } = await supabaseAdmin
      .from('user_achievements')
      .select('achievement_id, unlocked_at, achievements(name, description, icon, xp_reward)')
      .eq('user_id', req.user.sub)

    return res.json({ success: true, achievements: data || [] })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/xp/leaderboard/level
router.get('/leaderboard/level', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20

    const { data } = await supabaseAdmin
      .from('users')
      .select('id, username, avatar_url, level, xp')
      .order('level', { ascending: false })
      .order('xp', { ascending: false })
      .limit(limit)

    return res.json({ success: true, leaderboard: data || [] })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/xp/leaderboard/wagering
router.get('/leaderboard/wagering', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20

    const { data } = await supabaseAdmin
      .from('users')
      .select('id, username, avatar_url, total_wagered')
      .order('total_wagered', { ascending: false })
      .limit(limit)

    return res.json({ success: true, leaderboard: data || [] })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/xp/leaderboard/weekly-wagering
router.get('/leaderboard/weekly-wagering', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

    const { data } = await supabaseAdmin
      .from('game_history')
      .select('user_id, wagered, users(username, avatar_url)')
      .gte('created_at', weekAgo)

    // Aggregate by user
    const byUser = {}
    for (const row of data || []) {
      if (!byUser[row.user_id]) {
        byUser[row.user_id] = { user_id: row.user_id, weekly_wagered: 0, ...row.users }
      }
      byUser[row.user_id].weekly_wagered += row.wagered || 0
    }

    const leaderboard = Object.values(byUser)
      .sort((a, b) => b.weekly_wagered - a.weekly_wagered)
      .slice(0, limit)

    return res.json({ success: true, leaderboard })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/xp/requirements
router.get('/requirements', async (req, res) => {
  try {
    const maxLevel = parseInt(req.query.maxLevel) || 100

    const { data } = await supabaseAdmin
      .from('level_requirements')
      .select('level, xp_required, rewards')
      .lte('level', maxLevel)
      .order('level', { ascending: true })

    return res.json({ success: true, requirements: data || [] })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

module.exports = router
