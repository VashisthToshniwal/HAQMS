const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

// GET /api/queue
// List all active queue tokens
//FIX: only retrieve the neccessary queries
router.get('/', authenticate, async (req, res) => {
  try {
    const { doctorId, status } = req.query;

    const where = {};
    if (doctorId) where.doctorId = doctorId;
    if (status) where.status = status;

    const tokens = await prisma.queueToken.findMany({
      where,
      include: {
        patient: true,
        doctor: true,
      },
      select: {
        id: true,
        tokenNumber: true,
        tokenDate: true,
        patient: {
          select: {
            id: true,
            name: true,
            phoneNumber: true,
            email: true,
          }
        },
        doctor: {
          select: {
            id: true,
            name: true,
            specialization: true,
            department: true,
          }
        },
        status: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    res.status(200).json({ message: "Queue tokens retrieved successfully", tokens: tokens })
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve queue', details: error.message });
  }
});

// POST /api/queue/checkin
// Generate a new queue token for a patient
// CONCURRENCY/RACE CONDITION BUG: Token increment uses aggregate read followed by create.
// Introduce a deliberate asynchronous delay (setTimeout) to force a wide race window
// where concurrent check-ins assign the exact same token number.
// POST /api/queue/checkin
// Generate a new queue token for a patient
router.post('/checkin', authenticate, async (req, res) => {
  try {
    const { patientId, doctorId, appointmentId } = req.body;

    if (!patientId || !doctorId) {
      return res.status(400).json({ error: 'Patient and Doctor ID are required for check-in.' });
    }

    // FIX 1: Normalize date for querying AND for our database constraint
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // FIX 2: Implement a Retry Loop for Concurrency Control
    // If two users hit this at the exact same millisecond, one will succeed. 
    // The database will block the second one. This loop automatically catches that block 
    // and retries the process seamlessly without crashing the user's screen.
    let attempts = 0;
    const maxRetries = 3;
    let newToken = null;

    while (attempts < maxRetries) {
      try {
        // 1. Fetch current maximum token number
        const maxTokenResult = await prisma.queueToken.aggregate({
          where: {
            doctorId,
            tokenDate: today, // Using the specific date column we added earlier
          },
          _max: { tokenNumber: true },
        });

        const currentMax = maxTokenResult._max.tokenNumber || 0;
        const nextTokenNumber = currentMax + 1;

        // 2. Attempt to insert the new token
        newToken = await prisma.queueToken.create({
          data: {
            tokenNumber: nextTokenNumber,
            tokenDate: today, // Required for our @@unique constraint!
            patientId,
            doctorId,
            appointmentId: appointmentId || null,
            status: 'WAITING',
          },
          // FIX 3: Data Minimization (Removed 'include: { patient: true }')
          select: {
            id: true,
            tokenNumber: true,
            status: true,
            createdAt: true,
            patient: { select: { name: true } },
            doctor: { select: { name: true, department: true } }
          }
        });

        // If create succeeds, break out of the retry loop
        break;

      } catch (error) {
        // P2002 is the Prisma Error Code for Unique Constraint Violation
        if (error.code === 'P2002') {
          attempts++;
          console.warn(`[CONCURRENCY] Token collision for Doctor ${doctorId}. Retrying... (${attempts}/${maxRetries})`);
          if (attempts >= maxRetries) {
            throw new Error('System is currently experiencing high volume. Please try again.');
          }
          // Continue to the next loop iteration to try again
          continue;
        }
        // If it's a different database error, throw it out of the loop immediately
        throw error;
      }
    }

    // 4. Send successful response
    res.status(201).json({
      message: 'Checked in successfully. Token generated.',
      token: newToken,
    });

  } catch (error) {
    // FIX 4: Secure Error Handling
    console.error('Queue check-in error:', error);
    // Determine if it was our custom retry error or a general server error
    const errorMessage = error.message.includes('high volume')
      ? error.message
      : 'Check-in failed. Please try again later.';

    res.status(500).json({ error: errorMessage });
  }
});
// PATCH /api/queue/:id
// Update token status (WAITING -> CALLING -> COMPLETED / SKIPPED)
router.patch('/:id', authenticate, async (req, res) => {
  try {
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({ error: 'Status is required' });
    }

    const updatedToken = await prisma.queueToken.update({
      where: { id: req.params.id },
      data: { status },
      include: {
        patient: true,
        doctor: true,
      },
    });

    res.json(updatedToken);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update queue token', details: error.message });
  }
});

module.exports = router;
