require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 5000;

const corsOptions = {
  origin: '*', // Cho phép tất cả các nguồn trong quá trình dev/deploy nhanh
  methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));
app.use(express.json());

// Import routes
const bookRoutes = require('./routes/books');
const checkoutRoutes = require('./routes/checkout');

// Use routes
app.use('/api/books', bookRoutes);
app.use('/api/checkout', checkoutRoutes);

app.get('/', (req, res) => {
  res.send('Bookpatr Backend API is running.....');
});

if (process.env.NODE_ENV !== 'production') {
  app.listen(port, () => {
    console.log(`Server is running on port: ${port}`);
  });
}

module.exports = app;
