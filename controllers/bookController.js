const supabase = require('../supabase');

// Helper to resolve the site_id of a book
const getBookSite = (b) => {
  if (b.site_id && b.site_id !== 'all') return b.site_id;
  if (b.details && b.details.site_id && b.details.site_id !== 'all') return b.details.site_id;
  return 'bookpatr'; // Default existing library to bookpatr
};

exports.getAllBooks = async (req, res) => {
  try {
    const { site, site_id } = req.query;
    const targetSite = site || site_id;

    // Fetch all books safely
    const { data, error } = await supabase
      .from('books')
      .select('*')
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    let books = data || [];

    if (targetSite && targetSite !== 'all') {
      books = books.filter(b => getBookSite(b) === targetSite);
    }

    // Attach computed site_id to each book response for frontend consistency
    books = books.map(b => ({
      ...b,
      site_id: getBookSite(b)
    }));

    res.json(books);
  } catch (error) {
    console.error('Error in getAllBooks:', error);
    res.status(500).json({ error: error.message });
  }
};

exports.getBookById = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('books')
      .select('*')
      .eq('id', req.params.id)
      .single();
    
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Book not found' });

    res.json({
      ...data,
      site_id: getBookSite(data)
    });
  } catch (error) {
    console.error('Error in getBookById:', error);
    res.status(500).json({ error: error.message });
  }
};

exports.createBook = async (req, res) => {
  try {
    const { title, author, description, category, price, details, site_id, site } = req.body;
    const targetSite = site_id || site || 'bookpatr';
    const files = req.files;

    let fileUrl = '';
    let coverUrl = '';

    // Upload book file if exists
    if (files && files.file) {
      const file = files.file[0];
      const fileName = `${Date.now()}_${file.originalname.replace(/\s+/g, '_')}`;
      const { error: uploadError } = await supabase.storage
        .from('books')
        .upload(fileName, file.buffer, {
          contentType: file.mimetype,
          upsert: true
        });
      
      if (uploadError) throw uploadError;
      fileUrl = supabase.storage.from('books').getPublicUrl(fileName).data.publicUrl;
    }

    // Upload cover image if exists
    if (files && files.cover) {
      const cover = files.cover[0];
      const coverName = `${Date.now()}_${cover.originalname.replace(/\s+/g, '_')}`;
      const { error: uploadError } = await supabase.storage
        .from('covers')
        .upload(coverName, cover.buffer, {
          contentType: cover.mimetype,
          upsert: true
        });
      
      if (uploadError) throw uploadError;
      coverUrl = supabase.storage.from('covers').getPublicUrl(coverName).data.publicUrl;
    }

    const parsedDetails = typeof details === 'string' ? JSON.parse(details) : (details || {});
    parsedDetails.site_id = targetSite;

    const bookData = { 
      title, 
      author, 
      description, 
      category, 
      price, 
      details: parsedDetails,
      file_url: fileUrl,
      cover_url: coverUrl
    };

    let insertedData = null;
    try {
      // Try inserting with site_id column
      const { data, error } = await supabase
        .from('books')
        .insert([{ ...bookData, site_id: targetSite }])
        .select();
      
      if (error) throw error;
      insertedData = data;
    } catch (insertErr) {
      // Fallback: insert without site_id column (saved in details.site_id)
      const { data, error } = await supabase
        .from('books')
        .insert([bookData])
        .select();
      if (error) throw error;
      insertedData = data;
    }
    
    const result = insertedData[0];
    res.status(201).json({
      ...result,
      site_id: targetSite
    });
  } catch (error) {
    console.error('Error in createBook:', error);
    res.status(500).json({ error: error.message });
  }
};

exports.updateBook = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, author, description, category, price, details, site_id, site } = req.body;
    const files = req.files;

    let updateData = {
      title,
      author,
      description,
      category,
      price,
      details: typeof details === 'string' ? JSON.parse(details) : (details || {})
    };

    const targetSite = site_id || site;
    if (targetSite) {
      if (!updateData.details) updateData.details = {};
      updateData.details.site_id = targetSite;
      updateData.site_id = targetSite;
    }

    // Upload new book file if exists
    if (files && files.file) {
      const file = files.file[0];
      const fileName = `${Date.now()}_${file.originalname.replace(/\s+/g, '_')}`;
      const { error: uploadError } = await supabase.storage
        .from('books')
        .upload(fileName, file.buffer, {
          contentType: file.mimetype,
          upsert: true
        });
      
      if (uploadError) throw uploadError;
      updateData.file_url = supabase.storage.from('books').getPublicUrl(fileName).data.publicUrl;
    }

    // Upload new cover image if exists
    if (files && files.cover) {
      const cover = files.cover[0];
      const coverName = `${Date.now()}_${cover.originalname.replace(/\s+/g, '_')}`;
      const { error: uploadError } = await supabase.storage
        .from('covers')
        .upload(coverName, cover.buffer, {
          contentType: cover.mimetype,
          upsert: true
        });
      
      if (uploadError) throw uploadError;
      updateData.cover_url = supabase.storage.from('covers').getPublicUrl(coverName).data.publicUrl;
    }

    let updatedData = null;
    try {
      const { data, error } = await supabase
        .from('books')
        .update(updateData)
        .eq('id', id)
        .select();
      if (error) throw error;
      updatedData = data;
    } catch (updateErr) {
      delete updateData.site_id;
      const { data, error } = await supabase
        .from('books')
        .update(updateData)
        .eq('id', id)
        .select();
      if (error) throw error;
      updatedData = data;
    }
    
    const result = updatedData[0];
    res.json({
      ...result,
      site_id: getBookSite(result)
    });
  } catch (error) {
    console.error('Error in updateBook:', error);
    res.status(500).json({ error: error.message });
  }
};

exports.deleteBook = async (req, res) => {
  try {
    const { id } = req.params;
    
    const { error } = await supabase
      .from('books')
      .delete()
      .eq('id', id);
    
    if (error) throw error;
    res.json({ message: 'Book deleted successfully' });
  } catch (error) {
    console.error('Error in deleteBook:', error);
    res.status(500).json({ error: error.message });
  }
};

exports.deleteBatchBooks = async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'No book IDs provided' });
    }
    const { error } = await supabase
      .from('books')
      .delete()
      .in('id', ids);
    
    if (error) throw error;
    res.json({ message: `Successfully deleted ${ids.length} books` });
  } catch (error) {
    console.error('Error in deleteBatchBooks:', error);
    res.status(500).json({ error: error.message });
  }
};

exports.deleteAllBooks = async (req, res) => {
  try {
    const { site, site_id } = req.query;
    const targetSite = site || site_id || (req.body && (req.body.site || req.body.site_id));

    if (!targetSite || targetSite === 'all') {
      const { error } = await supabase
        .from('books')
        .delete()
        .neq('id', '00000000-0000-0000-0000-000000000000');
      
      if (error) throw error;
      return res.json({ message: 'All books deleted successfully' });
    }

    // Find books belonging to this specific site
    const { data: allBooks, error: fetchErr } = await supabase.from('books').select('*');
    if (fetchErr) throw fetchErr;

    const idsToDelete = (allBooks || [])
      .filter(b => getBookSite(b) === targetSite)
      .map(b => b.id);

    if (idsToDelete.length > 0) {
      const { error: delErr } = await supabase
        .from('books')
        .delete()
        .in('id', idsToDelete);
      if (delErr) throw delErr;
    }

    res.json({ message: `Successfully deleted ${idsToDelete.length} books for ${targetSite}` });
  } catch (error) {
    console.error('Error in deleteAllBooks:', error);
    res.status(500).json({ error: error.message });
  }
};



