const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const supabase = require('../supabase');
const { purgeExpiredPendingOrders, generateOrderCode } = require('./orders');

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
    const { items, site_id, site, customer_email, email, customer_name, first_name, last_name } = req.body;
    const targetSite = site_id || site;
    const { stripe, accountName, siteId: resolvedSiteId } = await getStripeClient(targetSite);

    console.log(`[Stripe Checkout] Creating payment link for site: "${targetSite}" -> Using Stripe Gateway: "${accountName}" (Site ID: "${resolvedSiteId}")`);

    if (!items || !items.length) {
      return res.status(400).json({ error: 'No items provided' });
    }

    // Auto-run background purge for expired pending orders older than 2 days
    purgeExpiredPendingOrders().catch(() => {});

    // Prepare Customer Info & Pending Order
    const targetEmail = (customer_email || email || '').trim();
    let fullName = customer_name ? customer_name.trim() : '';
    if (!fullName && (first_name || last_name)) {
      fullName = `${first_name || ''} ${last_name || ''}`.trim();
    }
    if (!fullName && targetEmail) fullName = targetEmail.split('@')[0];

    const orderCode = generateOrderCode();
    let totalOrderAmount = 0;
    items.forEach(item => {
      const rawPrice = String(item.price || '0.50').replace(/[^0-9.]/g, '');
      const p = parseFloat(rawPrice) || 0.50;
      const q = parseInt(item.quantity, 10) || 1;
      totalOrderAmount += p * q;
    });

    let createdOrder = null;
    try {
      if (targetEmail) {
        const { data: ordData } = await supabase
          .from('orders')
          .insert([{
            order_code: orderCode,
            site_id: (targetSite || 'bookpatr').toLowerCase().trim(),
            customer_name: fullName || 'Valued Customer',
            customer_email: targetEmail,
            items: items,
            total_amount: parseFloat(totalOrderAmount.toFixed(2)),
            currency: 'USD',
            payment_method: 'stripe',
            status: 'pending',
            expires_at: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
          }])
          .select();
        createdOrder = ordData?.[0] || null;
      }
    } catch (ordErr) {
      console.warn('[Checkout Order Log Notice]:', ordErr.message);
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
          tax_code: 'txcd_10202000', // Digital Books / E-books tax code for Stripe Managed Payments
        };
        if (isValidUrl(item.cover_url)) {
          productData.images = [item.cover_url];
        }

        let priceObj;
        try {
          priceObj = await stripe.prices.create({
            currency: 'usd',
            unit_amount: unitAmount,
            product_data: productData,
          });
        } catch (priceErr) {
          // If tax_code is not supported on some account types, retry without it
          console.warn('Price create with tax_code failed, retrying without tax_code:', priceErr.message);
          priceObj = await stripe.prices.create({
            currency: 'usd',
            unit_amount: unitAmount,
            product_data: {
              name: item.title || 'Digital E-Book',
              ...(isValidUrl(item.cover_url) ? { images: [item.cover_url] } : {})
            },
          });
        }

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
            url: `${frontendUrl}/success?session_id={CHECKOUT_SESSION_ID}&order_code=${orderCode}`,
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
          order_code: orderCode,
          order_id: createdOrder?.id || orderCode
        },
      };

      const paymentLink = await stripe.paymentLinks.create(paymentLinkParams);
      returnId = paymentLink.id;
      returnUrl = paymentLink.url; // URL dạng https://buy.stripe.com/...
      console.log(`[Stripe Payment Link] Created successfully: ${paymentLink.url}`);
    } catch (plinkErr) {
      console.warn('[Stripe Payment Link] Creation failed, falling back to Checkout Session:', plinkErr.message);

      // --- STRATEGY 2: Fallback to Checkout Sessions API (Enhanced with anti-fraud & managed payments) ---
      const sessionLineItems = items.map(item => {
        const rawPrice = String(item.price || '0.50').replace(/[^0-9.]/g, '');
        let numericPrice = parseFloat(rawPrice) || 0.50;
        let unitAmount = Math.round(numericPrice * 100);
        if (unitAmount < 50) unitAmount = 50;

        const productData = {
          name: item.title || 'Digital E-Book',
          tax_code: 'txcd_10202000',
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
        success_url: `${frontendUrl}/success?session_id={CHECKOUT_SESSION_ID}&order_code=${orderCode}`,
        cancel_url: `${frontendUrl}/cart`,
        metadata: {
          book_ids: bookIds,
          site_id: targetSite || 'all',
          account_name: accountName,
          order_code: orderCode,
          order_id: createdOrder?.id || orderCode
        },
      };

      if (targetEmail) {
        sessionParams.customer_email = targetEmail;
      }

      let session;
      try {
        session = await stripe.checkout.sessions.create(sessionParams);
      } catch (sessErr) {
        console.warn('Standard session creation failed, retrying with managed_payments disabled:', sessErr.message);
        try {
          session = await stripe.checkout.sessions.create({
            ...sessionParams,
            managed_payments: { enabled: false }
          });
        } catch (retryErr) {
          throw sessErr;
        }
      }

      returnId = session.id;
      returnUrl = session.url;
    }

    res.json({ 
      id: returnId, 
      url: returnUrl,
      orderCode: orderCode,
      orderId: createdOrder?.id || orderCode
    });
  } catch (error) {
    console.error('Stripe checkout error:', error);
    res.status(500).json({ 
      error: error.message || 'The payment gateway is temporarily initializing. Please try again in a few moments.',
      details: error.message 
    });
  }
});

