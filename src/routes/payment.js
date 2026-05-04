/**
 * Payment routes — in-house crypto processor
 *
 * Deposit:  HD wallet address per user per asset, monitored by depositMonitor service
 * Withdraw: hot wallet signs and broadcasts tx
 *
 * Supported assets:
 *   ETH   — Ethereum mainnet (native)
 *   BNB   — BSC mainnet (native)
 *   USDT  — USDT ERC-20 on Ethereum
 *   USDT-BEP20 — USDT BEP-20 on BSC
 */

const express = require('express')
const router = express.Router()
const { ethers } = require('ethers')
const { supabaseAdmin } = require('../config/supabase')
const { authMiddleware } = require('../middleware/auth')
const { deriveAddress, getHotWallet, isValidAddress, uuidToIndex } = require('../utils/wallet')
const { toUsd, getUsdPrice } = require('../services/priceService')

// ── Config ───────────────────────────────────────────────────────────────────

const SUPPORTED_ASSETS = [
  {
    symbol: 'ETH',
    name: 'Ethereum',
    network: 'eth',
    networkLabel: 'Ethereum (ERC-20)',
    color: '#627EEA',
    icon: '⟠',
    minDeposit: 0.001,
    minWithdraw: 0.002,
    decimals: 18,
    isNative: true,
  },
  {
    symbol: 'BNB',
    name: 'BNB',
    network: 'bsc',
    networkLabel: 'BNB Smart Chain',
    color: '#F3BA2F',
    icon: '◈',
    minDeposit: 0.005,
    minWithdraw: 0.01,
    decimals: 18,
    isNative: true,
  },
  {
    symbol: 'USDT',
    name: 'Tether USD',
    network: 'eth',
    networkLabel: 'Ethereum (ERC-20)',
    color: '#26A17B',
    icon: '₮',
    minDeposit: 1,
    minWithdraw: 5,
    decimals: 6,
    isNative: false,
    contractAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  },
  {
    symbol: 'USDT-BEP20',
    name: 'Tether USD (BSC)',
    network: 'bsc',
    networkLabel: 'BNB Smart Chain (BEP-20)',
    color: '#26A17B',
    icon: '₮',
    minDeposit: 1,
    minWithdraw: 2,
    decimals: 18,
    isNative: false,
    contractAddress: '0x55d398326f99059fF775485246999027B3197955',
  },
]

const PROVIDERS = {
  eth: new ethers.JsonRpcProvider(process.env.ETH_RPC || 'https://eth.llamarpc.com'),
  bsc: new ethers.JsonRpcProvider(process.env.BSC_RPC || 'https://bsc-dataseed.binance.org'),
}

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
]

