const winston = require('winston');
const path = require('path');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: path.join(__dirname, 'logs', 'error.log'), level: 'error', maxsize: 5_000_000, maxFiles: 5 }),
    new winston.transports.File({ filename: path.join(__dirname, 'logs', 'combined.log'), maxsize: 5_000_000, maxFiles: 5 })
  ]
});

// Also print to console (readable format) unless in production-quiet mode
if (process.env.NODE_ENV !== 'production' || process.env.LOG_TO_CONSOLE === 'true') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(winston.format.colorize(), winston.format.simple())
  }));
}

module.exports = logger;
