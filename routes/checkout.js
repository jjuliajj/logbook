const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const supabase = require('../supabase');

// Helper to get active Stripe client dynamically from DB or fallback to .env
async function getStripeClient() {
  try {
    const { data, error } = await supabase
      .from('stripe_settings')
      .select('*')
      .eq('is_active', true)
      .limit(1)
      .maybeSingle();

    if (!error && data && data.secret_key) {
      return {
        stripe: new Stripe(data.secret_key),
        accountName: data.account_name,
        secretKey: data.secret_key
      };
    }
  } catch (err) {
    console.log('Stripe DB query fallback to env:', err.message);
  }

  // Fallback to .env variable
  return {
    stripe: new Stripe(process.env.STRIPE_SECRET_KEY),
    accountName: 'Default (.env)',
    secretKey: process.env.STRIPE_SECRET_KEY
  };
}

// 1. Get all Stripe account settings
router.get('/stripe-settings', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('stripe_settings')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. Add new Stripe account setting
router.post('/stripe-settings', async (req, res) => {
  try {
    const { account_name, publishable_key, secret_key, is_active } = req.body;
    if (!account_name || !secret_key) {
      return res.status(400).json({ error: 'Account Name and Secret Key are required.' });
    }

    if (is_active) {
      // Deactivate all others first
      await supabase
        .from('stripe_settings')
        .update({ is_active: false })
        .neq('id', '00000000-0000-0000-0000-000000000000');
    }

    const { data, error } = await supabase
      .from('stripe_settings')
      .insert([{
        account_name,
        publishable_key: publishable_key || '',
        secret_key,
        is_active: Boolean(is_active)
      }])
      .select();

    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3. Activate a Stripe account
router.put('/stripe-settings/:id/activate', async (req, res) => {
  try {
    const { id } = req.params;

    // Deactivate all accounts
    await supabase
      .from('stripe_settings')
      .update({ is_active: false })
      .neq('id', '00000000-0000-0000-0000-000000000000');

    // Activate selected account
    const { data, error } = await supabase
      .from('stripe_settings')
      .update({ is_active: true })
      .eq('id', id)
      .select();

    if (error) throw error;
    res.json(data[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3b. Update a Stripe account configuration (name, keys, active state)
router.put('/stripe-settings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { account_name, publishable_key, secret_key, is_active } = req.body;

    if (is_active) {
      await supabase
        .from('stripe_settings')
        .update({ is_active: false })
        .neq('id', id);
    }

    const updateFields = {};
    if (account_name !== undefined) updateFields.account_name = account_name;
    if (publishable_key !== undefined) updateFields.publishable_key = publishable_key;
    if (secret_key !== undefined) updateFields.secret_key = secret_key;
    if (is_active !== undefined) updateFields.is_active = is_active;

    const { data, error } = await supabase
      .from('stripe_settings')
      .update(updateFields)
      .eq('id', id)
      .select();

    if (error) throw error;
    res.json(data[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 4. Delete a Stripe account setting
router.delete('/stripe-settings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase
      .from('stripe_settings')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ message: 'Stripe configuration deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 5. Create checkout session using active Stripe account
router.post('/create-checkout-session', async (req, res) => {
  try {
    const { items } = req.body;
    const { stripe } = await getStripeClient();

    const lineItems = items.map(item => {
      const rawPrice = String(item.price || '0.50').replace(/[^0-9.]/g, '');
      let numericPrice = parseFloat(rawPrice) || 0.50;
      let unitAmount = Math.round(numericPrice * 100);
      if (unitAmount < 50) unitAmount = 50; // Stripe minimum amount is 50 cents ($0.50 USD)

      return {
        price_data: {
          currency: 'usd',
          product_data: {
            name: item.title,
            images: item.cover_url ? [item.cover_url] : [],
            tax_code: 'txcd_10202000', // Digital Books / E-books product tax code
          },
          unit_amount: unitAmount,
        },
        quantity: item.quantity,
      };
    });

    const bookIds = items.map(item => item.id).join(',');
    let origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null);
    const rawFrontendUrl = process.env.FRONTEND_URL || origin || 'https://bookpatr.vercel.app';
    const frontendUrl = rawFrontendUrl.replace(/\/$/, '');

    const sessionParams = {
      line_items: lineItems,
      mode: 'payment',
      success_url: `${frontendUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendUrl}/cart`,
      metadata: {
        book_ids: bookIds
      }
    };

    let session;
    try {
      session = await stripe.checkout.sessions.create(sessionParams);
    } catch (err) {
      if (err.message && (err.message.includes('managed_payments') || err.message.includes('tax code'))) {
        session = await stripe.checkout.sessions.create({
          ...sessionParams,
          managed_payments: { enabled: false }
        });
      } else {
        throw err;
      }
    }

    res.json({ id: session.id, url: session.url });
  } catch (error) {
    console.error('Stripe checkout error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 6. Retrieve session details
router.get('/session/:id', async (req, res) => {
  try {
    const { stripe } = await getStripeClient();
    const session = await stripe.checkout.sessions.retrieve(req.params.id);
    if (session.payment_status !== 'paid') {
      return res.status(400).json({ error: 'Payment not completed' });
    }

    const bookIds = session.metadata.book_ids.split(',');

    const { data: books, error } = await supabase
      .from('books')
      .select('id, title, file_url, cover_url')
      .in('id', bookIds);

    if (error) throw error;

    res.json({ books });
  } catch (error) {
    console.error('Error retrieving session:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
