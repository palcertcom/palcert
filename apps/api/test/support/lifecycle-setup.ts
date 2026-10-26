import { PrismaClient } from '@palcert/database';
// supertest builds every request from this class; `request()` is a thin factory.
import Test from 'supertest/lib/test';
import { installLifecycleGuard } from './lifecycle';

// Runs before each e2e test file (see jest-e2e.config.js), so every hook and
// test in the file is a phase and abandoned ones are fenced off.
installLifecycleGuard({ supertestTest: Test, prismaClient: PrismaClient });
