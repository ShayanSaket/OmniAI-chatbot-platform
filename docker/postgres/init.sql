-- Runs once when the postgres volume is first created.
-- (The pgvector extension is created by the Prisma migrations.)

-- Separate database for integration tests.
CREATE DATABASE omniai_test OWNER omniai;
