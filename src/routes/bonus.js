const express = require('express')
const router = express.Router()
const { supabaseAdmin } = require('../config/supabase')
const { authMiddleware } = require('../middleware/auth')

const DAY_MS  = 24 * 60 * 60 * 1000
const WEEK_MS = 7  * DAY_MS

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getBalance(userId) {
  const { data } = await supabaseAdmin
    .from('users').select('balance').eq('id', userId).single()
  return parseFloat(data?.balance || 0)
}

async function addBalance(userId, amount) {
  const current = await getBalance(userId)
  const next = parseFloat((current + amount).toFixed(2))
  await supabaseAdmin.from('users').update({ balance: next }).eq('id', userId)
  return next
}

async function logTx(userId, type, amount, meta = {}) {
  await supabaseAdmin.from('transactions').insert({
    user_id: userId, type, amount, status: 'completed',
    metadata: meta,
  })
}

async function lastTx(userId, type) {
  const { data } = await supabaseAdmin
    .from('transactions')
    .select('created_at')
    .eq('user_id', userId).eq('type', type)
    .order('created_at', { ascending: false })
    .limit(1).maybeSingle()
  return data ? new Date(data.created_at) : null
}

function cooldownRes(nextTs) {
  return { canClaim: false, nextClaimAt: new Date(nextTs).toISOString() }
}

// ─── DAILY BONUS ($1 / 24h) ───────────────────────────────────────────────────

router.get('/daily/status', authMiddleware, async (req, res) => {
  try {
    const last = await lastTx(req.user.sub, 'daily_bonus')
    const nextTs = last ? last.getTime() + DAY_MS : 0
    const canClaim = Date.now() >= nextTs
    return res.json({ success: true, canClaim, amount: 1.00,
      nextClaimAt: canClaim ? null : new Date(nextTs).toISOString() })
  } catch (e) { return res.status(500).json({ success: false, error: 'Server error' }) }
})

router.post('/daily/claim', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.sub
    const last = await lastTx(userId, 'daily_bonus')
    const nextTs = last ? last.getTime() + DAY_MS : 0
    if (Date.now() < nextTs) return res.status(429).json({ success: false, error: 'Already claimed', ...cooldownRes(nextTs) })
    const newBalance = await addBalance(userId, 1.00)
    await logTx(userId, 'daily_bonus', 1.00, { label: 'Daily bonus' })
    return res.json({ success: true, amount: 1.00, newBalance,
      nextClaimAt: new Date(Date.now() + DAY_MS).toISOString() })
  } catch (e) { return res.status(500).json({ success: false, error: 'Server error' }) }
})

// ─── WEEKLY BONUS (tiered by 7-day wager) ────────────────────────────────────
// Tiers: wager $10→$0.50 / $50→$2 / $200→$5 / $500→$15 / $2000→$50

const WEEKLY_TIERS = [
  { min: 2000, reward: 50.00 },
  { min:  500, reward: 15.00 },
  { min:  200, reward:  5.00 },
  { min:   50, reward:  2.00 },
  { min:   10, reward:  0.50 },
]

async function weeklyWager(userId) {
  const since = new Date(Date.now() - WEEK_MS).toISOString()
  const { data } = await supabaseAdmin
    .from('game_history')
    .select('bet_amount')
    .eq('user_id', userId)
    .gte('created_at', since)
  return (data || []).reduce((s, r) => s + (parseFloat(r.bet_amount) || 0), 0)
}

function weeklyRewardFor(wager) {
  for (const t of WEEKLY_TIERS) {
    if (wager >= t.min) return t.reward
  }
  return 0
}

