const express = require('express')
const router = express.Router()

// GET /api/game-status/active-players
router.get('/active-players', (req, res) => {
  const activePlayers = req.app.get('activePlayers') || {}
  const total = Object.values(activePlayers).reduce((s, n) => s + n, 0)
  return res.json({ success: true, total, byGame: activePlayers })
})

// GET /api/game-status/active-players/:gameType
router.get('/active-players/:gameType', (req, res) => {
  const activePlayers = req.app.get('activePlayers') || {}
  const count = activePlayers[req.params.gameType] || 0
  return res.json({ success: true, count, gameType: req.params.gameType })
})

module.exports = router
