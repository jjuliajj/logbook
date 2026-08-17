const supabase = require('../supabase');

exports.getAllBooks = async (req, res) => {
  try {
    const { site, site_id } = req.query;
    const targetSite = site || site_id;

    let query = supabase.from('books').select('*');

    if (targetSite && targetSite !== 'all') {
      // Return books specifically assigned to this site, or general 'all' books
      query = query.or(`site_id.eq.${targetSite},site_id.eq.all,site_id.is.null`);
    }

    const { data, error } = await query.order('created_at', { ascending: false });
    
    if (error) throw error;
    res.json(data || []);
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
    res.json(data);
  } catch (error) {
    console.error('Error in getBookById:', error);
    res.status(500).json({ error: error.message });
  }
};

exports.createBook = async (req, res) => {
  try {
    const { title, author, description, category, price, details, site_id, site } = req.body;
    const targetSite = site_id || site || 'all';
    const files = req.files;

    let fileUrl = '';
    let coverUrl = '';

    // Upload book file if exists
    if (files && files.file) {
      const file = files.file[0];
      const fileName = `${Date.now()}_${file.originalname.replace(/\s+/g, '_')}`;
      const { data: uploadData, error: uploadError } = await supabase.storage
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
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('covers')
        .upload(coverName, cover.buffer, {
          contentType: cover.mimetype,
          upsert: true
        });
      
      if (uploadError) throw uploadError;
      coverUrl = supabase.storage.from('covers').getPublicUrl(coverName).data.publicUrl;
    }

    const bookData = { 
      site_id: targetSite,
      title, 
      author, 
      description, 
      category, 
      price, 
      details: typeof details === 'string' ? JSON.parse(details) : details,
      file_url: fileUrl,
      cover_url: coverUrl
    };

    const { data, error } = await supabase
      .from('books')
      .insert([bookData])
      .select();
    
    if (error) throw error;
    res.status(201).json(data[0]);
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
      details: typeof details === 'string' ? JSON.parse(details) : details
    };

    if (site_id !== undefined || site !== undefined) {
      updateData.site_id = site_id || site || 'all';
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

    const { data, error } = await supabase
      .from('books')
      .update(updateData)
      .eq('id', id)
      .select();
    
    if (error) throw error;
    res.json(data[0]);
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

    let query = supabase.from('books').delete();

    if (targetSite && targetSite !== 'all') {
      query = query.eq('site_id', targetSite);
    } else {
      query = query.neq('id', '00000000-0000-0000-0000-000000000000');
    }
    
    const { error } = await query;
    if (error) throw error;
    res.json({ message: targetSite && targetSite !== 'all' ? `All books for ${targetSite} deleted successfully` : 'All books deleted successfully' });
  } catch (error) {
    console.error('Error in deleteAllBooks:', error);
    res.status(500).json({ error: error.message });
  }
};


