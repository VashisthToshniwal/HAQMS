const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

// GET /api/doctors
// Retrieve list of doctors with special search filtering
// SECURITY BUG: SQL Injection vulnerability in the search parameter!
// Uses queryRawUnsafe with string concatenation instead of parameterized inputs.
// GET /api/doctors
// Retrieve list of doctors with special search filtering
router.get('/', authenticate, async (req, res) => {
  try {
    const { search, specialization } = req.query;

    // FIX 1: Build a dynamic Prisma filter object instead of a raw SQL string
    const whereClause = {};

    if (search) {
      whereClause.name = {
        contains: search,
        mode: 'insensitive', // This is Prisma's safe equivalent to PostgreSQL's ILIKE
      };
    }

    if (specialization && specialization !== 'All') {
      whereClause.specialization = specialization;
    }

    // FIX 2: Use Prisma's native ORM method. It completely eliminates SQL injection risk.
    const doctors = await prisma.doctor.findMany({
      where: whereClause,
      // FIX 3: Apply the same data-minimization strategy we used earlier
      select: {
        id: true,
        name: true,
        specialization: true,
        department: true,
        consultationFee: true,
        experience: true,
        availableFrom: true,
        availableTo: true,
      }
    });

    // FIX 4: Consistent API formatting
    res.status(200).json({
      message: "Doctors retrieved successfully",
      doctors: doctors
    });

  } catch (error) {
    // FIX 5: Secure Error Handling (No more leaked SQL syntax!)
    console.error('Error fetching doctors list:', error);
    res.status(500).json({ error: 'Failed to retrieve doctors list. Please try again later.' });
  }
});

// GET /api/doctors/stats
// Returns aggregation details about available doctors
// PERFORMANCE BUG: Sequential async calls instead of Promise.all()
// GET /api/doctors/stats
// Returns aggregation details about available doctors
router.get('/stats', authenticate, async (req, res) => {
  try {
    const start = Date.now();

    // FIX 1: Group independent async calls into a single Promise.all array
    // This executes all queries concurrently, massively speeding up the response time.
    const [
      totalDoctors,
      surgeonsCount,
      averageFeeResult,
      highestExperienceResult
    ] = await Promise.all([
      prisma.doctor.count(),
      prisma.doctor.count({ where: { department: 'Surgery' } }),
      prisma.doctor.aggregate({ _avg: { consultationFee: true } }),
      prisma.doctor.aggregate({ _max: { experience: true } })
    ]);

    const durationMs = Date.now() - start;

    res.json({
      success: true,
      data: {
        total: totalDoctors,
        surgeons: surgeonsCount,
        averageFee: Math.round(averageFeeResult._avg.consultationFee || 0),
        maxExperience: highestExperienceResult._max.experience || 0,
      },
      // Updated debug info to reflect the optimization
      debugInfo: {
        executionTimeMs: durationMs,
        notes: 'Optimized: Queries loaded concurrently via Promise.all.'
      }
    });
  } catch (error) {
    // FIX 2: Secure error handling
    // Log the actual error internally, but send a generic message to the client
    console.error('Stats aggregation error:', error);
    res.status(500).json({ error: 'Failed to fetch doctor statistics. Please try again later.' });
  }
});

// GET /api/doctors/:id
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params.id
    if (!id) {
      return res.status(404).json({ error: 'Doctor not found' });
    }
    const doctor = await prisma.doctor.findUnique({
      where: { id: id },
      // FIX 1: Use 'select' to specify exactly which fields to return
      select: {
        id: true,
        name: true,
        specialization: true,
        department: true,
        consultationFee: true,
        experience: true,
        availableFrom: true,
        availableTo: true,
        // Notice we left out userId, createdAt, and the relational fields
      }
    });

    if (!doctor) {
      return res.status(404).json({ error: 'Doctor not found' });
    }

    return res.status(200).json({
      message: "Doctor details retrieved successfully",
      doctor: doctor // This object now only contains the fields selected above
    });
  } catch (error) {
    // FIX 2: Prevent data leakage by logging the error internally 
    // and sending a generic message to the client instead of error.message
    console.error("Error fetching doctor details:", error);
    res.status(500).json({ error: 'Failed to retrieve doctor details. Please try again later.' });
  }
});

module.exports = router;