router.get('/weekly/status', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.sub
    const last = await lastTx(userId, 'weekly_bonus')
    const nextTs = last ? last.getTime() + WEEK_MS : 0
    const canClaim = Date.now() >= nextTs
    const wager = await weeklyWager(userId)
    const amount = weeklyRewardFor(wager)
    const nextTier = WEEKLY_TIERS.slice().reverse().find(t => t.min > wager)
    return res.json({
      success: true, canClaim: canClaim && amount > 0, amount,
      weeklyWager: parseFloat(wager.toFixed(2)),
      nextClaimAt: canClaim ? null : new Date(nextTs).toISOString(),
      nextTierAt: nextTier ? nextTier.min : null,
      nextTierReward: nextTier ? nextTier.reward : null,
    })
  } catch (e) { return res.status(500).json({ success: false, error: 'Server error' }) }
})

router.post('/weekly/claim', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.sub
    const last = await lastTx(userId, 'weekly_bonus')
    const nextTs = last ? last.getTime() + WEEK_MS : 0
    if (Date.now() < nextTs) return res.status(429).json({ success: false, error: 'Already claimed', ...cooldownRes(nextTs) })
    const wager = await weeklyWager(userId)
    const amount = weeklyRewardFor(wager)
    if (amount <= 0) return res.status(400).json({ success: false, error: 'Wager at least $10 this week to unlock weekly bonus' })
    const newBalance = await addBalance(userId, amount)
    await logTx(userId, 'weekly_bonus', amount, { wager: parseFloat(wager.toFixed(2)) })
    return res.json({ success: true, amount, newBalance,
      nextClaimAt: new Date(Date.now() + WEEK_MS).toISOString() })
  } catch (e) { return res.status(500).json({ success: false, error: 'Server error' }) }
})

// ─── RAKEBACK (5% of losses, accumulated, claim any time) ────────────────────

const RAKEBACK_PCT = 0.05

async function pendingRakeback(userId) {
  const last = await lastTx(userId, 'rakeback_claim')
  const since = last ? last.toISOString() : '2020-01-01'
  const { data } = await supabaseAdmin
    .from('game_history')
    .select('profit')
    .eq('user_id', userId)
    .lt('profit', 0)
    .gte('created_at', since)
  const totalLoss = (data || []).reduce((s, r) => s + Math.abs(parseFloat(r.profit) || 0), 0)
  return parseFloat((totalLoss * RAKEBACK_PCT).toFixed(2))
}

router.get('/rakeback/status', authMiddleware, async (req, res) => {
  try {
    const pending = await pendingRakeback(req.user.sub)
    return res.json({ success: true, pending, canClaim: pending >= 0.01, rate: RAKEBACK_PCT })
  } catch (e) { return res.status(500).json({ success: false, error: 'Server error' }) }
})

router.post('/rakeback/claim', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.sub
    const pending = await pendingRakeback(userId)
    if (pending < 0.01) return res.status(400).json({ success: false, error: 'Nothing to claim yet' })
    const newBalance = await addBalance(userId, pending)
    await logTx(userId, 'rakeback_claim', pending, { rate: RAKEBACK_PCT })
    return res.json({ success: true, amount: pending, newBalance })
  } catch (e) { return res.status(500).json({ success: false, error: 'Server error' }) }
})

// ─── ROLLBACK / ROLLBASE (0.3% of all wagers, accumulated) ───────────────────

const ROLLBACK_PCT = 0.003

async function pendingRollback(userId) {
  const last = await lastTx(userId, 'rollback_claim')
  const since = last ? last.toISOString() : '2020-01-01'
  const { data } = await supabaseAdmin
    .from('game_history')
    .select('bet_amount')
    .eq('user_id', userId)
    .gte('created_at', since)
  const total = (data || []).reduce((s, r) => s + (parseFloat(r.bet_amount) || 0), 0)
  return parseFloat((total * ROLLBACK_PCT).toFixed(2))
}

router.get('/rollback/status', authMiddleware, async (req, res) => {
  try {
    const pending = await pendingRollback(req.user.sub)
    return res.json({ success: true, pending, canClaim: pending >= 0.01, rate: ROLLBACK_PCT })
  } catch (e) { return res.status(500).json({ success: false, error: 'Server error' }) }
})

