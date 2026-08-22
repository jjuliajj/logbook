const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const supabase = require('../supabase');

// Helper to parse and extract site_id and clean display name from a stripe setting
function parseStripeSetting(r) {
  if (!r) return null;
  let site_id = r.site_id;
  let cleanName = r.account_name || '';

  // Extract [site_id] prefix from account_name if present
  const match = r.account_name && r.account_name.match(/^\[([a-zA-Z0-9_\-]+)\]\s*(.*)$/);
  if (match) {
    site_id = match[1];
    cleanName = match[2] || r.account_name;
  } else if (!site_id) {
    site_id = 'bookpatr'; // default legacy records to bookpatr
  }

  return {
    ...r,
    site_id: (site_id || 'bookpatr').toLowerCase().trim(),
    account_name: cleanName,
    raw_account_name: r.account_name,
  };
}

// Helper to get active Stripe client dynamically from DB per site or fallback to global / .env
async function getStripeClient(siteId) {
  const targetSite = siteId && siteId !== 'all' ? siteId.toLowerCase().trim() : null;

  try {
    const { data: allSettings, error } = await supabase
      .from('stripe_settings')
      .select('*')
      .order('created_at', { ascending: false });

    if (!error && allSettings && allSettings.length > 0) {
      const parsedSettings = allSettings.map(parseStripeSetting);
      const activeSettings = parsedSettings.filter(s => s.is_active && s.secret_key);

      // 1. Try to find active Stripe account configured specifically for this site
      if (targetSite) {
        const siteSetting = activeSettings.find(s => s.site_id === targetSite);
        if (siteSetting && siteSetting.secret_key) {
          return {
            stripe: new Stripe(siteSetting.secret_key),
            accountName: siteSetting.account_name,
            secretKey: siteSetting.secret_key,
            siteId: targetSite
          };
        }
      }

      // 2. Fallback to active global Stripe account (site_id = 'all')
      const globalSetting = activeSettings.find(s => s.site_id === 'all');
      if (globalSetting && globalSetting.secret_key) {
        return {
          stripe: new Stripe(globalSetting.secret_key),
          accountName: globalSetting.account_name,
          secretKey: globalSetting.secret_key,
          siteId: 'all'
        };
      }
    }
  } catch (err) {
    console.log('Stripe DB query fallback to env:', err.message);
  }

  // 3. Fallback to .env variable
  return {
    stripe: new Stripe(process.env.STRIPE_SECRET_KEY || ''),
    accountName: 'Default (.env)',
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    siteId: 'env'
  };
}

