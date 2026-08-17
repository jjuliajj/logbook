-- Run this in your Supabase SQL Editor

-- 1. Enable UUID extension if not enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. Create books table with site_id for multi-store isolation
CREATE TABLE IF NOT EXISTS books (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  site_id TEXT DEFAULT 'all',
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  description TEXT,
  category TEXT,
  price TEXT,
  details JSONB,
  file_url TEXT,
  cover_url TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Create stripe_settings table for multi-store Stripe account management
CREATE TABLE IF NOT EXISTS stripe_settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  site_id TEXT DEFAULT 'all',
  account_name TEXT NOT NULL,
  publishable_key TEXT,
  secret_key TEXT NOT NULL,
  is_active BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Fast indexes for multi-store filtering
CREATE INDEX IF NOT EXISTS idx_books_site_id ON books(site_id);
CREATE INDEX IF NOT EXISTS idx_stripe_settings_site_id ON stripe_settings(site_id);

-- 5. MIGRATION FOR EXISTING SUPABASE TABLES (Run if tables already exist):
-- ALTER TABLE books ADD COLUMN IF NOT EXISTS site_id TEXT DEFAULT 'all';
-- ALTER TABLE stripe_settings ADD COLUMN IF NOT EXISTS site_id TEXT DEFAULT 'all';
-- CREATE INDEX IF NOT EXISTS idx_books_site_id ON books(site_id);
-- CREATE INDEX IF NOT EXISTS idx_stripe_settings_site_id ON stripe_settings(site_id);
-- UPDATE books SET site_id = 'all' WHERE site_id IS NULL;
-- UPDATE stripe_settings SET site_id = 'all' WHERE site_id IS NULL;

