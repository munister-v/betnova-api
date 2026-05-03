const { supabaseAdmin } = require('../config/supabase')

const XP_PER_DOLLAR = 1 // 1 XP per $1 wagered

const LEVEL_THRESHOLDS = [
  { level: 1, xp: 0 }, { level: 2, xp: 100 }, { level: 3, xp: 250 },
  { level: 4, xp: 500 }, { level: 5, xp: 1000 }, { level: 10, xp: 5000 },
  { level: 20, xp: 20000 }, { level: 30, xp: 60000 },
  { level: 50, xp: 200000 }, { level: 100, xp: 1000000 },
]

function calcLevel(xp) {
  let level = 1
  for (const entry of LEVEL_THRESHOLDS) {
    if (xp >= entry.xp) level = entry.level
    else break
  }
  return level
}

async function awardXP(userId, wageredAmount) {
  if (!userId || !wageredAmount || wageredAmount <= 0) return
  const earned = Math.floor(wageredAmount * XP_PER_DOLLAR)
  if (earned <= 0) return

  const { data: user } = await supabaseAdmin
    .from('users')
    .select('xp, total_wagered')
    .eq('id', userId)
    .single()

  if (!user) return

  const newXp = (user.xp || 0) + earned
  const newLevel = calcLevel(newXp)
  const newWagered = (user.total_wagered || 0) + wageredAmount

  await supabaseAdmin
    .from('users')
    .update({ xp: newXp, level: newLevel, total_wagered: newWagered })
    .eq('id', userId)
}

module.exports = { awardXP }
