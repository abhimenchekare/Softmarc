#!/bin/bash
echo ""
echo "========================================"
echo "  Softmarc - Local Development Server"
echo "========================================"
echo ""
echo "Installing dependencies..."
npm install
echo ""
echo "Starting server with SQLite..."
echo ""
DB_TYPE=sqlite node server.js
