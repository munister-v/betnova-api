const express = require('express')
const router = express.Router()
const { supabaseAdmin } = require('../config/supabase')
const { authMiddleware } = require('../middleware/auth')
const { v4: uuidv4 } = require('uuid')

// GET /api/referrals/my — get current user's referral codes + stats
router.get('/my', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.sub

    const { data: codes, error } = await supabaseAdmin
      .from('referral_codes')
      .select('*')
      .eq('owner_id', userId)
      .order('created_at', { ascending: false })

    if (error && error.code !== 'PGRST116') {
      // Table might not exist yet — return empty
      return res.json({ success: true, codes: [], total_referrals: 0, total_earned: 0 })
    }

    // Count referred users & earnings
    const { count: totalReferrals } = await supabaseAdmin
      .from('referral_uses')
      .select('*', { count: 'exact', head: true })
      .eq('referrer_id', userId)

    const { data: earned } = await supabaseAdmin
      .from('referral_uses')
      .select('commission')
      .eq('referrer_id', userId)

    const totalEarned = (earned || []).reduce((s, r) => s + parseFloat(r.commission || 0), 0)

    return res.json({
      success: true,
      codes: codes || [],
      total_referrals: totalReferrals || 0,
      total_earned: totalEarned,
    })
  } catch (err) {
    return res.json({ success: true, codes: [], total_referrals: 0, total_earned: 0 })
  }
})

// POST /api/referrals/create — create a referral code
router.post('/create', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.sub
    const { code } = req.body

    if (!code || code.length < 3 || code.length > 20 || !/^[a-zA-Z0-9_-]+$/.test(code)) {
      return res.status(400).json({ success: false, error: 'Invalid code. Use 3-20 alphanumeric characters.' })
    }

    const slug = code.toUpperCase()

    // Check uniqueness
    const { data: existing } = await supabaseAdmin
      .from('referral_codes')
      .select('id')
      .eq('code', slug)
      .single()

    if (existing) {
      return res.status(409).json({ success: false, error: 'Code already taken.' })
    }

    const { data, error } = await supabaseAdmin
      .from('referral_codes')
      .insert({ id: uuidv4(), owner_id: userId, code: slug, uses: 0, earned: 0 })
      .select()
      .single()

    if (error) return res.status(500).json({ success: false, error: error.message })

    return res.json({ success: true, code: data })
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/referrals/users — list referred users
router.get('/users', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.sub
    const limit = parseInt(req.query.limit) || 20
    const page = parseInt(req.query.page) || 1
    const offset = (page - 1) * limit

    const { data, error, count } = await supabaseAdmin
      .from('referral_uses')
      .select('referred_id, commission, created_at, users!referred_id(username)', { count: 'exact' })
      .eq('referrer_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) return res.json({ success: true, users: [], total: 0 })

    return res.json({ success: true, users: data || [], total: count || 0 })
  } catch (err) {
    return res.json({ success: true, users: [], total: 0 })
  }
})

module.exports = router
