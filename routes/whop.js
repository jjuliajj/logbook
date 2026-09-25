const express = require('express');
const router = express.Router();
const supabase = require('../supabase');

// In-memory fallback if Supabase tables haven't been created yet
let memoryUsers = [
  { id: 'whop-user-1', name: 'User 1', slug: 'user-1', description: 'Tài khoản Whop chính 1', color: '#FF6243', sort_order: 1, created_at: new Date().toISOString() },
  { id: 'whop-user-2', name: 'User 2', slug: 'user-2', description: 'Tài khoản Whop phụ 2', color: '#6366F1', sort_order: 2, created_at: new Date().toISOString() }
];

let memoryLinks = [
  {
    id: 'link-sample-1',
    user_id: 'whop-user-1',
    user_name: 'User 1',
    title: 'Gói Ebook VIP & Tài Liệu Độc Quyền',
    url: 'https://whop.com/checkout/plan_sample1',
    price: '$29.00',
    category: 'Ebook & Tài Liệu',
    description: 'Truy cập toàn bộ kho sách điện tử cao cấp',
    site_id: 'all',
    clicks_count: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  },
  {
    id: 'link-sample-2',
    user_id: 'whop-user-2',
    user_name: 'User 2',
    title: 'Membership Khóa Học Kinh Doanh & Marketing',
    url: 'https://whop.com/checkout/plan_sample2',
    price: '$49.00',
    category: 'Khóa Học VIP',
    description: 'Gói thành viên truy cập hàng tháng',
    site_id: 'all',
    clicks_count: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }
];

// =========================================================================
// WHOP USERS / ACCOUNTS ROUTES
// =========================================================================

// 1. Get all Whop Users
router.get('/users', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('whop_users')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });

    if (error) {
      // Table doesn't exist yet, return memory fallback
      if (error.code === 'PGRST205' || error.message?.includes('does not exist')) {
        return res.json(memoryUsers);
      }
      throw error;
    }

    if (!data || data.length === 0) {
      return res.json(memoryUsers);
    }

    res.json(data);
  } catch (err) {
    console.warn('[Whop Users GET] Warning:', err.message);
    res.json(memoryUsers);
  }
});

// 2. Create Whop User
router.post('/users', async (req, res) => {
  try {
    const { name, slug, description, color, sort_order } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Tên User Whop là bắt buộc' });
    }

    const newUser = {
      name: name.trim(),
      slug: slug || name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''),
      description: description || '',
      color: color || '#FF6243',
      sort_order: sort_order !== undefined ? Number(sort_order) : memoryUsers.length + 1,
    };

    try {
      const { data, error } = await supabase
        .from('whop_users')
        .insert([newUser])
        .select();

      if (!error && data && data.length > 0) {
        return res.status(201).json(data[0]);
      }
    } catch (dbErr) {
      console.warn('[Whop User POST DB] Warning:', dbErr.message);
    }

    // Memory fallback
    const memUser = {
      id: `whop-user-${Date.now()}`,
      ...newUser,
      created_at: new Date().toISOString()
    };
    memoryUsers.push(memUser);
    res.status(201).json(memUser);
  } catch (err) {
    console.error('[Whop User POST] Error:', err);
    res.status(500).json({ error: 'Không thể tạo User Whop' });
  }
});

// 3. Update Whop User
router.put('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, slug, description, color, sort_order } = req.body;

    const updates = {};
    if (name !== undefined) updates.name = name.trim();
    if (slug !== undefined) updates.slug = slug;
    if (description !== undefined) updates.description = description;
    if (color !== undefined) updates.color = color;
    if (sort_order !== undefined) updates.sort_order = Number(sort_order);

    try {
      const { data, error } = await supabase
        .from('whop_users')
        .update(updates)
        .eq('id', id)
        .select();

      if (!error && data && data.length > 0) {
        return res.json(data[0]);
      }
    } catch (dbErr) {
      console.warn('[Whop User PUT DB] Warning:', dbErr.message);
    }

    // Memory fallback
    const idx = memoryUsers.findIndex(u => u.id === id);
    if (idx !== -1) {
      memoryUsers[idx] = { ...memoryUsers[idx], ...updates };
      return res.json(memoryUsers[idx]);
    }

    res.json({ id, ...updates });
  } catch (err) {
    console.error('[Whop User PUT] Error:', err);
    res.status(500).json({ error: 'Không thể cập nhật User Whop' });
  }
});

// 4. Delete Whop User
router.delete('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;

    try {
      await supabase.from('whop_links').delete().eq('user_id', id);
      const { error } = await supabase.from('whop_users').delete().eq('id', id);
      if (!error) {
        return res.json({ message: 'User Whop đã được xóa thành công' });
      }
    } catch (dbErr) {
      console.warn('[Whop User DELETE DB] Warning:', dbErr.message);
    }

    memoryUsers = memoryUsers.filter(u => u.id !== id);
    memoryLinks = memoryLinks.filter(l => l.user_id !== id);
    res.json({ message: 'User Whop đã được xóa thành công' });
  } catch (err) {
    console.error('[Whop User DELETE] Error:', err);
    res.status(500).json({ error: 'Không thể xóa User Whop' });
  }
});