router.post('/rollback/claim', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.sub
    const pending = await pendingRollback(userId)
    if (pending < 0.01) return res.status(400).json({ success: false, error: 'Nothing to claim yet — keep playing!' })
    const newBalance = await addBalance(userId, pending)
    await logTx(userId, 'rollback_claim', pending, { rate: ROLLBACK_PCT })
    return res.json({ success: true, amount: pending, newBalance })
  } catch (e) { return res.status(500).json({ success: false, error: 'Server error' }) }
})

// ─── FREE SIDEBET ($0.50 once per 7 days) ────────────────────────────────────

router.get('/free-sidebet/status', authMiddleware, async (req, res) => {
  try {
    const last = await lastTx(req.user.sub, 'free_sidebet')
    const nextTs = last ? last.getTime() + WEEK_MS : 0
    const canClaim = Date.now() >= nextTs
    return res.json({ success: true, canClaim, amount: 0.50,
      nextClaimAt: canClaim ? null : new Date(nextTs).toISOString() })
  } catch (e) { return res.status(500).json({ success: false, error: 'Server error' }) }
})

router.post('/free-sidebet/claim', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.sub
    const last = await lastTx(userId, 'free_sidebet')
    const nextTs = last ? last.getTime() + WEEK_MS : 0
    if (Date.now() < nextTs) return res.status(429).json({ success: false, error: 'Already claimed', ...cooldownRes(nextTs) })
    const newBalance = await addBalance(userId, 0.50)
    await logTx(userId, 'free_sidebet', 0.50, { label: 'Free sidebet credit' })
    return res.json({ success: true, amount: 0.50, newBalance,
      nextClaimAt: new Date(Date.now() + WEEK_MS).toISOString() })
  } catch (e) { return res.status(500).json({ success: false, error: 'Server error' }) }
})

// ─── ALL STATUS (single request for UI) ───────────────────────────────────────

router.get('/all', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.sub
    const now = Date.now()

    const [
      dailyLast, weeklyData, rakebackAmt, rollbackAmt, sidebtLast,
    ] = await Promise.all([
      lastTx(userId, 'daily_bonus'),
      (async () => {
        const last = await lastTx(userId, 'weekly_bonus')
        const nextTs = last ? last.getTime() + WEEK_MS : 0
        const canClaim = now >= nextTs
        const wager = await weeklyWager(userId)
        const amount = weeklyRewardFor(wager)
        return { canClaim: canClaim && amount > 0, amount, weeklyWager: parseFloat(wager.toFixed(2)),
          nextClaimAt: canClaim ? null : new Date(nextTs).toISOString(),
          nextTierAt: WEEKLY_TIERS.slice().reverse().find(t => t.min > wager)?.min || null }
      })(),
      pendingRakeback(userId),
      pendingRollback(userId),
      lastTx(userId, 'free_sidebet'),
    ])

    const dailyNextTs  = dailyLast  ? dailyLast.getTime()  + DAY_MS  : 0
    const sidebtNextTs = sidebtLast ? sidebtLast.getTime() + WEEK_MS : 0

    return res.json({
      success: true,
      daily:      { canClaim: now >= dailyNextTs,  amount: 1.00, nextClaimAt: now >= dailyNextTs  ? null : new Date(dailyNextTs).toISOString() },
      weekly:     weeklyData,
      rakeback:   { canClaim: rakebackAmt >= 0.01, pending: rakebackAmt, rate: RAKEBACK_PCT },
      rollback:   { canClaim: rollbackAmt >= 0.01, pending: rollbackAmt, rate: ROLLBACK_PCT },
      freeSidebet:{ canClaim: now >= sidebtNextTs, amount: 0.50, nextClaimAt: now >= sidebtNextTs ? null : new Date(sidebtNextTs).toISOString() },
    })
  } catch (e) {
    console.error('bonus/all error:', e)
    return res.status(500).json({ success: false, error: 'Server error' })
  }
})

module.exports = router