// Helper to parse and extract site_id and clean display name from a paypal setting
function parsePayPalSetting(r) {
  if (!r) return null;
  let site_id = r.site_id;
  let cleanName = r.account_name || '';

  // Extract [site_id] prefix from account_name if present
  const match = r.account_name && r.account_name.match(/^\[([a-zA-Z0-9_\-]+)\]\s*(.*)$/);
  if (match) {
    site_id = match[1];
    cleanName = match[2] || r.account_name;
  } else if (!site_id) {
    site_id = 'bookpatr';
  }

  return {
    ...r,
    site_id: (site_id || 'bookpatr').toLowerCase().trim(),
    account_name: cleanName,
    raw_account_name: r.account_name,
    mode: (r.mode || 'live').toLowerCase().trim(),
  };
}

// Helper to get active PayPal credentials dynamically from DB per site or fallback to global / .env
async function getPayPalCredentials(siteId) {
  const targetSite = siteId && siteId !== 'all' ? siteId.toLowerCase().trim() : null;

  try {
    const { data: allSettings, error } = await supabase
      .from('paypal_settings')
      .select('*')
      .order('created_at', { ascending: false });

    if (!error && allSettings && allSettings.length > 0) {
      const parsedSettings = allSettings.map(parsePayPalSetting);
      const activeSettings = parsedSettings.filter(s => s.is_active && s.client_id && s.client_secret);

      // 1. Try to find active PayPal account configured specifically for this site
      if (targetSite) {
        const siteSetting = activeSettings.find(s => s.site_id === targetSite);
        if (siteSetting) {
          return {
            clientId: siteSetting.client_id,
            clientSecret: siteSetting.client_secret,
            mode: siteSetting.mode || 'live',
            accountName: siteSetting.account_name,
            siteId: targetSite
          };
        }
      }

      // 2. Fallback to active global PayPal account (site_id = 'all')
      const globalSetting = activeSettings.find(s => s.site_id === 'all');
      if (globalSetting) {
        return {
          clientId: globalSetting.client_id,
          clientSecret: globalSetting.client_secret,
          mode: globalSetting.mode || 'live',
          accountName: globalSetting.account_name,
          siteId: 'all'
        };
      }
    }
  } catch (err) {
    console.log('PayPal DB query fallback to env:', err.message);
  }

  // 3. Fallback to .env variables
  return {
    clientId: process.env.PAYPAL_CLIENT_ID || '',
    clientSecret: process.env.PAYPAL_CLIENT_SECRET || '',
    mode: (process.env.PAYPAL_MODE || 'live').toLowerCase().trim(),
    accountName: 'Default (.env)',
    siteId: 'env'
  };
}