// =========================================================================
// WHOP LINKS ROUTES
// =========================================================================

// 5. Get all Whop Links
router.get('/links', async (req, res) => {
  try {
    const { user_id, site, site_id, search, category } = req.query;
    const targetSite = (site || site_id)?.toLowerCase().trim();

    try {
      let query = supabase
        .from('whop_links')
        .select('*')
        .order('created_at', { ascending: false });

      if (user_id && user_id !== 'all') {
        query = query.eq('user_id', user_id);
      }
      if (targetSite && targetSite !== 'all') {
        query = query.or(`site_id.eq.${targetSite},site_id.eq.all`);
      }
      if (category && category !== 'all') {
        query = query.eq('category', category);
      }

      const { data, error } = await query;
      if (!error && data) {
        let result = data;
        if (search && search.trim()) {
          const s = search.toLowerCase().trim();
          result = result.filter(l => 
            (l.title && l.title.toLowerCase().includes(s)) ||
            (l.url && l.url.toLowerCase().includes(s)) ||
            (l.category && l.category.toLowerCase().includes(s)) ||
            (l.description && l.description.toLowerCase().includes(s))
          );
        }
        return res.json(result);
      }
    } catch (dbErr) {
      console.warn('[Whop Links GET DB] Warning:', dbErr.message);
    }

    // Memory fallback
    let filtered = [...memoryLinks];
    if (user_id && user_id !== 'all') {
      filtered = filtered.filter(l => l.user_id === user_id);
    }
    if (targetSite && targetSite !== 'all') {
      filtered = filtered.filter(l => !l.site_id || l.site_id === 'all' || l.site_id === targetSite);
    }
    if (category && category !== 'all') {
      filtered = filtered.filter(l => l.category === category);
    }
    if (search && search.trim()) {
      const s = search.toLowerCase().trim();
      filtered = filtered.filter(l =>
        (l.title && l.title.toLowerCase().includes(s)) ||
        (l.url && l.url.toLowerCase().includes(s)) ||
        (l.category && l.category.toLowerCase().includes(s)) ||
        (l.description && l.description.toLowerCase().includes(s))
      );
    }

    res.json(filtered);
  } catch (err) {
    console.error('[Whop Links GET] Error:', err);
    res.json(memoryLinks);
  }
});

// 6. Create Whop Link
router.post('/links', async (req, res) => {
  try {
    const { user_id, user_name, title, url, price, category, description, image_url, site_name, site_id } = req.body;
    if (!url) {
      return res.status(400).json({ error: 'Đường link Whop là bắt buộc' });
    }

    // Format clean URL
    let formattedUrl = url.trim();
    if (!formattedUrl.startsWith('http://') && !formattedUrl.startsWith('https://')) {
      formattedUrl = `https://${formattedUrl}`;
    }

    const newLink = {
      user_id: user_id || (memoryUsers[0] ? memoryUsers[0].id : null),
      user_name: user_name || '',
      title: (title || '').trim() || formattedUrl.replace(/^https?:\/\//, '').replace(/\/$/, ''),
      url: formattedUrl,
      price: price ? price.trim() : '',
      category: category ? category.trim() : 'Khác',
      description: description ? description.trim() : '',
      image_url: image_url ? image_url.trim() : '',
      site_name: site_name ? site_name.trim() : 'Whop',
      site_id: site_id || 'all',
      clicks_count: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    try {
      const { data, error } = await supabase
        .from('whop_links')
        .insert([newLink])
        .select();

      if (!error && data && data.length > 0) {
        return res.status(201).json(data[0]);
      }
    } catch (dbErr) {
      console.warn('[Whop Link POST DB] Warning:', dbErr.message);
    }

    // Memory fallback
    const memLink = {
      id: `whop-link-${Date.now()}`,
      ...newLink
    };
    memoryLinks.unshift(memLink);
    res.status(201).json(memLink);
  } catch (err) {
    console.error('[Whop Link POST] Error:', err);
    res.status(500).json({ error: 'Không thể thêm Link Whop' });
  }
});

// 7. Update Whop Link
router.put('/links/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { user_id, user_name, title, url, price, category, description, image_url, site_name, site_id } = req.body;

    const updates = {
      updated_at: new Date().toISOString()
    };
    if (user_id !== undefined) updates.user_id = user_id;
    if (user_name !== undefined) updates.user_name = user_name;
    if (title !== undefined) updates.title = title.trim();
    if (url !== undefined) {
      let formattedUrl = url.trim();
      if (!formattedUrl.startsWith('http://') && !formattedUrl.startsWith('https://')) {
        formattedUrl = `https://${formattedUrl}`;
      }
      updates.url = formattedUrl;
    }
    if (price !== undefined) updates.price = price.trim();
    if (category !== undefined) updates.category = category.trim();
    if (description !== undefined) updates.description = description.trim();
    if (image_url !== undefined) updates.image_url = image_url.trim();
    if (site_name !== undefined) updates.site_name = site_name.trim();
    if (site_id !== undefined) updates.site_id = site_id;

    try {
      const { data, error } = await supabase
        .from('whop_links')
        .update(updates)
        .eq('id', id)
        .select();

      if (!error && data && data.length > 0) {
        return res.json(data[0]);
      }
    } catch (dbErr) {
      console.warn('[Whop Link PUT DB] Warning:', dbErr.message);
    }

    // Memory fallback
    const idx = memoryLinks.findIndex(l => l.id === id);
    if (idx !== -1) {
      memoryLinks[idx] = { ...memoryLinks[idx], ...updates };
      return res.json(memoryLinks[idx]);
    }

    res.json({ id, ...updates });
  } catch (err) {
    console.error('[Whop Link PUT] Error:', err);
    res.status(500).json({ error: 'Không thể cập nhật Link Whop' });
  }
});

