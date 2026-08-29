-- =========================================================================
-- RUN THIS IN YOUR SUPABASE SQL EDITOR TO FIX STORAGE UPLOAD & MULTI-SITE
-- =========================================================================

-- 1. Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. Create or Update Books Table with site_id
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

-- 3. Create or Update Stripe Settings Table
CREATE TABLE IF NOT EXISTS stripe_settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  site_id TEXT DEFAULT 'all',
  account_name TEXT NOT NULL,
  publishable_key TEXT,
  secret_key TEXT NOT NULL,
  is_active BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Create or Update PayPal Settings Table
CREATE TABLE IF NOT EXISTS paypal_settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  site_id TEXT DEFAULT 'all',
  account_name TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_secret TEXT NOT NULL,
  mode TEXT DEFAULT 'live', -- 'live' or 'sandbox'
  is_active BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. Disable RLS or grant full access on tables
ALTER TABLE books DISABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_settings DISABLE ROW LEVEL SECURITY;
ALTER TABLE paypal_settings DISABLE ROW LEVEL SECURITY;

-- 5. Fix Supabase Storage Buckets & Policies (Fixes "new row violates row-level security policy" on file/cover upload)
INSERT INTO storage.buckets (id, name, public) 
VALUES ('books', 'books', true) 
ON CONFLICT (id) DO UPDATE SET public = true;

INSERT INTO storage.buckets (id, name, public) 
VALUES ('covers', 'covers', true) 
ON CONFLICT (id) DO UPDATE SET public = true;

-- Drop old conflicting policies if exist
DROP POLICY IF EXISTS "Public Upload Books" ON storage.objects;
DROP POLICY IF EXISTS "Public Read Books" ON storage.objects;
DROP POLICY IF EXISTS "Public Update Books" ON storage.objects;
DROP POLICY IF EXISTS "Public Delete Books" ON storage.objects;
DROP POLICY IF EXISTS "Public Upload Covers" ON storage.objects;
DROP POLICY IF EXISTS "Public Read Covers" ON storage.objects;
DROP POLICY IF EXISTS "Public Update Covers" ON storage.objects;
DROP POLICY IF EXISTS "Public Delete Covers" ON storage.objects;

-- Create full read/write storage policies for books and covers buckets
CREATE POLICY "Public Upload Books" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'books');
CREATE POLICY "Public Read Books" ON storage.objects FOR SELECT USING (bucket_id = 'books');
CREATE POLICY "Public Update Books" ON storage.objects FOR UPDATE USING (bucket_id = 'books');
CREATE POLICY "Public Delete Books" ON storage.objects FOR DELETE USING (bucket_id = 'books');

CREATE POLICY "Public Upload Covers" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'covers');
CREATE POLICY "Public Read Covers" ON storage.objects FOR SELECT USING (bucket_id = 'covers');
CREATE POLICY "Public Update Covers" ON storage.objects FOR UPDATE USING (bucket_id = 'covers');
CREATE POLICY "Public Delete Covers" ON storage.objects FOR DELETE USING (bucket_id = 'covers');


