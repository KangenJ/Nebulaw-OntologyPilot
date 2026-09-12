/**
 * SPI Conformance Suite - In-Memory Provider
 *
 * Runs the full conformance suite against MemoryStorageProvider.
 */

import { MemoryStorageProvider } from '@openfoundry/storage-memory';
import { runConformanceSuite } from './suite.js';

runConformanceSuite('MemoryStorageProvider', () => new MemoryStorageProvider());
