import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add } from '../dist/math.js';
test('adds signed integers', () => assert.equal(add(-2, 3), 1));