// Helper to get PayPal OAuth2 Access Token with smart auto-detection (Sandbox / Live)
async function getPayPalAccessToken(clientId, clientSecret, mode) {
  if (!clientId || !clientSecret) {
    throw new Error('PayPal Client ID and Client Secret are required.');
  }

  const primaryMode = (mode || 'live').toLowerCase().trim();
  const primaryBaseUrl = primaryMode === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
  const authHeader = Buffer.from(`${clientId.trim()}:${clientSecret.trim()}`).toString('base64');

  // 1. Try primary configured mode
  try {
    const response = await fetch(`${primaryBaseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${authHeader}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    });

    const data = await response.json();
    if (response.ok && data.access_token) {
      return {
        accessToken: data.access_token,
        baseUrl: primaryBaseUrl,
        resolvedMode: primaryMode
      };
    }

    console.warn(`[PayPal Auth] Primary mode (${primaryMode}) failed:`, data.error_description || data.message || data.error);
  } catch (err) {
    console.warn(`[PayPal Auth] Network error on primary mode (${primaryMode}):`, err.message);
  }

  // 2. Auto-fallback to alternate mode (e.g. if user entered Sandbox keys under Live mode or vice versa)
  const altMode = primaryMode === 'sandbox' ? 'live' : 'sandbox';
  const altBaseUrl = altMode === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';

  console.log(`[PayPal Auth] Attempting auto-detection with alternate mode: ${altMode}...`);

  const altResponse = await fetch(`${altBaseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${authHeader}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });

  const altData = await altResponse.json();
  if (altResponse.ok && altData.access_token) {
    console.log(`[PayPal Auth] Auto-detection SUCCESS: Keys belong to ${altMode.toUpperCase()} environment.`);
    return {
      accessToken: altData.access_token,
      baseUrl: altBaseUrl,
      resolvedMode: altMode
    };
  }

  throw new Error(altData.error_description || altData.message || 'Client Authentication failed. Please check your PayPal Client ID and Client Secret.');
}

// ==========================================
// PAYPAL SETTINGS CRUD ENDPOINTS
// ==========================================

// 1. Get all PayPal account settings (optionally filtered by ?site=...)
router.get('/paypal-settings', async (req, res) => {
  try {
    const { site, site_id } = req.query;
    const targetSite = (site || site_id)?.toLowerCase().trim();

    const { data, error } = await supabase
      .from('paypal_settings')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    let settings = (data || []).map(parsePayPalSetting);

    if (targetSite && targetSite !== 'all') {
      settings = settings.filter(s => s.site_id === 'all' || s.site_id === targetSite);
    }

    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. Add new PayPal account setting for a specific site
router.post('/paypal-settings', async (req, res) => {
  try {
    const { account_name, client_id, client_secret, mode, is_active, site_id, site } = req.body;
    const targetSite = (site_id || site || 'all').toLowerCase().trim();

    if (!account_name || !client_id || !client_secret) {
      return res.status(400).json({ error: 'Account Name, Client ID, and Client Secret are required.' });
    }

    const cleanName = account_name.replace(/^\[[a-zA-Z0-9_\-]+\]\s*/, '').trim();
    const formattedAccountName = `[${targetSite}] ${cleanName}`;

    // If activating this account, deactivate OTHER accounts belonging to this specific site only!
    if (is_active) {
      const { data: allData } = await supabase.from('paypal_settings').select('*');
      if (allData) {
        const toDeactivate = allData
          .map(parsePayPalSetting)
          .filter(s => s.site_id === targetSite && s.is_active)
          .map(s => s.id);
        if (toDeactivate.length > 0) {
          await supabase.from('paypal_settings').update({ is_active: false }).in('id', toDeactivate);
        }
      }
    }

    const insertPayload = {
      account_name: formattedAccountName,
      client_id: client_id.trim(),
      client_secret: client_secret.trim(),
      mode: (mode || 'live').toLowerCase().trim(),
      is_active: Boolean(is_active)
    };

    let insertedSetting = null;
    try {
      const { data, error } = await supabase
        .from('paypal_settings')
        .insert([{ ...insertPayload, site_id: targetSite }])
        .select();
      if (error) throw error;
      insertedSetting = data;
    } catch {
      const { data, error } = await supabase
        .from('paypal_settings')
        .insert([insertPayload])
        .select();
      if (error) throw error;
      insertedSetting = data;
    }

    res.status(201).json(parsePayPalSetting(insertedSetting[0]));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3. Activate a PayPal account for its specific site
router.put('/paypal-settings/:id/activate', async (req, res) => {
  try {
    const { id } = req.params;
    const { site_id, site } = req.body || {};

    const { data: targetRecord, error: findErr } = await supabase
      .from('paypal_settings')
      .select('*')
      .eq('id', id)
      .single();

    if (findErr || !targetRecord) {
      return res.status(404).json({ error: 'PayPal configuration not found' });
    }

    const parsed = parsePayPalSetting(targetRecord);
    const targetSite = (site_id || site || parsed.site_id || 'all').toLowerCase().trim();

    // Deactivate other accounts belonging to this site only
    const { data: allData } = await supabase.from('paypal_settings').select('*');
    if (allData) {
      const toDeactivate = allData
        .map(parsePayPalSetting)
        .filter(s => s.id !== id && s.site_id === targetSite && s.is_active)
        .map(s => s.id);
      if (toDeactivate.length > 0) {
        await supabase.from('paypal_settings').update({ is_active: false }).in('id', toDeactivate);
      }
    }

    // Activate selected account
    const { data, error } = await supabase
      .from('paypal_settings')
      .update({ is_active: true })
      .eq('id', id)
      .select();

    if (error) throw error;
    res.json(parsePayPalSetting(data[0]));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 4. Update a PayPal account configuration
router.put('/paypal-settings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { account_name, client_id, client_secret, mode, is_active, site_id, site } = req.body;

    const { data: currentRecord } = await supabase.from('paypal_settings').select('*').eq('id', id).single();
    const currentParsed = parsePayPalSetting(currentRecord);

    const targetSite = (site_id || site || currentParsed?.site_id || 'all').toLowerCase().trim();
    const cleanName = (account_name !== undefined ? account_name : currentParsed?.account_name || '')
      .replace(/^\[[a-zA-Z0-9_\-]+\]\s*/, '').trim();
    const formattedAccountName = `[${targetSite}] ${cleanName}`;

    const updateFields = {
      account_name: formattedAccountName
    };
    if (client_id !== undefined) updateFields.client_id = client_id.trim();
    if (client_secret !== undefined) updateFields.client_secret = client_secret.trim();
    if (mode !== undefined) updateFields.mode = mode.toLowerCase().trim();
    if (is_active !== undefined) updateFields.is_active = is_active;

    if (is_active) {
      const { data: allData } = await supabase.from('paypal_settings').select('*');
      if (allData) {
        const toDeactivate = allData
          .map(parsePayPalSetting)
          .filter(s => s.id !== id && s.site_id === targetSite && s.is_active)
          .map(s => s.id);
        if (toDeactivate.length > 0) {
          await supabase.from('paypal_settings').update({ is_active: false }).in('id', toDeactivate);
        }
      }
    }

    let updatedData = null;
    try {
      const { data, error } = await supabase
        .from('paypal_settings')
        .update({ ...updateFields, site_id: targetSite })
        .eq('id', id)
        .select();
      if (error) throw error;
      updatedData = data;
    } catch {
      const { data, error } = await supabase
        .from('paypal_settings')
        .update(updateFields)
        .eq('id', id)
        .select();
      if (error) throw error;
      updatedData = data;
    }

    res.json(parsePayPalSetting(updatedData[0]));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 5. Delete a PayPal account setting
router.delete('/paypal-settings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase
      .from('paypal_settings')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ message: 'PayPal configuration deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// PAYPAL CHECKOUT FLOW ENDPOINTS
// ==========================================

// 6. Create PayPal Order
router.post('/paypal/create-order', async (req, res) => {
  try {
    const { items, site_id, site, customer_email, email, customer_name, first_name, last_name } = req.body;
    const targetSite = site_id || site;
    const { clientId, clientSecret, mode, accountName, siteId: resolvedSiteId } = await getPayPalCredentials(targetSite);

    console.log(`[PayPal Checkout] Creating order for site: "${targetSite}" -> Using PayPal Gateway: "${accountName}" (Mode: ${mode}, Site ID: "${resolvedSiteId}")`);

    if (!items || !items.length) {
      return res.status(400).json({ error: 'No items provided' });
    }

    // Auto-run background purge for expired pending orders older than 2 days
    purgeExpiredPendingOrders().catch(() => {});

    // Prepare Customer Info & Pending Order
    const targetEmail = (customer_email || email || '').trim();
    let fullName = customer_name ? customer_name.trim() : '';
    if (!fullName && (first_name || last_name)) {
      fullName = `${first_name || ''} ${last_name || ''}`.trim();
    }
    if (!fullName && targetEmail) fullName = targetEmail.split('@')[0];

    const orderCode = generateOrderCode();

    const { accessToken, baseUrl } = await getPayPalAccessToken(clientId, clientSecret, mode);

    const bookIds = items.map(item => item.id).join(',');
    let origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null);
    const rawFrontendUrl = process.env.FRONTEND_URL || origin || 'https://bookpatr.vercel.app';
    const frontendUrl = rawFrontendUrl.replace(/\/$/, '');

    // Calculate itemized pricing
    let totalAmount = 0;
    const lineItems = items.map(item => {
      const rawPrice = String(item.price || '0.50').replace(/[^0-9.]/g, '');
      let numericPrice = parseFloat(rawPrice) || 0.50;
      if (numericPrice < 0.50) numericPrice = 0.50;
      const qty = parseInt(item.quantity, 10) || 1;
      totalAmount += numericPrice * qty;

      return {
        name: (item.title || 'Digital E-Book').substring(0, 127),
        unit_amount: {
          currency_code: 'USD',
          value: numericPrice.toFixed(2),
        },
        quantity: String(qty),
        category: 'DIGITAL_GOODS'
      };
    });

    const totalValueStr = totalAmount.toFixed(2);

    let createdOrder = null;
    try {
      if (targetEmail) {
        const { data: ordData } = await supabase
          .from('orders')
          .insert([{
            order_code: orderCode,
            site_id: (targetSite || 'bookpatr').toLowerCase().trim(),
            customer_name: fullName || 'Valued Customer',
            customer_email: targetEmail,
            items: items,
            total_amount: parseFloat(totalAmount.toFixed(2)),
            currency: 'USD',
            payment_method: 'paypal',
            status: 'pending',
            expires_at: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
          }])
          .select();
        createdOrder = ordData?.[0] || null;
      }
    } catch (ordErr) {
      console.warn('[Checkout PayPal Order Log Notice]:', ordErr.message);
    }

    const orderPayload = {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: (targetSite || 'bookpatr').substring(0, 250),
          description: `Digital E-Book Purchase (${items.length} items)`,
          custom_id: `${orderCode}:${bookIds}`,
          amount: {
            currency_code: 'USD',
            value: totalValueStr,
            breakdown: {
              item_total: {
                currency_code: 'USD',
                value: totalValueStr
              }
            }
          },
          items: lineItems
        }
      ],
      application_context: {
        brand_name: targetSite ? targetSite.toUpperCase() : 'E-Book Store',
        landing_page: 'BILLING',
        shipping_preference: 'NO_SHIPPING',
        user_action: 'PAY_NOW',
        return_url: `${frontendUrl}/success?provider=paypal&site_id=${targetSite || 'all'}&order_code=${orderCode}`,
        cancel_url: `${frontendUrl}/cart`
      }
    };

    if (targetEmail) {
      orderPayload.payer = {
        email_address: targetEmail
      };
      if (first_name || last_name) {
        orderPayload.payer.name = {
          given_name: first_name || fullName,
          surname: last_name || ''
        };
      }
    }

    const orderResponse = await fetch(`${baseUrl}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(orderPayload)
    });

    const orderData = await orderResponse.json();

    if (!orderResponse.ok) {
      console.error('[PayPal Order Create Error]:', orderData);
      throw new Error(orderData.message || (orderData.details && orderData.details[0]?.description) || 'Failed to create PayPal order');
    }

    const approveLink = (orderData.links || []).find(l => l.rel === 'approve' || l.rel === 'payer-action');

    res.json({
      id: orderData.id,
      orderId: orderData.id,
      url: approveLink ? approveLink.href : null,
      approvalUrl: approveLink ? approveLink.href : null,
      orderCode: orderCode,
      dbOrderId: createdOrder?.id || orderCode,
      status: orderData.status
    });
  } catch (error) {
    console.error('PayPal create order error:', error);
    res.status(500).json({
      error: 'The PayPal payment gateway is temporarily initializing. Please try again in a few moments.',
      details: error.message
    });
  }
});

// 7. Capture PayPal Order upon customer return
router.post('/paypal/capture-order', async (req, res) => {
  try {
    const { orderId, order_id, token, site, site_id } = req.body;
    const targetOrderId = orderId || order_id || token;
    const targetSite = site || site_id;

    if (!targetOrderId) {
      return res.status(400).json({ error: 'Order ID / Token is required to capture PayPal payment' });
    }

    const { clientId, clientSecret, mode } = await getPayPalCredentials(targetSite);
    const { accessToken, baseUrl } = await getPayPalAccessToken(clientId, clientSecret, mode);

    // 1. Capture order on PayPal
    let captureResponse = await fetch(`${baseUrl}/v2/checkout/orders/${targetOrderId}/capture`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      }
    });

    let captureData = await captureResponse.json();

    // If order was already captured or is completed, fetch order details directly
    if (!captureResponse.ok) {
      const isAlreadyCaptured = captureData.details && captureData.details.some(d => d.issue === 'ORDER_ALREADY_CAPTURED');
      if (isAlreadyCaptured || captureResponse.status === 422) {
        const getOrderRes = await fetch(`${baseUrl}/v2/checkout/orders/${targetOrderId}`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        });
        if (getOrderRes.ok) {
          captureData = await getOrderRes.json();
        }
      } else {
        console.error('[PayPal Capture Error]:', captureData);
        throw new Error(captureData.message || (captureData.details && captureData.details[0]?.description) || 'Failed to capture PayPal payment');
      }
    }

    const isPaid = captureData.status === 'COMPLETED' || captureData.status === 'APPROVED';
    if (!isPaid) {
      return res.status(400).json({ error: `Payment not completed (Status: ${captureData.status})`, order: captureData });
    }

    // Extract book IDs from purchase units custom_id
    const unit = captureData.purchase_units && captureData.purchase_units[0];
    const customId = unit?.custom_id || (unit?.payments?.captures && unit.payments.captures[0]?.custom_id);
    const bookIds = customId ? customId.split(',') : [];

    let books = [];
    if (bookIds.length > 0) {
      const { data: foundBooks, error: booksErr } = await supabase
        .from('books')
        .select('id, title, file_url, cover_url')
        .in('id', bookIds);

      if (!booksErr && foundBooks) {
        books = foundBooks;
      }
    }

    res.json({
      status: 'COMPLETED',
      orderId: targetOrderId,
      books,
      payer: captureData.payer || null
    });
  } catch (error) {
    console.error('PayPal capture error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 8. Retrieve session details (Unified for Stripe Checkout Sessions & PayPal Orders)
router.get('/session/:id', async (req, res) => {
  try {
    const { site, site_id, provider } = req.query;
    const targetSite = site || site_id;
    const orderOrSessionId = req.params.id;

    // --- CASE A: Explicit PayPal Provider or PayPal Order ID format ---
    if (provider === 'paypal' || (!orderOrSessionId.startsWith('cs_') && !orderOrSessionId.startsWith('plink_'))) {
      try {
        const { clientId, clientSecret, mode } = await getPayPalCredentials(targetSite);
        if (clientId && clientSecret) {
          const { accessToken, baseUrl } = await getPayPalAccessToken(clientId, clientSecret, mode);
          
          // First attempt capture if not yet captured
          let orderData = null;
          const captureRes = await fetch(`${baseUrl}/v2/checkout/orders/${orderOrSessionId}/capture`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
            }
          });

          if (captureRes.ok) {
            orderData = await captureRes.json();
          } else {
            const getRes = await fetch(`${baseUrl}/v2/checkout/orders/${orderOrSessionId}`, {
              method: 'GET',
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
              }
            });
            if (getRes.ok) {
              orderData = await getRes.json();
            }
          }

          if (orderData && (orderData.status === 'COMPLETED' || orderData.status === 'APPROVED')) {
            const unit = orderData.purchase_units && orderData.purchase_units[0];
            const customId = unit?.custom_id || (unit?.payments?.captures && unit.payments.captures[0]?.custom_id) || '';
            
            // Extract orderCode and bookIds if formatted as orderCode:bookId1,bookId2
            let orderCode = null;
            let bookIds = [];
            if (customId.includes(':')) {
              const parts = customId.split(':');
              orderCode = parts[0];
              bookIds = parts[1] ? parts[1].split(',') : [];
            } else {
              bookIds = customId ? customId.split(',') : [];
            }

            // Mark order as completed in database
            try {
              if (orderCode) {
                await supabase.from('orders').update({
                  status: 'completed',
                  payment_id: orderOrSessionId,
                  updated_at: new Date().toISOString()
                }).eq('order_code', orderCode);
              } else {
                await supabase.from('orders').update({
                  status: 'completed',
                  payment_id: orderOrSessionId,
                  updated_at: new Date().toISOString()
                }).eq('payment_id', orderOrSessionId);
              }
            } catch (ordUpdateErr) {
              console.warn('[Order Complete Notice]:', ordUpdateErr.message);
            }

            const { data: books, error } = await supabase
              .from('books')
              .select('id, title, file_url, cover_url')
              .in('id', bookIds);

            if (!error && books) {
              return res.json({ books, provider: 'paypal', order: orderData, orderCode });
            }
          }
        }
      } catch (paypalErr) {
        console.warn('PayPal lookup in /session/:id had issue, falling back to Stripe lookup:', paypalErr.message);
      }
    }

    // --- CASE B: Stripe Session Lookup ---
    const { stripe } = await getStripeClient(targetSite);
    let session = null;

    // 1. Try retrieving with targeted Stripe client
    try {
      session = await stripe.checkout.sessions.retrieve(orderOrSessionId);
    } catch (sessionErr) {
      console.warn(`Could not retrieve session with primary client (${sessionErr.message}), searching other active Stripe accounts...`);
      
      // 2. Fallback: Search all active Stripe accounts in database
      const { data: allSettings } = await supabase.from('stripe_settings').select('*');
      if (allSettings && allSettings.length > 0) {
        for (const setting of allSettings) {
          if (setting.secret_key && setting.is_active) {
            try {
              const tempStripe = new Stripe(setting.secret_key);
              const foundSession = await tempStripe.checkout.sessions.retrieve(orderOrSessionId);
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
    const orderCode = session.metadata?.order_code || null;
    const orderId = session.metadata?.order_id || null;

    // Mark order as completed in database
    try {
      if (orderCode) {
        await supabase.from('orders').update({
          status: 'completed',
          payment_id: session.id,
          updated_at: new Date().toISOString()
        }).eq('order_code', orderCode);
      } else if (orderId) {
        await supabase.from('orders').update({
          status: 'completed',
          payment_id: session.id,
          updated_at: new Date().toISOString()
        }).eq('id', orderId);
      }
    } catch (ordUpdateErr) {
      console.warn('[Stripe Order Complete Notice]:', ordUpdateErr.message);
    }

    const { data: books, error } = await supabase
      .from('books')
      .select('id, title, file_url, cover_url')
      .in('id', bookIds);

    if (error) throw error;

    res.json({ books: books || [], provider: 'stripe', orderCode });
  } catch (error) {
    console.error('Error retrieving session:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
