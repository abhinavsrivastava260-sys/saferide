-- Script 1: extensions
CREATE EXTENSION IF NOT EXISTS postgis;      -- geography type and spatial indexes
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- lets a GiST index hold uuid and = tests