// 8. Delete Whop Link
router.delete('/links/:id', async (req, res) => {
  try {
    const { id } = req.params;

    try {
      const { error } = await supabase.from('whop_links').delete().eq('id', id);
      if (!error) {
        return res.json({ message: 'Link Whop đã được xóa' });
      }
    } catch (dbErr) {
      console.warn('[Whop Link DELETE DB] Warning:', dbErr.message);
    }

    memoryLinks = memoryLinks.filter(l => l.id !== id);
    res.json({ message: 'Link Whop đã được xóa' });
  } catch (err) {
    console.error('[Whop Link DELETE] Error:', err);
    res.status(500).json({ error: 'Không thể xóa Link Whop' });
  }
});

// 9. Increment Whop Link click count
router.post('/links/:id/click', async (req, res) => {
  try {
    const { id } = req.params;
    try {
      const { data: current } = await supabase.from('whop_links').select('clicks_count').eq('id', id).single();
      const currentCount = current ? (current.clicks_count || 0) : 0;
      await supabase.from('whop_links').update({ clicks_count: currentCount + 1 }).eq('id', id);
    } catch (dbErr) {
      const link = memoryLinks.find(l => l.id === id);
      if (link) {
        link.clicks_count = (link.clicks_count || 0) + 1;
      }
    }
    res.json({ success: true });
  } catch {
    res.json({ success: true });
  }
});

// 10. Fetch Rich OpenGraph Preview for any Whop / Web URL
router.get('/preview', async (req, res) => {
  try {
    const rawUrl = req.query.url;
    if (!rawUrl) return res.status(400).json({ error: 'URL is required' });

    let targetUrl = rawUrl.trim();
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      targetUrl = `https://${targetUrl}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    const response = await fetch(targetUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8'
      }
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return res.json({
        url: targetUrl,
        title: targetUrl.replace(/^https?:\/\//, '').replace(/\/$/, ''),
        description: '',
        image: '',
        site_name: 'Whop'
      });
    }

    const html = await response.text();
    const decode = (s) => s ? s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'") : '';

    const ogTitle = html.match(/<meta[^>]+(?:property|name)=["'](?:og:)?title["'][^>]+content=["']([^"']+)["']/i)?.[1]
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:)?title["']/i)?.[1]
      || html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];

    const ogDesc = html.match(/<meta[^>]+(?:property|name)=["'](?:og:|twitter:)?description["'][^>]+content=["']([^"']+)["']/i)?.[1]
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:|twitter:)?description["']/i)?.[1];

    const ogImage = html.match(/<meta[^>]+(?:property|name)=["'](?:og:|twitter:)?image["'][^>]+content=["']([^"']+)["']/i)?.[1]
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:|twitter:)?image["']/i)?.[1];

    const ogSite = html.match(/<meta[^>]+(?:property|name)=["'](?:og:)?site_name["'][^>]+content=["']([^"']+)["']/i)?.[1];

    res.json({
      url: targetUrl,
      title: decode(ogTitle) || targetUrl.replace(/^https?:\/\//, '').replace(/\/$/, ''),
      description: decode(ogDesc) || '',
      image: ogImage || '',
      site_name: decode(ogSite) || (targetUrl.includes('whop.com') ? 'Whop' : 'Web')
    });
  } catch (err) {
    console.warn('[Whop Preview GET] Error:', err.message);
    res.json({
      url: req.query.url || '',
      title: (req.query.url || '').replace(/^https?:\/\//, '').replace(/\/$/, ''),
      description: '',
      image: '',
      site_name: 'Whop'
    });
  }
});

module.exports = router;
