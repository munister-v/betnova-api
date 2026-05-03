/**
 * Run once: node src/scripts/migrate.js
 * Adds missing columns to the database via Supabase Management API
 */
require('dotenv').config()

const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY

async function runSQL(sql) {
  // Supabase exposes a pg endpoint on the REST API via service role
  // We create a temporary function, call it, then drop it
  const fnName = `_migrate_${Date.now()}`
  const create = `
    CREATE OR REPLACE FUNCTION ${fnName}()
    RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
    BEGIN
      ${sql}
    END;
    $$;
  `

  const headers = {
    'apikey': SERVICE_KEY,
    'Authorization': `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
  }

  // Create the function via query endpoint
  const createRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  })

  return { ok: createRes.ok, status: createRes.status }
}

// Alternative: use Supabase Management API
async function migrateViaManagementAPI(sql) {
  const projectRef = SUPABASE_URL.match(/https:\/\/([^.]+)/)?.[1]
  if (!projectRef) throw new Error('Cannot parse project ref from SUPABASE_URL')

  const PAT = process.env.SUPABASE_PAT
  if (!PAT) {
    console.log('⚠️  No SUPABASE_PAT env var found.')
    console.log('   Add to .env: SUPABASE_PAT=sbp_xxxx')
    console.log('   Get it from: https://supabase.com/dashboard/account/tokens')
    console.log('\n📋 Run this SQL manually in the Supabase SQL editor:')
    console.log('   ' + sql)
    console.log('\n   URL: https://supabase.com/dashboard/project/' + projectRef + '/editor')
    return false
  }

  const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${PAT}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  })

  const data = await res.json()
  return res.ok ? data : null
}

async function main() {
  const migrations = [
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS last_daily_bonus TIMESTAMPTZ;',
    "COMMENT ON COLUMN users.last_daily_bonus IS 'Timestamp of last daily bonus claim';",
  ]

  console.log('🔄 Running migrations...\n')

  for (const sql of migrations) {
    console.log('SQL:', sql)
    const result = await migrateViaManagementAPI(sql)
    if (result === false) {
      // Already printed instructions
      break
    } else if (result) {
      console.log('✅ Done\n')
    } else {
      console.log('❌ Failed\n')
    }
  }
}

main().catch(console.error)
