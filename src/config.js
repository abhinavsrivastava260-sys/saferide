require('dotenv').config({ quiet: true });

module.exports = {
  databaseUrl: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/ridebook',
  jwtSecret: process.env.JWT_SECRET || 'change-me',
  adminKey: process.env.ADMIN_KEY || 'admin123',
  port: Number(process.env.PORT || 3000),
  tz: process.env.APP_TZ || 'Asia/Kolkata',
  offerSeconds: Number(process.env.OFFER_SECONDS || 30),
  searchTimeoutMinutes: 3,
};
