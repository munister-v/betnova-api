/**
 * Deposit Monitor — polls blockchain every 30s for incoming deposits
 *
 * Strategy (no extra DB columns):
 *   - Track credited amount via SUM of completed deposit transactions per address
 *   - If on-chain balance > credited → new funds arrived → credit difference
 */

const { ethers } = require('ethers')
const { supabaseAdmin } = require('../config/supabase')
const { toUsd } = require('./priceService')
const { uuidToIndex } = require('../utils/wallet')

const PROVIDERS = {
  eth: new ethers.JsonRpcProvider(process.env.ETH_RPC || 'https://eth.llamarpc.com'),
  bsc: new ethers.JsonRpcProvider(process.env.BSC_RPC || 'https://bsc-dataseed.binance.org'),
}

const USDT_CONTRACTS = {
  eth: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  bsc: '0x55d398326f99059fF775485246999027B3197955',
}

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
]

const ASSET_META = {
  ETH:         { network: 'eth', isNative: true },
  BNB:         { network: 'bsc', isNative: true },
  USDT:        { network: 'eth', isNative: false },
  'USDT-BEP20':{ network: 'bsc', isNative: false },
}

async function getOnChainBalance(asset, network, address) {
  const provider = PROVIDERS[network]
  if (!provider) return 0
  try {
    if (ASSET_META[asset]?.isNative) {
      const raw = await provider.getBalance(address)
      return parseFloat(ethers.formatEther(raw))
    } else {
      const contract = USDT_CONTRACTS[network]
      if (!contract) return 0
      const erc20 = new ethers.Contract(contract, ERC20_ABI, provider)
      const [raw, decimals] = await Promise.all([
        erc20.balanceOf(address),
        erc20.decimals(),
      ])
      return parseFloat(ethers.formatUnits(raw, decimals))
    }
  } catch (err) {
    console.warn(`[depositMonitor] getBalance(${address}, ${asset}) failed:`, err.message)
    return 0
  }
}

async function getCreditedCryptoAmount(userId, asset, address) {
  // Sum of crypto_amount from completed deposits for this address
  const { data } = await supabaseAdmin
    .from('transactions')
    .select('metadata')
    .eq('user_id', userId)
    .eq('type', 'deposit')
    .eq('status', 'completed')
    .eq('asset', asset)
    .eq('address', address)

  return (data || []).reduce((sum, tx) => {
    return sum + parseFloat(tx.metadata?.crypto_amount || 0)
  }, 0)
}

async function checkWallet(wallet) {
  const { user_id, asset, network, address } = wallet
  const meta = ASSET_META[asset]
  if (!meta) return

  const [onChain, credited] = await Promise.all([
    getOnChainBalance(asset, network, address),
    getCreditedCryptoAmount(user_id, asset, address),
  ])

  const delta = onChain - credited
  if (delta < 0.000001) return // nothing new

  let usdAmount = 0
  try {
    usdAmount = await toUsd(delta, asset.includes('USDT') ? 'USDT' : asset)
  } catch {
    usdAmount = delta // USDT ≈ 1:1 fallback
  }

  if (usdAmount < 0.01) return // dust

  console.log(`[depositMonitor] ✅ ${delta} ${asset} ($${usdAmount}) for user ${user_id}`)

  const { data: user } = await supabaseAdmin
    .from('users').select('balance').eq('id', user_id).single()

  await Promise.all([
    supabaseAdmin.from('users')
      .update({ balance: (user?.balance || 0) + usdAmount })
      .eq('id', user_id),
    supabaseAdmin.from('transactions').insert({
      user_id,
      type: 'deposit',
      amount: usdAmount,
      asset,
      address,
      status: 'completed',
      reference: `${asset}_${address}_${Date.now()}`,
      metadata: { crypto_amount: delta, network, usd_rate: usdAmount / delta },
    }),
  ])
}

let _running = false

async function runCycle() {
  if (_running) return
  _running = true
  try {
    const { data: wallets } = await supabaseAdmin
      .from('payment_wallets')
      .select('*')

    if (wallets && wallets.length > 0) {
      await Promise.allSettled(wallets.map(checkWallet))
    }
  } catch (err) {
    console.error('[depositMonitor] cycle error:', err.message)
  } finally {
    _running = false
  }
}

function start() {
  console.log('[depositMonitor] started — polling every 30s')
  runCycle()
  setInterval(runCycle, 30_000)
}

module.exports = { start }
