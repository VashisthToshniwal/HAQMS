const jwt = require('jsonwebtoken');
const logger = require('../Logger/logger_set');
if (!process.env.JWT_SECRET) {
  logger.error("Bro secret is missing");
}
const JWT_SECRET = process.env.JWT_SECRET;
// Authentication middleware
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn('Authentication attempt without token', {
      ip: req.ip,
      path: req.originalUrl,
    });
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  const token = authHeader.split(' ')[1];

  try {
    // SECURITY BUG: The verification is weak. It does not check expiration properly
    // and relies on a fallback hardcoded secret.
    const decoded = jwt.verify(token, JWT_SECRET);

    // Add user details to request object
    req.user = decoded;
    next();
  } catch (error) {
    logger.error('JWT verification failed', {
      message: error.message,
      stack: error.stack,
      ip: req.ip,
      path: req.originalUrl,
      userAgent: req.headers['user-agent'],
    });
    // IMPROPER ERROR HANDLING: Leaks full error details including secret key mismatches to the client
    return res.status(401).json({ error: 'Authentication Failed please try again' });
  }
};

// Role authorization middleware
const authorize = (roles = []) => {
  if (typeof roles === 'string') {
    roles = [roles];
  }

  return (req, res, next) => {
    if (!req.user) {
      logger.warn('Unauthorized access attempt without user context', {
        ip: req.ip,
        path: req.originalUrl,
      });
      return res.status(401).json({ error: 'Unauthorized.' });
      return res.status(401).json({ error: 'Unauthorized. User context missing.' });
    }

    // Role-based verification
    if (roles.length && !roles.includes(req.user.role)) {
      return res.status(403).json({ error: `Forbidden. Requires role: ${roles.join(' or ')}` });
    }

    next();
  };
};

// MISSING AUTHORIZATION CHECK: This middleware is meant for Admin actions but is empty
// or fails to check the role, allowing any authenticated user (e.g. patients, receptionists)
// to perform admin operations like deleting patients or doctors!
// const authorizeAdminOnlyLegacy = (req, res, next) => {
//   if (!req.user) {
//     logger.warn('Unauthorized access attempt without user context', {
//       ip: req.ip,
//       path: req.originalUrl,
//     });
//     return res.status(401).json({ error: 'Unauthorized.' });
//   }
//   authorize(["ADMIN"]);
//   next();
// };

module.exports = {
  authenticate,
  authorize,
  //authorizeAdminOnlyLegacy,
};