// 1. Get all Stripe account settings (optionally filtered by ?site=...)
router.get('/stripe-settings', async (req, res) => {
  try {
    const { site, site_id } = req.query;
    const targetSite = (site || site_id)?.toLowerCase().trim();

    const { data, error } = await supabase
      .from('stripe_settings')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    let settings = (data || []).map(parseStripeSetting);

    if (targetSite && targetSite !== 'all') {
      settings = settings.filter(s => s.site_id === 'all' || s.site_id === targetSite);
    }

    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. Add new Stripe account setting for a specific site
router.post('/stripe-settings', async (req, res) => {
  try {
    const { account_name, publishable_key, secret_key, is_active, site_id, site } = req.body;
    const targetSite = (site_id || site || 'all').toLowerCase().trim();

    if (!account_name || !secret_key) {
      return res.status(400).json({ error: 'Account Name and Secret Key are required.' });
    }

    const cleanName = account_name.replace(/^\[[a-zA-Z0-9_\-]+\]\s*/, '').trim();
    const formattedAccountName = `[${targetSite}] ${cleanName}`;

    // If activating this account, deactivate OTHER accounts belonging to this specific site only!
    if (is_active) {
      const { data: allData } = await supabase.from('stripe_settings').select('*');
      if (allData) {
        const toDeactivate = allData
          .map(parseStripeSetting)
          .filter(s => s.site_id === targetSite && s.is_active)
          .map(s => s.id);
        if (toDeactivate.length > 0) {
          await supabase.from('stripe_settings').update({ is_active: false }).in('id', toDeactivate);
        }
      }
    }

    const insertPayload = {
      account_name: formattedAccountName,
      publishable_key: publishable_key || '',
      secret_key,
      is_active: Boolean(is_active)
    };

    let insertedSetting = null;
    try {
      const { data, error } = await supabase
        .from('stripe_settings')
        .insert([{ ...insertPayload, site_id: targetSite }])
        .select();
      if (error) throw error;
      insertedSetting = data;
    } catch {
      const { data, error } = await supabase
        .from('stripe_settings')
        .insert([insertPayload])
        .select();
      if (error) throw error;
      insertedSetting = data;
    }

    res.status(201).json(parseStripeSetting(insertedSetting[0]));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3. Activate a Stripe account for its specific site
router.put('/stripe-settings/:id/activate', async (req, res) => {
  try {
    const { id } = req.params;
    const { site_id, site } = req.body || {};

    const { data: targetRecord, error: findErr } = await supabase
      .from('stripe_settings')
      .select('*')
      .eq('id', id)
      .single();

    if (findErr || !targetRecord) {
      return res.status(404).json({ error: 'Stripe configuration not found' });
    }

    const parsed = parseStripeSetting(targetRecord);
    const targetSite = (site_id || site || parsed.site_id || 'all').toLowerCase().trim();

    // Deactivate other accounts belonging to this site only
    const { data: allData } = await supabase.from('stripe_settings').select('*');
    if (allData) {
      const toDeactivate = allData
        .map(parseStripeSetting)
        .filter(s => s.id !== id && s.site_id === targetSite && s.is_active)
        .map(s => s.id);
      if (toDeactivate.length > 0) {
        await supabase.from('stripe_settings').update({ is_active: false }).in('id', toDeactivate);
      }
    }

    // Activate selected account
    const { data, error } = await supabase
      .from('stripe_settings')
      .update({ is_active: true })
      .eq('id', id)
      .select();

    if (error) throw error;
    res.json(parseStripeSetting(data[0]));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3b. Update a Stripe account configuration
router.put('/stripe-settings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { account_name, publishable_key, secret_key, is_active, site_id, site } = req.body;

    const { data: currentRecord } = await supabase.from('stripe_settings').select('*').eq('id', id).single();
    const currentParsed = parseStripeSetting(currentRecord);

    const targetSite = (site_id || site || currentParsed?.site_id || 'all').toLowerCase().trim();
    const cleanName = (account_name !== undefined ? account_name : currentParsed?.account_name || '')
      .replace(/^\[[a-zA-Z0-9_\-]+\]\s*/, '').trim();
    const formattedAccountName = `[${targetSite}] ${cleanName}`;

    const updateFields = {
      account_name: formattedAccountName
    };
    if (publishable_key !== undefined) updateFields.publishable_key = publishable_key;
    if (secret_key !== undefined) updateFields.secret_key = secret_key;
    if (is_active !== undefined) updateFields.is_active = is_active;

    if (is_active) {
      const { data: allData } = await supabase.from('stripe_settings').select('*');
      if (allData) {
        const toDeactivate = allData
          .map(parseStripeSetting)
          .filter(s => s.id !== id && s.site_id === targetSite && s.is_active)
          .map(s => s.id);
        if (toDeactivate.length > 0) {
          await supabase.from('stripe_settings').update({ is_active: false }).in('id', toDeactivate);
        }
      }
    }

    let updatedData = null;
    try {
      const { data, error } = await supabase
        .from('stripe_settings')
        .update({ ...updateFields, site_id: targetSite })
        .eq('id', id)
        .select();
      if (error) throw error;
      updatedData = data;
    } catch {
      const { data, error } = await supabase
        .from('stripe_settings')
        .update(updateFields)
        .eq('id', id)
        .select();
      if (error) throw error;
      updatedData = data;
    }

    res.json(parseStripeSetting(updatedData[0]));
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

// 5. Create checkout session / payment link using site-specific active Stripe account
router.post('/create-checkout-session', async (req, res) => {
  try {
    const { items, site_id, site, customer_email } = req.body;
    const targetSite = site_id || site;
    const { stripe, accountName, siteId: resolvedSiteId } = await getStripeClient(targetSite);

    console.log(`[Stripe Checkout] Creating payment link for site: "${targetSite}" -> Using Stripe Gateway: "${accountName}" (Site ID: "${resolvedSiteId}")`);

    if (!items || !items.length) {
      return res.status(400).json({ error: 'No items provided' });
    }

    const isValidUrl = (url) => {
      if (!url || typeof url !== 'string') return false;
      return url.startsWith('http://') || url.startsWith('https://');
    };

    const bookIds = items.map(item => item.id).join(',');
    let origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null);
    const rawFrontendUrl = process.env.FRONTEND_URL || origin || 'https://bookpatr.vercel.app';
    const frontendUrl = rawFrontendUrl.replace(/\/$/, '');

    let returnUrl = null;
    let returnId = null;

    // --- STRATEGY 1: Create Stripe Payment Link (Produces buy.stripe.com) ---
    try {
      const paymentLinkLineItems = [];

      for (const item of items) {
        const rawPrice = String(item.price || '0.50').replace(/[^0-9.]/g, '');
        let numericPrice = parseFloat(rawPrice) || 0.50;
        let unitAmount = Math.round(numericPrice * 100);
        if (unitAmount < 50) unitAmount = 50; // Stripe minimum amount is 50 cents ($0.50 USD)

        const productData = {
          name: item.title || 'Digital E-Book',
        };
        if (isValidUrl(item.cover_url)) {
          productData.images = [item.cover_url];
        }

        const priceObj = await stripe.prices.create({
          currency: 'usd',
          unit_amount: unitAmount,
          product_data: productData,
        });

        paymentLinkLineItems.push({
          price: priceObj.id,
          quantity: item.quantity || 1,
        });
      }

      const paymentLinkParams = {
        line_items: paymentLinkLineItems,
        after_completion: {
          type: 'redirect',
          redirect: {
            url: `${frontendUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
          },
        },
        billing_address_collection: 'required', // Bắt buộc nhập địa chỉ & ZIP để qua AVS của ngân hàng
        phone_number_collection: {
          enabled: true, // Thu thập SĐT giúp Stripe Radar xác thực danh tính
        },
        metadata: {
          book_ids: bookIds,
          site_id: targetSite || 'all',
          account_name: accountName,
        },
      };

      const paymentLink = await stripe.paymentLinks.create(paymentLinkParams);
      returnId = paymentLink.id;
      returnUrl = paymentLink.url; // URL dạng https://buy.stripe.com/...
      console.log(`[Stripe Payment Link] Created successfully: ${paymentLink.url}`);
    } catch (plinkErr) {
      console.warn('[Stripe Payment Link] Creation failed, falling back to Checkout Session:', plinkErr.message);

      // --- STRATEGY 2: Fallback to Checkout Sessions API (Enhanced with anti-fraud params) ---
      const sessionLineItems = items.map(item => {
        const rawPrice = String(item.price || '0.50').replace(/[^0-9.]/g, '');
        let numericPrice = parseFloat(rawPrice) || 0.50;
        let unitAmount = Math.round(numericPrice * 100);
        if (unitAmount < 50) unitAmount = 50;

        const productData = {
          name: item.title || 'Digital E-Book',
        };
        if (isValidUrl(item.cover_url)) {
          productData.images = [item.cover_url];
        }

        return {
          price_data: {
            currency: 'usd',
            product_data: productData,
            unit_amount: unitAmount,
          },
          quantity: item.quantity || 1,
        };
      });

      const sessionParams = {
        line_items: sessionLineItems,
        mode: 'payment',
        billing_address_collection: 'required',
        phone_number_collection: {
          enabled: true,
        },
        success_url: `${frontendUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${frontendUrl}/cart`,
        metadata: {
          book_ids: bookIds,
          site_id: targetSite || 'all',
          account_name: accountName,
        },
      };

      if (customer_email) {
        sessionParams.customer_email = customer_email;
      }

      const session = await stripe.checkout.sessions.create(sessionParams);
      returnId = session.id;
      returnUrl = session.url;
    }

    res.json({ id: returnId, url: returnUrl });
  } catch (error) {
    console.error('Stripe checkout error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 6. Retrieve session details
router.get('/session/:id', async (req, res) => {
  try {
    const { site, site_id } = req.query;
    const targetSite = site || site_id;
    const { stripe } = await getStripeClient(targetSite);

    let session = null;

    // 1. Try retrieving with targeted Stripe client
    try {
      session = await stripe.checkout.sessions.retrieve(req.params.id);
    } catch (sessionErr) {
      console.warn(`Could not retrieve session with primary client (${sessionErr.message}), searching other active Stripe accounts...`);
      
      // 2. Fallback: Search all active Stripe accounts in database
      const { data: allSettings } = await supabase.from('stripe_settings').select('*');
      if (allSettings && allSettings.length > 0) {
        for (const setting of allSettings) {
          if (setting.secret_key && setting.is_active) {
            try {
              const tempStripe = new Stripe(setting.secret_key);
              const foundSession = await tempStripe.checkout.sessions.retrieve(req.params.id);
              if (foundSession) {
                session = foundSession;
                break;
              }
            } catch (_) {}
          }
        }
      }
    }

    if (!session) {
      return res.status(404).json({ error: 'Checkout session not found' });
    }

    if (session.payment_status !== 'paid') {
      return res.status(400).json({ error: 'Payment not completed' });
    }

    const bookIds = session.metadata?.book_ids ? session.metadata.book_ids.split(',') : [];

    const { data: books, error } = await supabase
      .from('books')
      .select('id, title, file_url, cover_url')
      .in('id', bookIds);

    if (error) throw error;

    res.json({ books: books || [] });
  } catch (error) {
    console.error('Error retrieving session:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
