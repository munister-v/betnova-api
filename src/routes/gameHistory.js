const express = require('express')
const router = express.Router()
const { supabaseAdmin } = require('../config/supabase')
const { authMiddleware } = require('../middleware/auth')

// GET /api/game-history/user
router.get('/user', authMiddleware, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20
    const page = parseInt(req.query.page) || 1
    const gameType = req.query.gameType
    const offset = (page - 1) * limit

    let query = supabaseAdmin
      .from('game_history')
      .select('id, game_type, bet_amount, profit, multiplier, created_at', { count: 'exact' })
      .eq('user_id', req.user.sub)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (gameType) query = query.eq('game_type', gameType)

    const { data, error, count } = await query

    if (error) return res.status(500).json({ success: false, error: error.message })

    return res.json({ success: true, games: data, total: count, page, limit })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/game-history/user/stats
router.get('/user/stats', authMiddleware, async (req, res) => {
  try {
    const gameType = req.query.gameType

    let query = supabaseAdmin
      .from('game_history')
      .select('profit, bet_amount, game_type')
      .eq('user_id', req.user.sub)

    if (gameType) query = query.eq('game_type', gameType)

    const { data } = await query

    const totalWagered = data?.reduce((s, g) => s + (g.bet_amount || 0), 0) || 0
    const totalProfit = data?.reduce((s, g) => s + (g.profit || 0), 0) || 0
    const wins = data?.filter(g => g.profit > 0).length || 0

    return res.json({
      success: true,
      totalGames: data?.length || 0,
      totalWagered,
      totalProfit,
      wins,
      losses: (data?.length || 0) - wins,
      winRate: data?.length > 0 ? Math.round((wins / data.length) * 100) : 0,
    })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/game-history/user/daily-stats
router.get('/user/daily-stats', authMiddleware, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

    const { data } = await supabaseAdmin
      .from('game_history')
      .select('profit, bet_amount, created_at')
      .eq('user_id', req.user.sub)
      .gte('created_at', since)
      .order('created_at', { ascending: true })

    // Group by day
    const byDay = {}
    for (const row of data || []) {
      const day = row.created_at.slice(0, 10)
      if (!byDay[day]) byDay[day] = { date: day, wagered: 0, profit: 0, games: 0 }
      byDay[day].wagered += row.bet_amount || 0
      byDay[day].profit += row.profit || 0
      byDay[day].games++
    }

    return res.json({ success: true, dailyStats: Object.values(byDay) })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/game-history/recent — public feed of recent wins (for LiveWins section)
router.get('/recent', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50)
    const filter = req.query.filter // 'Day','Week','Month' or omit for live

    let query = supabaseAdmin
      .from('game_history')
      .select('id, game_type, bet_amount, profit, multiplier, created_at, users(username, avatar_url)')
      .gt('profit', 0)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (filter === 'Day') {
      query = query.gte('created_at', new Date(Date.now() - 86400000).toISOString())
    } else if (filter === 'Week') {
      query = query.gte('created_at', new Date(Date.now() - 7 * 86400000).toISOString())
    } else if (filter === 'Month') {
      query = query.gte('created_at', new Date(Date.now() - 30 * 86400000).toISOString())
    }

    const { data, error } = await query
    if (error) return res.status(500).json({ success: false, error: error.message })

    return res.json({ success: true, wins: data || [] })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

module.exports = router
