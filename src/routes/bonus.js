const express = require('express')
const router = express.Router()
const { supabaseAdmin } = require('../config/supabase')
const { authMiddleware } = require('../middleware/auth')

const DAILY_AMOUNT = 1.00
const COOLDOWN_MS  = 24 * 60 * 60 * 1000  // 24 hours

// Helper: find last daily bonus claim from transactions table
async function getLastClaim(userId) {
  const { data } = await supabaseAdmin
    .from('transactions')
    .select('created_at')
    .eq('user_id', userId)
    .eq('type', 'daily_bonus')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  return data ? new Date(data.created_at) : null
}

// GET /api/bonus/daily/status
router.get('/daily/status', authMiddleware, async (req, res) => {
  try {
    const lastClaim = await getLastClaim(req.user.sub)
    const now = Date.now()
    const nextClaim = lastClaim ? lastClaim.getTime() + COOLDOWN_MS : 0
    const canClaim = now >= nextClaim

    return res.json({
      success: true,
      canClaim,
      nextClaimAt: canClaim ? null : new Date(nextClaim).toISOString(),
      amount: DAILY_AMOUNT,
    })
  } catch (err) {
    console.error('daily status error:', err)
    return res.status(500).json({ success: false, error: 'Server error' })
  }
})

// POST /api/bonus/daily/claim
router.post('/daily/claim', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.sub

    // Cooldown check
    const lastClaim = await getLastClaim(userId)
    const now = Date.now()
    const nextClaim = lastClaim ? lastClaim.getTime() + COOLDOWN_MS : 0

    if (now < nextClaim) {
      return res.status(429).json({
        success: false,
        error: 'Already claimed',
        nextClaimAt: new Date(nextClaim).toISOString(),
      })
    }

    // Fetch current balance
    const { data: profile, error: fetchErr } = await supabaseAdmin
      .from('users')
      .select('balance')
      .eq('id', userId)
      .single()

    if (fetchErr || !profile) {
      return res.status(404).json({ success: false, error: 'User not found' })
    }

    const newBalance = parseFloat((parseFloat(profile.balance) + DAILY_AMOUNT).toFixed(2))

    // Update balance
    const { error: updateErr } = await supabaseAdmin
      .from('users')
      .update({ balance: newBalance })
      .eq('id', userId)

    if (updateErr) throw updateErr

    // Log in transactions (this IS the record we check for cooldown)
    await supabaseAdmin.from('transactions').insert({
      user_id: userId,
      type: 'daily_bonus',
      amount: DAILY_AMOUNT,
      status: 'completed',
      metadata: { label: 'Daily bonus claim' },
    })

    return res.json({
      success: true,
      amount: DAILY_AMOUNT,
      newBalance,
      nextClaimAt: new Date(now + COOLDOWN_MS).toISOString(),
    })
  } catch (err) {
    console.error('daily claim error:', err)
    return res.status(500).json({ success: false, error: 'Server error' })
  }
})

module.exports = router