const USDT_CONTRACTS = {
  eth: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  bsc: '0x55d398326f99059fF775485246999027B3197955',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Deterministic index from user UUID — no DB column needed
function getWalletIndex(userId) {
  return uuidToIndex(userId)
}

// ── Routes ───────────────────────────────────────────────────────────────────

// GET /api/payment/assets
router.get('/assets', (req, res) => {
  res.json({ success: true, assets: SUPPORTED_ASSETS })
})

// GET /api/payment/prices
router.get('/prices', async (req, res) => {
  try {
    const prices = {}
    await Promise.all(
      ['ETH', 'BNB', 'USDT'].map(async (a) => {
        prices[a] = await getUsdPrice(a)
      })
    )
    prices['USDT-BEP20'] = 1
    res.json({ success: true, prices })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// POST /api/payment/deposit/create
// Returns a unique deposit address for the user + asset combination
router.post('/deposit/create', authMiddleware, async (req, res) => {
  try {
    const { asset } = req.body
    const userId = req.user.sub

    const assetInfo = SUPPORTED_ASSETS.find(a => a.symbol === (asset || '').toUpperCase())
    if (!assetInfo) return res.status(400).json({ success: false, error: 'Unsupported asset' })

    // Return existing wallet if already created
    const { data: existing } = await supabaseAdmin
      .from('payment_wallets')
      .select('*')
      .eq('user_id', userId)
      .eq('asset', assetInfo.symbol)
      .maybeSingle()

    if (existing) return res.json({ success: true, wallet: existing, assetInfo })

    // Derive new address
    const walletIndex = getWalletIndex(userId)
    const { address } = deriveAddress(walletIndex)

    const { data: wallet, error } = await supabaseAdmin
      .from('payment_wallets')
      .insert({
        user_id: userId,
        asset: assetInfo.symbol,
        network: assetInfo.network,
        address,
      })
      .select()
      .single()

    if (error) return res.status(500).json({ success: false, error: error.message })

    return res.json({ success: true, wallet, assetInfo })
  } catch (err) {
    console.error('Deposit create error:', err.message)
    res.status(500).json({ success: false, error: 'Failed to create deposit address' })
  }
})

// GET /api/payment/deposit/status/:asset
// Returns current on-chain balance at deposit address vs recorded last balance
router.get('/deposit/status/:asset', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.sub
    const asset = req.params.asset.toUpperCase()

    const { data: wallet } = await supabaseAdmin
      .from('payment_wallets')
      .select('*')
      .eq('user_id', userId)
      .eq('asset', asset)
      .maybeSingle()

    if (!wallet) return res.json({ success: true, status: 'no_wallet' })

    const assetInfo = SUPPORTED_ASSETS.find(a => a.symbol === asset)
    const provider = PROVIDERS[assetInfo?.network || 'eth']

    let onChainBalance = 0
    try {
      if (assetInfo?.isNative) {
        const raw = await provider.getBalance(wallet.address)
        onChainBalance = parseFloat(ethers.formatEther(raw))
      } else {
        const contract = new ethers.Contract(assetInfo.contractAddress, ERC20_ABI, provider)
        const [raw, decimals] = await Promise.all([
          contract.balanceOf(wallet.address),
          contract.decimals(),
        ])
        onChainBalance = parseFloat(ethers.formatUnits(raw, decimals))
      }
    } catch (err) {
      console.warn('Balance check error:', err.message)
    }

    const confirmed = onChainBalance > (parseFloat(wallet.last_balance) + 0.000001)

    return res.json({
      success: true,
      status: confirmed ? 'pending_credit' : 'waiting',
      onChainBalance,
      lastBalance: wallet.last_balance,
      address: wallet.address,
    })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// GET /api/payment/user/wallets
router.get('/user/wallets', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('payment_wallets')
      .select('*')
      .eq('user_id', req.user.sub)

    if (error) return res.status(500).json({ success: false, error: error.message })
    res.json({ success: true, wallets: data || [] })
  } catch (err) {
    res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// POST /api/payment/withdraw
router.post('/withdraw', authMiddleware, async (req, res) => {
  try {
    const { asset, cryptoAmount, toAddress } = req.body
    const userId = req.user.sub

    if (!asset || !cryptoAmount || !toAddress) {
      return res.status(400).json({ success: false, error: 'asset, cryptoAmount and toAddress required' })
    }

    const assetInfo = SUPPORTED_ASSETS.find(a => a.symbol === asset.toUpperCase())
    if (!assetInfo) return res.status(400).json({ success: false, error: 'Unsupported asset' })

    if (parseFloat(cryptoAmount) < assetInfo.minWithdraw) {
      return res.status(400).json({ success: false, error: `Minimum withdrawal is ${assetInfo.minWithdraw} ${asset}` })
    }

    if (!isValidAddress(toAddress)) {
      return res.status(400).json({ success: false, error: 'Invalid withdrawal address' })
    }

    // Convert crypto → USD
    const usdAmount = await toUsd(parseFloat(cryptoAmount), asset.includes('USDT') ? 'USDT' : asset)
    if (usdAmount < 0.01) return res.status(400).json({ success: false, error: 'Amount too small' })

    // Check balance
    const { data: user } = await supabaseAdmin
      .from('users').select('balance').eq('id', userId).single()

    if (!user || user.balance < usdAmount) {
      return res.status(400).json({ success: false, error: 'Insufficient balance' })
    }

    if (!process.env.HOT_WALLET_KEY) {
      // Dev mode — simulate withdrawal
      await supabaseAdmin.from('users').update({ balance: user.balance - usdAmount }).eq('id', userId)
      await supabaseAdmin.from('transactions').insert({
        user_id: userId, type: 'withdrawal', amount: usdAmount,
        asset: assetInfo.symbol, address: toAddress, status: 'pending',
        reference: `SIM_${Date.now()}`,
        metadata: { crypto_amount: cryptoAmount, simulated: true },
      })
      return res.json({ success: true, txHash: null, simulated: true, usdAmount })
    }

    // Deduct balance before sending (prevent double spend)
    await supabaseAdmin.from('users').update({ balance: user.balance - usdAmount }).eq('id', userId)

    const provider = PROVIDERS[assetInfo.network]
    const hotWallet = getHotWallet(provider)

    let txHash = null
    try {
      if (assetInfo.isNative) {
        // Send native ETH/BNB
        const tx = await hotWallet.sendTransaction({
          to: toAddress,
          value: ethers.parseEther(cryptoAmount.toString()),
        })
        txHash = tx.hash
      } else {
        // Send ERC-20 / BEP-20 token
        const contract = new ethers.Contract(assetInfo.contractAddress, ERC20_ABI, hotWallet)
        const decimals = assetInfo.decimals
        const amount = ethers.parseUnits(cryptoAmount.toString(), decimals)
        const tx = await contract.transfer(toAddress, amount)
        txHash = tx.hash
      }
    } catch (txErr) {
      console.error('TX send error:', txErr.message)
      // Refund balance
      await supabaseAdmin.from('users').update({ balance: user.balance }).eq('id', userId)
      return res.status(500).json({ success: false, error: 'Transaction failed — balance refunded' })
    }

    await supabaseAdmin.from('transactions').insert({
      user_id: userId, type: 'withdrawal', amount: usdAmount,
      asset: assetInfo.symbol, address: toAddress, status: 'processing',
      reference: txHash,
      metadata: { crypto_amount: cryptoAmount, network: assetInfo.network, tx_hash: txHash },
    })

    return res.json({ success: true, txHash, usdAmount })
  } catch (err) {
    console.error('Withdraw error:', err.message)
    res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/payment/user/transactions
router.get('/user/transactions', authMiddleware, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20
    const page = parseInt(req.query.page) || 1
    const offset = (page - 1) * limit

    const { data, error, count } = await supabaseAdmin
      .from('transactions')
      .select('*', { count: 'exact' })
      .eq('user_id', req.user.sub)
      .in('type', ['deposit', 'withdrawal'])
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) return res.status(500).json({ success: false, error: error.message })
    res.json({ success: true, transactions: data, total: count, page, limit })
  } catch (err) {
    res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// GET /api/payment/user/stats
router.get('/user/stats', authMiddleware, async (req, res) => {
  try {
    const { data } = await supabaseAdmin
      .from('transactions')
      .select('type, amount, status')
      .eq('user_id', req.user.sub)
      .eq('status', 'completed')
      .in('type', ['deposit', 'withdrawal'])

    const deposited = data?.filter(t => t.type === 'deposit').reduce((s, t) => s + parseFloat(t.amount || 0), 0) || 0
    const withdrawn = data?.filter(t => t.type === 'withdrawal').reduce((s, t) => s + parseFloat(t.amount || 0), 0) || 0

    res.json({ success: true, totalDeposited: deposited, totalWithdrawn: withdrawn })
  } catch (err) {
    res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

module.exports = router
