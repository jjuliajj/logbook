const express = require('express');
const router = express.Router();
const supabase = require('../supabase');

// Default secret recipient for support inquiries
const DEFAULT_SUPPORT_RECIPIENT = 'parkcongvien22@gmail.com';

// 1. Submit a new contact / support inquiry
router.post('/', async (req, res) => {
  try {
    const { name, email, subject, message, site_id, site } = req.body;

    if (!name || !email || !subject || !message) {
      return res.status(400).json({ 
        success: false, 
        error: 'Please fill in all required fields: name, email, subject, and message.' 
      });
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      return res.status(400).json({
        success: false,
        error: 'Please provide a valid email address.'
      });
    }

    const targetSite = (site_id || site || 'bookpatr').toLowerCase().trim();
    const recipientEmail = process.env.SUPPORT_RECIPIENT_EMAIL || DEFAULT_SUPPORT_RECIPIENT;

    console.log(`[Support Desk] New message received from "${name}" <${email}> for site: "${targetSite}"`);

    // Save ticket to Supabase support_tickets table
    let ticketId = null;
    try {
      const { data: ticket, error: dbError } = await supabase
        .from('support_tickets')
        .insert([{
          name: name.trim(),
          email: email.trim(),
          subject: subject.trim(),
          message: message.trim(),
          site_id: targetSite,
          recipient_email: recipientEmail,
          status: 'pending'
        }])
        .select()
        .single();

      if (!dbError && ticket) {
        ticketId = ticket.id;
      }
    } catch (dbErr) {
      console.warn('[Support Desk] DB insert notice:', dbErr.message);
    }

    // Forward notification to secret recipient email via FormSubmit API
    try {
      const shortId = ticketId ? ticketId.substring(0, 6) : Date.now().toString().slice(-4);
      const emailSubject = `[${targetSite.toUpperCase()} #${shortId}] New Inquiry from ${name.trim()}: ${subject.trim()}`;

      const mailRes = await fetch(`https://formsubmit.co/ajax/${encodeURIComponent(recipientEmail)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Origin': 'https://www.logicnode.ink',
          'Referer': 'https://www.logicnode.ink/contact'
        },
        body: JSON.stringify({
          _subject: emailSubject,
          _replyto: email.trim(),
          _template: 'table',
          _captcha: 'false',
          Ticket_ID: ticketId || `T-${Date.now()}`,
          Website: targetSite,
          Customer_Name: name.trim(),
          Customer_Email: email.trim(),
          Subject: subject.trim(),
          Message: message.trim(),
          Sent_At: new Date().toISOString()
        })
      });
      const mailData = await mailRes.json();
      console.log(`[Support Desk] FormSubmit status:`, mailData);
    } catch (mailErr) {
      console.warn('[Support Desk] Email dispatch notice:', mailErr.message);
    }

    res.json({
      success: true,
      message: 'Your message has been successfully received by our system support team. We will reply to your email within 24 hours.',
      ticket_id: ticketId
    });
  } catch (error) {
    console.error('[Support Desk] Unexpected error:', error);
    res.status(500).json({
      success: false,
      error: 'An unexpected error occurred while processing your request. Please try again later.',
      details: error.message
    });
  }
});

// 2. Get support tickets (for admin dashboard / auditing)
router.get('/', async (req, res) => {
  try {
    const { site, site_id } = req.query;
    const targetSite = (site || site_id)?.toLowerCase().trim();

    let query = supabase
      .from('support_tickets')
      .select('*')
      .order('created_at', { ascending: false });

    if (targetSite && targetSite !== 'all') {
      query = query.eq('site_id', targetSite);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json(data || []);
  } catch (error) {
    console.error('[Support Desk] Error fetching tickets:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
