const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || supabaseUrl === 'YOUR_SUPABASE_URL_HERE') {
  console.error('Error: SUPABASE_URL is not set in .env file.');
}

const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = supabase;
