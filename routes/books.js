const express = require('express');
const router = express.Router();
const bookController = require('../controllers/bookController');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

// Get all books
router.get('/', bookController.getAllBooks);

// Delete selected books (batch)
router.post('/delete-batch', bookController.deleteBatchBooks);

// Delete all books
router.delete('/all/truncate', bookController.deleteAllBooks);
router.delete('/truncate', bookController.deleteAllBooks);

// Create a new book (with file and cover image uploads)
router.post('/', upload.fields([
  { name: 'file', maxCount: 1 },
  { name: 'cover', maxCount: 1 }
]), bookController.createBook);

// Get book by ID
router.get('/:id', bookController.getBookById);

// Update a book
router.put('/:id', upload.fields([
  { name: 'file', maxCount: 1 },
  { name: 'cover', maxCount: 1 }
]), bookController.updateBook);

// Delete a book
router.delete('/:id', bookController.deleteBook);

module.exports = router;
