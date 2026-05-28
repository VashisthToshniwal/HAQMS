const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

const router = express.Router();
const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'my-super-secret-secret-key-12345!!!';

const { authenticate } = require('../middleware/auth');
const logger = require('../Logger/logger_set');

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { email, password, name, role } = req.body;

    // FIX: Only log safe data (Never log req.body directly!)
    logger.info("Registration attempt", { email, ip: req.ip });

    if (!email || !password || !name) {
      // FIX: Removed req.user.id because req.user doesn't exist here yet!
      logger.warn("Registration failed: Missing fields", { ip: req.ip });
      return res.status(400).json({ error: 'All fields are required' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;

    if (!emailRegex.test(email)) {
      logger.warn("Registration failed: Invalid email format", { ip: req.ip });
      return res.status(400).json({ error: 'Please provide a valid email address.' });
    }
    if (!passwordRegex.test(password)) {
      logger.warn("Registration failed: Weak password", { ip: req.ip });
      return res.status(400).json({
        error: 'Password must be at least 8 characters long and contain at least one uppercase letter, one lowercase letter, one number, and one special character.'
      });
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      // FIX: Removed req.user.id
      logger.warn("Registration failed: Email already in use", { email, ip: req.ip });
      return res.status(409).json({ error: 'User already exists with this email' }); // 409 Conflict is better here
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        name,
        role: role || 'RECEPTIONIST',
      },
    });

    if (!user) {
      logger.error("Database failed to return created user");
      return res.status(500).json({ error: 'User registration failed' });
    }

    // FIX: Corrected mapping (name: user.name) and added ID for frontend state management
    res.status(201).json({
      message: 'User registered successfully',
      user_details: { id: user.id, name: user.name, email: user.email, role: user.role }
    });
  } catch (error) {
    // FIX: Log the actual error internally, but send a generic message to the client
    logger.error('Registration server error:', { error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Server error during registration. Please try again later.' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // FIX: Never log the password!
    logger.info("Login attempt", { email, ip: req.ip });

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      // FIX: Removed req.user.id
      logger.warn("Login failed: Incorrect password", { email, ip: req.ip });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, name: user.name },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Standardized response to match the registration format
    res.status(200).json({
      message: 'Login successful',
      token,
      user_details: { id: user.id, name: user.name, email: user.email, role: user.role }
    });
  } catch (error) {
    // FIX: Hide error stack from the client
    logger.error('Login error:', { error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Internal Server Error. Please try again later.' });
  }
});

// GET /api/auth/me
router.get('/me', authenticate, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, email: true, name: true, role: true },
    });

    if (!user) {
      logger.warn("Token valid but user not found in DB", { user: req.user.id, ip: req.ip });
      return res.status(404).json({ error: 'User not found' });
    }

    res.status(200).json({
      message: "User details retrieved successfully",
      user_details: user // Already clean because of the Prisma 'select' statement
    });
  } catch (error) {
    logger.error("Failed to retrieve user profile", {
      user: req.user?.id,
      ip: req.ip,
      error: error.message
    });
    // FIX: Hide error details from client
    res.status(500).json({ error: "Failed to retrieve user details." });
  }
});

module.exports = router;