-- ═══════════════════════════════════════════════════════════════════════
-- Portfolio Tracker — Supabase Schema + RLS
-- Voer dit uit in: Supabase Dashboard → SQL Editor → New query → Run
-- ═══════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────
-- 1. PORTFOLIOS
-- id is text zodat frontend-IDs ('default', 'pf_1234567890') werken
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS portfolios (
  id         text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (length(name) >= 1 AND length(name) <= 100),
  created_at timestamptz DEFAULT now()
);

ALTER TABLE portfolios ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "users_own_portfolios" ON portfolios;
CREATE POLICY "users_own_portfolios" ON portfolios
  FOR ALL USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────────────
-- 2. TRANSACTIONS
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  portfolio_id text NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  type         text NOT NULL CHECK (type IN ('BUY','SELL')),
  ticker       text NOT NULL CHECK (ticker ~ '^[A-Z0-9.\-]{1,20}$'),
  name         text,
  qty          numeric NOT NULL CHECK (qty > 0),
  price        numeric NOT NULL CHECK (price > 0),
  fee          numeric NOT NULL DEFAULT 0 CHECK (fee >= 0),
  date         date NOT NULL,
  created_at   timestamptz DEFAULT now()
);

ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "users_own_transactions" ON transactions;
CREATE POLICY "users_own_transactions" ON transactions
  FOR ALL USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_transactions_user_portfolio
  ON transactions(user_id, portfolio_id);

-- ─────────────────────────────────────────────────────────────────────
-- 3. DIVIDENDS
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dividends (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  portfolio_id text REFERENCES portfolios(id) ON DELETE SET NULL,
  ticker       text NOT NULL,
  amount       numeric NOT NULL CHECK (amount > 0),
  date         date NOT NULL,
  description  text,
  created_at   timestamptz DEFAULT now()
);

ALTER TABLE dividends ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "users_own_dividends" ON dividends;
CREATE POLICY "users_own_dividends" ON dividends
  FOR ALL USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_dividends_user
  ON dividends(user_id);

-- ─────────────────────────────────────────────────────────────────────
-- 4. MANUAL POSITIONS (cash + alternatief)
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS manual_positions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type       text NOT NULL CHECK (type IN ('cash','alts')),
  name       text NOT NULL CHECK (length(name) >= 1 AND length(name) <= 100),
  value      numeric NOT NULL CHECK (value >= 0),
  subcat     text,
  note       text,
  updated_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now()
);

ALTER TABLE manual_positions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "users_own_manual_positions" ON manual_positions;
CREATE POLICY "users_own_manual_positions" ON manual_positions
  FOR ALL USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────────────
-- 5. WATCHLIST
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS watchlist (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ticker   text NOT NULL CHECK (ticker ~ '^[A-Z0-9.\-]{1,20}$'),
  name     text,
  added_at timestamptz DEFAULT now(),
  UNIQUE(user_id, ticker)
);

ALTER TABLE watchlist ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "users_own_watchlist" ON watchlist;
CREATE POLICY "users_own_watchlist" ON watchlist
  FOR ALL USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────────────
-- 6. ASSET CONFIGURATIE (klasse + doelgewicht per ticker)
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS asset_config (
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ticker        text NOT NULL,
  asset_class   text CHECK (asset_class IN (
                  'Aandelen','Crypto','Grondstoffen','Obligaties',
                  'Cash','Alternatief','Vastgoed','ETF/Fonds')),
  target_weight numeric DEFAULT 0 CHECK (target_weight >= 0 AND target_weight <= 100),
  PRIMARY KEY (user_id, ticker)
);

ALTER TABLE asset_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "users_own_asset_config" ON asset_config;
CREATE POLICY "users_own_asset_config" ON asset_config
  FOR ALL USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
