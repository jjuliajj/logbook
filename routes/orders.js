const express = require('express');
const router = express.Router();
const supabase = require('../supabase');

// Generate unique, readable order code (e.g. ORD-849201)
function generateOrderCode() {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let randomStr = '';
  for (let i = 0; i < 6; i++) {
    randomStr += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `ORD-${randomStr}`;
}

// Background auto-cleanup for pending orders older than 2 days (48 hours)
async function purgeExpiredPendingOrders() {
  try {
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const { error } = await supabase
      .from('orders')
      .delete()
      .eq('status', 'pending')
      .lt('created_at', twoDaysAgo);
    
    if (error) {
      console.warn('[Order Purge] Notice:', error.message);
    }
  } catch (err) {
    console.warn('[Order Purge] Error:', err.message);
  }
}

// 1. Get all orders (with filters by site, status, search)
router.get('/', async (req, res) => {
  try {
    // Run background cleanup asynchronously
    purgeExpiredPendingOrders().catch(() => {});

    const { site, site_id, status, search } = req.query;
    const targetSite = (site || site_id)?.toLowerCase().trim();

    let query = supabase
      .from('orders')
      .select('*')
      .order('created_at', { ascending: false });

    if (targetSite && targetSite !== 'all') {
      query = query.eq('site_id', targetSite);
    }

    if (status && status !== 'all') {
      query = query.eq('status', status.toLowerCase().trim());
    }

    const { data, error } = await query;
    if (error) {
      // If table doesn't exist yet, return empty list gracefully
      if (error.code === 'PGRST205' || error.message?.includes('does not exist')) {
        return res.json([]);
      }
      throw error;
    }

    let results = data || [];
    if (search && search.trim()) {
      const term = search.toLowerCase().trim();
      results = results.filter(order => 
        (order.order_code && order.order_code.toLowerCase().includes(term)) ||
        (order.customer_name && order.customer_name.toLowerCase().includes(term)) ||
        (order.customer_email && order.customer_email.toLowerCase().includes(term))
      );
    }

    res.json(results);
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ error: error.message });
  }
});

// 2. Get single order by ID or order_code
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Check by ID or order_code
    let { data, error } = await supabase
      .from('orders')
      .select('*')
      .or(`id.eq.${id},order_code.eq.${id}`)
      .single();

    if (error) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3. Create a new Order in 'pending' status
router.post('/', async (req, res) => {
  try {
    const { 
      site_id, 
      site, 
      customer_name, 
      first_name, 
      last_name, 
      customer_email, 
      email, 
      items, 
      total_amount, 
      currency, 
      payment_method, 
      payment_id 
    } = req.body;

    const targetEmail = (customer_email || email || '').trim();
    if (!targetEmail) {
      return res.status(400).json({ error: 'Customer email is required' });
    }

    let fullName = customer_name ? customer_name.trim() : '';
    if (!fullName && (first_name || last_name)) {
      fullName = `${first_name || ''} ${last_name || ''}`.trim();
    }
    if (!fullName) fullName = targetEmail.split('@')[0];

    const targetSite = (site_id || site || 'bookpatr').toLowerCase().trim();
    const orderCode = generateOrderCode();
    const cleanItems = Array.isArray(items) ? items : [];

    let calculatedTotal = 0;
    if (total_amount !== undefined && total_amount !== null) {
      calculatedTotal = parseFloat(String(total_amount).replace(/[^0-9.]/g, '')) || 0.00;
    } else {
      cleanItems.forEach(item => {
        const rawPrice = String(item.price || '0.50').replace(/[^0-9.]/g, '');
        const p = parseFloat(rawPrice) || 0.50;
        const q = parseInt(item.quantity, 10) || 1;
        calculatedTotal += p * q;
      });
    }

    const orderRecord = {
      order_code: orderCode,
      site_id: targetSite,
      customer_name: fullName,
      customer_email: targetEmail,
      items: cleanItems,
      total_amount: parseFloat(calculatedTotal.toFixed(2)),
      currency: (currency || 'USD').toUpperCase(),
      payment_method: (payment_method || 'stripe').toLowerCase(),
      status: 'pending',
      payment_id: payment_id || null,
      expires_at: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
    };

    const { data, error } = await supabase
      .from('orders')
      .insert([orderRecord])
      .select();

    if (error) {
      console.warn('[Create Order Notice]:', error.message);
      // Return order structure with code even if table is pending schema creation
      return res.status(201).json({
        id: `mock-${Date.now()}`,
        ...orderRecord,
        created_at: new Date().toISOString()
      });
    }

    res.status(201).json(data[0]);
  } catch (error) {
    console.error('Error creating order:', error);
    res.status(500).json({ error: error.message });
  }
});

// 4. Update order status
router.put('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, payment_id } = req.body;

    if (!status) {
      return res.status(400).json({ error: 'Status is required' });
    }

    const updateFields = {
      status: status.toLowerCase().trim(),
      updated_at: new Date().toISOString()
    };
    if (payment_id) {
      updateFields.payment_id = payment_id;
    }

    const { data, error } = await supabase
      .from('orders')
      .update(updateFields)
      .eq('id', id)
      .select();

    if (error) throw error;
    res.json(data[0] || { message: 'Order status updated' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 5. Complete order by payment session or order code
router.post('/complete', async (req, res) => {
  try {
    const { order_id, order_code, payment_id, session_id } = req.body;
    const targetPaymentId = payment_id || session_id;

    let query = supabase.from('orders').update({
      status: 'completed',
      payment_id: targetPaymentId,
      updated_at: new Date().toISOString()
    });

    if (order_id) {
      query = query.eq('id', order_id);
    } else if (order_code) {
      query = query.eq('order_code', order_code);
    } else if (targetPaymentId) {
      query = query.eq('payment_id', targetPaymentId);
    } else {
      return res.status(400).json({ error: 'Missing order identifier' });
    }

    const { data, error } = await query.select();
    if (error) throw error;

    res.json({ success: true, order: data?.[0] || null });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 6. Delete single order
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase
      .from('orders')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ message: 'Order deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 7. Manually purge all expired pending orders (older than 2 days)
router.post('/cleanup-expired', async (req, res) => {
  try {
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('orders')
      .delete()
      .eq('status', 'pending')
      .lt('created_at', twoDaysAgo)
      .select();

    if (error) throw error;
    res.json({ 
      success: true, 
      message: `Cleaned up expired pending orders`,
      deleted_count: data ? data.length : 0 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = {
  router,
  purgeExpiredPendingOrders,
  generateOrderCode
};
