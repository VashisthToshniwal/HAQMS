const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

// GET /api/reports/doctor-stats
// Generates aggregation details about available doctors
router.get('/doctor-stats', authenticate, async (req, res) => {
  try {
    const start = Date.now();

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // FIX 1: The O(1) Database Strategy
    // We fire exactly 3 queries concurrently using Promise.all to get everything we need.
    const [doctors, appointmentStats, queueStats] = await Promise.all([
      // Query 1: Get minimal doctor details
      prisma.doctor.findMany({
        select: { id: true, name: true, specialization: true, department: true, consultationFee: true }
      }),
      // Query 2: Group all appointments by doctor and status
      prisma.appointment.groupBy({
        by: ['doctorId', 'status'],
        _count: { _all: true }
      }),
      // Query 3: Group today's queue tokens by doctor
      prisma.queueToken.groupBy({
        by: ['doctorId'],
        where: { createdAt: { gte: today } },
        _count: { _all: true }
      })
    ]);

    // FIX 2: In-Memory Mapping
    // We construct a fast-lookup dictionary so we don't have to loop through arrays inefficiently.
    const statsMap = {};

    doctors.forEach(doc => {
      statsMap[doc.id] = {
        totalAppointments: 0,
        completedAppointments: 0,
        cancelledAppointments: 0,
        todayQueueSize: 0,
      };
    });

    // Populate the dictionary with our bulk appointment data
    appointmentStats.forEach(stat => {
      if (statsMap[stat.doctorId]) {
        statsMap[stat.doctorId].totalAppointments += stat._count._all;

        if (stat.status === 'COMPLETED') {
          statsMap[stat.doctorId].completedAppointments = stat._count._all;
        }
        if (stat.status === 'CANCELLED') {
          statsMap[stat.doctorId].cancelledAppointments = stat._count._all;
        }
      }
    });

    // Populate the dictionary with our bulk queue data
    queueStats.forEach(stat => {
      if (statsMap[stat.doctorId]) {
        statsMap[stat.doctorId].todayQueueSize = stat._count._all;
      }
    });

    // FIX 3: Assemble the final report synchronously without database calls
    const reportData = doctors.map(doc => {
      const stats = statsMap[doc.id];

      // FIX 4: Calculate revenue using math, not by fetching data rows!
      const revenue = stats.completedAppointments * doc.consultationFee;

      return {
        id: doc.id,
        name: doc.name,
        specialization: doc.specialization,
        department: doc.department,
        totalAppointments: stats.totalAppointments,
        completedAppointments: stats.completedAppointments,
        cancelledAppointments: stats.cancelledAppointments,
        todayQueueSize: stats.todayQueueSize,
        revenue: revenue
      };
    });

    const durationMs = Date.now() - start;

    res.status(200).json({
      message: 'Report generated successfully',
      timeTakenMs: durationMs,
      data: reportData,
    });
  } catch (error) {
    // FIX 5: Secure error handling
    console.error('Report generation error:', error);
    res.status(500).json({ error: 'Failed to generate report. Please try again later.' });
  }
});

module.exports = router;