-- Promo codes table
CREATE TABLE IF NOT EXISTS promo_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL,
  amount numeric NOT NULL CHECK (amount > 0),
  max_uses integer,
  used_count integer DEFAULT 0,
  expires_at timestamptz,
  active boolean DEFAULT true,
  description text,
  created_at timestamptz DEFAULT now()
);

-- Redemptions table (one per user per code)
CREATE TABLE IF NOT EXISTS promo_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  promo_code_id uuid REFERENCES promo_codes(id) ON DELETE CASCADE,
  amount numeric NOT NULL,
  redeemed_at timestamptz DEFAULT now(),
  UNIQUE(user_id, promo_code_id)
);

CREATE INDEX IF NOT EXISTS promo_codes_code_idx ON promo_codes(code);
CREATE INDEX IF NOT EXISTS promo_redemptions_user_idx ON promo_redemptions(user_id);

-- Insert a few demo codes
INSERT INTO promo_codes (code, amount, max_uses, description) VALUES
  ('WELCOME5', 5, 1000, 'Welcome bonus — $5'),
  ('BETNOVA10', 10, 500, '$10 bonus for early users'),
  ('LUCKY1', 1, 10000, '$1 free try')
ON CONFLICT (code) DO NOTHING;
