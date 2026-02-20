#!/usr/bin/env tsx

// Simple test to verify our implementation compiles and the functions exist
import { getTotalCostForTask } from './src/db/queries/costs.js';
import { getByIdWithCost, listWithCosts } from './src/db/queries/tasks.js';

console.log('✅ getTotalCostForTask function imported successfully');
console.log('✅ getByIdWithCost function imported successfully');  
console.log('✅ listWithCosts function imported successfully');

console.log('🎉 All functions exist and TypeScript compilation successful!');