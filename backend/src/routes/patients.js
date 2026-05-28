const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticate, authorizeAdminOnlyLegacy, authorize } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

// GET /api/patients
// Get all patients with search, filtering, and INEFICIENT IN-MEMORY PAGINATION
// GET /api/patients
// Retrieve paginated and filtered list of patients
router.get('/', authenticate, async (req, res) => {
  try {
    const { search, gender } = req.query;

    // FIX 1: Safe Pagination Parsing
    // Using Math.max ensures that even if a user passes '?page=-5', it defaults to 1.
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || 10);
    const skip = (page - 1) * limit;

    // FIX 2: Construct Database-Level Filters
    const whereClause = {};

    if (search) {
      const query = search.trim();
      // Prisma's OR operator lets the database efficiently search across multiple columns
      whereClause.OR = [
        { name: { contains: query, mode: 'insensitive' } },
        { phoneNumber: { contains: query } }, // Phone numbers usually don't need case-insensitivity
        { email: { contains: query, mode: 'insensitive' } }
      ];
    }

    if (gender && gender !== 'All') {
      whereClause.gender = { equals: gender, mode: 'insensitive' };
    }

    // FIX 3: Run queries concurrently (Data + Total Count)
    // We need both the paginated chunk of data AND the total count of matching rows to calculate totalPages.
    const [patients, totalPatients] = await Promise.all([
      prisma.patient.findMany({
        where: whereClause,
        skip: skip, // Skips the records from previous pages
        take: limit, // Only fetches the exact number of rows needed for this page
        orderBy: { createdAt: 'desc' },
        // Data minimization
        select: {
          id: true,
          name: true,
          email: true,
          phoneNumber: true,
          age: true,
          gender: true,
        }
      }),
      prisma.patient.count({ where: whereClause })
    ]);

    const totalPages = Math.ceil(totalPatients / limit);

    // FIX 4: Consistent API Response format
    res.status(200).json({
      message: 'Patients retrieved successfully',
      data: {
        patients: patients,
        pagination: {
          page,
          limit,
          totalPatients,
          totalPages,
        },
      }
    });
  } catch (error) {
    // FIX 5: Secure Error Handling (Hide internals)
    console.error('Error fetching patients list:', error);
    res.status(500).json({ error: 'Failed to fetch patients list. Please try again later.' });
  }
});
// GET /api/patients/:id
// Get patient details by ID. Notice N+1 issue could be placed here or in appointments,
// but let's make it fetch the patient with their appointments and tokens.
// GET /api/patients/:id
// Retrieve specific patient details and their appointment history
router.get('/:id', authenticate, async (req, res) => {
  try {
    // FIX 1: Corrected the destructuring syntax
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ error: "Patient ID is required" });
    }

    const patient = await prisma.patient.findUnique({
      where: { id },
      // FIX 2: Replaced 'include' with 'select' for strict data minimization
      select: {
        id: true,
        name: true,
        email: true,
        phoneNumber: true,
        age: true,
        gender: true,
        medicalHistory: true,
        // We can nest a select inside the relation to clean up the appointments too!
        appointments: {
          select: {
            id: true,
            appointmentDate: true,
            reason: true,
            status: true,
            doctor: {
              select: {
                name: true,
                department: true
              }
            }
          }
        }
      },
    });

    if (!patient) {
      return res.status(404).json({ error: 'Patient not found' });
    }

    // FIX 3: Standardized the API response
    return res.status(200).json({
      message: "Patient details retrieved successfully",
      patient_details: patient
    });

  } catch (error) {
    // FIX 4: Secure error handling (hiding database syntax from the client)
    console.error('Error fetching patient details:', error);
    res.status(500).json({ error: 'Failed to retrieve patient details. Please try again later.' });
  }
});

// POST /api/patients (Register patient)
// POST /api/patients
// Register a new patient
router.post('/', authenticate, async (req, res) => {
  try {
    const { name, email, phoneNumber, age, gender, medicalHistory } = req.body;

    // 1. Check for required fields
    if (!name || !phoneNumber || !age || !gender) {
      return res.status(400).json({ error: 'Name, phoneNumber, age, and gender are required.' });
    }

    // 2. Validate Phone Number Format (Allows standard formats like +1234567890 or 123-456-7890)
    const phoneRegex = /^\+?[1-9]\d{1,14}$|^[0-9]{3}-[0-9]{3}-[0-9]{4}$/;
    if (!phoneRegex.test(phoneNumber.trim())) {
      return res.status(400).json({ error: 'Please provide a valid phone number format.' });
    }

    // 3. Validate Email format only if it is provided (since it is optional/nullable)
    if (email) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email.trim())) {
        return res.status(400).json({ error: 'Please provide a valid email address.' });
      }
    }

    // 4. Validate and Parse Age safely
    const parsedAge = Number(age);
    if (isNaN(parsedAge) || parsedAge < 0 || parsedAge > 125) {
      return res.status(400).json({ error: 'Please provide a realistic age value.' });
    }

    // 5. Create Patient Record
    const patient = await prisma.patient.create({
      data: {
        name: name.trim(),
        email: email ? email.trim().toLowerCase() : null,
        phoneNumber: phoneNumber.trim(),
        age: parsedAge,
        gender,
        medicalHistory: medicalHistory || null, // UI components must use optional chaining (?.) when reading this
      },
      // Select only the public data to remain consistent with your other routes
      select: {
        id: true,
        name: true,
        email: true,
        phoneNumber: true,
        age: true,
        gender: true,
        medicalHistory: true
      }
    });

    // 6. Consistent API format response
    res.status(201).json({
      message: 'Patient registered successfully',
      patient_details: patient
    });

  } catch (error) {
    // 7. Secure Error Handling (Hides internal database messages from client)
    console.error('Patient registration error:', error);
    res.status(500).json({ error: 'Internal Server Error during patient registration.' });
  }
});

// DELETE /api/patients/:id
// SECURITY BUG: The route relies on authorizeAdminOnlyLegacy, which has the bypassed admin validation check!
// This allows any receptionist or doctor to delete a patient.
//FiX: Authorize with Admin
router.delete('/:id', authenticate, authorize("ADMIN"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: "Patient ID is required" })
    }
    const patient = await prisma.patient.findUnique({ where: { id } });
    if (!patient) {
      return res.status(404).json({ error: 'Patient not found' });
    }

    await prisma.patient.delete({ where: { id } });

    res.json({ message: `Successfully deleted patient ${patient.name}` });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete patient', details: error.message });
  }
});

module.exports = router;
