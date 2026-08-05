-- Run this in your Supabase SQL Editor

-- 1. Enable UUID extension if not enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. Create books table
CREATE TABLE IF NOT EXISTS books (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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

-- 3. Create stripe_settings table for multi-account management
CREATE TABLE IF NOT EXISTS stripe_settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_name TEXT NOT NULL,
  publishable_key TEXT,
  secret_key TEXT NOT NULL,
  is_active BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Storage Buckets (Manual Step)
-- Please go to Supabase Dashboard > Storage and create two PUBLIC buckets:
-- - 'books'
-- - 'covers'
-- Set the policy to allow Public Read/Write if you want the API to manage them.

-- 4. Sample Data (Optional)
-- INSERT INTO books (title, author, description, category, price, details)
-- VALUES ('The Midnight Library', 'Matt Haig', 'Between life and death there is a library...', 'Fiction', '$24.00', '{"Publisher": "Viking", "Pages": "304"}');
