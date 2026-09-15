// Vercel Serverless Entry - imports Express app from server.js
// This file makes /api/* routes work on Vercel
const app = require('../server');
module.exports = app;
